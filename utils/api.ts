import type { DemoMarket, DemoPosition, ResolutionTimelineStep } from "../lib/shared/market-types";
import type { StoredMarket } from "../lib/server/store";
import type { StoredPosition } from "../lib/server/store";

export interface ApiResolutionTimelineStep
  extends Omit<ResolutionTimelineStep, "timestamp"> {
  timestamp: string;
}

export interface ApiMarket extends Omit<DemoMarket, "resolutionTimestamp" | "timeline"> {
  resolutionTimestamp: string;
  timeline: ApiResolutionTimelineStep[];
}

export interface ApiPosition extends Omit<DemoPosition, "submittedAt" | "settledAt" | "choice"> {
  submittedAt: string;
  settledAt?: string;
}

export interface ApiProbabilityHistoryPoint {
  timestamp: string;
  yesProbability: number;
  noProbability: number;
  volumeSol: number;
}

export interface ProbabilityHistoryPoint extends Omit<ApiProbabilityHistoryPoint, "timestamp"> {
  timestamp: Date;
}

export interface ApiMarketActivityRecord {
  id: string;
  slot: number;
  signature: string;
  marketId: number;
  type: string;
  actor: string;
  timestamp: string;
  details: string;
}

export interface MarketActivityRecord extends Omit<ApiMarketActivityRecord, "timestamp"> {
  timestamp: Date;
}

export interface ApiDisputeEvidence {
  id: string;
  submittedBy: string;
  summary: string;
  uri?: string;
  sourceType: string;
  sourceDomain?: string;
  evidenceHash: string;
  verificationStatus: string;
  createdAt: string;
}

export interface ApiDisputeResolution {
  outcome: string;
  resolvedBy: string;
  resolutionNote: string;
  resolvedAt: string;
}

export interface ApiSettlementDisputeRecord {
  id: string;
  marketId: number;
  submittedBy: string;
  contestedResolver: string;
  reason: string;
  settlementStakeAtRiskSol: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  challengeWindow?: {
    openedAt: string;
    deadlineAt: string;
    closedAt?: string;
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
    reasonCode: string;
    rationale: string;
    refundMode: string;
    decidedAt: string;
  };
  evidence: ApiDisputeEvidence[];
  resolution?: ApiDisputeResolution;
}

export interface SettlementDisputeRecord
  extends Omit<
    ApiSettlementDisputeRecord,
    "createdAt" | "updatedAt" | "challengeWindow" | "slashing" | "invalidResolution" | "evidence" | "resolution"
  > {
  createdAt: Date;
  updatedAt: Date;
  challengeWindow?: {
    openedAt: Date;
    deadlineAt: Date;
    closedAt?: Date;
  };
  slashing?: {
    slashBps: number;
    slashAmountSol: number;
    slashedResolver: string;
    beneficiary: string;
    reason: string;
    appliedAt: Date;
  };
  invalidResolution?: {
    reasonCode: string;
    rationale: string;
    refundMode: string;
    decidedAt: Date;
  };
  evidence: Array<Omit<ApiDisputeEvidence, "createdAt"> & { createdAt: Date }>;
  resolution?: Omit<ApiDisputeResolution, "resolvedAt"> & { resolvedAt: Date };
}

export function serializeMarket(market: DemoMarket): ApiMarket {
  return {
    ...market,
    resolutionTimestamp: market.resolutionTimestamp.toISOString(),
    timeline: market.timeline.map(serializeTimelineStep),
  };
}

export function serializeStoredMarket(market: StoredMarket): ApiMarket {
  const parsedTimestamp = new Date(market.resolutionTimestamp);
  const category = market.category ?? "Crypto";
  const status = (market.status as DemoMarket["status"]) ?? "Open";
  const totalParticipants = market.totalParticipants ?? 0;
  const rules = market.rules ?? [];
  const resolutionSource = market.resolutionSource ?? "Arcium MPC";
  return {
    id: market.id,
    category,
    title: market.title,
    description: market.description,
    resolutionTimestamp: (isNaN(parsedTimestamp.getTime()) ? new Date() : parsedTimestamp).toISOString(),
    status,
    totalParticipants,
    rules,
    resolutionSource,
    outcome: market.outcome,
    revealedYesStake: market.revealedYesStake,
    revealedNoStake: market.revealedNoStake,
    timeline: [],
  };
}

