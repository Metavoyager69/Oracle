import type { NextApiRequest, NextApiResponse } from "next";
import { serializeMarket, serializePosition } from "../../../utils/api";
import { normalizeWallet, store } from "../../../lib/server/store";

// API endpoint: returns one market plus related chart/activity/dispute data.
// Important privacy rule: position history is wallet-scoped only.
function parseId(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return Number.NaN;
  return Number.parseInt(raw, 10);
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
    return;
  }

  const id = parseId(req.query.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid market id." });
    return;
  }

  const market = store.getMarketById(id);
  if (!market) {
    res.status(404).json({ error: "Market not found." });
    return;
  }

  const walletScope = req.query.wallet ? normalizeWallet(req.query.wallet) : undefined;
  const hasWalletScope = Boolean(walletScope && walletScope !== "demo_wallet");
  // Without a valid wallet, history is intentionally hidden.
  const history = hasWalletScope
    ? store
        .listPositions({ marketId: id, wallet: walletScope })
        .slice(0, 50)
        .map((position) => serializePosition(position))
    : [];

  const probabilityHistory = store.getMarketProbabilityHistory(id, 96).map((point) => ({
    ...point,
    timestamp: point.timestamp.toISOString(),
  }));
  const activity = store.getMarketActivity(id, 100).map((event) => ({
    ...event,
    timestamp: event.timestamp.toISOString(),
  }));
  const disputes = store.listMarketDisputes(id).map((dispute) => ({
    ...dispute,
    createdAt: dispute.createdAt.toISOString(),
    updatedAt: dispute.updatedAt.toISOString(),
    challengeWindow: {
      openedAt: dispute.challengeWindow.openedAt.toISOString(),
      deadlineAt: dispute.challengeWindow.deadlineAt.toISOString(),
      closedAt: dispute.challengeWindow.closedAt?.toISOString(),
    },
    slashing: dispute.slashing
      ? {
          ...dispute.slashing,
          appliedAt: dispute.slashing.appliedAt.toISOString(),
        }
      : undefined,
    invalidResolution: dispute.invalidResolution
      ? {
          ...dispute.invalidResolution,
          decidedAt: dispute.invalidResolution.decidedAt.toISOString(),
        }
      : undefined,
    evidence: dispute.evidence.map((evidence) => ({
      ...evidence,
      createdAt: evidence.createdAt.toISOString(),
    })),
    resolution: dispute.resolution
      ? {
          ...dispute.resolution,
          resolvedAt: dispute.resolution.resolvedAt.toISOString(),
        }
      : undefined,
  }));

  res.status(200).json({
    market: serializeMarket(market),
    history,
    historyScope: hasWalletScope ? "wallet" : "wallet_required",
    probabilityHistory,
    activity,
    disputes,
  });
}
