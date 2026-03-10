import { randomBytes } from "crypto";
import {
  DEMO_MARKETS,
  DEMO_POSITIONS,
  getPortfolioSummary,
  type DemoMarket,
  type DemoPosition,
  type MarketCategory,
  type MarketStatus,
} from "../../utils/program";
import {
  SettlementDisputeEngine,
  type AddEvidenceInput,
  type DisputeOutcome,
  type OpenDisputeInput,
  type ResolveDisputeInput,
  type SettlementDisputeRecord,
} from "./services/dispute-engine";
import {
  SolanaIndexerWorkerService,
  type AuditLogRecord,
  type IndexerEventRecord,
  type IndexerReconcileReport,
} from "./services/indexer";

// OracleStore is the central in-memory backend coordinator.
// It ties together markets, positions, disputes, and audit/indexer events.
const DEMO_WALLET = "demo_wallet";
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SEEDED_WALLETS = [
  "9xQeWvG816bUx9EPfM5f6K4M6R4xM3aMcMBXNte1qNbf",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
];

interface StoredPosition extends DemoPosition {
  wallet: string;
  encryptedStake?: { c1: number[]; c2: number[] };
  encryptedChoice?: { c1: number[]; c2: number[] };
  txSig?: string;
}

export interface ProbabilityHistoryPoint {
  timestamp: Date;
  yesProbability: number;
  noProbability: number;
  volumeSol: number;
}

export interface ListMarketFilters {
  status?: MarketStatus;
  category?: MarketCategory;
  search?: string;
}

export interface CreateMarketInput {
  title: string;
  description: string;
  resolutionTimestamp: Date;
  category: MarketCategory;
  resolutionSource: string;
  rules: string[];
  creatorWallet: string;
}

export interface ListPositionFilters {
  marketId?: number;
  wallet?: string;
}

export interface SubmitPositionInput {
  marketId: number;
  wallet: string;
  side: "YES" | "NO";
  stakeSol: number;
  encryptedStake?: { c1: number[]; c2: number[] };
  encryptedChoice?: { c1: number[]; c2: number[] };
}

export class OracleStore {
  private markets: DemoMarket[];
  private positions: StoredPosition[];
  private probabilityByMarket = new Map<number, ProbabilityHistoryPoint[]>();
  private disputeEngine = new SettlementDisputeEngine();
  private indexer = new SolanaIndexerWorkerService();
  private nextMarketId: number;
  private nextPositionId: number;

  constructor() {
    this.markets = DEMO_MARKETS.map(cloneMarket);
    this.positions = DEMO_POSITIONS.map((position, index) => ({
      ...clonePosition(position),
      wallet: SEEDED_WALLETS[index % SEEDED_WALLETS.length] ?? DEMO_WALLET,
    }));
    this.nextMarketId = this.markets.reduce((max, market) => Math.max(max, market.id), -1) + 1;
    this.nextPositionId =
      this.positions.reduce((max, position) => Math.max(max, position.id), 1000) + 1;

    this.seedIndexerAndTelemetry();
  }

  // Lists markets with optional filters used by the main discovery page.
  listMarkets(filters: ListMarketFilters = {}): DemoMarket[] {
    const { status, category, search } = filters;
    const normalizedSearch = search?.trim().toLowerCase();
    return this.markets
      .filter((market) => {
        if (status && market.status !== status) return false;
        if (category && market.category !== category) return false;
        if (normalizedSearch) {
          const haystack =
            `${market.title} ${market.description} ${market.resolutionSource}`.toLowerCase();
          return haystack.includes(normalizedSearch);
        }
        return true;
      })
      .sort(
        (left, right) => left.resolutionTimestamp.getTime() - right.resolutionTimestamp.getTime()
      )
      .map(cloneMarket);
  }

  getMarketById(id: number): DemoMarket | null {
    const market = this.markets.find((item) => item.id === id);
    return market ? cloneMarket(market) : null;
  }

