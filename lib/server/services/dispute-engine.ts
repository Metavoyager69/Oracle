import { createHash, randomBytes } from "crypto";

// This service is the "rulebook engine" for settlement disputes. The store
// serializes its snapshot into sqlite/file persistence, so the in-memory
// model here doubles as the source of truth for dispute rows.
const DEFAULT_CHALLENGE_WINDOW_HOURS = 24;
const DEFAULT_SLASH_BPS = 500;
const MIN_SLASH_BPS = 50;
const MAX_SLASH_BPS = 2_000;
const MAX_STAKE_AT_RISK_SOL = 1_000_000;
const MIN_REASON_LENGTH = 12;
const MAX_REASON_LENGTH = 280;
const MIN_EVIDENCE_SUMMARY_LENGTH = 8;
const MAX_EVIDENCE_SUMMARY_LENGTH = 280;
const MAX_EVIDENCE_URI_LENGTH = 512;
const MAX_EVIDENCE_ITEMS = 12;

export type DisputeStatus = "Open" | "Resolved" | "Rejected" | "Expired";
export type DisputeOutcome = "MarketInvalid" | "SettlementUpheld" | "MarketCancelled";
export type EvidenceSourceType =
  | "OfficialRecord"
  | "MarketDataAPI"
  | "NewsArticle"
  | "OnChainEvent"
  | "Other";
export type EvidenceVerificationStatus = "Pending" | "Verified" | "Rejected";
export type InvalidMarketReasonCode =
  | "INSUFFICIENT_RESOLUTION_DATA"
  | "AMBIGUOUS_MARKET_RULES"
  | "ORACLE_DATA_MISMATCH"
  | "SETTLEMENT_MANIPULATION"
  | "FORCE_MAJEURE_EVENT";

export interface DisputeEvidenceRecord {
  id: string;
  submittedBy: string;
  summary: string;
  uri?: string;
  sourceType: EvidenceSourceType;
  sourceDomain?: string;
  evidenceHash: string;
  verificationStatus: EvidenceVerificationStatus;
  createdAt: Date;
}

export interface DisputeResolutionRecord {
  outcome: DisputeOutcome;
  resolvedBy: string;
  resolutionNote: string;
  resolvedAt: Date;
}

export interface DisputeChallengeWindowRecord {
  openedAt: Date;
  deadlineAt: Date;
  closedAt?: Date;
}

export interface DisputeSlashingRecord {
  slashBps: number;
  slashAmountSol: number;
  slashedResolver: string;
  beneficiary: string;
  reason: string;
  appliedAt: Date;
}

export interface InvalidMarketResolutionRecord {
  reasonCode: InvalidMarketReasonCode;
  rationale: string;
  refundMode: "full_refund";
  decidedAt: Date;
}

export interface SettlementDisputeRecord {
  id: string;
  marketId: number;
  submittedBy: string;
  contestedResolver: string;
  reason: string;
  status: DisputeStatus;
  createdAt: Date;
  updatedAt: Date;
  settlementStakeAtRiskSol: number;
  challengeWindow: DisputeChallengeWindowRecord;
  evidence: DisputeEvidenceRecord[];
  resolution?: DisputeResolutionRecord;
  slashing?: DisputeSlashingRecord;
  invalidResolution?: InvalidMarketResolutionRecord;
}

export interface OpenDisputeInput {
  marketId: number;
  submittedBy: string;
  contestedResolver?: string;
  reason: string;
  settlementStakeAtRiskSol?: number;
  challengeWindowHours?: number;
  evidenceSummary?: string;
  evidenceUri?: string;
  evidenceSourceType?: EvidenceSourceType;
  evidenceSourceDomain?: string;
  now?: Date;
}

export interface AddEvidenceInput {
  disputeId: string;
  submittedBy: string;
  summary: string;
  uri?: string;
  sourceType?: EvidenceSourceType;
  sourceDomain?: string;
}

export interface ResolveDisputeInput {
  disputeId: string;
  resolvedBy: string;
  outcome: DisputeOutcome;
  resolutionNote: string;
  invalidReasonCode?: InvalidMarketReasonCode;
  slashBps?: number;
  now?: Date;
}

export interface DisputeEngineSnapshot {
  version: 1;
  nextDisputeId: number;
  disputes: SerializedDisputeRecord[];
}

