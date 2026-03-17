import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import {
  DEMO_MARKETS,
  getPortfolioSummary,
} from "../../utils/program";

// OracleStore is the central in-memory backend coordinator.
const CURRENT_STORE_VERSION = 2; 

const STORE_PATH_ENV = "ORACLE_STORE_PATH";
const DEFAULT_STORE_PATH = "mnt/oracle-store.json";

export interface StoredPosition {
  id: number;
  marketId: number;
  marketTitle: string;
  wallet: string;
  commitment: string;
  choice: boolean;
  depositedStake: number;
  submittedAt: Date;
  claimed: boolean;
  version: number;
}

export interface StoreSnapshot {
  version: number;
  savedAt: string;
  markets: any[];
  positions: any[];
  nextMarketId: number;
  nextPositionId: number;
}

export class OracleStore {
  private markets: any[] = [];
  private positions: StoredPosition[] = [];
  private nextMarketId: number = 0;
  private nextPositionId: number = 1000;
  private persistencePath?: string;

  constructor() {
    this.persistencePath = resolvePersistencePath();
    const snapshot = this.persistencePath ? loadSnapshot(this.persistencePath) : null;
    if (snapshot) {
      this.applySnapshot(snapshot);
    } else {
      this.seedDemoData();
    }
  }

  private seedDemoData() {
    this.markets = [...DEMO_MARKETS];
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
  }

  private persistSnapshot() {
    if (!this.persistencePath) return;
    const snapshot: StoreSnapshot = {
      version: CURRENT_STORE_VERSION,
      savedAt: new Date().toISOString(),
      markets: this.markets,
      positions: this.positions,
      nextMarketId: this.nextMarketId,
      nextPositionId: this.nextPositionId,
    };
    saveSnapshot(this.persistencePath, snapshot);
  }

  listMarkets(): any[] {
    return this.markets;
  }

  getMarketById(id: number): any | null {
    return this.markets.find(m => m.id === id) || null;
  }

  listPositions(filters: { marketId?: number; wallet?: string } = {}): StoredPosition[] {
    return this.positions.filter(p => {
      if (filters.marketId !== undefined && p.marketId !== filters.marketId) return false;
      if (filters.wallet !== undefined && p.wallet !== filters.wallet) return false;
      return true;
    });
  }

  submitPosition(input: any): { position: StoredPosition; txSig: string } {
    const txSig = randomBytes(32).toString("hex");
    const position: StoredPosition = {
      id: this.nextPositionId++,
      marketId: input.marketId,
      marketTitle: input.marketTitle || "Unknown",
      wallet: input.wallet,
      commitment: input.commitment,
      choice: input.choice,
      depositedStake: input.amount || 0,
      submittedAt: new Date(),
      claimed: false,
      version: CURRENT_STORE_VERSION,
    };
    this.positions.push(position);
    this.persistSnapshot();
    return { position, txSig };
  }
}

function resolvePersistencePath(): string | undefined {
  const configured = process.env[STORE_PATH_ENV]?.trim();
  if (configured) return resolve(configured);
  if (process.env.NODE_ENV === "development") return resolve(DEFAULT_STORE_PATH);
  return undefined;
}

function loadSnapshot(path: string): StoreSnapshot | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function saveSnapshot(path: string, snapshot: StoreSnapshot): void {
  try {
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    console.error("[oracle-store] Failed to persist snapshot.", error);
  }
}

export function normalizeWallet(wallet: string | string[] | undefined): string {
  const value = Array.isArray(wallet) ? wallet[0] : wallet;
  return value?.trim() || "demo_wallet";
}

export function isValidWalletAddress(wallet: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet);
}

type GlobalWithStore = typeof globalThis & { __oracleStore?: OracleStore };
const globalWithStore = globalThis as GlobalWithStore;
export const store = globalWithStore.__oracleStore ?? (globalWithStore.__oracleStore = new OracleStore());