  // Creates a new market and emits an indexer event so observers can track it.
  createMarket(input: CreateMarketInput): DemoMarket {
    const id = this.nextMarketId++;
    const now = new Date();
    const market: DemoMarket = {
      id,
      category: input.category,
      title: input.title,
      description: input.description,
      resolutionTimestamp: new Date(input.resolutionTimestamp),
      status: "Open",
      totalParticipants: 0,
      rules: input.rules,
      resolutionSource: input.resolutionSource,
      timeline: [
        {
          id: `m${id}_created`,
          label: "Market created",
          note: `Created by ${truncateWallet(input.creatorWallet)} and criteria locked for settlement.`,
          timestamp: now,
          status: "completed",
        },
        {
          id: `m${id}_open`,
          label: "Positioning window",
          note: "Encrypted stakes and votes accepted by Oracle.",
          timestamp: now,
          status: "active",
        },
        {
          id: `m${id}_settle`,
          label: "MPC settlement",
          note: "Arcium threshold decryption publishes final market outcome.",
          timestamp: new Date(input.resolutionTimestamp),
          status: "upcoming",
        },
      ],
    };

    this.markets.unshift(market);
    this.rebuildProbabilityHistory(market.id);
    this.indexer.consumeEvent({
      marketId: market.id,
      type: "MARKET_CREATED",
      actor: input.creatorWallet,
      details: `Market created: ${market.title}`,
      timestamp: now,
    });

    return cloneMarket(market);
  }

  // Returns positions, optionally narrowed to one market and/or one wallet.
  listPositions(filters: ListPositionFilters = {}): DemoPosition[] {
    const { marketId, wallet } = filters;
    const normalizedWallet = wallet ? normalizeWallet(wallet) : undefined;

    return this.positions
      .filter((position) => {
        if (typeof marketId === "number" && position.marketId !== marketId) return false;
        if (normalizedWallet && position.wallet !== normalizedWallet) return false;
        return true;
      })
      .sort((left, right) => right.submittedAt.getTime() - left.submittedAt.getTime())
      .map(clonePosition);
  }

  // Accepts a new private position and logs a redacted activity event.
  submitPosition(input: SubmitPositionInput): { position: DemoPosition; txSig: string } {
    const market = this.markets.find((item) => item.id === input.marketId);
    if (!market) {
      throw new Error("Market not found.");
    }
    if (market.status !== "Open") {
      throw new Error("Market is not open for new positions.");
    }
    if (market.resolutionTimestamp.getTime() <= Date.now()) {
      throw new Error("Market has passed its resolution date.");
    }

    const id = this.nextPositionId++;
    const normalizedWallet = normalizeWallet(input.wallet);
    const now = new Date();
    const entryOdds = this.estimateEntryOdds(input.marketId, input.side);
    const markOdds = clamp(entryOdds + (input.side === "YES" ? 0.02 : -0.02), 0.05, 0.95);
    const txSig = randomBytes(32).toString("hex");

    const position: StoredPosition = {
      id,
      marketId: market.id,
      marketTitle: market.title,
      side: input.side,
      stakeSol: input.stakeSol,
      entryOdds,
      markOdds,
      status: "Open",
      submittedAt: now,
      wallet: normalizedWallet,
      encryptedStake: input.encryptedStake,
      encryptedChoice: input.encryptedChoice,
      txSig,
    };

    this.positions.unshift(position);
    market.totalParticipants = market.totalParticipants + 1;
    this.rebuildProbabilityHistory(market.id);
    this.indexer.consumeEvent({
      marketId: market.id,
      type: "POSITION_SUBMITTED",
      actor: "private-participant",
      details: "Encrypted position submitted",
      timestamp: now,
      signature: txSig,
    });

    return {
      position: clonePosition(position),
      txSig,
    };
  }

  // Returns wallet-scoped positions plus computed PnL summary metrics.
  getPortfolio(wallet: string): {
    positions: DemoPosition[];
    summary: ReturnType<typeof getPortfolioSummary>;
  } {
    const normalizedWallet = normalizeWallet(wallet);
    const positions = this.positions
      .filter((position) => position.wallet === normalizedWallet)
      .sort((left, right) => right.submittedAt.getTime() - left.submittedAt.getTime())
      .map(clonePosition);

    return {
      positions,
      summary: getPortfolioSummary(positions),
    };
  }