interface SerializedDisputeRecord {
  id: string;
  marketId: number;
  submittedBy: string;
  contestedResolver: string;
  reason: string;
  status: DisputeStatus;
  createdAt: string;
  updatedAt: string;
  settlementStakeAtRiskSol: number;
  challengeWindow: {
    openedAt: string;
    deadlineAt: string;
    closedAt?: string;
  };
  evidence: Array<{
    id: string;
    submittedBy: string;
    summary: string;
    uri?: string;
    sourceType: EvidenceSourceType;
    sourceDomain?: string;
    evidenceHash: string;
    verificationStatus: EvidenceVerificationStatus;
    createdAt: string;
  }>;
  resolution?: {
    outcome: DisputeOutcome;
    resolvedBy: string;
    resolutionNote: string;
    resolvedAt: string;
  };
  slashing?: {
    slashBps: number;
    slashAmountSol: number;
    slashedResolver: string;
    beneficiary: string;
    reason: string;
    appliedAt: string;
  };
  invalidResolution?: {
    reasonCode: InvalidMarketReasonCode;
    rationale: string;
    refundMode: "full_refund";
    decidedAt: string;
  };
}

export class SettlementDisputeEngine {
  private disputes: SettlementDisputeRecord[] = [];
  private nextDisputeId = 1;

  // Returns all disputes (or disputes for one market), and auto-expires
  // records that stayed open past their challenge deadline.
  listDisputes(marketId?: number): SettlementDisputeRecord[] {
    this.expireDisputes();
    const filtered =
      typeof marketId === "number"
        ? this.disputes.filter((dispute) => dispute.marketId === marketId)
        : this.disputes;
    return filtered.map(cloneDispute);
  }

  getDispute(disputeId: string): SettlementDisputeRecord | null {
    this.expireDisputes();
    const dispute = this.disputes.find((item) => item.id === disputeId);
    return dispute ? cloneDispute(dispute) : null;
  }

  // Opens a new dispute ticket with optional initial evidence.
  // The challenge window is started immediately.
  openDispute(input: OpenDisputeInput): SettlementDisputeRecord {
    const now = input.now ? new Date(input.now) : new Date();
    const challengeWindowHours = clampInt(
      input.challengeWindowHours ?? DEFAULT_CHALLENGE_WINDOW_HOURS,
      1,
      168
    );
    const stakeAtRisk = clampNumber(input.settlementStakeAtRiskSol ?? 0, 0, MAX_STAKE_AT_RISK_SOL);
    const reason = input.reason.trim();
    if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
      throw new Error(
        `Dispute reason must be between ${MIN_REASON_LENGTH} and ${MAX_REASON_LENGTH} characters.`
      );
    }

    const dispute: SettlementDisputeRecord = {
      id: `disp_${String(this.nextDisputeId++).padStart(6, "0")}`,
      marketId: input.marketId,
      submittedBy: input.submittedBy,
      contestedResolver: input.contestedResolver?.trim() || "oracle-settlement-engine",
      reason,
      status: "Open",
      createdAt: now,
      updatedAt: now,
      settlementStakeAtRiskSol: stakeAtRisk,
      challengeWindow: {
        openedAt: now,
        deadlineAt: new Date(now.getTime() + challengeWindowHours * 60 * 60 * 1000),
      },
      evidence: [],
    };

    if (input.evidenceSummary) {
      const summary = input.evidenceSummary.trim();
      if (
        summary.length < MIN_EVIDENCE_SUMMARY_LENGTH ||
        summary.length > MAX_EVIDENCE_SUMMARY_LENGTH
      ) {
        throw new Error(
          `Evidence summary must be between ${MIN_EVIDENCE_SUMMARY_LENGTH} and ${MAX_EVIDENCE_SUMMARY_LENGTH} characters.`
        );
      }
      const normalizedUri = normalizeEvidenceUri(input.evidenceUri);
      const sourceDomain = normalizeSourceDomain(normalizedUri, input.evidenceSourceDomain);
      dispute.evidence.push({
        id: randomId("ev"),
        submittedBy: input.submittedBy,
        summary,
        uri: normalizedUri,
        sourceType: input.evidenceSourceType ?? "Other",
        sourceDomain,
        evidenceHash: evidenceHashFor(summary, normalizedUri, now),
        verificationStatus: deriveVerificationStatus(normalizedUri, sourceDomain),
        createdAt: now,
      });
    }

