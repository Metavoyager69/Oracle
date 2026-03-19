import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import {
  DEMO_MARKETS,
  getPortfolioSummary,
} from "../../utils/program";

// [ISSUE 5 FIX] - Incremented version for new schema
const CURRENT_STORE_VERSION = 3; 

const STORE_PATH_ENV = "ORACLE_STORE_PATH";
// [ISSUE 9 FIX] - Use absolute path from project root to ensure consistency across dev/prod
const PROJECT_ROOT = process.cwd();
const DEFAULT_STORE_PATH = resolve(PROJECT_ROOT, "data", "oracle-store.json");

// [ISSUES 1, 2, 3, 4 FIX] - Strict typing for all data structures
export interface StoredMarket {
  id: number;
  creator: string;
  title: string;
  description: string;
  resolutionTimestamp: string;
  status: string;
  version: number;
}

export interface StoredPosition {
  id: number;
  marketId: number;
  marketTitle: string;
  wallet: string;
  commitment: string;
  encryptedStake?: { c1: string; c2: string };
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
}

export interface SubmitPositionInput {
  marketId: number;
  marketTitle: string;
  wallet: string;
  commitment: string;
  choice: boolean;
  encryptedStake?: { c1: string; c2: string };
  encryptedChoice?: { c1: number[]; c2: number[] };
}

export class OracleStore {
  private markets: StoredMarket[] = [];
  private positions: StoredPosition[] = [];
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
      status: m.status,
      version: 1
    }));
    this.nextMarketId = this.markets.length;
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
    };
  }

  private persistSnapshot() {
    if (!this.persistencePath) return;
    saveSnapshot(this.persistencePath, this.buildSnapshot());
  }

  // [ISSUES 21 & 22 FIX Helper] - Returns the authorized admin
  getRegistryAuthority(): string {
    return this.authority;
  }

  listMarkets(): StoredMarket[] {
    return this.markets;
  }

  getMarketById(id: number): StoredMarket | null {
    return this.markets.find(m => m.id === id) || null;
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
    const position: StoredPosition = {
      id: this.nextPositionId++,
      marketId: input.marketId,
      marketTitle: input.marketTitle,
      wallet: input.wallet,
      commitment: input.commitment,
      encryptedStake: input.encryptedStake,
      encryptedChoice: input.encryptedChoice,
      submittedAt: new Date(),
      claimed: false,
      version: CURRENT_STORE_VERSION,
    };
    this.positions.push(position);
    this.persistSnapshot();
    return { position, txSig };
  }

  getPortfolio(wallet: string): { positions: StoredPosition[]; summary: any } {
    const positions = this.listPositions({ wallet });
    return {
      positions,
      summary: getPortfolioSummary(positions as any), // Cast for summary math compat
    };
  }
}

function resolvePersistencePath(): string | undefined {
  const configured = process.env[STORE_PATH_ENV]?.trim();
  if (configured) return resolve(configured);
  return DEFAULT_STORE_PATH;
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

function saveSnapshot(path: string, snapshot: StoreSnapshot): void {
  try {
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true });
    
    const tempPath = `${resolved}.tmp`;
    const dataToHash = JSON.stringify({ ...snapshot, checksum: undefined });
    snapshot.checksum = createHash("sha256").update(dataToHash).digest("hex");
    
    writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
    renameSync(tempPath, resolved);
  } catch (error) {
    console.error("[oracle-store] Failed to persist snapshot.", error);
  }
}

export function normalizeWallet(wallet: string | string[] | undefined): string {
  const value = Array.isArray(wallet) ? wallet[0] : wallet;
  const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (value && WALLET_PATTERN.test(value.trim())) return value.trim();
  return "demo_wallet";
}

export function isValidWalletAddress(wallet: string): boolean {
  const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return WALLET_PATTERN.test(wallet);
}

type GlobalWithStore = typeof globalThis & { __oracleStore?: OracleStore };
const globalWithStore = globalThis as GlobalWithStore;
export const store = globalWithStore.__oracleStore ?? (globalWithStore.__oracleStore = new OracleStore());
