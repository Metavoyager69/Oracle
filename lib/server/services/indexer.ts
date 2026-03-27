import { createHash, randomBytes } from "crypto";
import type { MarketStatus } from "../../../utils/program";

// The store persists this service alongside markets so operators can inspect
// an append-only activity feed and its tamper-evident audit trail.
export type IndexerEventType =
  | "MARKET_CREATED"
  | "POSITION_COMMITTED"
  | "POSITION_BATCHED"
  | "POSITION_SUBMITTED"
  | "DISPUTE_OPENED"
  | "DISPUTE_EVIDENCE_ADDED"
  | "DISPUTE_RESOLVED"
  | "DISPUTE_SLASHED"
  | "MARKET_STATUS_CHANGED";

export interface IndexerEventRecord {
  id: string;
  slot: number; // [ISSUE 23 FIX] - Real blockchain slot
  signature: string;
  marketId: number;
  type: IndexerEventType;
  actor: string;
  timestamp: Date;
  details: string;
}

export interface AuditLogRecord extends IndexerEventRecord {
  integrityHash: string;
}

export interface IndexerReconcileReport {
  generatedAt: Date;
  totalEvents: number;
  lastSlot: number;
  integrityVerified: boolean;
}

export interface IndexerEventInput {
  marketId: number;
  type: IndexerEventType;
  actor: string;
  details: string;
  slot: number; // Required real slot
  signature: string; // Required real signature
  timestamp?: Date;
}

export interface IndexerSnapshot {
  version: 2;
  nextEventId: number;
  events: SerializedIndexerEvent[];
  auditLog: SerializedAuditLogRecord[];
}

interface SerializedIndexerEvent {
  id: string;
  slot: number;
  signature: string;
  marketId: number;
  type: IndexerEventType;
  actor: string;
  timestamp: string;
  details: string;
}

interface SerializedAuditLogRecord extends SerializedIndexerEvent {
  integrityHash: string;
}

export class SolanaIndexerWorkerService {
  private events: IndexerEventRecord[] = [];
  // Newest audit entry stays at index 0 so each new hash can chain off the
  // previously committed head in O(1).
  private auditLog: AuditLogRecord[] = [];
  private nextEventId = 1;

  // [ISSUE 20 FIX] - Verify the entire SHA-256 integrity chain on restore
  verifyIntegrityChain(): boolean {
    if (this.auditLog.length === 0) return true;
    
    for (let i = 0; i < this.auditLog.length - 1; i++) {
      const current = this.auditLog[i];
      const previous = this.auditLog[i + 1]; // Chain goes backwards in array
      
      const expectedHash = createHash("sha256")
        .update(previous.integrityHash)
        .update(JSON.stringify(serializeEventSnapshot(stripIntegrity(current))))
        .digest("hex");
        
      if (current.integrityHash !== expectedHash) {
        console.error(`[indexer] INTEGRITY BREACH: Event ${current.id} has invalid hash chain.`);
        return false;
      }
    }
    return true;
  }

  consumeEvent(input: IndexerEventInput): IndexerEventRecord {
    const event: IndexerEventRecord = {
      id: `evt_${String(this.nextEventId++).padStart(8, "0")}`,
      slot: input.slot,
      signature: input.signature,
      marketId: input.marketId,
      type: input.type,
      actor: input.actor,
      timestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
      details: input.details,
    };

    this.events.unshift(event);
    // Each audit record hashes the previous head plus the current event
    // payload, creating a simple integrity chain over persisted activity.
    const previousHash = this.auditLog[0]?.integrityHash ?? "GENESIS";
    const integrityHash = createHash("sha256")
      .update(previousHash)
      .update(JSON.stringify(serializeEventSnapshot(event)))
      .digest("hex");

    this.auditLog.unshift({
      ...event,
      integrityHash,
    });

    return cloneEvent(event);
  }

  listMarketActivity(marketId: number, limit = 50): IndexerEventRecord[] {
    return this.events
      .filter((event) => event.marketId === marketId)
      .slice(0, Math.max(1, limit))
      .map(cloneEvent);
  }

  listAuditLog(limit = 200): AuditLogRecord[] {
    return this.auditLog.slice(0, Math.max(1, limit)).map(cloneAuditLogRecord);
  }

  reconcileState(): IndexerReconcileReport {
    return {
      generatedAt: new Date(),
      totalEvents: this.events.length,
      lastSlot: this.events[0]?.slot ?? 0,
      integrityVerified: this.verifyIntegrityChain(),
    };
  }

  snapshot(): IndexerSnapshot {
    return {
      version: 2,
      nextEventId: this.nextEventId,
      events: this.events.map(serializeEventSnapshot),
      auditLog: this.auditLog.map(serializeAuditSnapshot),
    };
  }

  restore(snapshot: IndexerSnapshot): void {
    if (!snapshot || snapshot.version !== 2) {
      console.warn("[indexer] Unsupported snapshot version, starting fresh.");
      return;
    }
    this.nextEventId = snapshot.nextEventId;
    this.events = snapshot.events.map(deserializeEventSnapshot);
    this.auditLog = snapshot.auditLog.map(deserializeAuditSnapshot);
    
    // Re-verify persisted history before trusting the reconstructed audit log.
    if (!this.verifyIntegrityChain()) {
      console.error("[indexer] Snapshot integrity verification FAILED.");
    }
  }
}

function cloneEvent(event: IndexerEventRecord): IndexerEventRecord {
  return { ...event, timestamp: new Date(event.timestamp) };
}

function cloneAuditLogRecord(entry: AuditLogRecord): AuditLogRecord {
  return { ...entry, timestamp: new Date(entry.timestamp) };
}

function serializeEventSnapshot(event: IndexerEventRecord): SerializedIndexerEvent {
  return {
    id: event.id,
    slot: event.slot,
    signature: event.signature,
    marketId: event.marketId,
    type: event.type,
    actor: event.actor,
    timestamp: event.timestamp.toISOString(),
    details: event.details,
  };
}

function serializeAuditSnapshot(entry: AuditLogRecord): SerializedAuditLogRecord {
  return {
    ...serializeEventSnapshot(entry),
    integrityHash: entry.integrityHash,
  };
}

function deserializeEventSnapshot(event: SerializedIndexerEvent): IndexerEventRecord {
  return {
    ...event,
    timestamp: new Date(event.timestamp),
  };
}

function deserializeAuditSnapshot(entry: SerializedAuditLogRecord): AuditLogRecord {
  return {
    ...deserializeEventSnapshot(entry),
    integrityHash: entry.integrityHash,
  };
}

function stripIntegrity(entry: AuditLogRecord): IndexerEventRecord {
  return {
    id: entry.id,
    slot: entry.slot,
    signature: entry.signature,
    marketId: entry.marketId,
    type: entry.type,
    actor: entry.actor,
    timestamp: entry.timestamp,
    details: entry.details,
  };
}