    this.disputes.unshift(dispute);
    return cloneDispute(dispute);
  }

  // Adds a new evidence item while the dispute is still open.
  // Evidence gets a hash and verification status for traceability.
  addEvidence(input: AddEvidenceInput): SettlementDisputeRecord {
    const dispute = this.disputes.find((item) => item.id === input.disputeId);
    if (!dispute) {
      throw new Error("Dispute not found.");
    }
    if (dispute.status !== "Open") {
      throw new Error("Dispute is no longer open.");
    }
    if (dispute.evidence.length >= MAX_EVIDENCE_ITEMS) {
      throw new Error("Evidence limit reached for this dispute.");
    }

    const now = new Date();
    const summary = input.summary.trim();
    if (
      summary.length < MIN_EVIDENCE_SUMMARY_LENGTH ||
      summary.length > MAX_EVIDENCE_SUMMARY_LENGTH
    ) {
      throw new Error(
        `Evidence summary must be between ${MIN_EVIDENCE_SUMMARY_LENGTH} and ${MAX_EVIDENCE_SUMMARY_LENGTH} characters.`
      );
    }
    const normalizedUri = normalizeEvidenceUri(input.uri);
    const sourceDomain = normalizeSourceDomain(normalizedUri, input.sourceDomain);
    dispute.evidence.push({
      id: randomId("ev"),
      submittedBy: input.submittedBy,
      summary,
      uri: normalizedUri,
      sourceType: input.sourceType ?? "Other",
      sourceDomain,
      evidenceHash: evidenceHashFor(summary, normalizedUri, now),
      verificationStatus: deriveVerificationStatus(normalizedUri, sourceDomain),
      createdAt: now,
    });
    dispute.updatedAt = now;

    return cloneDispute(dispute);
  }

  // Applies the final dispute decision.
  // Successful challenge outcomes can trigger slashing metadata.
  resolveDispute(input: ResolveDisputeInput): SettlementDisputeRecord {
    const now = input.now ? new Date(input.now) : new Date();
    this.expireDisputes(now);

    const dispute = this.disputes.find((item) => item.id === input.disputeId);
    if (!dispute) {
      throw new Error("Dispute not found.");
    }
    if (dispute.status === "Expired") {
      throw new Error("Challenge window has closed.");
    }
    if (dispute.status !== "Open") {
      throw new Error("Dispute is already resolved.");
    }

    if (dispute.challengeWindow.deadlineAt.getTime() < now.getTime()) {
      dispute.status = "Expired";
      dispute.challengeWindow.closedAt = now;
      dispute.updatedAt = now;
      throw new Error("Challenge window has closed.");
    }

    dispute.status = input.outcome === "SettlementUpheld" ? "Rejected" : "Resolved";
    dispute.resolution = {
      outcome: input.outcome,
      resolvedBy: input.resolvedBy,
      resolutionNote: input.resolutionNote,
      resolvedAt: now,
    };
    dispute.challengeWindow.closedAt = now;
    dispute.updatedAt = now;

    if (input.outcome !== "SettlementUpheld") {
      const slashBps = clampInt(input.slashBps ?? DEFAULT_SLASH_BPS, MIN_SLASH_BPS, MAX_SLASH_BPS);
      const slashAmountSol = roundToSix((dispute.settlementStakeAtRiskSol * slashBps) / 10_000);
      dispute.slashing = {
        slashBps,
        slashAmountSol,
        slashedResolver: dispute.contestedResolver,
        beneficiary: dispute.submittedBy,
        reason:
          input.outcome === "MarketCancelled"
            ? "Settlement cancelled after successful challenge."
            : "Settlement invalidated by challenge evidence.",
        appliedAt: now,
      };
      dispute.invalidResolution = {
        reasonCode: input.invalidReasonCode ?? "INSUFFICIENT_RESOLUTION_DATA",
        rationale: input.resolutionNote,
        refundMode: "full_refund",
        decidedAt: now,
      };
    }

    return cloneDispute(dispute);
  }

  // Marks stale open disputes as expired once their deadline passes.
  expireDisputes(reference = new Date()): number {
    let expiredCount = 0;
    for (const dispute of this.disputes) {
      if (dispute.status !== "Open") continue;
      if (dispute.challengeWindow.deadlineAt.getTime() >= reference.getTime()) continue;
      dispute.status = "Expired";
      dispute.updatedAt = new Date(reference);
      dispute.challengeWindow.closedAt = new Date(reference);
      expiredCount += 1;
    }
    return expiredCount;
  }

  snapshot(): DisputeEngineSnapshot {
    // Store snapshots persist disputes as JSON-safe strings, so Date fields
    // are converted here before the outer store writes them.
    return {
      version: 1,
      nextDisputeId: this.nextDisputeId,
      disputes: this.disputes.map(serializeDisputeSnapshot),
    };
  }

  restore(snapshot: DisputeEngineSnapshot): void {
    if (!snapshot || snapshot.version !== 1) {
      throw new Error("Unsupported dispute engine snapshot version.");
    }
    // Restoring here keeps the store layer free to treat disputes as a single
    // opaque subsystem when rehydrating application state.
    this.nextDisputeId = snapshot.nextDisputeId;
    this.disputes = snapshot.disputes.map(deserializeDisputeSnapshot);
  }
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function cloneDispute(dispute: SettlementDisputeRecord): SettlementDisputeRecord {
  return {
    ...dispute,
    createdAt: new Date(dispute.createdAt),
    updatedAt: new Date(dispute.updatedAt),
    challengeWindow: {
      openedAt: new Date(dispute.challengeWindow.openedAt),
      deadlineAt: new Date(dispute.challengeWindow.deadlineAt),
      closedAt: dispute.challengeWindow.closedAt
        ? new Date(dispute.challengeWindow.closedAt)
        : undefined,
    },
    evidence: dispute.evidence.map((item) => ({
      ...item,
      createdAt: new Date(item.createdAt),
    })),
    slashing: dispute.slashing
      ? {
          ...dispute.slashing,
          appliedAt: new Date(dispute.slashing.appliedAt),
        }
      : undefined,
    invalidResolution: dispute.invalidResolution
      ? {
          ...dispute.invalidResolution,
          decidedAt: new Date(dispute.invalidResolution.decidedAt),
        }
      : undefined,
    resolution: dispute.resolution
      ? {
          ...dispute.resolution,
          resolvedAt: new Date(dispute.resolution.resolvedAt),
        }
      : undefined,
  };
}

