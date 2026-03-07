import { createHash, randomBytes } from "crypto";
import type { MarketStatus } from "../../../utils/program";
import type { SettlementDisputeRecord } from "./dispute-engine";

export type IndexerEventType =
  | "MARKET_CREATED"
  | "POSITION_SUBMITTED"
  | "DISPUTE_OPENED"
  | "DISPUTE_EVIDENCE_ADDED"
  | "DISPUTE_RESOLVED"
  | "DISPUTE_SLASHED"
  | "MARKET_STATUS_CHANGED";

export interface IndexerEventRecord {
  id: string;
  slot: number;
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
  openDisputes: number;
  invalidMarkets: number;
  openMarkets: number;
  settledMarkets: number;
}

export interface IndexerEventInput {
  marketId: number;
  type: IndexerEventType;
  actor: string;
  details: string;
  timestamp?: Date;
  signature?: string;
}

export class SolanaIndexerWorkerService {
  private events: IndexerEventRecord[] = [];
  private auditLog: AuditLogRecord[] = [];
  private currentSlot = 200_000_000;
  private nextEventId = 1;

  consumeEvent(input: IndexerEventInput): IndexerEventRecord {
    const slot = ++this.currentSlot;
    const event: IndexerEventRecord = {
      id: `evt_${String(this.nextEventId++).padStart(8, "0")}`,
      slot,
      signature: input.signature ?? randomBytes(32).toString("hex"),
      marketId: input.marketId,
      type: input.type,
      actor: input.actor,
      timestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
      details: input.details,
    };

    this.events.unshift(event);
    const previousHash = this.auditLog[0]?.integrityHash ?? "GENESIS";
    const integrityHash = createHash("sha256")
      .update(previousHash)
      .update(JSON.stringify(event))
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

  reconcileState(
    marketStatuses: Array<{ id: number; status: MarketStatus }>,
    disputes: SettlementDisputeRecord[]
  ): IndexerReconcileReport {
    const openDisputes = disputes.filter((dispute) => dispute.status === "Open").length;
    const invalidMarkets = marketStatuses.filter((market) => market.status === "Invalid").length;
    const openMarkets = marketStatuses.filter((market) => market.status === "Open").length;
    const settledMarkets = marketStatuses.filter((market) => market.status === "Settled").length;

    return {
      generatedAt: new Date(),
      totalEvents: this.events.length,
      openDisputes,
      invalidMarkets,
      openMarkets,
      settledMarkets,
    };
  }
}

function cloneEvent(event: IndexerEventRecord): IndexerEventRecord {
  return {
    ...event,
    timestamp: new Date(event.timestamp),
  };
}

function cloneAuditLogRecord(entry: AuditLogRecord): AuditLogRecord {
  return {
    ...entry,
    timestamp: new Date(entry.timestamp),
  };
}
