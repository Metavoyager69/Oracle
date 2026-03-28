import { PublicKey } from "@solana/web3.js";

// Shared chain/program constants for the frontend. Live market data should come
// from the backend or on-chain reads, while this file stays focused on shared
// config, PDAs, and UI-safe helper types.
const DEFAULT_PROGRAM_ID = "7krCLEf4n4QnLnaLgJQTkQB7bS72PRxbM2dGZLb3oQto";
const TOKEN_PROGRAM_ID_VALUE = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID_VALUE = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const DEFAULT_MARKET_TOKEN_SYMBOL = "USDC";
const DEFAULT_MARKET_TOKEN_DECIMALS = 6;

function parsePublicKey(value: string | undefined, fallback: string): PublicKey {
  try {
    return new PublicKey(value ?? fallback);
  } catch {
    return new PublicKey(fallback);
  }
}

function parseOptionalPublicKey(value: string | undefined): PublicKey | null {
  try {
    return value?.trim() ? new PublicKey(value.trim()) : null;
  } catch {
    return null;
  }
}

function parseTokenDecimals(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 12) {
    return fallback;
  }
  return parsed;
}

export const PROGRAM_ID = parsePublicKey(
  process.env.NEXT_PUBLIC_PREDICTION_MARKET_PROGRAM_ID,
  DEFAULT_PROGRAM_ID
);
// Mainnet rollout: set NEXT_PUBLIC_PREDICTION_MARKET_PROGRAM_ID and
// NEXT_PUBLIC_SOLANA_RPC together so the UI talks to the correct cluster.
export const TOKEN_PROGRAM_ID = new PublicKey(TOKEN_PROGRAM_ID_VALUE);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  ASSOCIATED_TOKEN_PROGRAM_ID_VALUE
);
export const MARKET_TOKEN_MINT = parseOptionalPublicKey(
  process.env.NEXT_PUBLIC_MARKET_TOKEN_MINT
);
export const MARKET_TOKEN_SYMBOL =
  process.env.NEXT_PUBLIC_MARKET_TOKEN_SYMBOL?.trim() || DEFAULT_MARKET_TOKEN_SYMBOL;
export const MARKET_TOKEN_DECIMALS = parseTokenDecimals(
  process.env.NEXT_PUBLIC_MARKET_TOKEN_DECIMALS,
  DEFAULT_MARKET_TOKEN_DECIMALS
);
// The program enforces a raw minimum stake of 1_000_000 base units. The UI uses
// env-driven decimals so the displayed minimum stays aligned with the chosen mint.
export const MIN_STAKE_BASE_UNITS = 1_000_000n;

export const MARKET_SEED = Buffer.from("market");
export const VAULT_SEED = Buffer.from("vault");
export const BOND_VAULT_SEED = Buffer.from("bond-vault");
export const POSITION_SEED = Buffer.from("position");
export const REGISTRY_SEED = Buffer.from("registry");

export type MarketStatus =
  | "Open"
  | "SettledPending"
  | "Challenged"
  | "Settled"
  | "Invalid"
  | "Cancelled";

export type MarketCategory = "Crypto" | "Football" | "Politics" | "Macro" | "Tech";
export type ResolutionStepStatus = "completed" | "active" | "upcoming";
export type PositionVisibility = "public" | "encrypted";
export type PositionSide = "YES" | "NO" | "ENCRYPTED";

export const MARKET_CATEGORIES: MarketCategory[] = [
  "Crypto",
  "Football",
  "Politics",
  "Macro",
  "Tech",
];

export const CATEGORY_STYLES: Record<MarketCategory, { bg: string; border: string; text: string }> = {
  Crypto: { bg: "rgba(52,211,153,0.1)", border: "rgba(52,211,153,0.2)", text: "#34D399" },
  Football: { bg: "rgba(96,165,250,0.1)", border: "rgba(96,165,250,0.2)", text: "#60A5FA" },
  Politics: { bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.2)", text: "#F87171" },
  Macro: { bg: "rgba(167,139,250,0.1)", border: "rgba(167,139,250,0.2)", text: "#A78BFA" },
  Tech: { bg: "rgba(250,204,21,0.1)", border: "rgba(250,204,21,0.2)", text: "#FACC15" },
};

