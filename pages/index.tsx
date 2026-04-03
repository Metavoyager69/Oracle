import React, { useEffect, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import Navbar from "../components/Navbar";
import MarketCard from "../components/MarketCard";
import { deserializeMarket, fetchApiJson, type ApiMarket } from "../utils/api";
import type { DemoMarket } from "../lib/shared/market-types";

type FilterMode = "all" | "open" | "settled";

const TICKER_ITEMS = [
  "STAKES ENCRYPTED - ARCIUM MPC",
  "VOTES HIDDEN UNTIL SETTLEMENT",
  "NO HERDING - NO MANIPULATION",
  "FAIR - PRIVATE - ON-CHAIN",
  "SOLANA x ARCIUM",
];

export default function Home() {
  const [filter, setFilter] = useState<FilterMode>("all");
  const [markets, setMarkets] = useState<DemoMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadMarkets() {
      setLoading(true);
      setLoadError(null);

      try {
        const { response, payload } = await fetchApiJson<{
          markets?: ApiMarket[];
          error?: string;
        }>("/api/markets");

        if (!response.ok) {
          throw new Error(payload?.error ?? "Could not load markets.");
        }

        const items = Array.isArray(payload?.markets)
          ? (payload.markets as ApiMarket[]).map((item) => deserializeMarket(item))
          : [];

        if (!cancelled) {
          setMarkets(items);
        }
      } catch (caught) {
        if (!cancelled) {
          const message = caught instanceof Error ? caught.message : "Unknown API error.";
          setLoadError(message);
          setMarkets([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadMarkets();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredMarkets = markets.filter((market) => {
    if (filter === "open") return market.status === "Open";
    if (filter === "settled") return market.status === "Settled";
    return true;
  });

  const totalParticipants = markets.reduce(
    (sum, market) => sum + (market.totalParticipants ?? 0),
    0
  );
  const openMarkets = markets.filter((market) => market.status === "Open").length;

  return (
    <>
      <Head>
        <title>Oracle | Private Prediction Markets on Solana</title>
        <meta
          name="description"
          content="Prediction markets where stakes and votes stay encrypted until settlement, powered by Arcium MPC on Solana."
        />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <Navbar />

      <main style={{ minHeight: "100vh", paddingTop: "72px" }}>
        <div
          className="overflow-hidden py-2"
          style={{
            background: "rgba(107,63,160,0.15)",
            borderBottom: "1px solid rgba(107,63,160,0.2)",
          }}
        >
          <div className="marquee-track">
            {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, index) => (
              <span
                key={`${item}-${index}`}
                className="mx-8 font-mono text-xs tracking-widest"
                style={{ color: "#C084FC", whiteSpace: "nowrap" }}
              >
                * {item}
              </span>
            ))}
          </div>
        </div>

        <section
          className="relative overflow-hidden px-6 py-20 text-center"
          style={{ background: "bg-grid-pattern bg-grid" }}
        >
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(rgba(107,63,160,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(107,63,160,0.12) 1px, transparent 1px)",
              backgroundSize: "40px 40px",
            }}
          />

          <div
            className="absolute left-1/4 top-10 h-80 w-80 rounded-full pointer-events-none"
            style={{
              background: "radial-gradient(circle, rgba(107,63,160,0.2) 0%, transparent 70%)",
              filter: "blur(40px)",
            }}
          />
          <div
            className="absolute bottom-10 right-1/4 h-64 w-64 rounded-full pointer-events-none"
            style={{
              background: "radial-gradient(circle, rgba(34,211,238,0.12) 0%, transparent 70%)",
              filter: "blur(40px)",
            }}
          />

          <div className="relative mx-auto max-w-3xl">
            <div className="encrypted-tag mx-auto mb-6 w-fit">
              POWERED BY ARCIUM MPC - SOLANA DEVNET
            </div>

            <h1
              className="mb-4 font-display leading-none tracking-wider"
              style={{ fontSize: "clamp(3rem, 8vw, 6rem)", color: "white" }}
            >
              PREDICT
              <br />
              <span className="gradient-text">IN PRIVATE</span>
            </h1>

            <p className="mx-auto mb-8 max-w-xl font-body text-base leading-relaxed text-slate-400">
              Oracle keeps stakes, votes, and reveal inputs encrypted until settlement.
              Arcium-powered privacy reduces herding pressure while Solana keeps the
              market flow fast enough to feel usable.
            </p>

            <div className="flex flex-wrap justify-center gap-4">
              <a href="#markets" className="btn-primary">
                Browse Markets
              </a>
              <Link href="/create" className="btn-secondary">
                Create Market
              </Link>
            </div>
          </div>
        </section>

        <div
          className="flex flex-wrap items-center justify-center gap-8 py-5"
          style={{
            background: "rgba(255,255,255,0.02)",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          {[
            { label: "TOTAL MARKETS", value: loading ? "..." : String(markets.length) },
            {
              label: "PARTICIPANTS",
              value: loading ? "..." : totalParticipants.toLocaleString(),
            },
            { label: "OPEN NOW", value: loading ? "..." : String(openMarkets) },
            { label: "PRIVACY LAYER", value: "ARCIUM MPC" },
            { label: "CHAIN", value: "SOLANA DEVNET" },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <p className="font-display text-2xl tracking-wider" style={{ color: "#C084FC" }}>
                {stat.value}
              </p>
              <p className="font-mono text-xs tracking-widest text-slate-500">{stat.label}</p>
            </div>
          ))}
        </div>

        <section className="mx-auto max-w-5xl px-6 py-16">
          <h2
            className="mb-2 text-center font-display text-3xl tracking-widest"
            style={{ color: "white" }}
          >
            HOW <span className="gradient-text">ARCIUM</span> PROTECTS YOU
          </h2>
          <p className="mb-10 text-center font-mono text-xs tracking-widest text-slate-500">
            Three layers of privacy in the live market flow
          </p>

          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                title: "Encrypted Stakes",
                body: "Stake size is encrypted client-side before submission, so the public market does not learn how much conviction any one trader has.",
              },
              {
                title: "Hidden Direction",
                body: "YES and NO positions are submitted as ciphertext, which keeps crowd sentiment from turning into an instant copy-trading feed.",
              },
              {
                title: "Controlled Reveal",
                body: "Settlement-oriented reveal flows can publish outcomes and aggregate totals without exposing every participant's private inputs.",
              },
            ].map((item) => (
              <div key={item.title} className="card flex flex-col gap-3 p-6">
                <h3 className="font-mono text-sm tracking-widest" style={{ color: "#C084FC" }}>
                  {item.title.toUpperCase()}
                </h3>
                <p className="text-sm leading-relaxed text-slate-400">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="markets" className="mx-auto max-w-5xl px-6 pb-20">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-display text-3xl tracking-widest" style={{ color: "white" }}>
              ACTIVE MARKETS
            </h2>
            <div className="flex gap-2">
              {(["all", "open", "settled"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className="rounded-lg px-4 py-2 font-mono text-xs tracking-wider transition-all"
                  style={{
                    background:
                      filter === value ? "rgba(107,63,160,0.3)" : "transparent",
                    border: `1px solid ${
                      filter === value
                        ? "rgba(192,132,252,0.5)"
                        : "rgba(255,255,255,0.1)"
                    }`,
                    color: filter === value ? "#C084FC" : "#64748b",
                  }}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4 flex items-center justify-between gap-4">
            {loading ? (
              <p className="font-mono text-xs text-slate-500">Loading live market data...</p>
            ) : loadError ? (
              <p className="font-mono text-xs text-amber-300">
                Backend unavailable: {loadError}
              </p>
            ) : (
              <p className="font-mono text-xs text-emerald-300">Live backend market data</p>
            )}

            <Link href="/markets" className="font-mono text-xs text-slate-400 hover:text-white">
              VIEW ALL
            </Link>
          </div>

          {filteredMarkets.length === 0 ? (
            <div className="py-16 text-center">
              <p className="font-mono text-sm text-slate-500">
                {loading
                  ? "Waiting for markets..."
                  : "No markets available yet. Create the first one."}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {filteredMarkets.slice(0, 4).map((market) => (
                <MarketCard key={market.id} {...market} />
              ))}
            </div>
          )}
        </section>
      </main>

      <footer
        className="border-t py-8 text-center"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        <p className="font-mono text-xs tracking-widest text-slate-600">
          ORACLE - BUILT ON ARCIUM x SOLANA - OPEN SOURCE
        </p>
      </footer>
    </>
  );
}
