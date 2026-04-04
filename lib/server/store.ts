import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import Database from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import {
  type MarketCategory,
  type MarketStatus,
} from "../../lib/shared/market-types";
import { getPortfolioSummary } from "../../lib/shared/portfolio";
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
import { isProdLike } from "./runtime-env";

// OracleStore owns all persisted market state. The self-contained default is a
// JSON snapshot file; sqlite remains available as an opt-in backend.
const CURRENT_STORE_VERSION = 3; 

const STORE_PATH_ENV = "ORACLE_STORE_PATH";
const STORE_BACKEND_ENV = "ORACLE_STORE_BACKEND";
const DB_PATH_ENV = "ORACLE_DB_PATH";
// Resolve persistence paths from the project root so local and deployed
// environments agree on where fallback files/dbs live.
const PROJECT_ROOT = process.cwd();
const DEFAULT_DATA_ROOT = isProdLike()
  ? resolve(tmpdir(), "oracle")
  : resolve(PROJECT_ROOT, "data");
const DEFAULT_STORE_PATH = resolve(DEFAULT_DATA_ROOT, "oracle-store.json");
const DEFAULT_DB_PATH = resolve(DEFAULT_DATA_ROOT, "oracle-store.db");
const SNAPSHOT_DEBOUNCE_MS = 750;
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADMIN_WALLET_ENV = "ORACLE_ADMIN_WALLET";
const ADMIN_KEYPAIR_PATH_ENV = "ORACLE_ADMIN_KEYPAIR_PATH";
const DEFAULT_ADMIN_KEYPAIR_PATH = resolve(DEFAULT_DATA_ROOT, "oracle-admin-keypair.json");
const DB_SCHEMA_VERSION = 1;
type StoreBackend = "sqlite" | "file";

let pendingSnapshot: StoreSnapshot | null = null;
let pendingBackend: StoreBackend | null = null;
let pendingPath: string | undefined;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let missingPersistenceWarned = false;
type SqliteDatabase = InstanceType<typeof Database>;

// One sqlite handle is shared for the life of the process.
let database: SqliteDatabase | null = null;

type MetaRecord = Record<string, string>;

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function serializeCipher(
  cipher?: { c1: number[]; c2: number[] }
): string | null {
  if (!cipher) return null;
  return JSON.stringify(cipher);
}

function deserializeCipher(
  value: string | null
): { c1: number[]; c2: number[] } | undefined {
  if (!value) return undefined;
  const parsed = safeJsonParse<{ c1?: unknown; c2?: unknown }>(value, {});
  if (!Array.isArray(parsed.c1) || !Array.isArray(parsed.c2)) return undefined;
  return {
    c1: parsed.c1.filter((item): item is number => typeof item === "number"),
    c2: parsed.c2.filter((item): item is number => typeof item === "number"),
  };
}

function ensureSchema(db: SqliteDatabase): void {
  // The normalized schema keeps queryable entities in first-class tables while
  // smaller counters and version markers stay in oracle_meta.
  db.exec(`
    CREATE TABLE IF NOT EXISTS oracle_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY,
      creator TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      resolution_timestamp TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      total_participants INTEGER NOT NULL,
      rules TEXT NOT NULL,
      resolution_source TEXT NOT NULL,
      outcome INTEGER,
      revealed_yes_stake REAL,
      revealed_no_stake REAL,
      version INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
    CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY,
      market_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      commitment TEXT NOT NULL,
      encrypted_stake TEXT,
      encrypted_choice TEXT,
      submitted_at TEXT NOT NULL,
      claimed INTEGER NOT NULL,
      version INTEGER NOT NULL,
      FOREIGN KEY (market_id) REFERENCES markets(id)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id);
    CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet);

    CREATE TABLE IF NOT EXISTS disputes (
      id TEXT PRIMARY KEY,
      market_id INTEGER NOT NULL,
      submitted_by TEXT NOT NULL,
      contested_resolver TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settlement_stake_at_risk_sol REAL NOT NULL,
      challenge_opened_at TEXT NOT NULL,
      challenge_deadline_at TEXT NOT NULL,
      challenge_closed_at TEXT,
      resolution_outcome TEXT,
      resolution_resolved_by TEXT,
      resolution_note TEXT,
      resolution_resolved_at TEXT,
      slash_bps INTEGER,
      slash_amount_sol REAL,
      slashed_resolver TEXT,
      slash_beneficiary TEXT,
      slash_reason TEXT,
      slash_applied_at TEXT,
      invalid_reason_code TEXT,
      invalid_rationale TEXT,
      invalid_refund_mode TEXT,
      invalid_decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id TEXT PRIMARY KEY,
      dispute_id TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      summary TEXT NOT NULL,
      uri TEXT,
      source_type TEXT NOT NULL,
      source_domain TEXT,
      evidence_hash TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (dispute_id) REFERENCES disputes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute ON dispute_evidence(dispute_id);

    CREATE TABLE IF NOT EXISTS indexer_events (
      id TEXT PRIMARY KEY,
      slot INTEGER NOT NULL,
      signature TEXT NOT NULL,
      market_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      details TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      slot INTEGER NOT NULL,
      signature TEXT NOT NULL,
      market_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      details TEXT NOT NULL,
      integrity_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS probability_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      yes_probability REAL NOT NULL,
      no_probability REAL NOT NULL,
      volume_sol REAL NOT NULL
    );
  `);
}

