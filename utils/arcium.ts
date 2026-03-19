/**
 * arcium.ts
 * Client-side Arcium encryption utilities.
 *
 * Uses the official Arcium TypeScript client SDK to encrypt stakes and choices.
 * The encrypted payloads can be submitted to Arcium-enabled programs without
 * leaking plaintext to the network.
 */

import type { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getMXEPublicKey, RescueCipher, x25519 } from "@arcium-hq/client";
import nacl from "tweetnacl";

export interface Ciphertext {
  c1: Uint8Array;
  c2: Uint8Array;
}

/**
 * Everything the frontend needs to submit a position.
 * `stakeNonce` is kept client-side by the user and provided to
 * the Arcium relayer at settlement so it can call reveal_position.
 */
export interface StakeCommitment {
  commitment: Uint8Array; // SHA-256(amount_le_bytes || stakeNonce) stored on-chain
  stakeNonce: Uint8Array; // 32-byte random blinding nonce kept secret until reveal
}

export interface MarketState {
  id: number;
  title: string;
  description: string;
  resolutionTimestamp: Date;
  status: "Open" | "SettledPending" | "Challenged" | "Settled" | "Invalid" | "Cancelled";
  totalParticipants: number;
  outcome?: boolean;
  revealedYesStake?: number;
  revealedNoStake?: number;
}

type ArciumCipher = {
  cipher: RescueCipher;
  clientPublicKey: Uint8Array;
};

const cipherCache = new Map<string, Promise<ArciumCipher>>();

async function getMxePublicKeyWithRetry(
  provider: AnchorProvider,
  programId: PublicKey,
  retries = 12,
  delayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const mxePublicKey = await getMXEPublicKey(provider, programId);
    if (mxePublicKey) return mxePublicKey;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Arcium MXE public key unavailable.");
}

async function getArciumCipher(
  provider: AnchorProvider,
  programId: PublicKey
): Promise<ArciumCipher> {
  const cacheKey = programId.toBase58();
  const existing = cipherCache.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const clientSecretKey = x25519.utils.randomSecretKey();
    const clientPublicKey = x25519.getPublicKey(clientSecretKey);
    const mxePublicKey = await getMxePublicKeyWithRetry(provider, programId);
    const sharedSecret = x25519.getSharedSecret(clientSecretKey, mxePublicKey);
    return {
      cipher: new RescueCipher(sharedSecret),
      clientPublicKey,
    };
  })();

  cipherCache.set(cacheKey, promise);
  return promise;
}

function randomNonce(size = 16): Uint8Array {
  const nonce = new Uint8Array(size);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(nonce);
    return nonce;
  }
  return nacl.randomBytes(size);
}

function splitCiphertext(parts: number[][]): Ciphertext {
  const first = parts[0] ?? [];
  const second = parts[1] ?? [];
  const c1 = new Uint8Array(32);
  const c2 = new Uint8Array(32);
  c1.set(first.slice(0, 32));
  c2.set(second.slice(0, 32));
  return { c1, c2 };
}

export async function encryptStake(
  amountLamports: bigint,
  provider: AnchorProvider,
  programId: PublicKey
): Promise<Ciphertext> {
  const { cipher } = await getArciumCipher(provider, programId);
  const nonce = randomNonce();
  const parts = cipher.encrypt([amountLamports, 0n], nonce);
  return splitCiphertext(parts);
}

export async function encryptChoice(
  choice: boolean,
  provider: AnchorProvider,
  programId: PublicKey
): Promise<Ciphertext> {
  const { cipher } = await getArciumCipher(provider, programId);
  const nonce = randomNonce();
  const choiceValue = choice ? 1n : 0n;
  const parts = cipher.encrypt([choiceValue, 0n], nonce);
  return splitCiphertext(parts);
}

/** Converts a Ciphertext to the number[] format Anchor expects. */
export function serializeCiphertext(e: Ciphertext): { c1: number[]; c2: number[] } {
  return { c1: Array.from(e.c1), c2: Array.from(e.c2) };
}

/**
 * Generates a SHA-256 stake commitment.
 * The position account stores ONLY the commitment hash, not the plaintext amount.
 */
export async function commitStake(amountLamports: bigint): Promise<StakeCommitment> {
  const stakeNonce = nacl.randomBytes(32);

  const preimage = new Uint8Array(40);
  const amountBytes = bigintToBytes32(amountLamports);
  preimage.set(amountBytes.slice(0, 8), 0);
  preimage.set(stakeNonce, 8);

  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", preimage);
  const commitment = new Uint8Array(hashBuffer);

  return { commitment, stakeNonce };
}

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
  const yes = market.revealedYesStake ?? 0;
  const no = market.revealedNoStake ?? 0;
  const total = yes + no;
  return total === 0 ? 50 : Math.round((yes / total) * 100);
}

function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let tmp = n;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(tmp & BigInt(0xff));
    tmp >>= BigInt(8);
  }
  return buf;
}