function serializeDisputeSnapshot(dispute: SettlementDisputeRecord): SerializedDisputeRecord {
  return {
    id: dispute.id,
    marketId: dispute.marketId,
    submittedBy: dispute.submittedBy,
    contestedResolver: dispute.contestedResolver,
    reason: dispute.reason,
    status: dispute.status,
    createdAt: dispute.createdAt.toISOString(),
    updatedAt: dispute.updatedAt.toISOString(),
    settlementStakeAtRiskSol: dispute.settlementStakeAtRiskSol,
    challengeWindow: {
      openedAt: dispute.challengeWindow.openedAt.toISOString(),
      deadlineAt: dispute.challengeWindow.deadlineAt.toISOString(),
      closedAt: dispute.challengeWindow.closedAt
        ? dispute.challengeWindow.closedAt.toISOString()
        : undefined,
    },
    evidence: dispute.evidence.map((item) => ({
      id: item.id,
      submittedBy: item.submittedBy,
      summary: item.summary,
      uri: item.uri,
      sourceType: item.sourceType,
      sourceDomain: item.sourceDomain,
      evidenceHash: item.evidenceHash,
      verificationStatus: item.verificationStatus,
      createdAt: item.createdAt.toISOString(),
    })),
    resolution: dispute.resolution
      ? {
          outcome: dispute.resolution.outcome,
          resolvedBy: dispute.resolution.resolvedBy,
          resolutionNote: dispute.resolution.resolutionNote,
          resolvedAt: dispute.resolution.resolvedAt.toISOString(),
        }
      : undefined,
    slashing: dispute.slashing
      ? {
          slashBps: dispute.slashing.slashBps,
          slashAmountSol: dispute.slashing.slashAmountSol,
          slashedResolver: dispute.slashing.slashedResolver,
          beneficiary: dispute.slashing.beneficiary,
          reason: dispute.slashing.reason,
          appliedAt: dispute.slashing.appliedAt.toISOString(),
        }
      : undefined,
    invalidResolution: dispute.invalidResolution
      ? {
          reasonCode: dispute.invalidResolution.reasonCode,
          rationale: dispute.invalidResolution.rationale,
          refundMode: "full_refund",
          decidedAt: dispute.invalidResolution.decidedAt.toISOString(),
        }
      : undefined,
  };
}

