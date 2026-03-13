import { createHash, randomBytes } from "crypto";
import {
  DEMO_MARKETS,
  DEMO_POSITIONS,
  getPortfolioSummary,
  type DemoMarket,
  type DemoPosition,
  type MarketCategory,
  type MarketStatus,
  type PositionSide,
  type PositionVisibility,
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
const POSITION_BATCH_DELAY_MS = 45_000;
const POSITION_BATCH_JITTER_MS = 12_000;

interface StoredPosition extends DemoPosition {
  wallet: string;
  commitment: string;
  sealedAt: Date;
  pendingUntil?: Date;
  encryptedStake?: { c1: number[]; c2: number[] };
  encryptedChoice?: { c1: number[]; c2: number[] };
  txSig?: string;
}

interface TelemetryEvent {
  marketId: number;
  timestamp: Date;
  yesDelta: number;
  noDelta: number;
  volumeSol: number;
  source: PositionVisibility;
}

interface PendingTelemetryEvent extends TelemetryEvent {
  releaseAt: Date;
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
  commitment: string;
  sealedAt: Date;
  encryptedStake?: { c1: number[]; c2: number[] };
  encryptedChoice?: { c1: number[]; c2: number[] };
}

export class OracleStore {
  private markets: DemoMarket[];
  private positions: StoredPosition[];
  private probabilityByMarket = new Map<number, ProbabilityHistoryPoint[]>();
  private telemetryByMarket = new Map<number, TelemetryEvent[]>();
  private pendingTelemetry: PendingTelemetryEvent[] = [];
  private disputeEngine = new SettlementDisputeEngine();
  private indexer = new SolanaIndexerWorkerService();
  private nextMarketId: number;
  private nextPositionId: number;

  constructor() {
    this.markets = DEMO_MARKETS.map(cloneMarket);
    this.positions = DEMO_POSITIONS.map((position, index) => {
      const cloned = clonePosition(position);
      return {
        ...cloned,
        wallet: SEEDED_WALLETS[index % SEEDED_WALLETS.length] ?? DEMO_WALLET,
        commitment: commitmentForSeed(cloned.id, cloned.marketId, cloned.submittedAt),
        sealedAt: new Date(cloned.submittedAt),
      };
    });
    this.nextMarketId = this.markets.reduce((max, market) => Math.max(max, market.id), -1) + 1;
    this.nextPositionId =
      this.positions.reduce((max, position) => Math.max(max, position.id), 1000) + 1;

    this.seedIndexerAndTelemetry();
  }

  // Lists markets with optional filters used by the main discovery page.
  listMarkets(filters: ListMarketFilters = {}): DemoMarket[] {
    this.flushPendingTelemetry();
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
    this.flushPendingTelemetry();
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
    this.flushPendingTelemetry();
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

    const normalizedWallet = normalizeWallet(input.wallet);
    const now = new Date();
    const id = this.nextPositionId++;
    const txSig = randomBytes(32).toString("hex");
    const pendingUntil = new Date(
      now.getTime() +
        POSITION_BATCH_DELAY_MS +
        Math.floor(Math.random() * POSITION_BATCH_JITTER_MS)
    );

    const position: StoredPosition = {
      id,
      marketId: market.id,
      marketTitle: market.title,
      side: "ENCRYPTED",
      stakeSol: undefined,
      entryOdds: undefined,
      markOdds: undefined,
      status: "Open",
      visibility: "encrypted",
      submittedAt: now,
      wallet: normalizedWallet,
      commitment: input.commitment,
      sealedAt: new Date(input.sealedAt),
      pendingUntil,
      encryptedStake: input.encryptedStake,
      encryptedChoice: input.encryptedChoice,
      txSig,
    };

    this.positions.unshift(position);
    market.totalParticipants = market.totalParticipants + 1;
    this.queueTelemetryFromCommitment(market.id, input.commitment, now, pendingUntil);
    this.indexer.consumeEvent({
      marketId: market.id,
      type: "POSITION_COMMITTED",
      actor: "private-participant",
      details: "Encrypted position queued for private batch.",
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
    this.flushPendingTelemetry();
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
    this.flushPendingTelemetry();
    const points = this.probabilityByMarket.get(marketId) ?? [];
    return points.slice(-Math.max(1, limit)).map(cloneProbabilityPoint);
  }

  // Public activity feed for a market (already privacy-redacted).
  getMarketActivity(marketId: number, limit = 50): IndexerEventRecord[] {
    this.flushPendingTelemetry();
    return this.indexer.listMarketActivity(marketId, limit);
  }

  private queueTelemetryFromCommitment(
    marketId: number,
    commitment: string,
    timestamp: Date,
    releaseAt: Date
  ) {
    const derived = deriveTelemetryFromCommitment(commitment);
    const event: PendingTelemetryEvent = {
      marketId,
      timestamp,
      yesDelta: derived.side === "YES" ? derived.volumeSol : 0,
      noDelta: derived.side === "NO" ? derived.volumeSol : 0,
      volumeSol: derived.volumeSol,
      source: "encrypted",
      releaseAt,
    };
    this.pendingTelemetry.push(event);
  }

  private appendTelemetry(event: TelemetryEvent) {
    const list = this.telemetryByMarket.get(event.marketId) ?? [];
    list.push({
      ...event,
      timestamp: new Date(event.timestamp),
    });
    this.telemetryByMarket.set(event.marketId, list);
  }

  private flushPendingTelemetry(reference = new Date()) {
    if (this.pendingTelemetry.length === 0) return;
    const ready: PendingTelemetryEvent[] = [];
    const pending: PendingTelemetryEvent[] = [];
    for (const event of this.pendingTelemetry) {
      if (event.releaseAt.getTime() <= reference.getTime()) {
        ready.push(event);
      } else {
        pending.push(event);
      }
    }
    this.pendingTelemetry = pending;
    if (ready.length === 0) return;

    const touchedMarkets = new Set<number>();
    for (const event of ready) {
      this.appendTelemetry(event);
      touchedMarkets.add(event.marketId);
      this.indexer.consumeEvent({
        marketId: event.marketId,
        type: "POSITION_BATCHED",
        actor: "private-participant",
        details: "Encrypted position batched into private pool.",
        timestamp: event.releaseAt,
      });
    }

    for (const marketId of touchedMarkets) {
      this.rebuildProbabilityHistory(marketId);
    }
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
      .reduce((sum, position) => sum + (position.stakeSol ?? 0), 0);

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
    const normalizedTimeline = finalizeActiveTimeline(market.timeline);
    if (outcome === "MarketInvalid") {
      market.status = "Invalid";
      market.outcome = undefined;
      market.timeline = [
        ...normalizedTimeline,
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
        ...normalizedTimeline,
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
        ...normalizedTimeline,
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

  // Seeds startup telemetry so UI pages have immediate chart/activity content.
  private seedIndexerAndTelemetry() {
    const seedEvents: Array<{
      marketId: number;
      type:
        | "MARKET_CREATED"
        | "POSITION_BATCHED"
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
      const telemetry =
        position.visibility === "public" && position.side !== "ENCRYPTED"
          ? {
              side: position.side,
              volumeSol: position.stakeSol ?? 0,
            }
          : deriveTelemetryFromCommitment(position.commitment);

      this.appendTelemetry({
        marketId: position.marketId,
        timestamp: position.submittedAt,
        yesDelta: telemetry.side === "YES" ? telemetry.volumeSol : 0,
        noDelta: telemetry.side === "NO" ? telemetry.volumeSol : 0,
        volumeSol: telemetry.volumeSol,
        source: position.visibility,
      });

      seedEvents.push({
        marketId: position.marketId,
        type: "POSITION_BATCHED",
        actor: "private-participant",
        details: "Encrypted position batched",
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

    const events = (this.telemetryByMarket.get(marketId) ?? [])
      .slice()
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

    let yesStake = 0;
    let noStake = 0;
    let totalStake = 0;

    const firstTimestamp =
      events[0]?.timestamp ??
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

    for (const event of events) {
      yesStake += event.yesDelta;
      noStake += event.noDelta;
      totalStake += event.volumeSol;

      const yesProbability = totalStake === 0 ? 50 : Math.round((yesStake / totalStake) * 100);
      points.push({
        timestamp: new Date(event.timestamp),
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
  return isValidWalletAddress(trimmed) ? trimmed : DEMO_WALLET;
}

// Validates wallet addresses to avoid leaking demo data on malformed input.
export function isValidWalletAddress(wallet: string): boolean {
  return WALLET_PATTERN.test(wallet);
}

function truncateWallet(wallet: string): string {
  if (wallet === DEMO_WALLET) return "demo wallet";
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function commitmentForSeed(id: number, marketId: number, timestamp: Date): string {
  return createHash("sha256")
    .update(`${marketId}:${id}:${timestamp.toISOString()}`)
    .digest("hex");
}

function deriveTelemetryFromCommitment(commitment: string): {
  side: PositionSide;
  volumeSol: number;
} {
  const hash = createHash("sha256").update(commitment).digest();
  const side: PositionSide = hash[0] % 2 === 0 ? "YES" : "NO";
  const volumeSol = Number((((hash[1] % 9) + 2) / 10).toFixed(2));
  return { side, volumeSol };
}

// Close any active timeline step before appending terminal events.
function finalizeActiveTimeline(timeline: DemoMarket["timeline"]): DemoMarket["timeline"] {
  return timeline.map((step) => ({
    ...step,
    status: step.status === "active" ? "completed" : step.status,
  }));
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
