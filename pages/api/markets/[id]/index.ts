import type { NextApiRequest, NextApiResponse } from "next";
import { serializeStoredMarket, serializeStoredPosition } from "../../../../utils/api";
import { requireWalletAuth } from "../../../../lib/server/api-guards";

// API endpoint: returns one market plus related chart/activity/dispute data.
// Important privacy rule: position history is wallet-scoped only.
// Mainnet note: if wallet-scoped history remains sensitive, this route should
// require the same signed wallet auth used by /api/portfolio before returning it.
function parseId(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return Number.NaN;
  return Number.parseInt(raw, 10);
}

function backendErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Backend unavailable.";
}

async function loadStoreModule() {
  return import("../../../../lib/server/store");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

  let storeModule: Awaited<ReturnType<typeof loadStoreModule>>;
  try {
    storeModule = await loadStoreModule();
  } catch (error) {
    res.status(503).json({ error: backendErrorMessage(error) });
    return;
  }

  const market = storeModule.store.getMarketById(id);
  if (!market) {
    res.status(404).json({ error: "Market not found." });
    return;
  }

  const walletRaw = Array.isArray(req.query.wallet) ? req.query.wallet[0] : req.query.wallet;
  let walletScope: string | undefined;
  if (walletRaw) {
    try {
      walletScope = storeModule.normalizeWallet(walletRaw);
    } catch {
      res.status(400).json({ error: "Invalid wallet filter." });
      return;
    }
  }
  // Reject malformed wallet scopes to prevent accidental data leaks.
  const hasWalletScope = Boolean(walletScope);
  let historyScope: "wallet" | "wallet_required" | "wallet_auth_required" = "wallet_required";

  if (hasWalletScope) {
    let auth;
    try {
      auth = req.query.auth ? JSON.parse(req.query.auth as string) : undefined;
    } catch {
      res.status(400).json({ error: "Invalid auth payload in query." });
      return;
    }

    if (!(await requireWalletAuth(req, res, { wallet: walletScope as string, action: "markets:history:view", auth }))) {
      return;
    }
    historyScope = "wallet";
  }

  // Without a valid wallet, history is intentionally hidden.
  const history = hasWalletScope
    ? storeModule.store
        .listPositions({ marketId: id, wallet: walletScope })
        .slice(0, 50)
        .map((position) => serializeStoredPosition(position))
    : [];

  const probabilityHistory = storeModule.store.getMarketProbabilityHistory(id, 96).map((point) => ({
    ...point,
    timestamp: point.timestamp.toISOString(),
  }));
  const activity = storeModule.store.getMarketActivity(id, 100).map((event) => ({
    ...event,
    timestamp: event.timestamp.toISOString(),
  }));
  const disputes = storeModule.store.listMarketDisputes(id).map((dispute) => ({
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
    market: serializeStoredMarket(market),
    history,
    historyScope,
    probabilityHistory,
    activity,
    disputes,
  });
}
