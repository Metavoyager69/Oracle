import { useState } from "react";
import { useRouter } from "next/router";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { buildCreateMarketTransaction } from "../../lib/solana/instructions";
import { MARKET_TOKEN_MINT, MARKET_TOKEN_SYMBOL } from "../../lib/solana/config";
import { MARKET_CATEGORIES, type MarketCategory } from "../../lib/shared/market-types";
import { fetchApiJson } from "../../utils/api";
import { createWalletAuthPayload, ensureWalletUnlocked } from "../../utils/wallet-guard";

interface PendingChainMarket {
  marketId: number;
  txSig: string;
  title: string;
  description: string;
  category: MarketCategory;
  resolutionTimestamp: string;
  resolutionSource: string;
  rules: string[];
}

export function useCreateMarket() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { connected, publicKey, sendTransaction } = wallet;
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<MarketCategory>("Crypto");
  const [resolutionDate, setResolutionDate] = useState("");
  const [resolutionSource, setResolutionSource] = useState("");
  const [rulesInput, setRulesInput] = useState("");
  const [step, setStep] = useState<
    "idle" | "creating_chain" | "mirroring" | "done" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingChainMarket, setPendingChainMarket] = useState<PendingChainMarket | null>(null);

  const chainCreateEnabled = Boolean(MARKET_TOKEN_MINT);
  const parsedRules = rulesInput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
  const hasMinimumRules = parsedRules.length >= 2;
  const hasFallbackRule = parsedRules.some((rule) =>
    /(fallback|secondary|backup)/i.test(rule)
  );

  async function mirrorMarket(target?: PendingChainMarket) {
    const auth = await createWalletAuthPayload(wallet, "markets:create");
    const resolutionTimestamp =
      target?.resolutionTimestamp ?? new Date(`${resolutionDate}T00:00:00.000Z`).toISOString();
    const payloadRules = target?.rules ?? parsedRules;

    const { response, payload } = await fetchApiJson<{
      market?: { id?: number };
      error?: string;
    }>("/api/markets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: target?.title ?? title,
        description: target?.description ?? description,
        category: target?.category ?? category,
        resolutionTimestamp,
        resolutionSource: target?.resolutionSource ?? resolutionSource,
        rules: payloadRules,
        creatorWallet: publicKey?.toBase58(),
        auth,
        marketId: target?.marketId,
        txSig: target?.txSig,
      }),
    });

    if (!response.ok) {
      throw new Error(payload?.error ?? "Could not create market.");
    }

    setPendingChainMarket(null);
    return payload;
  }

  async function createOnChainMarket() {
    if (!publicKey || !sendTransaction) {
      throw new Error("Wallet is not ready to sign transactions.");
    }

    const resolutionTimestamp = new Date(`${resolutionDate}T00:00:00.000Z`);
    const { transaction, marketId } = await buildCreateMarketTransaction({
      connection,
      title,
      description,
      resolutionTimestamp,
      creator: publicKey,
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

    const createdMarket = {
      marketId,
      txSig,
      title,
      description,
      category,
      resolutionTimestamp: resolutionTimestamp.toISOString(),
      resolutionSource,
      rules: [...parsedRules],
    };
    setPendingChainMarket(createdMarket);
    return createdMarket;
  }

  async function handleCreate() {
    if (!pendingChainMarket && (!title || !description || !resolutionDate || !resolutionSource)) {
      return;
    }

    setError(null);
    if (!pendingChainMarket && !hasMinimumRules) {
      setError("Add at least 2 clear settlement rules before creating this market.");
      return;
    }

    let confirmedChainMarket = pendingChainMarket;
    try {
      await ensureWalletUnlocked(wallet, "create a market");
      let target = pendingChainMarket;
      if (!target && chainCreateEnabled) {
        setStep("creating_chain");
        target = await createOnChainMarket();
        confirmedChainMarket = target;
      }

      setStep("mirroring");
      const payload = await mirrorMarket(target);

      setStep("done");
      const marketId = payload?.market?.id;
      setTimeout(() => {
        router.push(typeof marketId === "number" ? `/market/${marketId}` : "/");
      }, 1200);
    } catch (caught) {
      const baseMessage = caught instanceof Error ? caught.message : "Unknown error";
      const message = confirmedChainMarket
        ? `On-chain market ${confirmedChainMarket.marketId} was created, but backend mirroring failed: ${baseMessage}`
        : baseMessage;
      setError(message);
      setStep("error");
    }
  }

  const canSubmit =
    Boolean(pendingChainMarket) ||
    (title.trim().length > 0 &&
      description.trim().length > 0 &&
      resolutionDate.trim().length > 0 &&
      resolutionSource.trim().length > 0 &&
      hasMinimumRules);

  return {
    MARKET_CATEGORIES,
    MARKET_TOKEN_SYMBOL,
    category,
    canSubmit,
    chainCreateEnabled,
    connected,
    description,
    error,
    handleCreate,
    hasFallbackRule,
    hasMinimumRules,
    parsedRules,
    pendingChainMarket,
    resolutionDate,
    resolutionSource,
    rulesInput,
    setCategory,
    setDescription,
    setResolutionDate,
    setResolutionSource,
    setRulesInput,
    setTitle,
    step,
    title,
  };
}
