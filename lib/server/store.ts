import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
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
  type DisputeEngineSnapshot,
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
  type IndexerSnapshot,
} from "./services/indexer";

// OracleStore is the central in-memory backend coordinator.
const DEMO_WALLET = "demo_wallet";
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const COMMITMENT_PATTERN = /^[a-f0-9]{64}$/i;
const SEEDED_WALLETS = [
  "9xQeWvG816bUx9EPfM5f6K4M6R4xM3aMcMBXNte1qNbf",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
];
const POSITION_BATCH_DELAY_MS = 45_000;
const POSITION_BATCH_JITTER_MS = 12_000;

// [ARCHITECT UPGRADE] - Incremented version for new schema
const CURRENT_STORE_VERSION = 2; 

const STORE_PATH_ENV = "ORACLE_STORE_PATH";
const DEFAULT_STORE_PATH = "mnt/oracle-store.json";

interface StoredPosition extends DemoPosition {
  wallet: string;
  commitment: string;
  sealedAt: Date;
  pendingUntil?: Date;
  encryptedStake?: { c1: number[]; c2: number[] };
  encryptedChoice?: { c1: number[]; c2: number[] };
  txSig?: string;
  version: number; // Added versioning
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

interface StoreSnapshot {
  version: number;
  savedAt: string;
  markets: SerializedMarket[];
  positions: SerializedPosition[];
  probabilityByMarket: Array<{ marketId: number; points: SerializedProbabilityPoint[] }>;
  telemetryByMarket: Array<{ marketId: number; events: SerializedTelemetryEvent[] }>;
  pendingTelemetry: SerializedPendingTelemetryEvent[];
  nextMarketId: number;
  nextPositionId: number;
  disputeEngine: DisputeEngineSnapshot;
  indexer: IndexerSnapshot;
}

interface SerializedMarket extends Omit<DemoMarket, "resolutionTimestamp" | "timeline"> {
  resolutionTimestamp: string;
  version: number;
  timeline: Array<{
    id: string;
    label: string;
    note: string;
    timestamp: string;
    status: "completed" | "active" | "upcoming";
  }>;
}

interface SerializedPosition extends Omit<StoredPosition, "submittedAt" | "settledAt" | "sealedAt" | "pendingUntil"> {
  submittedAt: string;
  settledAt?: string;
  sealedAt: string;
  pendingUntil?: string;
  version: number;
}

interface SerializedProbabilityPoint {
  timestamp: string;
  yesProbability: number;
  noProbability: number;
  volumeSol: number;
}

interface SerializedTelemetryEvent {
  marketId: number;
  timestamp: string;
  yesDelta: number;
  noDelta: number;
  volumeSol: number;
  source: PositionVisibility;
}

interface SerializedPendingTelemetryEvent extends SerializedTelemetryEvent {
  releaseAt: string;
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

// [ARCHITECT UPGRADE] - Graceful Schema Migrations
function migrateSnapshot(snapshot: any): StoreSnapshot {
  let data = { ...snapshot };

  // v1 -> v2 Migration
  if (data.version === 1) {
    console.log("[oracle-store] Migrating snapshot from v1 to v2...");
    
    // Add version field to all markets
    data.markets = data.markets.map((m: any) => ({
      ...m,
      version: 1
    }));

    // Add version field to all positions
    data.positions = data.positions.map((p: any) => ({
      ...p,
      version: 1
    }));

    data.version = 2;
  }

  return data as StoreSnapshot;
}

export class OracleStore {
  private markets: (DemoMarket & { version: number })[] = [];
  private positions: StoredPosition[] = [];
  private probabilityByMarket = new Map<number, ProbabilityHistoryPoint[]>();
  private telemetryByMarket = new Map<number, TelemetryEvent[]>();
  private pendingTelemetry: PendingTelemetryEvent[] = [];
  private disputeEngine = new SettlementDisputeEngine();
  private indexer = new SolanaIndexerWorkerService();
  private nextMarketId: number;
  private nextPositionId: number;
  private persistencePath?: string;

  constructor() {
    this.persistencePath = resolvePersistencePath();
    const rawSnapshot = this.persistencePath ? loadRawSnapshot(this.persistencePath) : null;
    
    if (rawSnapshot) {
      const snapshot = migrateSnapshot(rawSnapshot);
      this.applySnapshot(snapshot);
      return;
    }

    this.seedDemoData();
  }

