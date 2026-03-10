import React from "react";
import Head from "next/head";
import Navbar from "../../components/Navbar";

const STEPS = [
  {
    number: "01",
    title: "Market Created On-Chain",
    description:
      "A market creator deploys a new prediction market to the Solana program. The market is assigned to an Arcium MXE (Multiparty eXecution Environment) cluster that will handle all encrypted computations.",
    arciumRole: "Cluster assignment â€” Arcium nodes register to handle this market's MPC jobs.",
  },
  {
    number: "02",
    title: "Users Encrypt Client-Side",
    description:
      "Before submitting a position, the user's browser generates a fresh ElGamal keypair, encrypts both their stake amount and YES/NO choice using the cluster's public key. The plaintext values never leave the browser.",
    arciumRole: "Client-side encryption â€” Arcium SDK generates the ciphertexts locally.",
  },
  {
    number: "03",
    title: "Ciphertexts Stored On-Chain",
    description:
      "Only the encrypted ciphertexts (C1, C2 curve points) are stored in the Solana account. Anyone inspecting the chain sees only opaque byte arrays â€” no amounts, no choices.",
    arciumRole: "On-chain storage â€” Arcium nodes monitor the chain for new position events.",
  },
  {
    number: "04",
    title: "Homomorphic Accumulation",
    description:
      "As positions arrive, Arcium nodes homomorphically accumulate the encrypted stakes â€” adding ciphertexts together without decrypting them. This maintains a running encrypted tally of YES and NO stakes.",
    arciumRole: "Off-chain MPC â€” Additive homomorphism over Ristretto255 ElGamal ciphertexts.",
  },
  {
    number: "05",
    title: "Threshold MPC Decryption",
    description:
      "After the resolution timestamp, anyone triggers the tally. Arcium's threshold MPC protocol requires a quorum of nodes to cooperate for decryption â€” no single node can learn the result alone.",
    arciumRole: "Threshold decryption â€” t-of-n nodes must participate; collusion resistance built in.",
  },
  {
    number: "06",
    title: "Outcome Revealed & Claims Open",
    description:
      "The decrypted YES/NO totals and outcome are written on-chain. Individual position amounts are also revealed via per-position MPC decryption. Winners claim proportional payouts from the vault.",
    arciumRole: "Result relay â€” Arcium relayer posts the verified decryption result on-chain.",
  },
];

export default function HowItWorks() {
  return (
    <>
      <Head>
        <title>How It Works Â· Oracle Nexus</title>
      </Head>
      <Navbar />

      <main style={{ minHeight: "100vh", paddingTop: "72px" }}>
        <div className="max-w-3xl mx-auto px-6 py-16">
          <div className="text-center mb-14">
            <div className="encrypted-tag mb-4 mx-auto w-fit">ARCIUM MPC FLOW</div>
            <h1 className="font-display text-5xl tracking-widest mb-3" style={{ color: "white" }}>
              HOW IT <span className="gradient-text">WORKS</span>
            </h1>
            <p className="text-slate-400 font-body max-w-xl mx-auto leading-relaxed">
              Oracle Nexus combines Solana's high-throughput execution with Arcium's
              cryptographic privacy layer to create prediction markets where no
              participant's position is ever exposed.
            </p>
          </div>

          {/* Step-by-step */}
          <div className="flex flex-col gap-4">
            {STEPS.map((step, i) => (
              <div key={step.number}
                   className="card p-6 flex gap-5">
                <div className="flex-shrink-0 font-display text-4xl tracking-wider"
                     style={{ color: "rgba(107,63,160,0.4)", lineHeight: 1 }}>
                  {step.number}
                </div>
                <div className="flex-1">
                  <h3 className="font-mono text-sm tracking-wider mb-2" style={{ color: "#C084FC" }}>
                    {step.title.toUpperCase()}
                  </h3>
                  <p className="text-slate-400 text-sm leading-relaxed mb-3">
                    {step.description}
                  </p>
                  <div className="flex items-start gap-2 p-3 rounded-lg"
                       style={{ background: "rgba(34,211,238,0.05)", border: "1px solid rgba(34,211,238,0.12)" }}>
                    <span style={{ color: "#22D3EE" }}>âš¡</span>
                    <p className="font-mono text-xs text-slate-400 leading-relaxed">
                      {step.arciumRole}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Why this matters */}
          <div className="mt-12 card p-8">
            <h2 className="font-display text-3xl tracking-widest mb-4" style={{ color: "white" }}>
              WHY THIS <span className="gradient-text">MATTERS</span>
            </h2>
            <div className="grid sm:grid-cols-2 gap-4 text-sm text-slate-400 leading-relaxed font-body">
              <div>
                <p className="font-mono text-xs mb-1" style={{ color: "#F87171" }}>âŒ Traditional markets</p>
                <p>Public stakes create herding â€” participants copy popular positions rather than contributing genuine information, distorting prices.</p>
              </div>
              <div>
                <p className="font-mono text-xs mb-1" style={{ color: "#34D399" }}>âœ“ Oracle Nexus with Arcium</p>
                <p>Encrypted stakes force genuine belief-based positions. No one can herd on hidden information. Outcomes aggregate true wisdom of the crowd.</p>
              </div>
            </div>
          </div>

        </div>
      </main>
    </>
  );
}