export interface ResolutionTimelineStep {
  id: string;
  label: string;
  note: string;
  timestamp: Date;
  status: ResolutionStepStatus;
}

export interface SettlementArtifacts {
  proofUri: string;
  proofHash: string;
  settlementHash: string;
  publishedAt: string;
  verifier: string;
}

export interface DemoMarket {
  id: number;
  category: MarketCategory;
  title: string;
  description: string;
  resolutionTimestamp: Date;
  status: MarketStatus;
  totalParticipants: number;
  revealedYesStake?: number;
  revealedNoStake?: number;
  outcome?: boolean;
  rules: string[];
  resolutionSource: string;
  timeline: ResolutionTimelineStep[];
  settlementArtifacts?: SettlementArtifacts;
  yesVotes?: number;
  noVotes?: number;
}

export interface DemoPosition {
  id: number;
  marketId: number;
  marketTitle: string;
  side: PositionSide;
  stakeSol?: number;
  entryOdds?: number;
  markOdds?: number;
  status: "Open" | "Won" | "Lost";
  visibility: PositionVisibility;
  submittedAt: Date;
  settledAt?: Date;
  payoutSol?: number;
  choice?: boolean;
}

export function getRegistryPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([REGISTRY_SEED], PROGRAM_ID);
}

export function getMarketPDA(marketId: number): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(marketId));
  return PublicKey.findProgramAddressSync([MARKET_SEED, idBuf], PROGRAM_ID);
}

export function getVaultPDA(marketId: number): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(marketId));
  return PublicKey.findProgramAddressSync([VAULT_SEED, idBuf], PROGRAM_ID);
}

export function getBondVaultPDA(marketId: number): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(marketId));
  return PublicKey.findProgramAddressSync([BOND_VAULT_SEED, idBuf], PROGRAM_ID);
}

export function getPositionPDA(
  marketPubkey: PublicKey,
  userPubkey: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, marketPubkey.toBuffer(), userPubkey.toBuffer()],
    PROGRAM_ID
  );
}

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";

export function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

export function parseTokenAmount(value: string, decimals = MARKET_TOKEN_DECIMALS): bigint | null {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

  const [wholePart, fractionPart = ""] = normalized.split(".");
  const paddedFraction = (fractionPart + "0".repeat(decimals)).slice(0, decimals);
  try {
    const whole = BigInt(wholePart || "0");
    const fraction = BigInt(paddedFraction || "0");
    return whole * 10n ** BigInt(decimals) + fraction;
  } catch {
    return null;
  }
}

export function formatTokenAmount(
  value: bigint,
  decimals = MARKET_TOKEN_DECIMALS,
  precision = Math.min(decimals, 4)
): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (precision === 0) return whole.toString();

  const rawFraction = fraction.toString().padStart(decimals, "0").slice(0, precision);
  const trimmedFraction = rawFraction.replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString();
}

export function formatMinimumStakeLabel(): string {
  return `${formatTokenAmount(MIN_STAKE_BASE_UNITS)} ${MARKET_TOKEN_SYMBOL}`;
}

export function calculatePositionPnl(position: DemoPosition): number {
  if (position.visibility === "encrypted") return 0;
  const stake = position.stakeSol ?? 0;
  const entry = position.entryOdds ?? 0;
  const mark = position.markOdds ?? 0;
  if (position.status === "Open") {
    return (mark - entry) * stake;
  }
  return (position.payoutSol ?? 0) - stake;
}

export function getPortfolioSummary(positions: DemoPosition[]) {
  const visible = positions.filter((position) => position.visibility === "public");
  const open = visible.filter((position) => position.status === "Open");
  const settled = visible.filter((position) => position.status !== "Open");
  const winners = visible.filter((position) => position.status === "Won");

  const realizedPnl = settled.reduce(
    (total, position) => total + calculatePositionPnl(position),
    0
  );
  const unrealizedPnl = open.reduce(
    (total, position) => total + calculatePositionPnl(position),
    0
  );
  const totalStaked = visible.reduce((total, position) => total + (position.stakeSol ?? 0), 0);
  const winRate = settled.length === 0 ? 0 : (winners.length / settled.length) * 100;

  return {
    openCount: open.length,
    settledCount: settled.length,
    totalStaked,
    realizedPnl,
    unrealizedPnl,
    winRate,
  };
}