export function serializePosition(position: DemoPosition): ApiPosition {
  return {
    id: position.id,
    marketId: position.marketId,
    marketTitle: position.marketTitle,
    side: position.side,
    stakeSol: position.stakeSol,
    entryOdds: position.entryOdds,
    markOdds: position.markOdds,
    status: position.status,
    visibility: position.visibility,
    payoutSol: position.payoutSol,
    submittedAt: position.submittedAt.toISOString(),
    settledAt: position.settledAt?.toISOString(),
  };
}

export function serializeStoredPosition(position: StoredPosition): ApiPosition {
  return {
    id: position.id,
    marketId: position.marketId,
    marketTitle: position.marketTitle,
    side: "ENCRYPTED",
    status: "Open",
    visibility: "encrypted",
    submittedAt: position.submittedAt.toISOString(),
  };
}

export function deserializeMarket(market: ApiMarket): DemoMarket {
  return {
    ...market,
    resolutionTimestamp: new Date(market.resolutionTimestamp),
    timeline: market.timeline.map(deserializeTimelineStep),
  };
}

export function deserializePosition(position: ApiPosition): DemoPosition {
  return {
    ...position,
    visibility: position.visibility ?? "encrypted",
    submittedAt: new Date(position.submittedAt),
    settledAt: position.settledAt ? new Date(position.settledAt) : undefined,
  };
}

export function deserializeProbabilityPoint(
  point: ApiProbabilityHistoryPoint
): ProbabilityHistoryPoint {
  return {
    ...point,
    timestamp: new Date(point.timestamp),
  };
}

export function deserializeActivityRecord(
  record: ApiMarketActivityRecord
): MarketActivityRecord {
  return {
    ...record,
    timestamp: new Date(record.timestamp),
  };
}

export function deserializeSettlementDispute(
  dispute: ApiSettlementDisputeRecord
): SettlementDisputeRecord {
  return {
    ...dispute,
    createdAt: new Date(dispute.createdAt),
    updatedAt: new Date(dispute.updatedAt),
    evidence: dispute.evidence.map((item) => ({
      ...item,
      createdAt: new Date(item.createdAt),
    })),
    challengeWindow: dispute.challengeWindow
      ? {
          openedAt: new Date(dispute.challengeWindow.openedAt),
          deadlineAt: new Date(dispute.challengeWindow.deadlineAt),
          closedAt: dispute.challengeWindow.closedAt
            ? new Date(dispute.challengeWindow.closedAt)
            : undefined,
        }
      : undefined,
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

function summarizeUnexpectedResponseBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Empty response body.";
  }
  if (/^<!doctype html/i.test(compact) || /^<html/i.test(compact)) {
    return "Server returned HTML instead of JSON.";
  }
  return compact.slice(0, 160);
}

export async function readApiJson<T>(response: Response): Promise<T> {
  const rawBody = await response.text();
  if (!rawBody) {
    return {} as T;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    const contentType = response.headers.get("content-type") ?? "unknown content type";
    const detail = summarizeUnexpectedResponseBody(rawBody);
    throw new Error(
      response.ok
        ? `Expected JSON response but received ${contentType}. ${detail}`
        : `Backend returned ${response.status} ${response.statusText}. ${detail}`
    );
  }
}

export async function fetchApiJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ response: Response; payload: T }> {
  const response = await fetch(input, init);
  const payload = await readApiJson<T>(response);
  return { response, payload };
}

function serializeTimelineStep(step: ResolutionTimelineStep): ApiResolutionTimelineStep {
  return {
    ...step,
    timestamp: step.timestamp.toISOString(),
  };
}

function deserializeTimelineStep(step: ApiResolutionTimelineStep): ResolutionTimelineStep {
  return {
    ...step,
    timestamp: new Date(step.timestamp),
  };
}
