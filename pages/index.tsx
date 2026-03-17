import React, { useState } from "react";
import Head from "next/head";
import Navbar from "../components/Navbar";
import MarketCard from "../components/MarketCard";
import { DEMO_MARKETS } from "../utils/program";
import type { MarketState } from "../utils/arcium";

const TICKER_ITEMS = [
  "STAKES ENCRYPTED · ARCIUM MPC",
  "VOTES HIDDEN UNTIL SETTLEMENT",
  "NO HERDING · NO MANIPULATION",
  "FAIR · PRIVATE · ON-CHAIN",
  "SOLANA × ARCIUM",
];

export default function Home() {
  const [filter, setFilter] = useState<"all" | "open" | "settled">("all");

  const filtered = DEMO_MARKETS.filter((m) => {
    if (filter === "open") return m.status === "Open";
    if (filter === "settled") return m.status === "Settled";
    return true;
  });

  return (
    <>
      <Head>
        <title>CipherBet — Private Prediction Markets on Solana</title>
        <meta name="description" content="Prediction markets where stakes and votes stay encrypted until settlement, powered by Arcium MPC on Solana." />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <Navbar />

      <main style={{ minHeight: "100vh", paddingTop: "72px" }}>

        {/* ── Ticker ── */}
        <div className="overflow-hidden py-2"
             style={{ background: "rgba(107,63,160,0.15)", borderBottom: "1px solid rgba(107,63,160,0.2)" }}>
          <div className="marquee-track">
            {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
              <span key={i} className="mx-8 font-mono text-xs tracking-widest"
                    style={{ color: "#C084FC", whiteSpace: "nowrap" }}>
                ◆ {item}
              </span>
            ))}
          </div>
        </div>

        {/* ── Hero ── */}
        <section className="relative px-6 py-20 text-center overflow-hidden"
                 style={{ background: "bg-grid-pattern bg-grid" }}>
          {/* Grid background */}
          <div className="absolute inset-0 pointer-events-none"
               style={{
                 backgroundImage: "linear-gradient(rgba(107,63,160,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(107,63,160,0.12) 1px, transparent 1px)",
                 backgroundSize: "40px 40px",
               }} />

          {/* Glow orbs */}
          <div className="absolute top-10 left-1/4 w-80 h-80 rounded-full pointer-events-none"
               style={{ background: "radial-gradient(circle, rgba(107,63,160,0.2) 0%, transparent 70%)", filter: "blur(40px)" }} />
          <div className="absolute bottom-10 right-1/4 w-64 h-64 rounded-full pointer-events-none"
               style={{ background: "radial-gradient(circle, rgba(34,211,238,0.12) 0%, transparent 70%)", filter: "blur(40px)" }} />

          <div className="relative max-w-3xl mx-auto">
            <div className="encrypted-tag mb-6 mx-auto w-fit">
              <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
                <rect x="1" y="5" width="8" height="7" rx="1.5" stroke="#22D3EE" strokeWidth="1.2"/>
                <path d="M3 5V3.5a2 2 0 014 0V5" stroke="#22D3EE" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              POWERED BY ARCIUM MPC · SOLANA DEVNET
            </div>

            <h1 className="font-display tracking-wider leading-none mb-4"
                style={{ fontSize: "clamp(3rem, 8vw, 6rem)", color: "white" }}>
              PREDICT<br />
              <span className="gradient-text">IN PRIVATE</span>
            </h1>

            <p className="font-body text-slate-400 text-base max-w-xl mx-auto mb-8 leading-relaxed">
              The first prediction market where{" "}
              <span style={{ color: "#C084FC" }}>stakes, votes, and resolution inputs</span>{" "}
              remain encrypted on-chain. Arcium's Multi-Party Computation reveals outcomes
              while hiding individual positions — forever eliminating herding and manipulation.
            </p>

            <div className="flex flex-wrap gap-4 justify-center">
              <a href="#markets" className="btn-primary">
                Browse Markets
              </a>
              <a href="/create" className="btn-secondary">
                Create Market
              </a>
            </div>
          </div>
        </section>

        {/* ── Stats bar ── */}
        <div className="flex items-center justify-center gap-8 py-5 flex-wrap"
             style={{ background: "rgba(255,255,255,0.02)", borderTop: "1px solid rgba(255,255,255,0.06)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          {[
            { label: "TOTAL MARKETS", value: "4" },
            { label: "PARTICIPANTS", value: "1,100+" },
            { label: "PRIVACY LAYER", value: "ARCIUM MPC" },
            { label: "CHAIN", value: "SOLANA DEVNET" },
          ].map((s) => (
            <div key={s.label} className="text-center">
              <p className="font-display text-2xl tracking-wider" style={{ color: "#C084FC" }}>{s.value}</p>
              <p className="font-mono text-xs text-slate-500 tracking-widest">{s.label}</p>
            </div>
          ))}
        </div>

        {/* ── How Arcium Protects You ── */}
        <section className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="font-display text-3xl tracking-widest text-center mb-2" style={{ color: "white" }}>
            HOW <span className="gradient-text">ARCIUM</span> PROTECTS YOU
          </h2>
          <p className="text-slate-500 text-center font-mono text-xs tracking-widest mb-10">
            Three layers of cryptographic privacy
          </p>
          <div className="grid md:grid-cols-3 gap-4">
            {[
              {
                icon: "🔒",
                title: "Encrypted Stakes",
                body: "Your stake amount is encrypted client-side with Arcium's ElGamal scheme before it ever touches the chain. The network never learns how much you've wagered.",
              },
              {
                icon: "🗳️",
                title: "Hidden Votes",
                body: "YES/NO choices are encrypted ciphertexts. No one — not even the market creator — can see which way you voted until MPC nodes jointly decrypt at settlement.",
              },
              {
                icon: "⚡",
                title: "Fair Settlement",
                body: "Arcium's threshold MPC cluster homomorphically tallies all encrypted votes. The result is revealed only after consensus, preventing last-minute manipulation.",
              },
            ].map((item) => (
              <div key={item.title} className="card p-6 flex flex-col gap-3">
                <div className="text-3xl">{item.icon}</div>
                <h3 className="font-mono text-sm tracking-widest" style={{ color: "#C084FC" }}>
                  {item.title.toUpperCase()}
                </h3>
                <p className="text-slate-400 text-sm leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Markets ── */}
        <section id="markets" className="max-w-5xl mx-auto px-6 pb-20">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
            <h2 className="font-display text-3xl tracking-widest" style={{ color: "white" }}>
              ACTIVE MARKETS
            </h2>
            <div className="flex gap-2">
              {(["all", "open", "settled"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className="font-mono text-xs px-4 py-2 rounded-lg tracking-wider transition-all"
                  style={{
                    background: filter === f ? "rgba(107,63,160,0.3)" : "transparent",
                    border: `1px solid ${filter === f ? "rgba(192,132,252,0.5)" : "rgba(255,255,255,0.1)"}`,
                    color: filter === f ? "#C084FC" : "#64748b",
                  }}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {filtered.map((m) => {
              const market = m as MarketState;
              return (
                <MarketCard
                  key={market.id}
                  id={market.id}
                  title={market.title}
                  description={market.description}
                  resolutionTimestamp={market.resolutionTimestamp}
                  status={market.status}
                  totalParticipants={market.totalParticipants}
                  revealedYesStake={market.revealedYesStake}
                  revealedNoStake={market.revealedNoStake}
                  outcome={market.outcome}
                />
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="text-center py-16 text-slate-500 font-mono text-sm">
              No markets found.
            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t py-8 text-center" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <p className="font-mono text-xs text-slate-600 tracking-widest">
          CIPHERBET · BUILT ON ARCIUM × SOLANA · OPEN SOURCE
        </p>
      </footer>
    </>
  );
}
