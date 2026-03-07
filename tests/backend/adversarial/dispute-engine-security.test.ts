import assert from "node:assert/strict";
import test from "node:test";
import { SettlementDisputeEngine } from "../../../lib/server/services/dispute-engine.ts";

const CHALLENGER = "Stake11111111111111111111111111111111111111";

test("adversarial: replay resolution attempt is rejected", () => {
  const engine = new SettlementDisputeEngine();
  const opened = engine.openDispute({
    marketId: 33,
    submittedBy: CHALLENGER,
    reason: "Disputed settlement artifacts fail reproducibility checks.",
    challengeWindowHours: 6,
    now: new Date("2026-03-07T09:00:00.000Z"),
  });

  engine.resolveDispute({
    disputeId: opened.id,
    resolvedBy: CHALLENGER,
    outcome: "MarketInvalid",
    resolutionNote: "First challenge accepted.",
    now: new Date("2026-03-07T10:00:00.000Z"),
  });

  assert.throws(
    () =>
      engine.resolveDispute({
        disputeId: opened.id,
        resolvedBy: CHALLENGER,
        outcome: "MarketCancelled",
        resolutionNote: "Replay resolution should fail.",
        now: new Date("2026-03-07T10:05:00.000Z"),
      }),
    /already resolved/i
  );
});

test("adversarial: late challenge cannot be resolved after challenge window", () => {
  const engine = new SettlementDisputeEngine();
  const opened = engine.openDispute({
    marketId: 34,
    submittedBy: CHALLENGER,
    reason: "Challenge submitted too late should expire.",
    challengeWindowHours: 1,
    now: new Date("2026-03-07T09:00:00.000Z"),
  });

  assert.throws(
    () =>
      engine.resolveDispute({
        disputeId: opened.id,
        resolvedBy: CHALLENGER,
        outcome: "MarketInvalid",
        resolutionNote: "Attempting to resolve after challenge window closure.",
        now: new Date("2026-03-07T10:30:00.000Z"),
      }),
    /Challenge window has closed/i
  );
});

test("adversarial: slash and stake-at-risk values are clamped to safe bounds", () => {
  const engine = new SettlementDisputeEngine();
  const opened = engine.openDispute({
    marketId: 35,
    submittedBy: CHALLENGER,
    reason: "Attempting extreme slash parameters for griefing behavior.",
    settlementStakeAtRiskSol: 50_000_000,
    challengeWindowHours: 2,
    now: new Date("2026-03-07T09:00:00.000Z"),
  });

  const resolved = engine.resolveDispute({
    disputeId: opened.id,
    resolvedBy: CHALLENGER,
    outcome: "MarketInvalid",
    resolutionNote: "System should clamp slash to protocol max.",
    slashBps: 90_000,
    now: new Date("2026-03-07T09:30:00.000Z"),
  });

  assert.equal(resolved.settlementStakeAtRiskSol, 1_000_000);
  assert.equal(resolved.slashing?.slashBps, 2_000);
  assert.equal(resolved.slashing?.slashAmountSol, 200_000);
});
