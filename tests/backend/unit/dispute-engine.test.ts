import assert from "node:assert/strict";
import test from "node:test";
import {
  SettlementDisputeEngine,
  type InvalidMarketReasonCode,
} from "../../../lib/server/services/dispute-engine.ts";

const TEST_WALLET = "9xQeWvG816bUx9EPfM5f6K4M6R4xM3aMcMBXNte1qNbf";

test("unit: MarketInvalid resolution records slashing and invalid metadata", () => {
  const engine = new SettlementDisputeEngine();
  const openedAt = new Date("2026-03-07T09:00:00.000Z");

  const dispute = engine.openDispute({
    marketId: 11,
    submittedBy: TEST_WALLET,
    contestedResolver: "oracle-engine",
    reason: "Primary oracle and fallback source mismatch at settlement time.",
    settlementStakeAtRiskSol: 240,
    challengeWindowHours: 12,
    evidenceSummary: "Source hashes and timestamps differ.",
    now: openedAt,
  });

  const invalidReasonCode: InvalidMarketReasonCode = "ORACLE_DATA_MISMATCH";
  const resolved = engine.resolveDispute({
    disputeId: dispute.id,
    resolvedBy: TEST_WALLET,
    outcome: "MarketInvalid",
    resolutionNote: "Evidence confirms source divergence during the settlement window.",
    invalidReasonCode,
    slashBps: 500,
    now: new Date("2026-03-07T10:00:00.000Z"),
  });

  assert.equal(resolved.status, "Resolved");
  assert.equal(resolved.resolution?.outcome, "MarketInvalid");
  assert.equal(resolved.invalidResolution?.reasonCode, invalidReasonCode);
  assert.equal(resolved.slashing?.slashBps, 500);
  assert.equal(resolved.slashing?.slashAmountSol, 12);
  assert.equal(resolved.challengeWindow.closedAt?.toISOString(), "2026-03-07T10:00:00.000Z");
});

test("unit: SettlementUpheld marks dispute rejected without slashing", () => {
  const engine = new SettlementDisputeEngine();
  const dispute = engine.openDispute({
    marketId: 17,
    submittedBy: TEST_WALLET,
    reason: "Submitted challenge where evidence may be inconclusive.",
    challengeWindowHours: 3,
    now: new Date("2026-03-07T09:00:00.000Z"),
  });

  const resolved = engine.resolveDispute({
    disputeId: dispute.id,
    resolvedBy: TEST_WALLET,
    outcome: "SettlementUpheld",
    resolutionNote: "Settlement artifacts are consistent and verifiable.",
    now: new Date("2026-03-07T10:00:00.000Z"),
  });

  assert.equal(resolved.status, "Rejected");
  assert.equal(resolved.slashing, undefined);
  assert.equal(resolved.invalidResolution, undefined);
});

test("unit: open disputes expire when challenge window closes", () => {
  const engine = new SettlementDisputeEngine();
  const dispute = engine.openDispute({
    marketId: 19,
    submittedBy: TEST_WALLET,
    reason: "Potential manipulation flagged by delayed data publication.",
    challengeWindowHours: 1,
    now: new Date("2026-03-07T09:00:00.000Z"),
  });

  const expired = engine.expireDisputes(new Date("2026-03-07T11:00:01.000Z"));
  assert.equal(expired, 1);

  const snapshot = engine.getDispute(dispute.id);
  assert.equal(snapshot?.status, "Expired");

  assert.throws(
    () =>
      engine.resolveDispute({
        disputeId: dispute.id,
        resolvedBy: TEST_WALLET,
        outcome: "MarketInvalid",
        resolutionNote: "Late resolution attempt.",
        now: new Date("2026-03-07T11:30:00.000Z"),
      }),
    /Challenge window has closed/i
  );
});