function deserializeDisputeSnapshot(snapshot: SerializedDisputeRecord): SettlementDisputeRecord {
  return {
    id: snapshot.id,
    marketId: snapshot.marketId,
    submittedBy: snapshot.submittedBy,
    contestedResolver: snapshot.contestedResolver,
    reason: snapshot.reason,
    status: snapshot.status,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
    settlementStakeAtRiskSol: snapshot.settlementStakeAtRiskSol,
    challengeWindow: {
      openedAt: new Date(snapshot.challengeWindow.openedAt),
      deadlineAt: new Date(snapshot.challengeWindow.deadlineAt),
      closedAt: snapshot.challengeWindow.closedAt
        ? new Date(snapshot.challengeWindow.closedAt)
        : undefined,
    },
    evidence: snapshot.evidence.map((item) => ({
      id: item.id,
      submittedBy: item.submittedBy,
      summary: item.summary,
      uri: item.uri,
      sourceType: item.sourceType,
      sourceDomain: item.sourceDomain,
      evidenceHash: item.evidenceHash,
      verificationStatus: item.verificationStatus,
      createdAt: new Date(item.createdAt),
    })),
    resolution: snapshot.resolution
      ? {
          outcome: snapshot.resolution.outcome,
          resolvedBy: snapshot.resolution.resolvedBy,
          resolutionNote: snapshot.resolution.resolutionNote,
          resolvedAt: new Date(snapshot.resolution.resolvedAt),
        }
      : undefined,
    slashing: snapshot.slashing
      ? {
          slashBps: snapshot.slashing.slashBps,
          slashAmountSol: snapshot.slashing.slashAmountSol,
          slashedResolver: snapshot.slashing.slashedResolver,
          beneficiary: snapshot.slashing.beneficiary,
          reason: snapshot.slashing.reason,
          appliedAt: new Date(snapshot.slashing.appliedAt),
        }
      : undefined,
    invalidResolution: snapshot.invalidResolution
      ? {
          reasonCode: snapshot.invalidResolution.reasonCode,
          rationale: snapshot.invalidResolution.rationale,
          refundMode: "full_refund",
          decidedAt: new Date(snapshot.invalidResolution.decidedAt),
        }
      : undefined,
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function roundToSix(value: number): number {
  return Number(value.toFixed(6));
}

function evidenceHashFor(summary: string, uri: string | undefined, createdAt: Date): string {
  // Hash acts like a tamper-evident fingerprint for the evidence item.
  return createHash("sha256")
    .update(summary.trim().toLowerCase())
    .update("|")
    .update((uri ?? "").trim().toLowerCase())
    .update("|")
    .update(createdAt.toISOString())
    .digest("hex");
}

function normalizeEvidenceUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const trimmed = uri.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_EVIDENCE_URI_LENGTH) {
    throw new Error(`Evidence URI must be ${MAX_EVIDENCE_URI_LENGTH} characters or less.`);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") {
      throw new Error("Evidence URI must use https://");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Evidence URI must")) {
      throw error;
    }
    throw new Error("Evidence URI must be a valid https:// URL.");
  }
  return trimmed;
}

function normalizeSourceDomain(uri: string | undefined, sourceDomain: string | undefined): string | undefined {
  if (sourceDomain?.trim()) return sourceDomain.trim().toLowerCase();
  if (!uri) return undefined;
  try {
    const parsed = new URL(uri);
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function deriveVerificationStatus(
  uri: string | undefined,
  sourceDomain: string | undefined
): EvidenceVerificationStatus {
  // Simple trust heuristic:
  // - no URI => pending manual review
  // - non-HTTPS => rejected
  // - HTTPS + valid source domain => verified
  if (!uri) return "Pending";
  const isHttps = /^https:\/\//i.test(uri);
  if (!isHttps) return "Rejected";
  if (!sourceDomain) return "Pending";
  if (sourceDomain === "example.com") return "Rejected";
  return "Verified";
}
