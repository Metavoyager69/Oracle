import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { format } from "date-fns";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Navbar from "../components/Navbar";
import {
  calculatePositionPnl,
  getPortfolioSummary,
  type DemoPosition,
} from "../utils/program";
import { deserializePosition, type ApiPosition } from "../utils/api";
import { createWalletAuthPayload } from "../utils/wallet-guard";

// Portfolio is intentionally wallet-scoped and backend-driven. That is the
// correct shape for mainnet because encrypted positions should never leak
// through public market discovery endpoints.
function formatSigned(value: number): string {
  const rounded = Math.abs(value).toFixed(2);
  return `${value >= 0 ? "+" : "-"}${rounded} SOL`;
}

export default function PortfolioPage() {
  const { connected, publicKey, signMessage } = useWallet();
  const walletAddress = publicKey?.toBase58();

  const [positions, setPositions] = useState<DemoPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || !walletAddress) {
      setPositions([]);
      setLoading(false);
      setLoadError(null);
      return;
    }

    let cancelled = false;

    async function loadPortfolio() {
      setLoading(true);
      setLoadError(null);

      try {
        // Frontend signs an action-specific auth payload so the backend can
        // safely return private history for one wallet only.
        const auth = await createWalletAuthPayload({ connected, publicKey, signMessage }, "portfolio:view");
        const authParam = encodeURIComponent(JSON.stringify(auth));
        const response = await fetch(
          `/api/portfolio?wallet=${encodeURIComponent(walletAddress)}&auth=${authParam}`
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error ?? "Could not load portfolio.");
        }

        const items = Array.isArray(payload?.positions)
          ? (payload.positions as ApiPosition[]).map((item) => deserializePosition(item))
          : [];

        if (!cancelled) {
          setPositions(items);
        }
      } catch (caught) {
        if (!cancelled) {
          const message = caught instanceof Error ? caught.message : "Unknown API error.";
          setLoadError(message);
          setPositions([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadPortfolio();
    return () => {
      cancelled = true;
    };
  }, [connected, publicKey, signMessage, walletAddress]);

  const summary = useMemo(() => getPortfolioSummary(positions), [positions]);
  const hasEncrypted = useMemo(
    () => positions.some((position) => position.visibility === "encrypted"),
    [positions]
  );
  const sorted = useMemo(
    () =>
      [...positions].sort(
        (left, right) => right.submittedAt.getTime() - left.submittedAt.getTime()
      ),
    [positions]
  );

  return (
    <>
      <Head>
        <title>Portfolio | Oracle</title>
      </Head>
      <Navbar />
      <main className="pink-grid-bg" style={{ minHeight: "100vh", paddingTop: "72px" }}>
        <div className="mx-auto max-w-6xl px-6 py-12">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="font-display text-4xl tracking-widest text-white">PORTFOLIO</h1>
              <p className="font-mono text-xs tracking-wider text-slate-500">
                PNL, position history, and settlement outcomes
              </p>
            </div>
            <Link href="/" className="btn-secondary">
              BACK TO MARKETS
            </Link>
          </div>

          {!connected ? (
            <div className="card p-10 text-center">
              <p className="mb-4 font-body text-slate-400">
                Connect wallet to view your portfolio data.
              </p>
              <WalletMultiButton />
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between">
                {loading ? (
                  <p className="font-mono text-xs text-slate-500">Loading portfolio from backend...</p>
                ) : loadError ? (
                  <p className="font-mono text-xs text-amber-300">{loadError}</p>
                ) : (
                  <p className="font-mono text-xs text-emerald-300">
                    Wallet-scoped portfolio loaded
                  </p>
                )}
              </div>
              {hasEncrypted ? (
                <p className="mb-4 font-mono text-xs text-slate-500">
                  Encrypted positions are redacted until settlement.
                </p>
              ) : null}

              <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <div className="card p-5">
                  <p className="font-mono text-xs text-slate-500">TOTAL STAKED</p>
                  <p className="mt-2 font-mono text-xl text-white">
                    {summary.totalStaked.toFixed(2)} SOL
                  </p>
                </div>
                <div className="card p-5">
                  <p className="font-mono text-xs text-slate-500">REALIZED</p>
                  <p
                    className="mt-2 font-mono text-xl"
                    style={{ color: summary.realizedPnl >= 0 ? "#34D399" : "#F87171" }}
                  >
                    {formatSigned(summary.realizedPnl)}
                  </p>
                </div>
                <div className="card p-5">
                  <p className="font-mono text-xs text-slate-500">UNREALIZED</p>
                  <p
                    className="mt-2 font-mono text-xl"
                    style={{ color: summary.unrealizedPnl >= 0 ? "#34D399" : "#F87171" }}
                  >
                    {formatSigned(summary.unrealizedPnl)}
                  </p>
                </div>
                <div className="card p-5">
                  <p className="font-mono text-xs text-slate-500">SETTLED</p>
                  <p className="mt-2 font-mono text-xl text-white">{summary.settledCount}</p>
                </div>
                <div className="card p-5">
                  <p className="font-mono text-xs text-slate-500">WIN RATE</p>
                  <p className="mt-2 font-mono text-xl text-white">{summary.winRate.toFixed(1)}%</p>
                </div>
              </div>

              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <div
                    className="grid px-4 py-3 font-mono text-xs tracking-wider text-slate-500"
                    style={{
                      gridTemplateColumns: "1.5fr 0.6fr 0.6fr 0.7fr 0.8fr 0.9fr 0.8fr",
                      borderBottom: "1px solid rgba(255,255,255,0.06)",
                      minWidth: "900px",
                    }}
                  >
                    <span>MARKET</span>
                    <span>SIDE</span>
                    <span>STAKE</span>
                    <span>ENTRY</span>
                    <span>MARK</span>
                    <span>SUBMITTED</span>
                    <span>PNL</span>
                  </div>
                  {sorted.map((position) => {
                    const isEncrypted = position.visibility === "encrypted";
                    const pnl = calculatePositionPnl(position);
                    return (
                      <Link
                        key={position.id}
                        href={`/market/${position.marketId}`}
                        className="grid px-4 py-3 text-sm no-underline transition-colors hover:bg-white/5"
                        style={{
                          gridTemplateColumns: "1.5fr 0.6fr 0.6fr 0.7fr 0.8fr 0.9fr 0.8fr",
                          borderBottom: "1px solid rgba(255,255,255,0.04)",
                          minWidth: "900px",
                        }}
                      >
                        <span className="text-slate-200">{position.marketTitle}</span>
                        <span
                          className="font-mono"
                          style={{
                            color: isEncrypted
                              ? "#94A3B8"
                              : position.side === "YES"
                                ? "#34D399"
                                : "#F87171",
                          }}
                        >
                          {isEncrypted ? "ENCRYPTED" : position.side}
                        </span>
                        <span className="font-mono text-slate-300">
                          {isEncrypted ? "PRIVATE" : `${position.stakeSol?.toFixed(2)} SOL`}
                        </span>
                        <span className="font-mono text-slate-300">
                          {isEncrypted ? "—" : `${((position.entryOdds ?? 0) * 100).toFixed(1)}%`}
                        </span>
                        <span className="font-mono text-slate-300">
                          {isEncrypted ? "—" : `${((position.markOdds ?? 0) * 100).toFixed(1)}%`}
                        </span>
                        <span className="font-mono text-slate-300">
                          {format(position.submittedAt, "MMM d, yyyy")}
                        </span>
                        <span
                          className="font-mono"
                          style={{ color: isEncrypted ? "#94A3B8" : pnl >= 0 ? "#34D399" : "#F87171" }}
                        >
                          {isEncrypted ? "—" : formatSigned(pnl)}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
