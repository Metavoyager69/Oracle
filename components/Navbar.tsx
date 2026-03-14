import React from "react";
import Image from "next/image";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export default function Navbar() {
  const { connected, publicKey } = useWallet();

  return (
    <nav
      className="fixed left-0 right-0 top-0 z-50"
      style={{
        background: "rgba(3,3,8,0.9)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <Image
            src="/oracle-logo.svg"
            alt="Oracle logo"
            width={28}
            height={28}
            style={{ borderRadius: "6px" }}
          />
          <span className="font-display text-2xl tracking-widest text-white">ORACLE</span>
        </Link>

        <div className="hidden items-center gap-6 md:flex">
          <Link href="/" className="font-mono text-xs tracking-widest text-slate-300 hover:text-white">
            MARKETS
          </Link>
          <Link
            href="/portfolio"
            className="font-mono text-xs tracking-widest text-slate-300 hover:text-white"
          >
            PORTFOLIO
          </Link>
          <Link
            href="/create"
            className="font-mono text-xs tracking-widest text-slate-300 hover:text-white"
          >
            CREATE
          </Link>
        </div>

        <div className="flex items-center gap-3">
          {connected ? (
            <span className="hidden rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-slate-300 sm:inline">
              {publicKey?.toBase58().slice(0, 4)}...{publicKey?.toBase58().slice(-4)}
            </span>
          ) : null}
          <WalletMultiButton
            style={{
              background: "#6B3FA0",
              borderRadius: "8px",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "12px",
              height: "36px",
              padding: "0 14px",
            }}
          />
        </div>
      </div>
    </nav>
  );
}