  private seedDemoData() {
    this.markets = DEMO_MARKETS.map(m => ({ ...cloneMarket(m), version: 1 }));
    this.positions = DEMO_POSITIONS.map((position, index) => {
      const cloned = clonePosition(position);
      return {
        ...cloned,
        wallet: SEEDED_WALLETS[index % SEEDED_WALLETS.length] ?? DEMO_WALLET,
        commitment: commitmentForSeed(cloned.id, cloned.marketId, cloned.submittedAt),
        sealedAt: new Date(cloned.submittedAt),
        version: 1
      };
    });
    this.nextMarketId = this.markets.reduce((max, market) => Math.max(max, market.id), -1) + 1;
    this.nextPositionId =
      this.positions.reduce((max, position) => Math.max(max, position.id), 1000) + 1;

    this.seedIndexerAndTelemetry();
    this.persistSnapshot();
  }

  private applySnapshot(snapshot: StoreSnapshot) {
    this.markets = snapshot.markets.map(deserializeMarketSnapshot);
    this.positions = snapshot.positions.map(deserializePositionSnapshot);
    this.probabilityByMarket = new Map(
      snapshot.probabilityByMarket.map((entry) => [
        entry.marketId,
        entry.points.map(deserializeProbabilityPointSnapshot),
      ])
    );
    this.telemetryByMarket = new Map(
      snapshot.telemetryByMarket.map((entry) => [
        entry.marketId,
        entry.events.map(deserializeTelemetryEventSnapshot),
      ])
    );
    this.pendingTelemetry = snapshot.pendingTelemetry.map(deserializePendingTelemetrySnapshot);
    this.nextMarketId = snapshot.nextMarketId;
    this.nextPositionId = snapshot.nextPositionId;
    this.disputeEngine.restore(snapshot.disputeEngine);
    this.indexer.restore(snapshot.indexer);
  }

  private buildSnapshot(): StoreSnapshot {
    return {
      version: CURRENT_STORE_VERSION,
      savedAt: new Date().toISOString(),
      markets: this.markets.map(serializeMarketSnapshot),
      positions: this.positions.map(serializePositionSnapshot),
      probabilityByMarket: Array.from(this.probabilityByMarket.entries()).map(
        ([marketId, points]) => ({
          marketId,
          points: points.map(serializeProbabilityPointSnapshot),
        })
      ),
      telemetryByMarket: Array.from(this.telemetryByMarket.entries()).map(([marketId, events]) => ({
        marketId,
        events: events.map(serializeTelemetryEventSnapshot),
      })),
      pendingTelemetry: this.pendingTelemetry.map(serializePendingTelemetrySnapshot),
      nextMarketId: this.nextMarketId,
      nextPositionId: this.nextPositionId,
      disputeEngine: this.disputeEngine.snapshot(),
      indexer: this.indexer.snapshot(),
    };
  }

  private persistSnapshot() {
    if (!this.persistencePath) return;
    saveStoreSnapshot(this.persistencePath, this.buildSnapshot());
  }

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