  // Market timeline chart data for probability/price history visualization.
  getMarketProbabilityHistory(marketId: number, limit = 64): ProbabilityHistoryPoint[] {
    const points = this.probabilityByMarket.get(marketId) ?? [];
    return points.slice(-Math.max(1, limit)).map(cloneProbabilityPoint);
  }

  // Public activity feed for a market (already privacy-redacted).
  getMarketActivity(marketId: number, limit = 50): IndexerEventRecord[] {
    return this.indexer.listMarketActivity(marketId, limit);
  }

  // Dispute APIs consume this market-scoped list.
  listMarketDisputes(marketId: number): SettlementDisputeRecord[] {
    return this.disputeEngine.listDisputes(marketId);
  }

  // Opens a dispute and computes stake-at-risk used for slashing math.
  openMarketDispute(input: OpenDisputeInput): SettlementDisputeRecord {
    const market = this.markets.find((item) => item.id === input.marketId);
    if (!market) {
      throw new Error("Market not found.");
    }
    if (market.status === "Cancelled") {
      throw new Error("Cancelled markets do not accept new disputes.");
    }

    const settlementStakeAtRiskSol = this.positions
      .filter((position) => position.marketId === input.marketId)
      .reduce((sum, position) => sum + position.stakeSol, 0);

    const dispute = this.disputeEngine.openDispute({
      ...input,
      contestedResolver: "oracle-mpc-relayer",
      challengeWindowHours: 24,
      settlementStakeAtRiskSol,
    });
    this.indexer.consumeEvent({
      marketId: input.marketId,
      type: "DISPUTE_OPENED",
      actor: "private-participant",
      details: `Dispute opened. Challenge deadline ${dispute.challengeWindow.deadlineAt.toISOString()}.`,
      timestamp: dispute.createdAt,
    });

    return dispute;
  }

  // Adds extra evidence to an existing open dispute.
  addDisputeEvidence(input: AddEvidenceInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.addEvidence(input);
    this.indexer.consumeEvent({
      marketId: dispute.marketId,
      type: "DISPUTE_EVIDENCE_ADDED",
      actor: "private-participant",
      details: "Settlement evidence submitted.",
    });

    return dispute;
  }

  // Resolves dispute and mirrors the outcome back onto market status/timeline.
  resolveDispute(input: ResolveDisputeInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.resolveDispute(input);
    this.indexer.consumeEvent({
      marketId: dispute.marketId,
      type: "DISPUTE_RESOLVED",
      actor: "private-resolver",
      details: `${input.outcome} resolution recorded.`,
      timestamp: dispute.resolution?.resolvedAt,
    });

    if (dispute.slashing) {
      this.indexer.consumeEvent({
        marketId: dispute.marketId,
        type: "DISPUTE_SLASHED",
        actor: "private-resolver",
        details: `Resolver slash executed (${dispute.slashing.slashBps} bps).`,
        timestamp: dispute.slashing.appliedAt,
      });
    }

    const market = this.markets.find((item) => item.id === dispute.marketId);
    if (market) {
      const previousStatus = market.status;
      this.applyDisputeOutcomeToMarket(market, input.outcome);

      if (previousStatus !== market.status) {
        this.indexer.consumeEvent({
          marketId: market.id,
          type: "MARKET_STATUS_CHANGED",
          actor: "private-resolver",
          details: `Status changed: ${previousStatus} -> ${market.status}`,
        });
      }
    }

    return dispute;
  }

  // Append-only audit records used for compliance and post-incident reviews.
  getAuditLog(limit = 200): AuditLogRecord[] {
    return this.indexer.listAuditLog(limit);
  }

  // Health report: compares indexer view against market/dispute current state.
  reconcileIndexerState(): IndexerReconcileReport {
    return this.indexer.reconcileState(
      this.markets.map((market) => ({ id: market.id, status: market.status })),
      this.disputeEngine.listDisputes()
    );
  }

