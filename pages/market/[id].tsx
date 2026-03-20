import React, { useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { format } from "date-fns";
import { AnchorProvider } from "@coral-xyz/anchor";
import Navbar from "../../components/Navbar";
import { DEMO_MARKETS, PROGRAM_ID } from "../../utils/program";
import {
  encryptStake,
  encryptChoice,
  commitStake,
} from "../../utils/arcium";
import { storeStakeNonce } from "../../utils/nonce-vault";

type StepState = "idle" | "encrypting" | "submitting" | "confirmed" | "error";

export default function MarketPage() {
  const router = useRouter();
  const { id } = router.query;
  const { connected, publicKey, signMessage } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const provider = anchorWallet
    ? new AnchorProvider(connection, anchorWallet, { preflightCommitment: "confirmed" })
    : null;

  const market = DEMO_MARKETS.find((m) => m.id === Number(id));

  const [choice, setChoice] = useState<"yes" | "no" | null>(null);
  const [stakeInput, setStakeInput] = useState("");
  const [step, setStep] = useState<StepState>("idle");
  const [txSig, setTxSig] = useState<string | null>(null);
  const [encryptedPreview, setEncryptedPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!market) {
    return (
      <div className="flex items-center justify-center min-h-screen font-mono text-slate-500">
        Market not found.
      </div>
    );
  }

  const isOpen = market.status === "Open";
  const isSettled = market.status === "Settled";
  const total = (market.revealedYesStake ?? 0) + (market.revealedNoStake ?? 0);
  const yesP = total === 0 ? 50 : Math.round(((market.revealedYesStake ?? 0) / total) * 100);
  const noP = 100 - yesP;

  async function handleSubmit() {
    if (!choice || !stakeInput || !connected || !provider) return;
    const stakeSOL = parseFloat(stakeInput);
    if (isNaN(stakeSOL) || stakeSOL <= 0) return;

    setStep("encrypting");
    setError(null);

    try {
      // 1. Encrypt stake amount + choice CLIENT-SIDE via Arcium SDK
      const stakeLamports = BigInt(Math.floor(stakeSOL * 1e9));
      const encStake = await encryptStake(stakeLamports, provider, PROGRAM_ID);
      const encChoice = await encryptChoice(choice === "yes", provider, PROGRAM_ID);

      // 3. Generate stake commitment — hides amount from on-chain state.
      //    stakeNonce must be stored securely; it is required at settlement
      //    so the Arcium relayer can call reveal_position and verify the hash.
      const { commitment, stakeNonce } = await commitStake(stakeLamports);

      // Store nonce in encrypted local storage derived from the wallet signature.
      await storeStakeNonce(
        { connected, publicKey, signMessage },
        market.id,
        commitment,
        stakeNonce
      );

      // Preview the ciphertext (first 8 bytes of c1 for UI)
      const preview = `0x${Buffer.from(encStake.c1).slice(0, 8).toString("hex")}...`;
      setEncryptedPreview(preview);

      setStep("submitting");

      // 4. In production: build + send Anchor transaction here
      //    Instruction args: encStake, encChoice, stakeLamports, commitment
      //    e.g. program.methods.submitPosition(
      //           serializeCiphertext(encStake),
      //           serializeCiphertext(encChoice),
      //           new BN(stakeLamports.toString()),
      //           Array.from(commitment)
      //         ).accounts({...}).rpc()
      await new Promise((r) => setTimeout(r, 1800));

      const fakeSig =
        Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 64);

      setTxSig(fakeSig);
      setStep("confirmed");
    } catch (e: any) {
      setError(e.message ?? "Unknown error");
      setStep("error");
    }
  }

  return (
    <>
      <Head>
        <title>{market.title} · CipherBet</title>
      </Head>
      <Navbar />

      <main style={{ minHeight: "100vh", paddingTop: "72px" }}>
        <div className="max-w-3xl mx-auto px-6 py-12">

          {/* Back */}
          <button onClick={() => router.push("/")}
                  className="font-mono text-xs text-slate-500 hover:text-white mb-8 flex items-center gap-2 transition-colors">
            ← ALL MARKETS
          </button>

          {/* Market header */}
          <div className="card p-6 mb-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <h1 className="text-white font-body font-medium text-xl leading-snug flex-1">
                {market.title}
              </h1>
              <div className="encrypted-tag flex-shrink-0">
                <span className={`w-1.5 h-1.5 rounded-full ${isOpen ? "bg-green-400 animate-pulse" : "bg-cyan-400"}`} />
                {market.status.toUpperCase()}
              </div>
            </div>
            <p className="text-slate-400 text-sm leading-relaxed mb-4">{market.description}</p>
            <div className="flex gap-6 flex-wrap">
              <div>
                <p className="font-mono text-xs text-slate-500">RESOLUTION</p>
                <p className="font-mono text-sm text-white">{format(market.resolutionTimestamp, "PPP")}</p>
              </div>
              <div>
                <p className="font-mono text-xs text-slate-500">PARTICIPANTS</p>
                <p className="font-mono text-sm text-white">{market.totalParticipants}</p>
              </div>
              <div>
                <p className="font-mono text-xs text-slate-500">PRIVACY</p>
                <p className="font-mono text-sm" style={{ color: "#22D3EE" }}>ARCIUM MPC</p>
              </div>
            </div>
          </div>

          {/* Odds / Result */}
          {isSettled ? (
            <div className="card p-6 mb-6">
              <p className="font-mono text-xs text-slate-500 mb-3">FINAL RESULT</p>
              <div className="flex justify-between mb-2">
                <span className="font-mono text-sm" style={{ color: market.outcome ? "#34D399" : "#64748b" }}>
                  YES {yesP}% {market.outcome && "← WINNER"}
                </span>
                <span className="font-mono text-sm" style={{ color: !market.outcome ? "#F87171" : "#64748b" }}>
                  {!market.outcome && "WINNER →"} NO {noP}%
                </span>
              </div>
              <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
                <div style={{ width: `${yesP}%`, background: "linear-gradient(90deg,#34D399,#059669)" }} />
                <div style={{ width: `${noP}%`, background: "linear-gradient(90deg,#F87171,#DC2626)" }} />
              </div>
              <p className="text-xs text-slate-500 mt-3 font-mono">
                Stakes decrypted by Arcium MPC at settlement block.
              </p>
            </div>
          ) : (
            <div className="card p-6 mb-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="encrypted-tag">
                  <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
                    <rect x="1" y="5" width="8" height="7" rx="1.5" stroke="#22D3EE" strokeWidth="1.2"/>
                    <path d="M3 5V3.5a2 2 0 014 0V5" stroke="#22D3EE" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                  ODDS HIDDEN
                </div>
                <p className="text-slate-500 font-mono text-xs">
                  All stakes are encrypted — real-time odds are unavailable by design to prevent herding.
                </p>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden opacity-20"
                   style={{ background: "repeating-linear-gradient(90deg, #6B3FA0 0px, #6B3FA0 4px, transparent 4px, transparent 8px)" }} />
            </div>
          )}

          {/* Position form */}
          {isOpen && (
            <div className="card p-6">
              <h2 className="font-mono text-sm tracking-widest mb-5" style={{ color: "#C084FC" }}>
                SUBMIT ENCRYPTED POSITION
              </h2>

              {!connected ? (
                <div className="text-center py-8">
                  <p className="text-slate-400 font-body text-sm mb-4">
                    Connect your Solana wallet to submit a private position.
                  </p>
                  <WalletMultiButton style={{
                    background: "linear-gradient(135deg, #6B3FA0, #9B6FD0)",
                    borderRadius: "8px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "12px",
                  }} />
                </div>
              ) : step === "confirmed" ? (
                <div className="text-center py-8">
                  <div className="text-5xl mb-4">🔒</div>
                  <p className="font-mono text-sm mb-2" style={{ color: "#34D399" }}>POSITION ENCRYPTED & SUBMITTED</p>
                  <p className="text-slate-400 text-xs font-body mb-4">
                    Your stake and choice are encrypted. Arcium nodes will tally
                    all positions jointly at resolution — no individual vote is ever
                    revealed until settlement.
                  </p>
                  {txSig && (
                    <a href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                       target="_blank" rel="noreferrer"
                       className="font-mono text-xs"
                       style={{ color: "#22D3EE" }}>
                      View tx: {txSig.slice(0, 16)}...
                    </a>
                  )}
                </div>
              ) : (
                <>
                  {/* Choice */}
                  <div className="mb-5">
                    <p className="font-mono text-xs text-slate-500 mb-3">YOUR PREDICTION</p>
                    <div className="flex gap-3">
                      <button onClick={() => setChoice("yes")}
                              className="flex-1 py-3 rounded-lg font-mono text-sm tracking-widest transition-all"
                              style={{
                                background: choice === "yes" ? "rgba(52,211,153,0.15)" : "transparent",
                                border: `1px solid ${choice === "yes" ? "rgba(52,211,153,0.5)" : "rgba(255,255,255,0.1)"}`,
                                color: choice === "yes" ? "#34D399" : "#64748b",
                              }}>
                        YES ↑
                      </button>
                      <button onClick={() => setChoice("no")}
                              className="flex-1 py-3 rounded-lg font-mono text-sm tracking-widest transition-all"
                              style={{
                                background: choice === "no" ? "rgba(248,113,113,0.15)" : "transparent",
                                border: `1px solid ${choice === "no" ? "rgba(248,113,113,0.5)" : "rgba(255,255,255,0.1)"}`,
                                color: choice === "no" ? "#F87171" : "#64748b",
                              }}>
                        NO ↓
                      </button>
                    </div>
                  </div>

                  {/* Stake amount */}
                  <div className="mb-5">
                    <p className="font-mono text-xs text-slate-500 mb-2">STAKE AMOUNT (SOL)</p>
                    <div className="flex gap-2 items-center"
                         style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "12px 16px" }}>
                      <input
                        type="number"
                        min="0.001"
                        step="0.01"
                        placeholder="0.10"
                        value={stakeInput}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStakeInput(e.target.value)}
                        className="flex-1 bg-transparent font-mono text-white text-sm outline-none"
                      />
                      <span className="font-mono text-xs text-slate-500">SOL</span>
                    </div>
                  </div>

                  {/* Encryption info */}
                  <div className="mb-5 p-3 rounded-lg"
                       style={{ background: "rgba(34,211,238,0.05)", border: "1px solid rgba(34,211,238,0.15)" }}>
                    <p className="font-mono text-xs text-slate-400 leading-relaxed">
                      🔐 Your position is encrypted with{" "}
                      <span style={{ color: "#22D3EE" }}>Arcium ElGamal</span> before submission.
                      The plaintext never touches the blockchain. Arcium MPC nodes hold key shares
                      and can only decrypt jointly at settlement.
                    </p>
                    {encryptedPreview && step === "submitting" && (
                      <p className="font-mono text-xs mt-2" style={{ color: "#C084FC" }}>
                        Ciphertext: {encryptedPreview}
                      </p>
                    )}
                  </div>

                  {error && (
                    <p className="font-mono text-xs text-red-400 mb-4">{error}</p>
                  )}

                  <button onClick={handleSubmit}
                          disabled={!choice || !stakeInput || step === "encrypting" || step === "submitting"}
                          className="btn-primary w-full"
                          style={{ opacity: !choice || !stakeInput ? 0.5 : 1 }}>
                    {step === "encrypting" && "⟳ ENCRYPTING..."}
                    {step === "submitting" && "⟳ SUBMITTING..."}
                    {(step === "idle" || step === "error") && "🔒 ENCRYPT & SUBMIT POSITION"}
                  </button>
                </>
              )}
            </div>
          )}

        </div>
      </main>
    </>
  );
}
