import assert from "node:assert/strict";
import test from "node:test";
import { SettlementDisputeEngine } from "../../../lib/server/services/dispute-engine.ts";
import { SolanaIndexerWorkerService } from "../../../lib/server/services/indexer.ts";
import type { MarketStatus } from "../../../utils/program.ts";

const TEST_WALLET = "Vote111111111111111111111111111111111111111";

test("integration: invalid challenge resolution is reflected in audit and reconcile state", () => {
  const engine = new SettlementDisputeEngine();
  const indexer = new SolanaIndexerWorkerService();
  const marketId = 7;

  const dispute = engine.openDispute({
    marketId,
    submittedBy: TEST_WALLET,
    reason: "Settlement source hashes diverge between primary and fallback feeds.",
    settlementStakeAtRiskSol: 180,
    evidenceSummary: "Included signed snapshots from both sources.",
    now: new Date("2026-03-07T09:00:00.000Z"),
  });
  indexer.consumeEvent({
    marketId,
    type: "DISPUTE_OPENED",
    actor: TEST_WALLET,
    details: "Dispute opened",
    timestamp: dispute.createdAt,
  });

  const withEvidence = engine.addEvidence({
    disputeId: dispute.id,
    submittedBy: TEST_WALLET,
    summary: "Fallback source final candle timestamp differs by 2 minutes.",
  });
  indexer.consumeEvent({
    marketId,
    type: "DISPUTE_EVIDENCE_ADDED",
    actor: TEST_WALLET,
    details: `Evidence count ${withEvidence.evidence.length}`,
  });

  const resolved = engine.resolveDispute({
    disputeId: dispute.id,
    resolvedBy: TEST_WALLET,
    outcome: "MarketInvalid",
    invalidReasonCode: "ORACLE_DATA_MISMATCH",
    resolutionNote: "Mismatch reproduced by independent observer nodes.",
    slashBps: 500,
    now: new Date("2026-03-07T10:00:00.000Z"),
  });
  indexer.consumeEvent({
    marketId,
    type: "DISPUTE_RESOLVED",
    actor: TEST_WALLET,
    details: resolved.resolution?.outcome ?? "unknown",
    timestamp: resolved.resolution?.resolvedAt,
  });
  if (resolved.slashing) {
    indexer.consumeEvent({
      marketId,
      type: "DISPUTE_SLASHED",
      actor: TEST_WALLET,
      details: `${resolved.slashing.slashBps}bps`,
      timestamp: resolved.slashing.appliedAt,
    });
  }

  const marketStatuses: Array<{ id: number; status: MarketStatus }> = [{ id: marketId, status: "Invalid" }];
  const report = indexer.reconcileState(marketStatuses, engine.listDisputes(marketId));
  const audit = indexer.listAuditLog(20);

  assert.equal(resolved.status, "Resolved");
  assert.ok((resolved.slashing?.slashAmountSol ?? 0) > 0);
  assert.equal(report.invalidMarkets, 1);
  assert.equal(report.openDisputes, 0);
  assert.ok(audit.some((entry) => entry.type === "DISPUTE_SLASHED"));
});

test("integration: upheld challenge keeps zero invalid markets and no slashing event", () => {
  const engine = new SettlementDisputeEngine();
  const indexer = new SolanaIndexerWorkerService();
  const marketId = 12;

  const dispute = engine.openDispute({
    marketId,
    submittedBy: TEST_WALLET,
    reason: "Challenge raised for review but evidence quality is weak.",
    now: new Date("2026-03-07T09:00:00.000Z"),
  });

  const resolved = engine.resolveDispute({
    disputeId: dispute.id,
    resolvedBy: TEST_WALLET,
    outcome: "SettlementUpheld",
    resolutionNote: "Evidence does not invalidate settlement artifacts.",
    now: new Date("2026-03-07T09:30:00.000Z"),
  });

  indexer.consumeEvent({
    marketId,
    type: "DISPUTE_RESOLVED",
    actor: TEST_WALLET,
    details: resolved.resolution?.outcome ?? "unknown",
  });

  const report = indexer.reconcileState([{ id: marketId, status: "Settled" }], engine.listDisputes(marketId));
  const audit = indexer.listAuditLog(20);

  assert.equal(resolved.status, "Rejected");
  assert.equal(resolved.slashing, undefined);
  assert.equal(report.invalidMarkets, 0);
  assert.ok(!audit.some((entry) => entry.type === "DISPUTE_SLASHED"));
});
