import { PublicKey } from "@solana/web3.js";

const DEFAULT_PROGRAM_ID = "9xQeWvG816bUx9EPfM5f6K4M6R4xM3aMcMBXNte1qNbf";

function parsePublicKey(value: string | undefined, fallback: string): PublicKey {
  try {
    return new PublicKey(value ?? fallback);
  } catch {
    return new PublicKey(fallback);
  }
}

export const PROGRAM_ID = parsePublicKey(
  process.env.NEXT_PUBLIC_PREDICTION_MARKET_PROGRAM_ID,
  DEFAULT_PROGRAM_ID
);

export const MARKET_SEED = Buffer.from("market");
export const VAULT_SEED = Buffer.from("vault");
export const POSITION_SEED = Buffer.from("position");
export const REGISTRY_SEED = Buffer.from("registry");

export type MarketStatus =
  | "Open"
  | "SettledPending"
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

export const DEMO_MARKETS: DemoMarket[] = [
  {
    id: 0,
    category: "Crypto",
    title: "Will BTC exceed $100k before Q4 2026?",
    description: "Resolves YES if BTC spot price print on Binance exceeds $100,000.",
    resolutionTimestamp: new Date("2026-10-01"),
    status: "Open",
    totalParticipants: 312,
    rules: ["Binance API is the source of truth."],
    resolutionSource: "Binance API",
    timeline: [
      { id: "m0_created", label: "Market created", note: "Question locked on-chain.", timestamp: new Date("2026-02-15"), status: "completed" },
      { id: "m0_open", label: "Positioning", note: "Accepting encrypted bets.", timestamp: new Date("2026-03-01"), status: "active" },
    ],
  }
];

export const DEMO_POSITIONS: DemoPosition[] = [
  {
    id: 1001,
    marketId: 0,
    marketTitle: "Will BTC exceed $100k before Q4 2026?",
    side: "YES",
    stakeSol: 2.8,
    entryOdds: 0.47,
    markOdds: 0.55,
    status: "Open",
    visibility: "public",
    submittedAt: new Date("2026-03-02"),
    choice: true,
  }
];
