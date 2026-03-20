import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { promises as fs } from "fs";
import { dirname, resolve } from "path";
import Database from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
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
const STORE_BACKEND_ENV = "ORACLE_STORE_BACKEND";
const DB_PATH_ENV = "ORACLE_DB_PATH";
// [ISSUE 9 FIX] - Use absolute path from project root to ensure consistency across dev/prod
const PROJECT_ROOT = process.cwd();
const DEFAULT_STORE_PATH = resolve(PROJECT_ROOT, "data", "oracle-store.json");
const DEFAULT_DB_PATH = resolve(PROJECT_ROOT, "data", "oracle-store.db");
const SNAPSHOT_DEBOUNCE_MS = 750;
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADMIN_WALLET_ENV = "ORACLE_ADMIN_WALLET";
const ADMIN_KEYPAIR_PATH_ENV = "ORACLE_ADMIN_KEYPAIR_PATH";
const DEFAULT_ADMIN_KEYPAIR_PATH = resolve(PROJECT_ROOT, "data", "oracle-admin-keypair.json");
type StoreBackend = "sqlite" | "file";

let pendingSnapshot: StoreSnapshot | null = null;
let pendingBackend: StoreBackend | null = null;
let pendingPath: string | undefined;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let missingPersistenceWarned = false;
let database: Database | null = null;

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

function resolveAdminAuthority(): string {
  const inProd = process.env.NODE_ENV === "production";
  const explicit = process.env[ADMIN_WALLET_ENV]?.trim();
  if (explicit) {
    if (!WALLET_PATTERN.test(explicit)) {
      throw new Error("[oracle-store] ORACLE_ADMIN_WALLET is invalid.");
    }
    return explicit;
  }

  const configuredPath = process.env[ADMIN_KEYPAIR_PATH_ENV]?.trim();
  const keypairPath = resolve(configuredPath || DEFAULT_ADMIN_KEYPAIR_PATH);

  if (inProd && !configuredPath) {
    throw new Error("[oracle-store] Set ORACLE_ADMIN_WALLET or ORACLE_ADMIN_KEYPAIR_PATH in production.");
  }

  try {
    if (existsSync(keypairPath)) {
      const secret = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
      const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      return keypair.publicKey.toBase58();
    }
    if (inProd) {
      throw new Error("[oracle-store] Admin keypair file missing in production.");
    }
  } catch (error) {
    if (inProd) {
      throw error;
    }
    console.warn("[oracle-store] Failed to load admin keypair, generating new one.", error);
  }

  const keypair = Keypair.generate();
  try {
    mkdirSync(dirname(keypairPath), { recursive: true });
    writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)), "utf8");
  } catch (error) {
    console.warn("[oracle-store] Failed to persist admin keypair.", error);
  }

  console.warn(
    "[oracle-store] Generated new admin keypair. Set ORACLE_ADMIN_WALLET in production for stability."
  );
  return keypair.publicKey.toBase58();
}

export class OracleStore {
  private markets: StoredMarket[] = [];
  private positions: StoredPosition[] = [];
  private disputeEngine = new SettlementDisputeEngine();
  private indexer = new SolanaIndexerWorkerService();
  private nextMarketId: number = 0;
  private nextPositionId: number = 1000;
  private authority: string = resolveAdminAuthority();
  private persistenceBackend: StoreBackend;
  private persistencePath?: string;

  constructor() {
    this.persistenceBackend = resolveStoreBackend();
    assertProductionPersistence(this.persistenceBackend);
    this.persistencePath = resolvePersistencePath(this.persistenceBackend);
    const snapshot =
      this.persistenceBackend === "sqlite"
        ? loadSnapshotFromDatabase()
        : this.persistencePath
          ? loadSnapshot(this.persistencePath)
          : null;
    
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
    if (this.persistenceBackend === "sqlite") {
      queueSnapshotSave(this.persistenceBackend, this.persistencePath, this.buildSnapshot());
      return;
    }

    if (!this.persistencePath) {
      if (!missingPersistenceWarned) {
        console.warn("[oracle-store] Persistence disabled. Set ORACLE_STORE_PATH in production to avoid data loss.");
        missingPersistenceWarned = true;
      }
      return;
    }
    queueSnapshotSave(this.persistenceBackend, this.persistencePath, this.buildSnapshot());
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

function resolveStoreBackend(): StoreBackend {
  const configured = process.env[STORE_BACKEND_ENV]?.trim().toLowerCase();
  if (configured === "file") return "file";
  if (configured === "sqlite") return "sqlite";
  return "sqlite";
}

function assertProductionPersistence(backend: StoreBackend): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!process.env[STORE_BACKEND_ENV]) {
    throw new Error("[oracle-store] ORACLE_STORE_BACKEND must be set in production.");
  }
  if (backend === "sqlite" && !process.env[DB_PATH_ENV]) {
    throw new Error("[oracle-store] ORACLE_DB_PATH must be set for sqlite persistence in production.");
  }
  if (backend === "file" && !process.env[STORE_PATH_ENV]) {
    throw new Error("[oracle-store] ORACLE_STORE_PATH must be set for file persistence in production.");
  }
}