  private applyDisputeOutcomeToMarket(market: DemoMarket, outcome: DisputeOutcome) {
    const now = new Date();
    if (outcome === "MarketInvalid") {
      market.status = "Invalid";
      market.outcome = undefined;
      market.timeline = [
        ...market.timeline.map((step) => ({
          ...step,
          status: step.status === "active" ? "completed" : step.status,
        })),
        {
          id: `m${market.id}_invalid_${now.getTime()}`,
          label: "Invalid market path",
          note: "Settlement challenge accepted. Market marked INVALID and position refunds unlocked.",
          timestamp: now,
          status: "completed",
        },
      ];
      return;
    }
    if (outcome === "MarketCancelled") {
      market.status = "Cancelled";
      market.outcome = undefined;
      market.timeline = [
        ...market.timeline.map((step) => ({
          ...step,
          status: step.status === "active" ? "completed" : step.status,
        })),
        {
          id: `m${market.id}_cancelled_${now.getTime()}`,
          label: "Market cancelled",
          note: "Settlement challenge accepted. Market cancelled and positions eligible for refunds.",
          timestamp: now,
          status: "completed",
        },
      ];
      return;
    }
    if (outcome === "SettlementUpheld" && market.status === "Invalid") {
      market.status = "Settled";
      market.timeline = [
        ...market.timeline.map((step) => ({
          ...step,
          status: step.status === "active" ? "completed" : step.status,
        })),
        {
          id: `m${market.id}_upheld_${now.getTime()}`,
          label: "Settlement upheld",
          note: "Challenge rejected. Market status returned to settled.",
          timestamp: now,
          status: "completed",
        },
      ];
    }
  }

  private estimateEntryOdds(marketId: number, side: "YES" | "NO"): number {
    const marketPositions = this.positions.filter((position) => position.marketId === marketId);
    if (marketPositions.length === 0) return 0.5;

    const yesStake = marketPositions
      .filter((position) => position.side === "YES")
      .reduce((sum, position) => sum + position.stakeSol, 0);
    const noStake = marketPositions
      .filter((position) => position.side === "NO")
      .reduce((sum, position) => sum + position.stakeSol, 0);
    const total = yesStake + noStake;
    if (total === 0) return 0.5;

    const impliedYes = yesStake / total;
    const base = side === "YES" ? impliedYes : 1 - impliedYes;
    const jitter = ((this.nextPositionId % 5) - 2) * 0.01;
    return clamp(Number((base + jitter).toFixed(2)), 0.05, 0.95);
  }

  // Seeds startup telemetry so UI pages have immediate chart/activity content.
  private seedIndexerAndTelemetry() {
    const seedEvents: Array<{
      marketId: number;
      type:
        | "MARKET_CREATED"
        | "POSITION_SUBMITTED"
        | "MARKET_STATUS_CHANGED";
      actor: string;
      details: string;
      timestamp: Date;
    }> = [];

    for (const market of this.markets) {
      const createdAt = market.timeline[0]?.timestamp ?? new Date(market.resolutionTimestamp);
      seedEvents.push({
        marketId: market.id,
        type: "MARKET_CREATED",
        actor: "system",
        details: `Market seeded: ${market.title}`,
        timestamp: createdAt,
      });
      if (market.status !== "Open") {
        seedEvents.push({
          marketId: market.id,
          type: "MARKET_STATUS_CHANGED",
          actor: "system",
          details: `Market status seeded as ${market.status}`,
          timestamp: market.resolutionTimestamp,
        });
      }
    }

    for (const position of this.positions) {
      seedEvents.push({
        marketId: position.marketId,
        type: "POSITION_SUBMITTED",
        actor: "private-participant",
        details: "Encrypted position submitted",
        timestamp: position.submittedAt,
      });
    }

    seedEvents
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .forEach((event) => {
        this.indexer.consumeEvent(event);
      });

    for (const market of this.markets) {
      this.rebuildProbabilityHistory(market.id);
    }
  }

