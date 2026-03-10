import React, { useCallback, useEffect, useMemo, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { format, formatDistanceToNow } from "date-fns";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Navbar from "../../components/Navbar";
import {
  CATEGORY_STYLES,
  DEMO_MARKETS,
  calculatePositionPnl,
  type DemoMarket,
  type DemoPosition,
} from "../../utils/program";
import {
  ARCIUM_DEVNET_CLUSTER,
  encryptChoice,
  encryptStake,
  fetchClusterPublicKey,
  serializeCiphertext,
} from "../../utils/arcium";
import {
  deserializeActivityRecord,
  deserializeMarket,
  deserializePosition,
  deserializeProbabilityPoint,
  deserializeSettlementDispute,
  type ApiMarket,
  type ApiMarketActivityRecord,
  type ApiPosition,
  type ApiProbabilityHistoryPoint,
  type ApiSettlementDisputeRecord,
  type MarketActivityRecord,
  type ProbabilityHistoryPoint,
  type SettlementDisputeRecord,
} from "../../utils/api";
import { ensureWalletUnlocked } from "../../utils/wallet-guard";

// Market detail page: combines trading UI, privacy-safe activity, and dispute actions.
type StepState = "idle" | "encrypting" | "submitting" | "confirmed" | "error";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function formatSigned(value: number): string {
  const rounded = Math.abs(value).toFixed(2);
  return `${value >= 0 ? "+" : "-"}${rounded} SOL`;
}

function activityLabel(type: string): string {
  const labels: Record<string, string> = {
    MARKET_CREATED: "Market created",
    POSITION_SUBMITTED: "Position submitted",
    DISPUTE_OPENED: "Dispute opened",
    DISPUTE_EVIDENCE_ADDED: "Evidence added",
    DISPUTE_RESOLVED: "Dispute resolved",
    DISPUTE_SLASHED: "Resolver slashed",
    MARKET_STATUS_CHANGED: "Status changed",
  };
  return labels[type] ?? type;
}

function ProbabilityChart({ points }: { points: ProbabilityHistoryPoint[] }) {
  if (points.length < 2) {
    return <p className="font-mono text-xs text-slate-500">Not enough data points yet.</p>;
  }

  const width = 560;
  const height = 200;
  const padding = 16;
  const xStep = (width - padding * 2) / (points.length - 1);

  const yesPath = points
    .map((point, index) => {
      const x = padding + index * xStep;
      const y = padding + ((100 - point.yesProbability) / 100) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const noPath = points
    .map((point, index) => {
      const x = padding + index * xStep;
      const y = padding + ((100 - point.noProbability) / 100) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const latest = points[points.length - 1];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-xs text-emerald-300">YES {latest.yesProbability.toFixed(1)}%</p>
        <p className="font-mono text-xs text-rose-300">NO {latest.noProbability.toFixed(1)}%</p>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: "220px", borderRadius: "8px", background: "rgba(255,255,255,0.03)" }}
      >
        <path d={yesPath} stroke="#34D399" fill="none" strokeWidth="2.5" />
        <path d={noPath} stroke="#F87171" fill="none" strokeWidth="2.5" />
      </svg>
      <div className="mt-3 flex justify-between font-mono text-xs text-slate-500">
        <span>{format(points[0].timestamp, "MMM d, HH:mm")}</span>
        <span>{format(points[points.length - 1].timestamp, "MMM d, HH:mm")}</span>
      </div>
    </div>
  );
}

export default function MarketPage() {
  const router = useRouter();
  const wallet = useWallet();
  const { connected, publicKey } = wallet;
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);
  const [stakeInput, setStakeInput] = useState("");
  const [step, setStep] = useState<StepState>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [encryptedPreview, setEncryptedPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState<DemoMarket | null>(null);
  const [history, setHistory] = useState<DemoPosition[]>([]);
  const [probabilityHistory, setProbabilityHistory] = useState<ProbabilityHistoryPoint[]>([]);
  const [activity, setActivity] = useState<MarketActivityRecord[]>([]);
  const [disputes, setDisputes] = useState<SettlementDisputeRecord[]>([]);
  const [disputeReason, setDisputeReason] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [evidenceUri, setEvidenceUri] = useState("");
  const [evidenceSourceType, setEvidenceSourceType] = useState<
    "OfficialRecord" | "MarketDataAPI" | "NewsArticle" | "OnChainEvent" | "Other"
  >("Other");
  const [disputeError, setDisputeError] = useState<string | null>(null);
  const [historyScope, setHistoryScope] = useState<"wallet" | "wallet_required">("wallet_required");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const marketId = useMemo(() => {
    if (typeof router.query.id !== "string") return Number.NaN;
    return Number.parseInt(router.query.id, 10);
  }, [router.query.id]);

  const fetchMarketData = useCallback(async () => {
    if (!router.isReady || Number.isNaN(marketId)) return;

    setLoading(true);
    setLoadError(null);

    try {
      const wallet = publicKey?.toBase58();
      const suffix = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
      const response = await fetch(`/api/markets/${marketId}${suffix}`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not load market.");
      }

      const marketItem = payload?.market as ApiMarket;
      const historyItems = Array.isArray(payload?.history)
        ? (payload.history as ApiPosition[]).map((item) => deserializePosition(item))
        : [];
      const probabilityItems = Array.isArray(payload?.probabilityHistory)
        ? (payload.probabilityHistory as ApiProbabilityHistoryPoint[]).map((item) =>
            deserializeProbabilityPoint(item)
          )
        : [];
      const activityItems = Array.isArray(payload?.activity)
        ? (payload.activity as ApiMarketActivityRecord[]).map((item) =>
            deserializeActivityRecord(item)
          )
        : [];
      const disputeItems = Array.isArray(payload?.disputes)
        ? (payload.disputes as ApiSettlementDisputeRecord[]).map((item) =>
            deserializeSettlementDispute(item)
          )
        : [];
      const fetchedHistoryScope = payload?.historyScope === "wallet" ? "wallet" : "wallet_required";

      setMarket(deserializeMarket(marketItem));
      setHistory(historyItems);
      // Server decides whether this user may view history (wallet-scoped only).
      setHistoryScope(fetchedHistoryScope);
      setProbabilityHistory(probabilityItems);
      setActivity(activityItems);
      setDisputes(disputeItems);
    } catch (caught) {
      const fallbackMarket = DEMO_MARKETS.find((item) => item.id === marketId) ?? null;
      setMarket(fallbackMarket);
      setHistory([]);
      setHistoryScope("wallet_required");
      setProbabilityHistory([]);
      setActivity([]);
      setDisputes([]);
      const message = caught instanceof Error ? caught.message : "Unknown API error.";
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [marketId, publicKey, router.isReady]);

  useEffect(() => {
    fetchMarketData();
  }, [fetchMarketData]);

  async function handleSubmit() {
    if (!market || !choice || !connected) return;
    const stakeSOL = Number.parseFloat(stakeInput);
    if (Number.isNaN(stakeSOL) || stakeSOL <= 0) return;

    setError(null);

    try {
      await ensureWalletUnlocked(wallet, "submit an encrypted position");
      setStep("encrypting");

      const clusterKey = await fetchClusterPublicKey(ARCIUM_DEVNET_CLUSTER);
      const stakeLamports = BigInt(Math.floor(stakeSOL * 1e9));
      const encStake = encryptStake(stakeLamports, clusterKey);
      const encChoice = encryptChoice(choice === "yes", clusterKey);
      const preview = `stake:0x${toHex(encStake.c1.slice(0, 8))}... choice:0x${toHex(
        encChoice.c1.slice(0, 4)
      )}...`;
      setEncryptedPreview(preview);

      setStep("submitting");

      const response = await fetch("/api/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: market.id,
          side: choice.toUpperCase(),
          stakeSol: stakeSOL,
          wallet: publicKey?.toBase58(),
          encryptedStake: serializeCiphertext(encStake),
          encryptedChoice: serializeCiphertext(encChoice),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not submit encrypted position.");
      }

      setTxSig(typeof payload?.txSig === "string" ? payload.txSig : null);
      setStep("confirmed");
      await fetchMarketData();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unknown error";
      setError(message);
      setStep("error");
    }
  }

  async function handleOpenDispute() {
    if (!market || !connected || !publicKey) return;
    if (!disputeReason.trim()) return;

    setDisputeError(null);

    try {
      await ensureWalletUnlocked(wallet, "open a dispute");
      const sourceDomain = evidenceUri
        ? (() => {
            try {
              return new URL(evidenceUri).hostname;
            } catch {
              return undefined;
            }
          })()
        : undefined;
      const response = await fetch(`/api/markets/${market.id}/disputes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          reason: disputeReason,
          evidenceSummary: evidenceSummary,
          evidenceUri: evidenceUri || undefined,
          evidenceSourceType,
          evidenceSourceDomain: sourceDomain,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not open dispute.");
      }
      setDisputeReason("");
      setEvidenceSummary("");
      setEvidenceUri("");
      setEvidenceSourceType("Other");
      await fetchMarketData();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unknown dispute error.";
      setDisputeError(message);
    }
  }

  async function handleResolveDispute(disputeId: string, outcome: "MarketInvalid" | "SettlementUpheld") {
    if (!connected || !publicKey) return;
    try {
      await ensureWalletUnlocked(wallet, "resolve a dispute");
      const response = await fetch(`/api/disputes/${disputeId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          outcome,
          invalidReasonCode:
            outcome === "MarketInvalid" ? "ORACLE_DATA_MISMATCH" : undefined,
          slashBps: outcome === "MarketInvalid" ? 500 : undefined,
          resolutionNote:
            outcome === "MarketInvalid"
              ? "Invalid criteria confirmed by challenger evidence."
              : "Settlement evidence is sufficient and upheld.",
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Could not resolve dispute.");
      }
      await fetchMarketData();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unknown dispute error.";
      setDisputeError(message);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center font-mono text-slate-500">
        Loading market...
      </div>
    );
  }

  if (!market) {
    return (
      <div className="flex min-h-screen items-center justify-center font-mono text-slate-500">
        Market not found.
      </div>
    );
  }

  const isOpen = market.status === "Open";
  const isSettled = market.status === "Settled";
  const categoryStyle = CATEGORY_STYLES[market.category];
  const total = (market.revealedYesStake ?? 0) + (market.revealedNoStake ?? 0);
  const yesP = total === 0 ? 50 : Math.round(((market.revealedYesStake ?? 0) / total) * 100);
  const noP = 100 - yesP;

  return (
    <>
      <Head>
        <title>{market.title} | Oracle</title>
      </Head>
      <Navbar />

      <main className="pink-grid-bg" style={{ minHeight: "100vh", paddingTop: "72px" }}>
        <div className="mx-auto grid max-w-6xl gap-6 px-6 py-12 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <button
              onClick={() => router.push("/")}
              className="mb-8 flex items-center gap-2 font-mono text-xs text-slate-500 transition-colors hover:text-white"
            >
              {"<"} ALL MARKETS
            </button>

            {loadError ? (
              <p className="mb-4 font-mono text-xs text-amber-300">
                Backend unavailable, showing fallback data: {loadError}
              </p>
            ) : null}

            <div className="card mb-6 p-6">
              <div className="mb-4 flex items-start justify-between gap-4">
                <h1 className="flex-1 text-xl font-medium leading-snug text-white">{market.title}</h1>
                <div className="flex flex-shrink-0 flex-col items-end gap-2">
                  <div
                    className="font-mono text-xs"
                    style={{
                      background: categoryStyle.bg,
                      border: `1px solid ${categoryStyle.border}`,
                      borderRadius: "999px",
                      color: categoryStyle.text,
                      padding: "4px 10px",
                    }}
                  >
                    {market.category.toUpperCase()}
                  </div>
                  <div className="encrypted-tag">{market.status.toUpperCase()}</div>
                </div>
              </div>
              <p className="mb-4 text-sm leading-relaxed text-slate-400">{market.description}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="font-mono text-xs text-slate-500">RESOLUTION DATE</p>
                  <p className="font-mono text-sm text-white">{format(market.resolutionTimestamp, "PPP p")}</p>
                </div>
                <div>
                  <p className="font-mono text-xs text-slate-500">RESOLUTION SOURCE</p>
                  <p className="font-mono text-sm text-cyan-300">{market.resolutionSource}</p>
                </div>
              </div>
            </div>

            <div className="card mb-6 p-6">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-mono text-xs tracking-widest text-violet-300">PRICE / PROBABILITY HISTORY</h2>
                <p className="font-mono text-xs text-slate-500">
                  {probabilityHistory.length} point{probabilityHistory.length === 1 ? "" : "s"}
                </p>
              </div>
              <ProbabilityChart points={probabilityHistory} />
            </div>

            <div className="card mb-6 p-6">
              <h2 className="mb-4 font-mono text-xs tracking-widest text-violet-300">MARKET ACTIVITY FEED</h2>
              <div className="space-y-3">
                {activity.length === 0 ? (
                  <p className="font-mono text-xs text-slate-500">No indexed activity yet.</p>
                ) : (
                  activity.slice(0, 10).map((event) => (
                    <div
                      key={event.id}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-mono text-xs text-cyan-300">{activityLabel(event.type)}</p>
                        <p className="font-mono text-xs text-slate-500">
                          {formatDistanceToNow(event.timestamp, { addSuffix: true })}
                        </p>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{event.details}</p>
                      <p className="mt-1 font-mono text-[10px] text-slate-500">slot {event.slot}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="card mb-6 p-6">
              <h2 className="mb-4 font-mono text-xs tracking-widest text-violet-300">RESOLUTION TIMELINE</h2>
              <div className="space-y-4">
                {market.timeline.map((timelineStep) => (
                  <div key={timelineStep.id} className="flex items-start gap-3">
                    <span
                      className="mt-1 inline-block h-2.5 w-2.5 rounded-full"
                      style={{
                        background:
                          timelineStep.status === "completed"
                            ? "#34D399"
                            : timelineStep.status === "active"
                              ? "#C084FC"
                              : "#64748B",
                      }}
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-mono text-xs tracking-wider text-white">
                          {timelineStep.label.toUpperCase()}
                        </p>
                        <p className="font-mono text-xs text-slate-500">
                          {format(timelineStep.timestamp, "MMM d, yyyy")}
                        </p>
                      </div>
                      <p className="mt-1 text-sm text-slate-400">{timelineStep.note}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card mb-6 p-6">
              <h2 className="mb-4 font-mono text-xs tracking-widest text-violet-300">CLEAR RULES</h2>
              <ul className="space-y-2 text-sm text-slate-300">
                {market.rules.map((rule, index) => (
                  <li key={`${market.id}-rule-${index}`} className="flex gap-2">
                    <span className="font-mono text-cyan-300">{index + 1}.</span>
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="card p-6">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-mono text-xs tracking-widest text-violet-300">POSITION HISTORY</h2>
                <Link href="/portfolio" className="font-mono text-xs text-cyan-400">
                  VIEW ALL
                </Link>
              </div>
              {!connected || historyScope !== "wallet" ? (
                <p className="font-mono text-xs text-slate-500">
                  Connect wallet to view your private position history for this market.
                </p>
              ) : history.length === 0 ? (
                <p className="font-mono text-xs text-slate-500">
                  No wallet-scoped positions in this market yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {history.map((position) => {
                    const pnl = calculatePositionPnl(position);
                    return (
                      <div
                        key={position.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="font-mono text-xs"
                            style={{ color: position.side === "YES" ? "#34D399" : "#F87171" }}
                          >
                            {position.side}
                          </span>
                          <span className="font-mono text-xs text-slate-300">
                            {position.stakeSol.toFixed(2)} SOL
                          </span>
                          <span className="font-mono text-xs text-slate-500">
                            {format(position.submittedAt, "MMM d, yyyy")}
                          </span>
                        </div>
                        <span className="font-mono text-xs" style={{ color: pnl >= 0 ? "#34D399" : "#F87171" }}>
                          {formatSigned(pnl)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div>
            {isSettled ? (
              <div className="card mb-6 p-6">
                <p className="mb-3 font-mono text-xs text-slate-500">FINAL RESULT</p>
                <div className="mb-2 flex justify-between">
                  <span className="font-mono text-sm text-emerald-400">YES {yesP}%</span>
                  <span className="font-mono text-sm text-rose-400">NO {noP}%</span>
                </div>
                <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
                  <div style={{ width: `${yesP}%`, background: "linear-gradient(90deg,#34D399,#059669)" }} />
                  <div style={{ width: `${noP}%`, background: "linear-gradient(90deg,#F87171,#DC2626)" }} />
                </div>
              </div>
            ) : null}

            <div className="card mb-6 p-6">
              <h2 className="mb-4 font-mono text-sm tracking-widest text-violet-300">SETTLEMENT DISPUTES</h2>
              {!connected ? (
                <div className="py-6 text-center">
                  <p className="mb-4 text-sm text-slate-400">
                    Connect wallet to open disputes and submit evidence.
                  </p>
                  <WalletMultiButton />
                </div>
              ) : (
                <>
                  <textarea
                    value={disputeReason}
                    onChange={(event) => setDisputeReason(event.target.value)}
                    placeholder="Explain why this market should be challenged or invalidated."
                    rows={3}
                    className="mb-3 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
                  />
                  <input
                    value={evidenceSummary}
                    onChange={(event) => setEvidenceSummary(event.target.value)}
                    placeholder="Evidence summary (optional)"
                    className="mb-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
                  />
                  <input
                    value={evidenceUri}
                    onChange={(event) => setEvidenceUri(event.target.value)}
                    placeholder="Evidence URI (https://...)"
                    className="mb-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
                  />
                  <select
                    value={evidenceSourceType}
                    onChange={(event) =>
                      setEvidenceSourceType(
                        event.target.value as
                          | "OfficialRecord"
                          | "MarketDataAPI"
                          | "NewsArticle"
                          | "OnChainEvent"
                          | "Other"
                      )
                    }
                    className="mb-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
                  >
                    <option value="Other">Other evidence source</option>
                    <option value="OfficialRecord">Official record</option>
                    <option value="MarketDataAPI">Market data API</option>
                    <option value="NewsArticle">News article</option>
                    <option value="OnChainEvent">On-chain event</option>
                  </select>
                  {disputeError ? <p className="mb-3 font-mono text-xs text-rose-300">{disputeError}</p> : null}
                  <button onClick={handleOpenDispute} className="btn-secondary w-full">
                    OPEN DISPUTE
                  </button>
                </>
              )}

              <div className="mt-5 space-y-3">
                {disputes.length === 0 ? (
                  <p className="font-mono text-xs text-slate-500">No disputes yet.</p>
                ) : (
                  disputes.slice(0, 6).map((dispute) => (
                    <div key={dispute.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
                      <div className="mb-1 flex items-center justify-between">
                        <p className="font-mono text-xs text-cyan-300">{dispute.status.toUpperCase()}</p>
                        <p className="font-mono text-xs text-slate-500">
                          {formatDistanceToNow(dispute.createdAt, { addSuffix: true })}
                        </p>
                      </div>
                      <p className="text-xs text-slate-300">{dispute.reason}</p>
                      <p className="mt-1 font-mono text-[10px] text-slate-500">
                        {dispute.evidence.length} evidence item{dispute.evidence.length === 1 ? "" : "s"}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-slate-500">
                        Verified{" "}
                        {dispute.evidence.filter((item) => item.verificationStatus === "Verified").length} /
                        {dispute.evidence.length}
                      </p>
                      {dispute.evidence[0]?.evidenceHash ? (
                        <p className="mt-1 font-mono text-[10px] text-slate-500">
                          Evidence hash: {dispute.evidence[0].evidenceHash.slice(0, 14)}...
                        </p>
                      ) : null}
                      {dispute.challengeWindow ? (
                        <p className="mt-1 font-mono text-[10px] text-slate-500">
                          Challenge deadline: {format(dispute.challengeWindow.deadlineAt, "MMM d, HH:mm")}
                        </p>
                      ) : null}
                      {dispute.invalidResolution ? (
                        <p className="mt-1 font-mono text-[10px] text-amber-300">
                          Invalid path: {dispute.invalidResolution.reasonCode}
                        </p>
                      ) : null}
                      {dispute.slashing ? (
                        <p className="mt-1 font-mono text-[10px] text-rose-300">
                          Slashed {dispute.slashing.slashAmountSol.toFixed(4)} SOL ({dispute.slashing.slashBps} bps)
                        </p>
                      ) : null}
                      {connected && dispute.status === "Open" ? (
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => handleResolveDispute(dispute.id, "MarketInvalid")}
                            className="rounded-md border border-amber-400/40 px-2 py-1 font-mono text-[10px] text-amber-300"
                          >
                            MARK INVALID
                          </button>
                          <button
                            onClick={() => handleResolveDispute(dispute.id, "SettlementUpheld")}
                            className="rounded-md border border-emerald-400/40 px-2 py-1 font-mono text-[10px] text-emerald-300"
                          >
                            UPHOLD
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            {isOpen ? (
              <div className="card p-6">
                <h2 className="mb-5 font-mono text-sm tracking-widest text-violet-300">
                  SUBMIT ENCRYPTED POSITION
                </h2>

                {!connected ? (
                  <div className="py-8 text-center">
                    <p className="mb-4 text-sm text-slate-400">
                      Connect your Solana wallet to submit a private position.
                    </p>
                    <WalletMultiButton />
                  </div>
                ) : step === "confirmed" ? (
                  <div className="py-8 text-center">
                    <p className="mb-2 font-mono text-sm text-emerald-400">
                      POSITION ENCRYPTED AND SUBMITTED
                    </p>
                    {txSig ? (
                      <a
                        href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-cyan-400"
                      >
                        View tx: {txSig.slice(0, 16)}...
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="mb-5">
                      <p className="mb-3 font-mono text-xs text-slate-500">YOUR PREDICTION</p>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setChoice("yes")}
                          data-side="yes"
                          data-selected={choice === "yes"}
                          className="prediction-choice"
                        >
                          <span>YES</span>
                          {choice === "yes" ? <span className="choice-indicator">SELECTED</span> : null}
                        </button>
                        <button
                          onClick={() => setChoice("no")}
                          data-side="no"
                          data-selected={choice === "no"}
                          className="prediction-choice"
                        >
                          <span>NO</span>
                          {choice === "no" ? <span className="choice-indicator">SELECTED</span> : null}
                        </button>
                      </div>
                    </div>

                    <div className="mb-5">
                      <p className="mb-2 font-mono text-xs text-slate-500">STAKE AMOUNT (SOL)</p>
                      <input
                        type="number"
                        min="0.001"
                        step="0.01"
                        value={stakeInput}
                        onChange={(event) => setStakeInput(event.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-mono text-sm text-white outline-none"
                        placeholder="0.10"
                      />
                    </div>

                    {encryptedPreview ? (
                      <p className="mb-4 font-mono text-xs text-violet-300">Ciphertext: {encryptedPreview}</p>
                    ) : null}
                    {error ? <p className="mb-4 font-mono text-xs text-rose-400">{error}</p> : null}

                    <button
                      onClick={handleSubmit}
                      disabled={!choice || !stakeInput || step === "encrypting" || step === "submitting"}
                      className="btn-primary w-full"
                    >
                      {step === "encrypting" && "ENCRYPTING..."}
                      {step === "submitting" && "SUBMITTING..."}
                      {(step === "idle" || step === "error") && "ENCRYPT AND SUBMIT"}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </main>
    </>
  );
}
