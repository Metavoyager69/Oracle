import { useEffect, useState } from "react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { DemoMarket } from "../../lib/shared/market-types";
import { MARKET_TOKEN_MINT, MARKET_TOKEN_SYMBOL, MIN_STAKE_BASE_UNITS, PROGRAM_ID } from "../../lib/solana/config";
import { formatMinimumStakeLabel, parseTokenAmount } from "../../lib/solana/token";
import {
  buildSubmitPositionTransaction,
  marketExistsOnChain,
} from "../../lib/solana/instructions";
import {
  commitStake,
  encryptChoice,
  encryptStake,
  serializeCiphertext,
} from "../../lib/arcium/encrypt";
import { storeStakeNonce } from "../../lib/arcium/nonce-vault";
import { fetchApiJson, type ApiMarket, deserializeMarket } from "../../utils/api";
import { createWalletAuthPayload, ensureWalletUnlocked } from "../../utils/wallet-guard";

type StepState = "idle" | "encrypting" | "submitting" | "confirmed" | "error";
type SubmissionMode = "checking" | "onchain" | "backend";

interface PendingMirrorSubmission {
  txSig?: string;
  commitment: string;
  encryptedStake: { c1: number[]; c2: number[] };
  encryptedChoice: { c1: number[]; c2: number[] };
  sealedAt: string;
}

function toHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function useMarketDetail(marketId: number, isReady: boolean) {
  const { connected, publicKey, sendTransaction, signMessage } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const provider = anchorWallet
    ? new AnchorProvider(connection, anchorWallet, { preflightCommitment: "confirmed" })
    : null;

  const [market, setMarket] = useState<DemoMarket | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);
  const [stakeInput, setStakeInput] = useState("");
  const [step, setStep] = useState<StepState>("idle");
  const [submissionRef, setSubmissionRef] = useState<string | null>(null);
  const [encryptedPreview, setEncryptedPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submissionMode, setSubmissionMode] = useState<SubmissionMode>("checking");
  const [submissionModeNote, setSubmissionModeNote] = useState<string | null>(null);
  const [pendingMirrorSubmission, setPendingMirrorSubmission] =
    useState<PendingMirrorSubmission | null>(null);

  async function loadMarketDetails(targetId: number, silent = false): Promise<void> {
    if (!silent) {
      setLoadingMarket(true);
    }
    setLoadError(null);

    try {
      const { response, payload } = await fetchApiJson<{
        market?: ApiMarket;
        error?: string;
      }>(`/api/markets/${targetId}`);
      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not load market.");
      }
      if (!payload?.market) {
        throw new Error("Market payload missing.");
      }

      setMarket(deserializeMarket(payload.market as ApiMarket));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unknown API error.";
      setLoadError(message);
      if (!silent) {
        setMarket(null);
      }
    } finally {
      if (!silent) {
        setLoadingMarket(false);
      }
    }
  }

  useEffect(() => {
    if (!isReady) return;
    if (!Number.isFinite(marketId)) {
      setLoadingMarket(false);
      setLoadError("Invalid market id.");
      setMarket(null);
      return;
    }

    void loadMarketDetails(marketId);
  }, [isReady, marketId]);

  useEffect(() => {
    let cancelled = false;

    async function detectSubmissionMode() {
      if (!market) {
        setSubmissionMode("checking");
        setSubmissionModeNote(null);
        return;
      }

      if (!MARKET_TOKEN_MINT) {
        setSubmissionMode("backend");
        setSubmissionModeNote(
          "NEXT_PUBLIC_MARKET_TOKEN_MINT is not configured, so the page is using the backend-only encrypted submission path."
        );
        return;
      }

      try {
        const exists = await marketExistsOnChain(connection, market.id);
        if (cancelled) return;

        if (exists) {
          setSubmissionMode("onchain");
          setSubmissionModeNote(
            `Chain-backed market detected. Position submission will transfer ${MARKET_TOKEN_SYMBOL} on Solana before the backend mirrors the encrypted record.`
          );
          return;
        }

        setSubmissionMode("backend");
        setSubmissionModeNote(
          "This market does not have a live program account yet, so the page falls back to backend-only encrypted submission."
        );
      } catch {
        if (cancelled) return;
        setSubmissionMode("backend");
        setSubmissionModeNote(
          "Could not verify the on-chain market account, so the page is using the backend-only encrypted submission path."
        );
      }
    }

    void detectSubmissionMode();
    return () => {
      cancelled = true;
    };
  }, [connection, market]);

  async function mirrorPositionSubmission(payload: PendingMirrorSubmission) {
    const auth = await createWalletAuthPayload(
      { connected, publicKey, signMessage },
      "positions:submit"
    );

    const { response, payload: body } = await fetchApiJson<{
      txSig?: string;
      error?: string;
    }>("/api/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketId: market?.id,
        wallet: publicKey?.toBase58(),
        auth,
        ...payload,
      }),
    });
    if (!response.ok) {
      throw new Error(body?.error ?? "Position submission failed.");
    }

    setPendingMirrorSubmission(null);
    return body;
  }

  function applySuccessfulSubmission(payload: { txSig?: string }) {
    setSubmissionRef(typeof payload?.txSig === "string" ? payload.txSig : null);
    setMarket((current) =>
      current
        ? {
            ...current,
            totalParticipants: current.totalParticipants + 1,
          }
        : current
    );
    setStep("confirmed");
    setStakeInput("");
    setChoice(null);
    void loadMarketDetails(marketId, true);
  }

  async function handleSubmit() {
    if (!connected || !market || !publicKey) return;

    if (pendingMirrorSubmission) {
      setError(null);
      setStep("submitting");
      try {
        await ensureWalletUnlocked({ connected, publicKey, signMessage }, "submit a position");
        const payload = await mirrorPositionSubmission(pendingMirrorSubmission);
        applySuccessfulSubmission(payload);
      } catch (caught) {
        const baseMessage = caught instanceof Error ? caught.message : "Unknown error";
        const message = pendingMirrorSubmission.txSig
          ? `On-chain position ${pendingMirrorSubmission.txSig.slice(0, 18)}... is confirmed, but backend mirroring failed: ${baseMessage}`
          : baseMessage;
        setError(message);
        setStep("error");
      }
      return;
    }

    if (!choice || !stakeInput || !provider) return;

    const stakeAmount = parseTokenAmount(stakeInput);
    if (stakeAmount === null || stakeAmount <= 0n) {
      setError("Enter a valid stake amount.");
      setStep("error");
      return;
    }
    if (stakeAmount < MIN_STAKE_BASE_UNITS) {
      setError(`Minimum stake is ${formatMinimumStakeLabel()}.`);
      setStep("error");
      return;
    }

    setStep("encrypting");
    setError(null);

    let confirmedOnChainSubmission = pendingMirrorSubmission;
    try {
      await ensureWalletUnlocked({ connected, publicKey, signMessage }, "submit a position");

      if (!confirmedOnChainSubmission) {
        const encStake = await encryptStake(stakeAmount, provider, PROGRAM_ID);
        const encChoice = await encryptChoice(choice === "yes", provider, PROGRAM_ID);
        const { commitment, stakeNonce } = await commitStake(stakeAmount);

        await storeStakeNonce(
          { connected, publicKey, signMessage },
          market.id,
          commitment,
          stakeNonce
        );

        const preview = `0x${Buffer.from(encStake.c1).slice(0, 8).toString("hex")}...`;
        setEncryptedPreview(preview);
        setStep("submitting");

        confirmedOnChainSubmission = {
          commitment: toHex(commitment),
          encryptedStake: serializeCiphertext(encStake),
          encryptedChoice: serializeCiphertext(encChoice),
          sealedAt: new Date().toISOString(),
        };

        if (submissionMode === "onchain") {
          if (!sendTransaction) {
            throw new Error("Wallet is not ready to send transactions.");
          }

          const { transaction } = await buildSubmitPositionTransaction({
            connection,
            marketId: market.id,
            user: publicKey,
            encryptedStake: encStake,
            encryptedChoice: encChoice,
            amount: stakeAmount,
            commitment,
          });

          const latestBlockhash = await connection.getLatestBlockhash("confirmed");
          transaction.feePayer = publicKey;
          transaction.recentBlockhash = latestBlockhash.blockhash;

          const txSig = await sendTransaction(transaction, connection, {
            preflightCommitment: "confirmed",
          });

          await connection.confirmTransaction(
            {
              signature: txSig,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            "confirmed"
          );

          confirmedOnChainSubmission = {
            ...confirmedOnChainSubmission,
            txSig,
          };
        }

        setPendingMirrorSubmission(confirmedOnChainSubmission);
      }

      const payload = await mirrorPositionSubmission(confirmedOnChainSubmission);
      applySuccessfulSubmission(payload);
    } catch (caught) {
      const baseMessage = caught instanceof Error ? caught.message : "Unknown error";
      const message = confirmedOnChainSubmission?.txSig
        ? `On-chain position ${confirmedOnChainSubmission.txSig.slice(0, 18)}... is confirmed, but backend mirroring failed: ${baseMessage}`
        : baseMessage;
      setError(message);
      setStep("error");
    }
  }

  return {
    choice,
    connected,
    encryptedPreview,
    error,
    handleSubmit,
    loadError,
    loadingMarket,
    market,
    pendingMirrorSubmission,
    setChoice,
    setStakeInput,
    stakeInput,
    step,
    submissionMode,
    submissionModeNote,
    submissionRef,
    handleRefresh: () => (market ? loadMarketDetails(market.id) : Promise.resolve()),
  };
}