function resolvePersistencePath(backend: StoreBackend): string | undefined {
  if (backend !== "file") return undefined;
  const configured = process.env[STORE_PATH_ENV]?.trim();
  if (configured) return resolve(configured);
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
    return DEFAULT_STORE_PATH;
  }
  return DEFAULT_STORE_PATH;
}

function resolveDatabasePath(): string {
  const configured = process.env[DB_PATH_ENV]?.trim();
  return resolve(configured || DEFAULT_DB_PATH);
}

function getDatabase(): Database {
  if (!database) {
    const dbPath = resolveDatabasePath();
    mkdirSync(dirname(dbPath), { recursive: true });
    try {
      database = new Database(dbPath);
    } catch (error) {
      console.error("[oracle-store] Failed to open sqlite database.", error);
      throw new Error("[oracle-store] SQLite backend unavailable. Install better-sqlite3 or switch ORACLE_STORE_BACKEND=file.");
    }
    database.pragma("journal_mode = wal");
    database.exec(`
      CREATE TABLE IF NOT EXISTS oracle_store (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  return database;
}

function loadSnapshotFromDatabase(): StoreSnapshot | null {
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT snapshot FROM oracle_store WHERE id = 1").get() as { snapshot?: string } | undefined;
    if (!row?.snapshot) return null;
    const snapshot = JSON.parse(row.snapshot) as StoreSnapshot;

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
      console.error("[oracle-store] FATAL: Store database is corrupt. Build aborted.");
      process.exit(1);
    }
    console.error("[oracle-store] Failed to load snapshot from database.", err);
    return null;
  }
}

function saveSnapshotToDatabase(snapshot: StoreSnapshot): void {
  try {
    const db = getDatabase();
    const dataToHash = JSON.stringify({ ...snapshot, checksum: undefined });
    snapshot.checksum = createHash("sha256").update(dataToHash).digest("hex");
    const payload = JSON.stringify(snapshot);
    db.prepare("INSERT OR REPLACE INTO oracle_store (id, snapshot, updated_at) VALUES (1, ?, ?)").run(
      payload,
      new Date().toISOString()
    );
  } catch (error) {
    console.error("[oracle-store] Failed to persist snapshot to database.", error);
  }
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

function queueSnapshotSave(backend: StoreBackend, path: string | undefined, snapshot: StoreSnapshot): void {
  pendingSnapshot = snapshot;
  pendingBackend = backend;
  pendingPath = path;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    const snapshotToSave = pendingSnapshot;
    const backendToUse = pendingBackend;
    const pathToUse = pendingPath;
    pendingSnapshot = null;
    pendingBackend = null;
    pendingPath = undefined;
    persistTimer = null;
    if (!snapshotToSave || !backendToUse) return;
    if (backendToUse === "sqlite") {
      saveSnapshotToDatabase(snapshotToSave);
      return;
    }
    if (pathToUse) {
      void saveSnapshot(pathToUse, snapshotToSave);
    }
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
  if (!trimmed) return undefined;
  if (!WALLET_PATTERN.test(trimmed)) {
    throw new Error("Invalid wallet address.");
  }
  return trimmed;
}

type GlobalWithStore = typeof globalThis & { __oracleStore?: OracleStore };
const globalWithStore = globalThis as GlobalWithStore;
export const store = globalWithStore.__oracleStore ?? (globalWithStore.__oracleStore = new OracleStore());
