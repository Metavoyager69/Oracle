/**
 * arcium.ts
 * Client-side Arcium encryption utilities.
 *
 * Arcium uses a threshold ElGamal encryption scheme over Ristretto255.
 * Stakes and vote choices are encrypted client-side so no plaintext
 * ever hits the chain.  The Arcium MPC cluster can:
 *   1. Homomorphically accumulate ciphertexts (sum encrypted balances)
 *   2. Jointly decrypt only after quorum threshold is reached
 *
 * NOTE: In production, import directly from `@arcium-hq/arcium-sdk`.
 */

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

// ─────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────

/**
 * Mirror of the on-chain `Ciphertext` struct.
 * FIX (RED-1): replaces the identical EncryptedU64 / EncryptedBool pair.
 */
export interface Ciphertext {
  c1: Uint8Array; // r · G           (ephemeral public key)
  c2: Uint8Array; // m · G + r · PK  (blinded message)
}

/**
 * Everything the frontend needs to submit a position.
 * `stakeNonce` is kept client-side by the user and provided to
 * the Arcium relayer at settlement so it can call reveal_position.
 */
export interface StakeCommitment {
  commitment: Uint8Array; // SHA-256(amount_le_bytes || stakeNonce) — stored on-chain
  stakeNonce: Uint8Array; // 32-byte random blinding nonce — kept secret until reveal
}

export interface MarketState {
  id:                  number;
  title:               string;
  description:         string;
  resolutionTimestamp: Date;
  status:              "Open" | "SettledPending" | "Challenged" | "Settled" | "Invalid" | "Cancelled";
  totalParticipants:   number;
  outcome?:            boolean;
  // Only populated after Arcium MPC settlement:
  revealedYesStake?:   number;
  revealedNoStake?:    number;
}

// ─────────────────────────────────────────────────────────────────
//  Cluster configuration
// ─────────────────────────────────────────────────────────────────

/** Arcium devnet MXE cluster — replace with mainnet ID for production. */
export const ARCIUM_DEVNET_CLUSTER = new PublicKey(
  "ArcmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
);

/**
 * Returns the Arcium cluster's public encryption key.
 * Production: read from the Arcium on-chain cluster registry.
 */
export async function fetchClusterPublicKey(
  _clusterId: PublicKey
): Promise<Uint8Array> {
  // Devnet demo: well-known test key
  return new Uint8Array(32).fill(0x42);
}

// ─────────────────────────────────────────────────────────────────
//  Encryption
// ─────────────────────────────────────────────────────────────────

/**
 * Encrypts a u64 stake amount.
 *
 * Demo XOR-based ElGamal (structural only):
 *   C1 = r XOR PK
 *   C2 = amount_bytes XOR r
 *
 * Production: Arcium SDK implements full Ristretto255 ElGamal.
 */
export function encryptStake(
  amountLamports: bigint,
  clusterPublicKey: Uint8Array
): Ciphertext {
  const r  = nacl.randomBytes(32);
  const c1 = xorBytes(r, clusterPublicKey);
  const c2 = xorBytes(bigintToBytes32(amountLamports), r);
  return { c1, c2 };
}

/**
 * Encrypts a YES/NO vote choice.
 * true = YES, false = NO.
 */
export function encryptChoice(
  choice: boolean,
  clusterPublicKey: Uint8Array
): Ciphertext {
  const r           = nacl.randomBytes(32);
  const c1          = xorBytes(r, clusterPublicKey);
  const choiceBytes = new Uint8Array(32);
  choiceBytes[0]    = choice ? 1 : 0;
  const c2          = xorBytes(choiceBytes, r);
  return { c1, c2 };
}

// ─────────────────────────────────────────────────────────────────
//  Serialisation for Anchor CPI
// ─────────────────────────────────────────────────────────────────

/** Converts a Ciphertext to the `number[]` format Anchor expects. */
export function serializeCiphertext(e: Ciphertext): { c1: number[]; c2: number[] } {
  return { c1: Array.from(e.c1), c2: Array.from(e.c2) };
}

/**
 * Generates a SHA-256 stake commitment.
 *
 * This breaks the direct link between the plaintext stake amount and
 * the on-chain account state.  The position account stores ONLY the
 * commitment hash — not the plaintext amount.
 *
 * At settlement, the Arcium relayer provides (amount, stakeNonce) to
 * reveal_position, which re-hashes and verifies on-chain.
 *
 * NOTE: The token TRANSFER in the same transaction is still visible
 * on-chain (Solana is a public ledger).  For full transfer-level
 * privacy, SPL Token 2022 Confidential Transfers would be required.
 *
 * Usage:
 *   const { commitment, stakeNonce } = await commitStake(stakeLamports);
 *   // store stakeNonce securely — user must provide it at settlement
 */
export async function commitStake(
  amountLamports: bigint
): Promise<StakeCommitment> {
  // Generate a random 32-byte blinding nonce
  const stakeNonce = nacl.randomBytes(32);

  // Build preimage: 8-byte LE amount || 32-byte nonce = 40 bytes total
  const preimage = new Uint8Array(40);
  const amountBytes = bigintToBytes32(amountLamports);
  preimage.set(amountBytes.slice(0, 8), 0); // only the 8 LE amount bytes
  preimage.set(stakeNonce, 8);

  // SHA-256 via Web Crypto API (available in browser + Node 16+)
  const hashBuffer = await crypto.subtle.digest("SHA-256", preimage);
  const commitment = new Uint8Array(hashBuffer);

  return { commitment, stakeNonce };
}

// ─────────────────────────────────────────────────────────────────
//  Market display helpers
// ─────────────────────────────────────────────────────────────────

/** Decodes a null-padded 128-byte title array from on-chain. */
export function decodeMarketTitle(bytes: number[]): string {
  return Buffer.from(bytes).toString("utf8").replace(/\0/g, "").trim();
}

/** Human-readable status badge label. */
export function marketStatusLabel(status: MarketState["status"]): string {
  const labels: Record<MarketState["status"], string> = {
    Open: "LIVE",
    SettledPending: "SETTLEMENT WINDOW",
    Challenged: "CHALLENGED",
    Settled: "SETTLED",
    Invalid: "INVALID",
    Cancelled: "CANCELLED",
  };
  return labels[status];
}

/**
 * YES percentage for the odds bar.
 * Returns 50 before settlement (no data available by design).
 */
export function yesPercent(
  market: Pick<MarketState, "revealedYesStake" | "revealedNoStake">
): number {
  const yes   = market.revealedYesStake ?? 0;
  const no    = market.revealedNoStake  ?? 0;
  const total = yes + no;
  return total === 0 ? 50 : Math.round((yes / total) * 100);
}

// ─────────────────────────────────────────────────────────────────
//  Private utilities
// ─────────────────────────────────────────────────────────────────

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i % b.length];
  return out;
}

function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let   tmp = n;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(tmp & BigInt(0xff));
    tmp  >>= BigInt(8);
  }
  return buf;
}
