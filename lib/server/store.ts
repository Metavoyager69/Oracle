import { createHash, randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { promises as fs } from "fs";
import { dirname, resolve } from "path";
import {
  DEMO_MARKETS,
  getPortfolioSummary,
  type MarketCategory,
  type MarketStatus,
} from "../../utils/program";
import {
  SolanaIndexerWorkerService,
  type IndexerSnapshot,
  type AuditLogRecord,
  type IndexerReconcileReport,
  type IndexerEventRecord
} from "./services/indexer";
import {
  SettlementDisputeEngine,
  type AddEvidenceInput,
  type DisputeEngineSnapshot,
  type OpenDisputeInput,
  type ResolveDisputeInput,
  type SettlementDisputeRecord,
} from "./services/dispute-engine";

// [ISSUE 5 FIX] - Incremented version for new schema
const CURRENT_STORE_VERSION = 3; 

const STORE_PATH_ENV = "ORACLE_STORE_PATH";
// [ISSUE 9 FIX] - Use absolute path from project root to ensure consistency across dev/prod
const PROJECT_ROOT = process.cwd();
const DEFAULT_STORE_PATH = resolve(PROJECT_ROOT, "data", "oracle-store.json");
const SNAPSHOT_DEBOUNCE_MS = 750;
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
let pendingSnapshot: StoreSnapshot | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let missingPersistenceWarned = false;

// [ISSUES 1, 2, 3, 4 FIX] - Strict typing for all data structures
export interface StoredMarket {
  id: number;
  creator: string;
  title: string;
  description: string;
  resolutionTimestamp: string;
  category: MarketCategory;
  status: MarketStatus;
  totalParticipants: number;
  rules: string[];
  resolutionSource: string;
  outcome?: boolean;
  revealedYesStake?: number;
  revealedNoStake?: number;
  version: number;
}

export interface StoredPosition {
  id: number;
  marketId: number;
  marketTitle: string;
  wallet: string;
  commitment: string;
  encryptedStake?: { c1: number[]; c2: number[] };
  encryptedChoice?: { c1: number[]; c2: number[] };
  submittedAt: Date;
  claimed: boolean;
  version: number;
}

export interface StoreSnapshot {
  version: number;
  savedAt: string;
  checksum?: string;
  markets: StoredMarket[];
  positions: StoredPosition[];
  nextMarketId: number;
  nextPositionId: number;
  authority: string; // The protocol admin wallet
  disputeEngine?: DisputeEngineSnapshot;
  indexer: IndexerSnapshot; // [Tier 3] Re-integrated indexer state
}

export interface ListMarketFilters {
  status?: MarketStatus;
  category?: MarketCategory;
  search?: string;
}

export interface SubmitPositionInput {
  marketId: number;
  wallet: string;
  commitment: string;
  encryptedStake?: { c1: number[]; c2: number[] };
  encryptedChoice?: { c1: number[]; c2: number[] };
}

export class OracleStore {
  private markets: StoredMarket[] = [];
  private positions: StoredPosition[] = [];
  private disputeEngine = new SettlementDisputeEngine();
  private indexer = new SolanaIndexerWorkerService();
  private nextMarketId: number = 0;
  private nextPositionId: number = 1000;
  private authority: string = "9xQeWvG816bUx9EPfM5f6K4M6R4xM3aMcMBXNte1qNbf"; // Default dev authority
  private persistencePath?: string;

  constructor() {
    this.persistencePath = resolvePersistencePath();
    const snapshot = this.persistencePath ? loadSnapshot(this.persistencePath) : null;
    
    if (snapshot) {
      if (snapshot.version < CURRENT_STORE_VERSION) {
        console.log(`[oracle-store] Migrating from version ${snapshot.version} to ${CURRENT_STORE_VERSION}`);
      }
      this.applySnapshot(snapshot);
    } else {
      this.seedDemoData();
    }
  }

  private seedDemoData() {
    this.markets = DEMO_MARKETS.map(m => ({
      id: m.id,
      creator: "SYSTEM",
      title: m.title,
      description: m.description,
      resolutionTimestamp: m.resolutionTimestamp.toISOString(),
      category: m.category,
      status: m.status,
      totalParticipants: m.totalParticipants,
      rules: m.rules,
      resolutionSource: m.resolutionSource,
      outcome: m.outcome,
      revealedYesStake: m.revealedYesStake,
      revealedNoStake: m.revealedNoStake,
      version: 1
    }));
    this.nextMarketId = this.markets.reduce((max, market) => Math.max(max, market.id), -1) + 1;
    
    // Seed initial events with placeholder slot
    for (const m of this.markets) {
      this.indexer.consumeEvent({
        marketId: m.id,
        type: "MARKET_CREATED",
        actor: "system",
        details: `Seeded market: ${m.title}`,
        slot: 0,
        signature: "GENESIS"
      });
    }
    
    this.persistSnapshot();
  }

  private applySnapshot(snapshot: StoreSnapshot) {
    this.markets = snapshot.markets;
    this.positions = snapshot.positions.map(p => ({
      ...p,
      submittedAt: new Date(p.submittedAt)
    }));
    this.nextMarketId = snapshot.nextMarketId;
    this.nextPositionId = snapshot.nextPositionId;
    this.authority = snapshot.authority || this.authority;
    if (snapshot.disputeEngine) {
      this.disputeEngine.restore(snapshot.disputeEngine);
    }
    if (snapshot.indexer) {
      this.indexer.restore(snapshot.indexer);
    }
  }

  private buildSnapshot(): StoreSnapshot {
    return {
      version: CURRENT_STORE_VERSION,
      savedAt: new Date().toISOString(),
      markets: this.markets,
      positions: this.positions,
      nextMarketId: this.nextMarketId,
      nextPositionId: this.nextPositionId,
      authority: this.authority,
      disputeEngine: this.disputeEngine.snapshot(),
      indexer: this.indexer.snapshot(),
    };
  }

  private persistSnapshot() {
    if (!this.persistencePath) {
      if (!missingPersistenceWarned) {
        console.warn("[oracle-store] Persistence disabled. Set ORACLE_STORE_PATH in production to avoid data loss.");
        missingPersistenceWarned = true;
      }
      return;
    }
    queueSnapshotSave(this.persistencePath, this.buildSnapshot());
  }

  getRegistryAuthority(): string {
    return this.authority;
  }

  listMarkets(filters: ListMarketFilters = {}): StoredMarket[] {
    const query = filters.search?.trim().toLowerCase();
    return this.markets.filter((market) => {
      const status = market.status ?? "Open";
      const category = market.category ?? "Crypto";
      if (filters.status && status !== filters.status) return false;
      if (filters.category && category !== filters.category) return false;
      if (query) {
        const haystack = `${market.title} ${market.description}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  getMarketById(id: number): StoredMarket | null {
    return this.markets.find(m => m.id === id) || null;
  }

  createMarket(input: {
    title: string;
    description: string;
    category: MarketCategory;
    resolutionTimestamp: Date;
    resolutionSource: string;
    rules: string[];
    creatorWallet: string;
  }): StoredMarket {
    const market: StoredMarket = {
      id: this.nextMarketId++,
      creator: input.creatorWallet,
      title: input.title,
      description: input.description,
      resolutionTimestamp: input.resolutionTimestamp.toISOString(),
      category: input.category,
      status: "Open",
      totalParticipants: 0,
      rules: input.rules,
      resolutionSource: input.resolutionSource,
      version: CURRENT_STORE_VERSION,
    };
    this.markets.unshift(market);
    this.indexer.consumeEvent({
      marketId: market.id,
      type: "MARKET_CREATED",
      actor: input.creatorWallet,
      details: `Market created: ${market.title}`,
      slot: 0,
      signature: randomBytes(32).toString("hex"),
    });
    this.persistSnapshot();
    return market;
  }

  listPositions(filters: { marketId?: number; wallet?: string } = {}): StoredPosition[] {
    return this.positions.filter(p => {
      if (filters.marketId !== undefined && p.marketId !== filters.marketId) return false;
      if (filters.wallet !== undefined && p.wallet !== filters.wallet) return false;
      return true;
    });
  }

  submitPosition(input: SubmitPositionInput): { position: StoredPosition; txSig: string } {
    const txSig = randomBytes(32).toString("hex");
    const market = this.getMarketById(input.marketId);
    if (!market) {
      throw new Error("Market not found.");
    }
    const position: StoredPosition = {
      id: this.nextPositionId++,
      marketId: input.marketId,
      marketTitle: market.title,
      wallet: input.wallet,
      commitment: input.commitment,
      encryptedStake: input.encryptedStake,
      encryptedChoice: input.encryptedChoice,
      submittedAt: new Date(),
      claimed: false,
      version: CURRENT_STORE_VERSION,
    };
    this.positions.push(position);
    market.totalParticipants = (market.totalParticipants ?? 0) + 1;
    
    // Log the event through the indexer
    this.indexer.consumeEvent({
      marketId: input.marketId,
      type: "POSITION_COMMITTED",
      actor: input.wallet,
      details: "Private position submitted.",
      slot: 0, // Placeholder until indexer worker pushes real data
      signature: txSig
    });

    this.persistSnapshot();
    return { position, txSig };
  }

  getPortfolio(wallet: string): { positions: StoredPosition[]; summary: any } {
    const positions = this.listPositions({ wallet });
    return {
      positions,
      summary: getPortfolioSummary(positions as any),
    };
  }

  // [Tier 3] Re-integrated indexer methods for observability dashboard
  getAuditLog(limit = 200): AuditLogRecord[] {
    return this.indexer.listAuditLog(limit);
  }

  reconcileIndexerState(): IndexerReconcileReport {
    return this.indexer.reconcileState();
  }

  getMarketActivity(marketId: number, limit = 50): IndexerEventRecord[] {
    return this.indexer.listMarketActivity(marketId, limit);
  }

  getMarketProbabilityHistory(_marketId: number, _limit = 96): Array<{ timestamp: Date; yesProbability: number; noProbability: number; volumeSol: number }> {
    return [];
  }

  listMarketDisputes(marketId: number): SettlementDisputeRecord[] {
    return this.disputeEngine.listDisputes(marketId);
  }

  listDisputes(): SettlementDisputeRecord[] {
    return this.disputeEngine.listDisputes();
  }

  openMarketDispute(input: OpenDisputeInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.openDispute(input);
    this.persistSnapshot();
    return dispute;
  }

  addDisputeEvidence(input: AddEvidenceInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.addEvidence(input);
    this.persistSnapshot();
    return dispute;
  }

  resolveDispute(input: ResolveDisputeInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.resolveDispute(input);
    this.persistSnapshot();
    return dispute;
  }
}

function resolvePersistencePath(): string | undefined {
  const configured = process.env[STORE_PATH_ENV]?.trim();
  if (configured) return resolve(configured);
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
    return DEFAULT_STORE_PATH;
  }
  return undefined;
}

function loadSnapshot(path: string): StoreSnapshot | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf8");
    const snapshot = JSON.parse(content) as StoreSnapshot;
    
    if (snapshot.checksum) {
      const dataToHash = JSON.stringify({ ...snapshot, checksum: undefined });
      const currentHash = createHash("sha256").update(dataToHash).digest("hex");
      if (currentHash !== snapshot.checksum) {
        console.error("[oracle-store] FATAL: Snapshot checksum mismatch. Possible tampering.");
        process.exit(1);
      }
    }
    
    return snapshot;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error("[oracle-store] FATAL: Store file is corrupt. Build aborted.");
      process.exit(1);
    }
    return null;
  }
}

function queueSnapshotSave(path: string, snapshot: StoreSnapshot): void {
  pendingSnapshot = snapshot;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    const snapshotToSave = pendingSnapshot;
    pendingSnapshot = null;
    persistTimer = null;
    if (!snapshotToSave) return;
    void saveSnapshot(path, snapshotToSave);
  }, SNAPSHOT_DEBOUNCE_MS);
}

async function saveSnapshot(path: string, snapshot: StoreSnapshot): Promise<void> {
  try {
    const resolved = resolve(path);
    await fs.mkdir(dirname(resolved), { recursive: true });

    const tempPath = `${resolved}.tmp`;
    const dataToHash = JSON.stringify({ ...snapshot, checksum: undefined });
    snapshot.checksum = createHash("sha256").update(dataToHash).digest("hex");

    await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tempPath, resolved);
  } catch (error) {
    console.error("[oracle-store] Failed to persist snapshot.", error);
  }
}

export function normalizeWallet(wallet: string | string[] | undefined): string | undefined {
  const value = Array.isArray(wallet) ? wallet[0] : wallet;
  if (!value) return undefined;
  const trimmed = value.trim();
  return WALLET_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function isValidWalletAddress(wallet: string | undefined): boolean {
  if (!wallet) return false;
  return WALLET_PATTERN.test(wallet);
}

type GlobalWithStore = typeof globalThis & { __oracleStore?: OracleStore };
const globalWithStore = globalThis as GlobalWithStore;
export const store = globalWithStore.__oracleStore ?? (globalWithStore.__oracleStore = new OracleStore());
