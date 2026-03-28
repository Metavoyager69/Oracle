import React, { useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Navbar from "../../components/Navbar";
import { buildCreateMarketTransaction } from "../../utils/anchor-client";
import {
  MARKET_CATEGORIES,
  MARKET_TOKEN_MINT,
  MARKET_TOKEN_SYMBOL,
  type MarketCategory,
} from "../../utils/program";
import { createWalletAuthPayload, ensureWalletUnlocked } from "../../utils/wallet-guard";

// This form gathers the off-chain metadata that both the backend store and the
// future on-chain market account need. Mainnet should keep the UX here while
// making chain confirmation, not local store writes, the final success signal.
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

export default function CreateMarket() {
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

  // Parse plain-text rules into a clean bounded list.
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

    const response = await fetch("/api/markets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: target?.title ?? title,
        description: target?.description ?? description,
        category: target?.category ?? category,
        // Normalize to an ISO timestamp before sending so the server persists
        // one canonical settlement time regardless of browser locale.
        resolutionTimestamp,
        resolutionSource: target?.resolutionSource ?? resolutionSource,
        rules: payloadRules,
        creatorWallet: publicKey?.toBase58(),
        auth,
        marketId: target?.marketId,
        txSig: target?.txSig,
      }),
    });

    const payload = await response.json();
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
      // Nontechnical requirement: every market must include clear, testable rules.
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

  return (
    <>
      <Head>
        <title>Create Market | Oracle</title>
      </Head>
      <Navbar />

      <main className="pink-grid-bg" style={{ minHeight: "100vh", paddingTop: "72px" }}>
        <div className="mx-auto max-w-2xl px-6 py-12">
          <button
            onClick={() => router.push("/")}
            className="mb-8 flex items-center gap-2 font-mono text-xs text-slate-500 transition-colors hover:text-white"
          >
            {"<"} BACK
          </button>

          <h1 className="mb-2 font-display text-4xl tracking-widest text-white">CREATE MARKET</h1>
          <p className="mb-8 font-mono text-xs tracking-widest text-slate-400">
            PRIVATE RESOLUTION CRITERIA WITH ARCIUM MPC
          </p>

          {!connected ? (
            <div className="card p-10 text-center">
              <p className="mb-4 font-body text-slate-400">Connect wallet to create a market.</p>
              <WalletMultiButton
                style={{
                  background: "linear-gradient(135deg, #6B3FA0, #9B6FD0)",
                  borderRadius: "8px",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "12px",
                }}
              />
            </div>
          ) : step === "done" ? (
            <div className="card p-10 text-center">
              <p className="font-mono text-sm text-emerald-400">MARKET CREATED</p>
              <p className="mt-2 text-sm text-slate-400">Redirecting to market page...</p>
            </div>
          ) : (
            <div className="card flex flex-col gap-5 p-6">
              <div>
                <label className="mb-2 block font-mono text-xs text-slate-500">QUESTION / TITLE</label>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Will BTC exceed $150k before Jan 2027?"
                  maxLength={128}
                  className="w-full bg-transparent px-4 py-3 font-body text-sm text-white outline-none"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "8px",
                  }}
                />
                <p className="mt-1 font-mono text-xs text-slate-600">{title.length}/128</p>
              </div>

              <div>
                <label className="mb-2 block font-mono text-xs text-slate-500">CATEGORY</label>
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value as MarketCategory)}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-mono text-sm text-white outline-none"
                >
                  {MARKET_CATEGORIES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block font-mono text-xs text-slate-500">RESOLUTION CRITERIA</label>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Describe exact resolve conditions for YES and NO."
                  rows={4}
                  maxLength={512}
                  className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-body text-sm text-white outline-none"
                />
                <p className="mt-1 font-mono text-xs text-slate-600">{description.length}/512</p>
              </div>

              <div>
                <label className="mb-2 block font-mono text-xs text-slate-500">RESOLUTION SOURCE</label>
                <input
                  value={resolutionSource}
                  onChange={(event) => setResolutionSource(event.target.value)}
                  maxLength={160}
                  placeholder="Data source, e.g. Binance API, Senate roll call, EPL final table"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-body text-sm text-white outline-none"
                />
              </div>

              <div>
                <label className="mb-2 block font-mono text-xs text-slate-500">RULES (REQUIRED)</label>
                <textarea
                  value={rulesInput}
                  onChange={(event) => setRulesInput(event.target.value)}
                  placeholder="One enforceable settlement rule per line."
                  rows={4}
                  className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-body text-sm text-white outline-none"
                />
                <p className="mt-1 font-mono text-xs text-slate-500">
                  {parsedRules.length}/8 rules. Minimum 2 required.
                </p>
                <div className="mt-2 space-y-1">
                  <p className="font-mono text-[11px] text-slate-500">
                    {hasMinimumRules ? "PASS" : "MISSING"}: minimum rule count
                  </p>
                  <p className="font-mono text-[11px] text-slate-500">
                    {hasFallbackRule ? "PASS" : "RECOMMENDED"}: fallback source rule
                  </p>
                </div>
                {parsedRules.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {parsedRules.map((rule, index) => (
                      <li key={`${index}-${rule}`} className="font-mono text-[11px] text-slate-400">
                        {index + 1}. {rule}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div>
                <label className="mb-2 block font-mono text-xs text-slate-500">RESOLUTION DATE</label>
                <input
                  type="date"
                  value={resolutionDate}
                  onChange={(event) => setResolutionDate(event.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-mono text-sm text-white outline-none"
                  style={{ colorScheme: "dark" }}
                />
              </div>

              <div
                className="rounded-lg p-4"
                style={{
                  background: "rgba(107,63,160,0.1)",
                  border: "1px solid rgba(107,63,160,0.2)",
                }}
              >
                <p className="font-mono text-xs leading-relaxed text-slate-400">
                  {chainCreateEnabled
                    ? `This cluster is configured for chain-backed market creation. New markets are created on Solana first, then mirrored into the backend. Trading uses the configured ${MARKET_TOKEN_SYMBOL} mint.`
                    : "Chain-backed create is disabled until NEXT_PUBLIC_MARKET_TOKEN_MINT is configured. The page will fall back to backend-only prototype creation."}
                </p>
              </div>

              {pendingChainMarket ? (
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-4">
                  <p className="font-mono text-xs leading-relaxed text-amber-200">
                    On-chain market {pendingChainMarket.marketId} is already confirmed with tx{" "}
                    {pendingChainMarket.txSig.slice(0, 18)}... Click create again to retry only
                    the backend mirror step.
                  </p>
                </div>
              ) : null}

              {error ? <p className="font-mono text-xs text-rose-400">{error}</p> : null}

              <button
                onClick={handleCreate}
                disabled={!canSubmit || step === "creating_chain" || step === "mirroring"}
                className="btn-primary"
                style={{ opacity: !canSubmit ? 0.5 : 1 }}
              >
                {step === "creating_chain" && "CREATING ON-CHAIN..."}
                {step === "mirroring" && "SYNCING BACKEND..."}
                {(step === "idle" || step === "error") && "CREATE MARKET"}
              </button>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