  // Rebuilds chart points whenever position activity changes.
  private rebuildProbabilityHistory(marketId: number) {
    const market = this.markets.find((item) => item.id === marketId);
    if (!market) return;

    const positions = this.positions
      .filter((position) => position.marketId === marketId)
      .sort((left, right) => left.submittedAt.getTime() - right.submittedAt.getTime());

    let yesStake = 0;
    let noStake = 0;
    let totalStake = 0;

    const firstTimestamp =
      positions[0]?.submittedAt ??
      market.timeline[0]?.timestamp ??
      new Date(market.resolutionTimestamp.getTime() - 24 * 60 * 60 * 1000);
    const points: ProbabilityHistoryPoint[] = [
      {
        timestamp: new Date(firstTimestamp.getTime() - 60 * 60 * 1000),
        yesProbability: 50,
        noProbability: 50,
        volumeSol: 0,
      },
    ];

    for (const position of positions) {
      if (position.side === "YES") {
        yesStake += position.stakeSol;
      } else {
        noStake += position.stakeSol;
      }
      totalStake += position.stakeSol;

      const yesProbability = totalStake === 0 ? 50 : Math.round((yesStake / totalStake) * 100);
      points.push({
        timestamp: new Date(position.submittedAt),
        yesProbability,
        noProbability: 100 - yesProbability,
        volumeSol: Number(totalStake.toFixed(2)),
      });
    }

    if (market.status === "Settled" && typeof market.outcome === "boolean") {
      const yesProbability =
        (market.revealedYesStake ?? 0) + (market.revealedNoStake ?? 0) > 0
          ? Math.round(
              ((market.revealedYesStake ?? 0) /
                ((market.revealedYesStake ?? 0) + (market.revealedNoStake ?? 0))) *
                100
            )
          : market.outcome
            ? 100
            : 0;
      points.push({
        timestamp: new Date(market.resolutionTimestamp),
        yesProbability,
        noProbability: 100 - yesProbability,
        volumeSol: Number(totalStake.toFixed(2)),
      });
    }

    while (points.length < 6) {
      const lastPoint = points[points.length - 1];
      const jitter = points.length % 2 === 0 ? 2 : -2;
      const yesProbability = clamp(lastPoint.yesProbability + jitter, 10, 90);
      points.push({
        timestamp: new Date(lastPoint.timestamp.getTime() + 2 * 60 * 60 * 1000),
        yesProbability,
        noProbability: 100 - yesProbability,
        volumeSol: Number((lastPoint.volumeSol + 0.25).toFixed(2)),
      });
    }

    this.probabilityByMarket.set(marketId, points.map(cloneProbabilityPoint));
  }
}

export function normalizeWallet(wallet: string | string[] | undefined): string {
  const value = Array.isArray(wallet) ? wallet[0] : wallet;
  if (!value) return DEMO_WALLET;
  const trimmed = value.trim();
  return WALLET_PATTERN.test(trimmed) ? trimmed : DEMO_WALLET;
}

function truncateWallet(wallet: string): string {
  if (wallet === DEMO_WALLET) return "demo wallet";
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cloneMarket(market: DemoMarket): DemoMarket {
  return {
    ...market,
    resolutionTimestamp: new Date(market.resolutionTimestamp),
    timeline: market.timeline.map((step) => ({
      ...step,
      timestamp: new Date(step.timestamp),
    })),
  };
}

function clonePosition(position: DemoPosition): DemoPosition {
  return {
    ...position,
    submittedAt: new Date(position.submittedAt),
    settledAt: position.settledAt ? new Date(position.settledAt) : undefined,
  };
}

function cloneProbabilityPoint(point: ProbabilityHistoryPoint): ProbabilityHistoryPoint {
  return {
    ...point,
    timestamp: new Date(point.timestamp),
  };
}

type GlobalWithStore = typeof globalThis & {
  __oracleStore?: OracleStore;
};

const globalWithStore = globalThis as GlobalWithStore;

export const store =
  globalWithStore.__oracleStore ?? (globalWithStore.__oracleStore = new OracleStore());