function readMeta(db: SqliteDatabase): MetaRecord {
  const rows = db.prepare("SELECT key, value FROM oracle_meta").all() as Array<{ key: string; value: string }>;
  return rows.reduce<MetaRecord>((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

function writeMeta(db: SqliteDatabase, entries: MetaRecord): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO oracle_meta (key, value) VALUES (?, ?)");
  const tx = db.transaction(() => {
    Object.entries(entries).forEach(([key, value]) => {
      stmt.run(key, value);
    });
  });
  tx();
}

function nextSequenceId(ids: string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const numeric = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(numeric)) {
      max = Math.max(max, numeric);
    }
  }
  return max + 1;
}

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
  txSig?: string;
}

export interface RelayRevealInput {
  marketId: number;
  yesTotal: number;
  noTotal: number;
  relaySignature: string;
  relayActor?: string;
  slot?: number;
  signature?: string;
}

function resolveAdminAuthority(): string {
  const explicit = process.env[ADMIN_WALLET_ENV]?.trim();
  if (explicit) {
    if (!WALLET_PATTERN.test(explicit)) {
      console.warn(
        "[oracle-store] ORACLE_ADMIN_WALLET is invalid. Falling back to generated admin keypair."
      );
    } else {
      return explicit;
    }
  }

  const configuredPath = process.env[ADMIN_KEYPAIR_PATH_ENV]?.trim();
  const keypairPath = resolve(configuredPath || DEFAULT_ADMIN_KEYPAIR_PATH);

  try {
    if (existsSync(keypairPath)) {
      const secret = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
      const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      return keypair.publicKey.toBase58();
    }
  } catch (error) {
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
    "[oracle-store] Generated local admin keypair. Set ORACLE_ADMIN_WALLET if you need a stable authority."
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
    const preferredBackend = resolveStoreBackend();
    assertProductionPersistence(preferredBackend);
    this.persistenceBackend = preferredBackend;
    this.persistencePath = resolvePersistencePath(this.persistenceBackend);

    // Try the requested backend first, but keep booting with the file snapshot
    // backend if sqlite is unavailable in the current environment.
    let snapshot: StoreSnapshot | null = null;
    if (this.persistenceBackend === "sqlite") {
      try {
        snapshot = loadNormalizedStateFromDatabase();
      } catch (error) {
        console.warn(
          "[oracle-store] SQLite backend unavailable. Falling back to file snapshot storage.",
          error
        );
        this.persistenceBackend = "file";
        this.persistencePath = resolvePersistencePath("file");
      }
    }
    if (!snapshot && this.persistenceBackend === "file" && this.persistencePath) {
      snapshot = loadSnapshot(this.persistencePath);
    }
    
    if (snapshot) {
      if (snapshot.version < CURRENT_STORE_VERSION) {
        console.log(`[oracle-store] Migrating from version ${snapshot.version} to ${CURRENT_STORE_VERSION}`);
      }
      this.applySnapshot(snapshot);
    } else {
      this.initializeEmptyState();
    }

    if (this.persistenceBackend === "sqlite") {
      this.persistMeta();
    }
  }

  private initializeEmptyState() {
    // Fresh workspaces now start empty instead of auto-injecting sample markets.
    // That makes backend/API behavior match what is actually persisted.
    this.markets = [];
    this.positions = [];
    this.nextMarketId = 0;
    this.nextPositionId = 1000;
  }

  private applySnapshot(snapshot: StoreSnapshot) {
    // Restore JSON-safe snapshot data back into runtime-friendly shapes such
    // as Date instances and subsystem state machines.
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
      // Sqlite writes entity rows eagerly, so the snapshot path only needs to
      // keep meta counters in sync.
      this.persistMeta();
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

  private persistMeta() {
    if (this.persistenceBackend !== "sqlite") return;
    const db = getDatabase();
    const disputeSnapshot = this.disputeEngine.snapshot();
    const indexerSnapshot = this.indexer.snapshot();
    // These counters let rehydration continue id generation without scanning
    // every table on boot.
    writeMeta(db, {
      schema_version: String(DB_SCHEMA_VERSION),
      next_market_id: String(this.nextMarketId),
      next_position_id: String(this.nextPositionId),
      next_dispute_id: String(disputeSnapshot.nextDisputeId),
      next_event_id: String(indexerSnapshot.nextEventId),
      authority: this.authority,
    });
  }

  private persistMarketToDatabase(market: StoredMarket): void {
    if (this.persistenceBackend !== "sqlite") return;
    const db = getDatabase();
    db.prepare(
      `INSERT OR REPLACE INTO markets
      (id, creator, title, description, resolution_timestamp, category, status, total_participants, rules, resolution_source, outcome, revealed_yes_stake, revealed_no_stake, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      market.id,
      market.creator,
      market.title,
      market.description,
      market.resolutionTimestamp,
      market.category,
      market.status,
      market.totalParticipants,
      JSON.stringify(market.rules ?? []),
      market.resolutionSource,
      typeof market.outcome === "boolean" ? Number(market.outcome) : null,
      market.revealedYesStake ?? null,
      market.revealedNoStake ?? null,
      market.version
    );
  }

  private persistPositionToDatabase(position: StoredPosition): void {
    if (this.persistenceBackend !== "sqlite") return;
    const db = getDatabase();
    db.prepare(
      `INSERT OR REPLACE INTO positions
       (id, market_id, wallet, commitment, encrypted_stake, encrypted_choice, submitted_at, claimed, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      position.id,
      position.marketId,
      position.wallet,
      position.commitment,
      serializeCipher(position.encryptedStake),
      serializeCipher(position.encryptedChoice),
      position.submittedAt.toISOString(),
      position.claimed ? 1 : 0,
      position.version
    );
  }

  private persistDisputeToDatabase(dispute: SettlementDisputeRecord): void {
    if (this.persistenceBackend !== "sqlite") return;
    const db = getDatabase();
    const insertDispute = db.prepare(
      `INSERT OR REPLACE INTO disputes
       (id, market_id, submitted_by, contested_resolver, reason, status, created_at, updated_at, settlement_stake_at_risk_sol,
        challenge_opened_at, challenge_deadline_at, challenge_closed_at,
        resolution_outcome, resolution_resolved_by, resolution_note, resolution_resolved_at,
        slash_bps, slash_amount_sol, slashed_resolver, slash_beneficiary, slash_reason, slash_applied_at,
        invalid_reason_code, invalid_rationale, invalid_refund_mode, invalid_decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEvidence = db.prepare(
      `INSERT OR REPLACE INTO dispute_evidence
       (id, dispute_id, submitted_by, summary, uri, source_type, source_domain, evidence_hash, verification_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const tx = db.transaction(() => {
      insertDispute.run(
        dispute.id,
        dispute.marketId,
        dispute.submittedBy,
        dispute.contestedResolver,
        dispute.reason,
        dispute.status,
        dispute.createdAt.toISOString(),
        dispute.updatedAt.toISOString(),
        dispute.settlementStakeAtRiskSol,
        dispute.challengeWindow.openedAt.toISOString(),
        dispute.challengeWindow.deadlineAt.toISOString(),
        dispute.challengeWindow.closedAt ? dispute.challengeWindow.closedAt.toISOString() : null,
        dispute.resolution?.outcome ?? null,
        dispute.resolution?.resolvedBy ?? null,
        dispute.resolution?.resolutionNote ?? null,
        dispute.resolution?.resolvedAt ? dispute.resolution.resolvedAt.toISOString() : null,
        dispute.slashing?.slashBps ?? null,
        dispute.slashing?.slashAmountSol ?? null,
        dispute.slashing?.slashedResolver ?? null,
        dispute.slashing?.beneficiary ?? null,
        dispute.slashing?.reason ?? null,
        dispute.slashing?.appliedAt ? dispute.slashing.appliedAt.toISOString() : null,
        dispute.invalidResolution?.reasonCode ?? null,
        dispute.invalidResolution?.rationale ?? null,
        dispute.invalidResolution?.refundMode ?? null,
        dispute.invalidResolution?.decidedAt ? dispute.invalidResolution.decidedAt.toISOString() : null
      );

      db.prepare("DELETE FROM dispute_evidence WHERE dispute_id = ?").run(dispute.id);
      dispute.evidence.forEach((evidence) => {
        insertEvidence.run(
          evidence.id,
          dispute.id,
          evidence.submittedBy,
          evidence.summary,
          evidence.uri ?? null,
          evidence.sourceType,
          evidence.sourceDomain ?? null,
          evidence.evidenceHash,
          evidence.verificationStatus,
          evidence.createdAt.toISOString()
        );
      });
    });

    tx();
  }

  private persistLatestAuditEntry(): void {
    if (this.persistenceBackend !== "sqlite") return;
    const latest = this.indexer.listAuditLog(1)[0];
    if (!latest) return;
    const db = getDatabase();
    db.prepare(
      `INSERT OR REPLACE INTO indexer_events
       (id, slot, signature, market_id, type, actor, timestamp, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      latest.id,
      latest.slot,
      latest.signature,
      latest.marketId,
      latest.type,
      latest.actor,
      latest.timestamp.toISOString(),
      latest.details
    );
    db.prepare(
      `INSERT OR REPLACE INTO audit_log
       (id, slot, signature, market_id, type, actor, timestamp, details, integrity_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      latest.id,
      latest.slot,
      latest.signature,
      latest.marketId,
      latest.type,
      latest.actor,
      latest.timestamp.toISOString(),
      latest.details,
      latest.integrityHash
    );
  }

  private recordProbabilityPoint(marketId: number, yesTotal: number, noTotal: number): void {
    if (this.persistenceBackend !== "sqlite") return;
    const yes = Number.isFinite(yesTotal) ? Math.max(0, yesTotal) : 0;
    const no = Number.isFinite(noTotal) ? Math.max(0, noTotal) : 0;
    const total = yes + no;
    const yesProbability = total > 0 ? yes / total : 0.5;
    const noProbability = total > 0 ? no / total : 0.5;
    const volumeSol = total;
    const db = getDatabase();
    db.prepare(
      `INSERT INTO probability_history (market_id, timestamp, yes_probability, no_probability, volume_sol)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      marketId,
      new Date().toISOString(),
      yesProbability,
      noProbability,
      volumeSol
    );
  }

  private persistFullStateToDatabase(): void {
    if (this.persistenceBackend !== "sqlite") return;
    const db = getDatabase();
    const snapshot = this.buildSnapshot();
    const disputeSnapshot = snapshot.disputeEngine ?? this.disputeEngine.snapshot();
    const indexerSnapshot = snapshot.indexer ?? this.indexer.snapshot();

    const insertMarket = db.prepare(
      `INSERT OR REPLACE INTO markets
       (id, creator, title, description, resolution_timestamp, category, status, total_participants, rules, resolution_source, outcome, revealed_yes_stake, revealed_no_stake, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertPosition = db.prepare(
      `INSERT OR REPLACE INTO positions
       (id, market_id, wallet, commitment, encrypted_stake, encrypted_choice, submitted_at, claimed, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertDispute = db.prepare(
      `INSERT OR REPLACE INTO disputes
       (id, market_id, submitted_by, contested_resolver, reason, status, created_at, updated_at, settlement_stake_at_risk_sol,
        challenge_opened_at, challenge_deadline_at, challenge_closed_at,
        resolution_outcome, resolution_resolved_by, resolution_note, resolution_resolved_at,
        slash_bps, slash_amount_sol, slashed_resolver, slash_beneficiary, slash_reason, slash_applied_at,
        invalid_reason_code, invalid_rationale, invalid_refund_mode, invalid_decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEvidence = db.prepare(
      `INSERT OR REPLACE INTO dispute_evidence
       (id, dispute_id, submitted_by, summary, uri, source_type, source_domain, evidence_hash, verification_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEvent = db.prepare(
      `INSERT OR REPLACE INTO indexer_events
       (id, slot, signature, market_id, type, actor, timestamp, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAudit = db.prepare(
      `INSERT OR REPLACE INTO audit_log
       (id, slot, signature, market_id, type, actor, timestamp, details, integrity_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const tx = db.transaction(() => {
      // Full rewrites are reserved for initialization and migration paths.
      // Hot-path updates use the narrower persist* helpers above.
      db.exec(
        "DELETE FROM markets; DELETE FROM positions; DELETE FROM disputes; DELETE FROM dispute_evidence; DELETE FROM indexer_events; DELETE FROM audit_log; DELETE FROM probability_history;"
      );

      snapshot.markets.forEach((market) => {
        insertMarket.run(
          market.id,
          market.creator,
          market.title,
          market.description,
          market.resolutionTimestamp,
          market.category,
          market.status,
          market.totalParticipants,
          JSON.stringify(market.rules ?? []),
          market.resolutionSource,
          typeof market.outcome === "boolean" ? Number(market.outcome) : null,
          market.revealedYesStake ?? null,
          market.revealedNoStake ?? null,
          market.version
        );
      });

      snapshot.positions.forEach((position) => {
        insertPosition.run(
          position.id,
          position.marketId,
          position.wallet,
          position.commitment,
          serializeCipher(position.encryptedStake),
          serializeCipher(position.encryptedChoice),
          position.submittedAt.toISOString(),
          position.claimed ? 1 : 0,
          position.version
        );
      });

      disputeSnapshot.disputes.forEach((dispute) => {
        insertDispute.run(
          dispute.id,
          dispute.marketId,
          dispute.submittedBy,
          dispute.contestedResolver,
          dispute.reason,
          dispute.status,
          dispute.createdAt,
          dispute.updatedAt,
          dispute.settlementStakeAtRiskSol,
          dispute.challengeWindow.openedAt,
          dispute.challengeWindow.deadlineAt,
          dispute.challengeWindow.closedAt ?? null,
          dispute.resolution?.outcome ?? null,
          dispute.resolution?.resolvedBy ?? null,
          dispute.resolution?.resolutionNote ?? null,
          dispute.resolution?.resolvedAt ?? null,
          dispute.slashing?.slashBps ?? null,
          dispute.slashing?.slashAmountSol ?? null,
          dispute.slashing?.slashedResolver ?? null,
          dispute.slashing?.beneficiary ?? null,
          dispute.slashing?.reason ?? null,
          dispute.slashing?.appliedAt ?? null,
          dispute.invalidResolution?.reasonCode ?? null,
          dispute.invalidResolution?.rationale ?? null,
          dispute.invalidResolution?.refundMode ?? null,
          dispute.invalidResolution?.decidedAt ?? null
        );
        dispute.evidence.forEach((evidence) => {
          insertEvidence.run(
            evidence.id,
            dispute.id,
            evidence.submittedBy,
            evidence.summary,
            evidence.uri ?? null,
            evidence.sourceType,
            evidence.sourceDomain ?? null,
            evidence.evidenceHash,
            evidence.verificationStatus,
            evidence.createdAt
          );
        });
      });

      indexerSnapshot.events.forEach((event) => {
        insertEvent.run(
          event.id,
          event.slot,
          event.signature,
          event.marketId,
          event.type,
          event.actor,
          event.timestamp,
          event.details
        );
      });
      indexerSnapshot.auditLog.forEach((entry) => {
        insertAudit.run(
          entry.id,
          entry.slot,
          entry.signature,
          entry.marketId,
          entry.type,
          entry.actor,
          entry.timestamp,
          entry.details,
          entry.integrityHash
        );
      });

      writeMeta(db, {
        schema_version: String(DB_SCHEMA_VERSION),
        next_market_id: String(snapshot.nextMarketId),
        next_position_id: String(snapshot.nextPositionId),
        next_dispute_id: String(disputeSnapshot.nextDisputeId),
        next_event_id: String(indexerSnapshot.nextEventId),
        authority: snapshot.authority,
      });
    });

    tx();
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
    marketId?: number;
    txSig?: string;
  }): StoredMarket {
    // Chain-backed flows can supply the already-confirmed on-chain id/tx sig so
    // the backend mirrors program state instead of inventing its own identifiers.
    const explicitId = input.marketId;
    const marketId = explicitId ?? this.nextMarketId;
    const existingIndex = this.markets.findIndex((candidate) => candidate.id === marketId);
    const existing = existingIndex >= 0 ? this.markets[existingIndex] : undefined;

    if (existing && existing.creator !== "SYSTEM") {
      throw new Error("Market id already exists.");
    }
    if (
      existing &&
      this.positions.some((position) => position.marketId === marketId)
    ) {
      throw new Error("Cannot replace a seeded market that already has positions.");
    }

    const market: StoredMarket = {
      id: marketId,
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

    if (existingIndex >= 0) {
      this.markets.splice(existingIndex, 1);
    }
    this.markets.unshift(market);
    this.nextMarketId = Math.max(this.nextMarketId, marketId + 1);

    this.indexer.consumeEvent({
      marketId: market.id,
      type: "MARKET_CREATED",
      actor: input.creatorWallet,
      details: `Market created: ${market.title}`,
      slot: 0,
      signature: input.txSig ?? randomBytes(32).toString("hex"),
    });
    if (this.persistenceBackend === "sqlite") {
      this.persistMarketToDatabase(market);
      this.persistLatestAuditEntry();
      this.persistMeta();
    } else {
      this.persistSnapshot();
    }
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
    const txSig = input.txSig ?? randomBytes(32).toString("hex");
    const market = this.getMarketById(input.marketId);
    if (!market) {
      throw new Error("Market not found.");
    }
    if (
      this.positions.some(
        (position) => position.marketId === input.marketId && position.wallet === input.wallet
      )
    ) {
      throw new Error("This wallet already has a position for the selected market.");
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
    if (this.persistenceBackend === "sqlite") {
      this.persistPositionToDatabase(position);
      this.persistMarketToDatabase(market);
      this.persistLatestAuditEntry();
      this.persistMeta();
    } else {
      this.persistSnapshot();
    }
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

  getMarketProbabilityHistory(marketId: number, limit = 96): Array<{ timestamp: Date; yesProbability: number; noProbability: number; volumeSol: number }> {
    if (this.persistenceBackend !== "sqlite") return [];
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT timestamp, yes_probability, no_probability, volume_sol
       FROM probability_history
       WHERE market_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    ).all(marketId, Math.max(1, limit)) as Array<{
      timestamp: string;
      yes_probability: number;
      no_probability: number;
      volume_sol: number;
    }>;
    return rows.map((row) => ({
      timestamp: new Date(row.timestamp),
      yesProbability: row.yes_probability,
      noProbability: row.no_probability,
      volumeSol: row.volume_sol,
    }));
  }

  listMarketDisputes(marketId: number): SettlementDisputeRecord[] {
    return this.disputeEngine.listDisputes(marketId);
  }

  listDisputes(): SettlementDisputeRecord[] {
    return this.disputeEngine.listDisputes();
  }

  openMarketDispute(input: OpenDisputeInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.openDispute(input);
    if (this.persistenceBackend === "sqlite") {
      this.persistDisputeToDatabase(dispute);
      this.persistMeta();
    } else {
      this.persistSnapshot();
    }
    return dispute;
  }

  addDisputeEvidence(input: AddEvidenceInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.addEvidence(input);
    if (this.persistenceBackend === "sqlite") {
      this.persistDisputeToDatabase(dispute);
    } else {
      this.persistSnapshot();
    }
    return dispute;
  }

  resolveDispute(input: ResolveDisputeInput): SettlementDisputeRecord {
    const dispute = this.disputeEngine.resolveDispute(input);
    if (this.persistenceBackend === "sqlite") {
      this.persistDisputeToDatabase(dispute);
    } else {
      this.persistSnapshot();
    }
    return dispute;
  }

  recordRelayReveal(input: RelayRevealInput): StoredMarket {
    const market = this.getMarketById(input.marketId);
    if (!market) {
      throw new Error("Market not found.");
    }

    // This write is where reveal totals become visible in the app. Mainnet
    // should only reach it with a verified relayer signature/proof and a real
    // slot/signature from the settlement transaction.
    market.revealedYesStake = input.yesTotal;
    market.revealedNoStake = input.noTotal;
    if (market.status === "Open") {
      market.status = "SettledPending";
    }

    this.indexer.consumeEvent({
      marketId: market.id,
      type: "MARKET_STATUS_CHANGED",
      actor: input.relayActor ?? "arcium-relay",
      details: `Relay reveal submitted (${input.relaySignature.slice(0, 12)}...)`,
      slot: input.slot ?? 0,
      signature: input.signature ?? "RELAY",
    });
    if (this.persistenceBackend === "sqlite") {
      this.recordProbabilityPoint(market.id, input.yesTotal, input.noTotal);
      this.persistMarketToDatabase(market);
      this.persistLatestAuditEntry();
      this.persistMeta();
    } else {
      this.persistSnapshot();
    }
    return market;
  }
}

function resolveStoreBackend(): StoreBackend {
  const configured = process.env[STORE_BACKEND_ENV]?.trim().toLowerCase();
  if (!configured) {
    return "file";
  }
  if (configured !== "file" && configured !== "sqlite") {
    console.warn(
      `[oracle-store] Unsupported ORACLE_STORE_BACKEND "${configured}". Falling back to file snapshots.`
    );
    return "file";
  }
  return configured;
}

function assertProductionPersistence(backend: StoreBackend): void {
  if (!isProdLike()) return;
  if (!process.env[STORE_BACKEND_ENV]) {
    console.warn(
      `[oracle-store] ORACLE_STORE_BACKEND not set. Using ${backend} with self-contained local storage.`
    );
  }
}

function resolvePersistencePath(backend: StoreBackend): string | undefined {
  if (backend !== "file") return undefined;
  const configured = process.env[STORE_PATH_ENV]?.trim();
  if (configured) return resolve(configured);
  return DEFAULT_STORE_PATH;
}

function resolveDatabasePath(): string {
  const configured = process.env[DB_PATH_ENV]?.trim();
  return resolve(configured || DEFAULT_DB_PATH);
}

function getDatabase(): SqliteDatabase {
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
    database.pragma("foreign_keys = ON");
    ensureSchema(database);
    // Older installs stored everything in a single snapshot row; migrate them
    // forward once after opening the normalized schema.
    migrateLegacySnapshotIfNeeded(database);
  }
  return database;
}

function loadNormalizedStateFromDatabase(): StoreSnapshot | null {
  // Reconstruct the in-memory snapshot shape expected by OracleStore from the
  // normalized tables plus meta counters.
  const db = getDatabase();
  const meta = readMeta(db);
  const markets = loadMarketsFromDatabase(db);
  const marketById = new Map(markets.map((market) => [market.id, market]));
  const positions = loadPositionsFromDatabase(db, marketById);
  const disputeSnapshot = loadDisputeSnapshotFromDatabase(db, meta);
  const indexerSnapshot = loadIndexerSnapshotFromDatabase(db, meta);

  const nextMarketId = resolveNextId(meta.next_market_id, markets.map((m) => m.id));
  const nextPositionId = resolveNextId(meta.next_position_id, positions.map((p) => p.id));
  const authority = meta.authority ?? resolveAdminAuthority();
  const hasData =
    markets.length > 0 ||
    positions.length > 0 ||
    disputeSnapshot.disputes.length > 0 ||
    indexerSnapshot.events.length > 0 ||
    Object.keys(meta).length > 0;

  if (!hasData) return null;

  return {
    version: CURRENT_STORE_VERSION,
    savedAt: new Date().toISOString(),
    markets,
    positions,
    nextMarketId,
    nextPositionId,
    authority,
    disputeEngine: disputeSnapshot,
    indexer: indexerSnapshot,
  };
}

function resolveNextId(metaValue: string | undefined, ids: number[]): number {
  const parsed = Number.parseInt(metaValue ?? "", 10);
  if (Number.isFinite(parsed)) return parsed;
  const max = ids.length ? Math.max(...ids) : -1;
  return max + 1;
}

function loadMarketsFromDatabase(db: SqliteDatabase): StoredMarket[] {
  const rows = db
    .prepare(
      `SELECT id, creator, title, description, resolution_timestamp, category, status, total_participants, rules, resolution_source, outcome, revealed_yes_stake, revealed_no_stake, version
       FROM markets ORDER BY id DESC`
    )
    .all() as Array<{
    id: number;
    creator: string;
    title: string;
    description: string;
    resolution_timestamp: string;
    category: string;
    status: string;
    total_participants: number;
    rules: string;
    resolution_source: string;
    outcome: number | null;
    revealed_yes_stake: number | null;
    revealed_no_stake: number | null;
    version: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    creator: row.creator,
    title: row.title,
    description: row.description,
    resolutionTimestamp: row.resolution_timestamp,
    category: row.category as MarketCategory,
    status: row.status as MarketStatus,
    totalParticipants: row.total_participants,
    rules: safeJsonParse<string[]>(row.rules, []),
    resolutionSource: row.resolution_source,
    outcome: row.outcome === null ? undefined : Boolean(row.outcome),
    revealedYesStake: row.revealed_yes_stake ?? undefined,
    revealedNoStake: row.revealed_no_stake ?? undefined,
    version: row.version,
  }));
}

function loadPositionsFromDatabase(
  db: SqliteDatabase,
  markets: Map<number, StoredMarket>
): StoredPosition[] {
  const rows = db
    .prepare(
      `SELECT id, market_id, wallet, commitment, encrypted_stake, encrypted_choice, submitted_at, claimed, version
       FROM positions ORDER BY submitted_at DESC`
    )
    .all() as Array<{
    id: number;
    market_id: number;
    wallet: string;
    commitment: string;
    encrypted_stake: string | null;
    encrypted_choice: string | null;
    submitted_at: string;
    claimed: number;
    version: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    marketId: row.market_id,
    marketTitle: markets.get(row.market_id)?.title ?? "Unknown Market",
    wallet: row.wallet,
    commitment: row.commitment,
    encryptedStake: deserializeCipher(row.encrypted_stake),
    encryptedChoice: deserializeCipher(row.encrypted_choice),
    submittedAt: new Date(row.submitted_at),
    claimed: Boolean(row.claimed),
    version: row.version,
  }));
}

function loadDisputeSnapshotFromDatabase(db: SqliteDatabase, meta: MetaRecord): DisputeEngineSnapshot {
  const disputes = db
    .prepare("SELECT * FROM disputes ORDER BY created_at DESC")
    .all() as Array<Record<string, any>>;
  const evidenceRows = db
    .prepare("SELECT * FROM dispute_evidence ORDER BY created_at ASC")
    .all() as Array<Record<string, any>>;
  const evidenceMap = new Map<string, Array<Record<string, any>>>();
  evidenceRows.forEach((row) => {
    const list = evidenceMap.get(row.dispute_id) ?? [];
    list.push(row);
    evidenceMap.set(row.dispute_id, list);
  });

  const serialized = disputes.map((row) => ({
    id: row.id,
    marketId: row.market_id,
    submittedBy: row.submitted_by,
    contestedResolver: row.contested_resolver,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settlementStakeAtRiskSol: row.settlement_stake_at_risk_sol,
    challengeWindow: {
      openedAt: row.challenge_opened_at,
      deadlineAt: row.challenge_deadline_at,
      closedAt: row.challenge_closed_at ?? undefined,
    },
    evidence: (evidenceMap.get(row.id) ?? []).map((evidence) => ({
      id: evidence.id,
      submittedBy: evidence.submitted_by,
      summary: evidence.summary,
      uri: evidence.uri ?? undefined,
      sourceType: evidence.source_type,
      sourceDomain: evidence.source_domain ?? undefined,
      evidenceHash: evidence.evidence_hash,
      verificationStatus: evidence.verification_status,
      createdAt: evidence.created_at,
    })),
    resolution: row.resolution_outcome
      ? {
          outcome: row.resolution_outcome,
          resolvedBy: row.resolution_resolved_by,
          resolutionNote: row.resolution_note,
          resolvedAt: row.resolution_resolved_at,
        }
      : undefined,
    slashing: row.slash_bps
      ? {
          slashBps: row.slash_bps,
          slashAmountSol: row.slash_amount_sol,
          slashedResolver: row.slashed_resolver,
          beneficiary: row.slash_beneficiary,
          reason: row.slash_reason,
          appliedAt: row.slash_applied_at,
        }
      : undefined,
    invalidResolution: row.invalid_reason_code
      ? {
          reasonCode: row.invalid_reason_code,
          rationale: row.invalid_rationale,
          refundMode: row.invalid_refund_mode ?? "full_refund",
          decidedAt: row.invalid_decided_at,
        }
      : undefined,
  }));

  const nextDisputeIdMeta = Number.parseInt(meta.next_dispute_id ?? "", 10);
  const nextDisputeId = Number.isFinite(nextDisputeIdMeta)
    ? nextDisputeIdMeta
    : nextSequenceId(serialized.map((item) => item.id), "disp_");

  return {
    version: 1,
    nextDisputeId,
    disputes: serialized,
  };
}

function loadIndexerSnapshotFromDatabase(db: SqliteDatabase, meta: MetaRecord): IndexerSnapshot {
  const events = db
    .prepare("SELECT * FROM indexer_events ORDER BY id DESC")
    .all() as Array<Record<string, any>>;
  const auditLog = db
    .prepare("SELECT * FROM audit_log ORDER BY id DESC")
    .all() as Array<Record<string, any>>;

  const serializedEvents = events.map((row) => ({
    id: row.id,
    slot: row.slot,
    signature: row.signature,
    marketId: row.market_id,
    type: row.type,
    actor: row.actor,
    timestamp: row.timestamp,
    details: row.details,
  }));

  const serializedAudit = auditLog.map((row) => ({
    id: row.id,
    slot: row.slot,
    signature: row.signature,
    marketId: row.market_id,
    type: row.type,
    actor: row.actor,
    timestamp: row.timestamp,
    details: row.details,
    integrityHash: row.integrity_hash,
  }));

  const nextEventIdMeta = Number.parseInt(meta.next_event_id ?? "", 10);
  const nextEventId = Number.isFinite(nextEventIdMeta)
    ? nextEventIdMeta
    : nextSequenceId(serializedEvents.map((event) => event.id), "evt_");

  return {
    version: 2,
    nextEventId,
    events: serializedEvents,
    auditLog: serializedAudit,
  };
}

function migrateLegacySnapshotIfNeeded(db: SqliteDatabase): void {
  const meta = readMeta(db);
  if (meta.schema_version) return;

  // Legacy sqlite installs used a single oracle_store row that mirrored the
  // file backend snapshot shape.
  const legacyTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oracle_store'")
    .get() as { name?: string } | undefined;
  if (!legacyTable?.name) return;

  const legacySnapshot = loadLegacySnapshotFromDatabase(db);
  if (!legacySnapshot) return;
  importLegacySnapshot(db, legacySnapshot);
  db.exec("DROP TABLE IF EXISTS oracle_store");
}

function loadLegacySnapshotFromDatabase(db: SqliteDatabase): StoreSnapshot | null {
  try {
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
    console.error("[oracle-store] Failed to load legacy snapshot from database.", err);
    return null;
  }
}

function importLegacySnapshot(db: SqliteDatabase, snapshot: StoreSnapshot): void {
  const insertMarket = db.prepare(
    `INSERT OR REPLACE INTO markets
    (id, creator, title, description, resolution_timestamp, category, status, total_participants, rules, resolution_source, outcome, revealed_yes_stake, revealed_no_stake, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertPosition = db.prepare(
    `INSERT OR REPLACE INTO positions
     (id, market_id, wallet, commitment, encrypted_stake, encrypted_choice, submitted_at, claimed, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertDispute = db.prepare(
    `INSERT OR REPLACE INTO disputes
     (id, market_id, submitted_by, contested_resolver, reason, status, created_at, updated_at, settlement_stake_at_risk_sol,
      challenge_opened_at, challenge_deadline_at, challenge_closed_at,
      resolution_outcome, resolution_resolved_by, resolution_note, resolution_resolved_at,
      slash_bps, slash_amount_sol, slashed_resolver, slash_beneficiary, slash_reason, slash_applied_at,
      invalid_reason_code, invalid_rationale, invalid_refund_mode, invalid_decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEvidence = db.prepare(
    `INSERT OR REPLACE INTO dispute_evidence
     (id, dispute_id, submitted_by, summary, uri, source_type, source_domain, evidence_hash, verification_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEvent = db.prepare(
    `INSERT OR REPLACE INTO indexer_events
     (id, slot, signature, market_id, type, actor, timestamp, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAudit = db.prepare(
    `INSERT OR REPLACE INTO audit_log
     (id, slot, signature, market_id, type, actor, timestamp, details, integrity_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    snapshot.markets.forEach((market) => {
      insertMarket.run(
        market.id,
        market.creator,
        market.title,
        market.description,
        market.resolutionTimestamp,
        market.category,
        market.status,
        market.totalParticipants,
        JSON.stringify(market.rules ?? []),
        market.resolutionSource,
        typeof market.outcome === "boolean" ? Number(market.outcome) : null,
        market.revealedYesStake ?? null,
        market.revealedNoStake ?? null,
        market.version
      );
    });
    snapshot.positions.forEach((position) => {
      insertPosition.run(
        position.id,
        position.marketId,
        position.wallet,
        position.commitment,
        serializeCipher(position.encryptedStake),
        serializeCipher(position.encryptedChoice),
        position.submittedAt.toISOString(),
        position.claimed ? 1 : 0,
        position.version
      );
    });
    if (snapshot.disputeEngine) {
      snapshot.disputeEngine.disputes.forEach((dispute) => {
        insertDispute.run(
          dispute.id,
          dispute.marketId,
          dispute.submittedBy,
          dispute.contestedResolver,
          dispute.reason,
          dispute.status,
          dispute.createdAt,
          dispute.updatedAt,
          dispute.settlementStakeAtRiskSol,
          dispute.challengeWindow.openedAt,
          dispute.challengeWindow.deadlineAt,
          dispute.challengeWindow.closedAt ?? null,
          dispute.resolution?.outcome ?? null,
          dispute.resolution?.resolvedBy ?? null,
          dispute.resolution?.resolutionNote ?? null,
          dispute.resolution?.resolvedAt ?? null,
          dispute.slashing?.slashBps ?? null,
          dispute.slashing?.slashAmountSol ?? null,
          dispute.slashing?.slashedResolver ?? null,
          dispute.slashing?.beneficiary ?? null,
          dispute.slashing?.reason ?? null,
          dispute.slashing?.appliedAt ?? null,
          dispute.invalidResolution?.reasonCode ?? null,
          dispute.invalidResolution?.rationale ?? null,
          dispute.invalidResolution?.refundMode ?? null,
          dispute.invalidResolution?.decidedAt ?? null
        );
        dispute.evidence.forEach((evidence) => {
          insertEvidence.run(
            evidence.id,
            dispute.id,
            evidence.submittedBy,
            evidence.summary,
            evidence.uri ?? null,
            evidence.sourceType,
            evidence.sourceDomain ?? null,
            evidence.evidenceHash,
            evidence.verificationStatus,
            evidence.createdAt
          );
        });
      });
    }
    if (snapshot.indexer) {
      snapshot.indexer.events.forEach((event) => {
        insertEvent.run(
          event.id,
          event.slot,
          event.signature,
          event.marketId,
          event.type,
          event.actor,
          event.timestamp,
          event.details
        );
      });
      snapshot.indexer.auditLog.forEach((entry) => {
        insertAudit.run(
          entry.id,
          entry.slot,
          entry.signature,
          entry.marketId,
          entry.type,
          entry.actor,
          entry.timestamp,
          entry.details,
          entry.integrityHash
        );
      });
    }

    writeMeta(db, {
      schema_version: String(DB_SCHEMA_VERSION),
      next_market_id: String(snapshot.nextMarketId),
      next_position_id: String(snapshot.nextPositionId),
      next_dispute_id: String(snapshot.disputeEngine?.nextDisputeId ?? 1),
      next_event_id: String(snapshot.indexer?.nextEventId ?? 1),
      authority: snapshot.authority,
    });
  });

  tx();
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
  // Debounce file snapshots so bursts of writes coalesce into one disk flush.
  persistTimer = setTimeout(() => {
    const snapshotToSave = pendingSnapshot;
    const backendToUse = pendingBackend;
    const pathToUse = pendingPath;
    pendingSnapshot = null;
    pendingBackend = null;
    pendingPath = undefined;
    persistTimer = null;
    if (!snapshotToSave || !backendToUse) return;
    if (backendToUse !== "file") return;
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

    // Write-then-rename keeps partially written files from becoming the next
    // startup snapshot after crashes or interrupted saves.
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