  createMarket(input: CreateMarketInput): DemoMarket {
    const id = this.nextMarketId++;
    const now = new Date();
    const market: DemoMarket & { version: number } = {
      id,
      category: input.category,
      title: input.title,
      description: input.description,
      resolutionTimestamp: new Date(input.resolutionTimestamp),
      status: "Open",
      totalParticipants: 0,
      rules: input.rules,
      resolutionSource: input.resolutionSource,
      version: 1, // New markets start at current schema version
      timeline: [
        {
          id: `m${id}_created`,
          label: "Market created",
          note: `Created by ${truncateWallet(input.creatorWallet)}`,
          timestamp: now,
          status: "completed",
        },
        {
          id: `m${id}_open`,
          label: "Positioning window",
          note: "Encrypted stakes and votes accepted.",
          timestamp: now,
          status: "active",
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

    this.persistSnapshot();
    return cloneMarket(market);
  }

  submitPosition(input: SubmitPositionInput): { position: DemoPosition; txSig: string } {
    const market = this.markets.find((item) => item.id === input.marketId);
    if (!market) throw new Error("Market not found.");

    const normalizedWallet = normalizeWallet(input.wallet);
    const now = new Date();
    const id = this.nextPositionId++;
    const txSig = randomBytes(32).toString("hex");
    const pendingUntil = new Date(now.getTime() + POSITION_BATCH_DELAY_MS);

    const position: StoredPosition = {
      id,
      marketId: market.id,
      marketTitle: market.title,
      side: "ENCRYPTED",
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
      version: 1
    };

    this.positions.unshift(position);
    market.totalParticipants = market.totalParticipants + 1;
    this.indexer.consumeEvent({
      marketId: market.id,
      type: "POSITION_COMMITTED",
      actor: "private-participant",
      details: "Encrypted position queued.",
      timestamp: now,
      signature: txSig,
    });

    this.persistSnapshot();
    return {
      position: clonePosition(position),
      txSig,
    };
  }

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

  getMarketProbabilityHistory(marketId: number, limit = 64): ProbabilityHistoryPoint[] {
    this.flushPendingTelemetry();
    const points = this.probabilityByMarket.get(marketId) ?? [];
    return points.slice(-Math.max(1, limit)).map(cloneProbabilityPoint);
  }

  getMarketActivity(marketId: number, limit = 50): IndexerEventRecord[] {
    this.flushPendingTelemetry();
    return this.indexer.listMarketActivity(marketId, limit);
  }

  private appendTelemetry(event: TelemetryEvent) {
    const list = this.telemetryByMarket.get(event.marketId) ?? [];
    list.push({ ...event, timestamp: new Date(event.timestamp) });
    this.telemetryByMarket.set(event.marketId, list);
  }

  private flushPendingTelemetry(reference = new Date()) {
    if (this.pendingTelemetry.length === 0) return;
    const ready = this.pendingTelemetry.filter(e => e.releaseAt.getTime() <= reference.getTime());
    this.pendingTelemetry = this.pendingTelemetry.filter(e => e.releaseAt.getTime() > reference.getTime());
    
    if (ready.length === 0) return;

    for (const event of ready) {
      this.appendTelemetry(event);
      this.indexer.consumeEvent({
        marketId: event.marketId,
        type: "POSITION_BATCHED",
        actor: "private-participant",
        details: "Encrypted position batched.",
        timestamp: event.releaseAt,
      });
    }

    const touchedMarkets = new Set(ready.map(e => e.marketId));
    for (const marketId of touchedMarkets) {
      this.rebuildProbabilityHistory(marketId);
    }

    this.persistSnapshot();
  }

  listMarketDisputes(marketId: number): SettlementDisputeRecord[] {
    return this.disputeEngine.listDisputes(marketId);
  }

  openMarketDispute(input: OpenDisputeInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.openDispute({
      ...input,
      contestedResolver: "oracle-mpc-relayer",
      challengeWindowHours: 24,
      settlementStakeAtRiskSol: 0,
    });
    this.indexer.consumeEvent({
      marketId: input.marketId,
      type: "DISPUTE_OPENED",
      actor: "private-participant",
      details: "Dispute opened.",
      timestamp: dispute.createdAt,
    });
    this.persistSnapshot();
    return dispute;
  }

  addDisputeEvidence(input: AddEvidenceInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.addEvidence(input);
    this.indexer.consumeEvent({
      marketId: dispute.marketId,
      type: "DISPUTE_EVIDENCE_ADDED",
      actor: "private-participant",
      details: "Evidence submitted.",
    });
    this.persistSnapshot();
    return dispute;
  }

  resolveDispute(input: ResolveDisputeInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.resolveDispute(input);
    this.indexer.consumeEvent({
      marketId: dispute.marketId,
      type: "DISPUTE_RESOLVED",
      actor: "private-resolver",
      details: "Dispute resolved.",
      timestamp: dispute.resolution?.resolvedAt,
    });
    this.persistSnapshot();
    return dispute;
  }

  getAuditLog(limit = 200): AuditLogRecord[] {
    return this.indexer.listAuditLog(limit);
  }

  reconcileIndexerState(): IndexerReconcileReport {
    return this.indexer.reconcileState(
      this.markets.map((market) => ({ id: market.id, status: market.status })),
      this.disputeEngine.listDisputes()
    );
  }

  private rebuildProbabilityHistory(marketId: number) {
    const market = this.markets.find((item) => item.id === marketId);
    if (!market) return;
    this.probabilityByMarket.set(marketId, []); // Simplified for now
  }
}

function resolvePersistencePath(): string | undefined {
  const configured = process.env[STORE_PATH_ENV]?.trim();
  if (configured) return resolve(configured);
  if (process.env.NODE_ENV === "development") return resolve(DEFAULT_STORE_PATH);
  return undefined;
}

function loadRawSnapshot(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function saveStoreSnapshot(path: string, snapshot: StoreSnapshot): void {
  try {
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    console.error("[oracle-store] Failed to persist snapshot.", error);
  }
}

function serializeMarketSnapshot(market: DemoMarket & { version: number }): SerializedMarket {
  return {
    ...market,
    resolutionTimestamp: market.resolutionTimestamp.toISOString(),
    version: market.version,
    timeline: market.timeline.map((step) => ({
      ...step,
      timestamp: step.timestamp.toISOString(),
    })),
  };
}

function deserializeMarketSnapshot(market: SerializedMarket): DemoMarket & { version: number } {
  return {
    ...market,
    resolutionTimestamp: new Date(market.resolutionTimestamp),
    version: market.version,
    timeline: market.timeline.map((step) => ({
      ...step,
      timestamp: new Date(step.timestamp),
    })),
  };
}

function serializePositionSnapshot(position: StoredPosition): SerializedPosition {
  return {
    ...position,
    submittedAt: position.submittedAt.toISOString(),
    sealedAt: position.sealedAt.toISOString(),
    version: position.version
  };
}

function deserializePositionSnapshot(position: SerializedPosition): StoredPosition {
  return {
    ...position,
    submittedAt: new Date(position.submittedAt),
    sealedAt: new Date(position.sealedAt),
    version: position.version
  };
}

function deserializeProbabilityPointSnapshot(point: SerializedProbabilityPoint): ProbabilityHistoryPoint {
  return { ...point, timestamp: new Date(point.timestamp) };
}

function serializeProbabilityPointSnapshot(point: ProbabilityHistoryPoint): SerializedProbabilityPoint {
  return { ...point, timestamp: point.timestamp.toISOString() };
}

function deserializeTelemetryEventSnapshot(event: SerializedTelemetryEvent): TelemetryEvent {
  return { ...event, timestamp: new Date(event.timestamp) };
}

function serializeTelemetryEventSnapshot(event: TelemetryEvent): SerializedTelemetryEvent {
  return { ...event, timestamp: event.timestamp.toISOString() };
}

function deserializePendingTelemetrySnapshot(event: SerializedPendingTelemetryEvent): PendingTelemetryEvent {
  return { ...event, timestamp: new Date(event.timestamp), releaseAt: new Date(event.releaseAt) };
}

function serializePendingTelemetrySnapshot(event: PendingTelemetryEvent): SerializedPendingTelemetryEvent {
  return { ...event, timestamp: event.timestamp.toISOString(), releaseAt: event.releaseAt.toISOString() };
}

function isValidWalletAddress(wallet: string): boolean {
  return WALLET_PATTERN.test(wallet);
}

function truncateWallet(wallet: string): string {
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

function commitmentForSeed(id: number, marketId: number, timestamp: Date): string {
  return createHash("sha256").update(`${marketId}:${id}:${timestamp.toISOString()}`).digest("hex");
}

function cloneMarket(market: DemoMarket): DemoMarket {
  return {
    ...market,
    resolutionTimestamp: new Date(market.resolutionTimestamp),
    timeline: market.timeline.map((step) => ({ ...step, timestamp: new Date(step.timestamp) })),
  };
}

function clonePosition(position: DemoPosition): DemoPosition {
  return { ...position, submittedAt: new Date(position.submittedAt) };
}

function cloneProbabilityPoint(point: ProbabilityHistoryPoint): ProbabilityHistoryPoint {
  return { ...point, timestamp: new Date(point.timestamp) };
}

type GlobalWithStore = typeof globalThis & { __oracleStore?: OracleStore };
const globalWithStore = globalThis as GlobalWithStore;
export const store = globalWithStore.__oracleStore ?? (globalWithStore.__oracleStore = new OracleStore());
