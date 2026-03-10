import React, { useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Navbar from "../../components/Navbar";

export default function CreateMarket() {
  const { connected } = useWallet();
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [resolutionDate, setResolutionDate] = useState("");
  const [step, setStep] = useState<"idle" | "submitting" | "done">("idle");

  async function handleCreate() {
    if (!title || !resolutionDate) return;
    setStep("submitting");
    await new Promise((r) => setTimeout(r, 1500));
    setStep("done");
    setTimeout(() => router.push("/"), 2000);
  }

  return (
    <>
      <Head>
        <title>Create Market Â· Oracle Nexus</title>
      </Head>
      <Navbar />

      <main style={{ minHeight: "100vh", paddingTop: "72px" }}>
        <div className="max-w-2xl mx-auto px-6 py-12">
          <button onClick={() => router.push("/")}
                  className="font-mono text-xs text-slate-500 hover:text-white mb-8 flex items-center gap-2 transition-colors">
            â† BACK
          </button>

          <h1 className="font-display text-4xl tracking-widest mb-2" style={{ color: "white" }}>
            CREATE MARKET
          </h1>
          <p className="text-slate-400 font-mono text-xs mb-8 tracking-widest">
            ENCRYPTED BY ARCIUM Â· SOLANA DEVNET
          </p>

          {!connected ? (
            <div className="card p-10 text-center">
              <p className="text-slate-400 font-body mb-4">Connect wallet to create a market.</p>
              <WalletMultiButton style={{
                background: "linear-gradient(135deg, #6B3FA0, #9B6FD0)",
                borderRadius: "8px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "12px",
              }} />
            </div>
          ) : step === "done" ? (
            <div className="card p-10 text-center">
              <div className="text-5xl mb-4">ðŸŽ‰</div>
              <p className="font-mono text-sm" style={{ color: "#34D399" }}>MARKET CREATED</p>
              <p className="text-slate-400 text-sm mt-2">Redirecting to marketsâ€¦</p>
            </div>
          ) : (
            <div className="card p-6 flex flex-col gap-5">
              {/* Title */}
              <div>
                <label className="font-mono text-xs text-slate-500 mb-2 block">QUESTION / TITLE</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Will BTC exceed $200k before 2026?"
                  maxLength={128}
                  className="w-full bg-transparent font-body text-sm text-white outline-none"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "12px 16px" }}
                />
                <p className="text-xs text-slate-600 mt-1 font-mono">{title.length}/128</p>
              </div>

              {/* Description */}
              <div>
                <label className="font-mono text-xs text-slate-500 mb-2 block">RESOLUTION CRITERIA</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe exactly how this market resolves. Include the data source."
                  rows={4}
                  maxLength={512}
                  className="w-full font-body text-sm text-white outline-none resize-none"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "12px 16px" }}
                />
                <p className="text-xs text-slate-600 mt-1 font-mono">{description.length}/512</p>
              </div>

              {/* Resolution date */}
              <div>
                <label className="font-mono text-xs text-slate-500 mb-2 block">RESOLUTION DATE</label>
                <input
                  type="date"
                  value={resolutionDate}
                  onChange={(e) => setResolutionDate(e.target.value)}
                  className="w-full font-mono text-sm text-white outline-none"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "12px 16px", colorScheme: "dark" }}
                />
              </div>

              {/* Arcium note */}
              <div className="p-4 rounded-lg" style={{ background: "rgba(107,63,160,0.1)", border: "1px solid rgba(107,63,160,0.2)" }}>
                <p className="font-mono text-xs text-slate-400 leading-relaxed">
                  âš¡ This market will be assigned to the{" "}
                  <span style={{ color: "#C084FC" }}>Arcium devnet MXE cluster</span>.
                  All participant stakes and votes will remain encrypted until your resolution
                  date, when the cluster performs a joint decryption via threshold MPC.
                </p>
              </div>

              <button
                onClick={handleCreate}
                disabled={!title || !resolutionDate || step === "submitting"}
                className="btn-primary"
                style={{ opacity: !title || !resolutionDate ? 0.5 : 1 }}
              >
                {step === "submitting" ? "âŸ³ DEPLOYING ON-CHAINâ€¦" : "ðŸš€ CREATE MARKET"}
              </button>
            </div>
          )}
        </div>
      </main>
    </>
  );
}

