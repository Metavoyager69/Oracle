import type { NextApiRequest, NextApiResponse } from "next";
import { enforceRateLimit, rateLimitKey, requireJson, requireWalletAuth } from "../../../../lib/server/api-guards";
import { normalizeWallet, store } from "../../../../lib/server/store";
import type { EvidenceSourceType } from "../../../../lib/server/services/dispute-engine";

const EVIDENCE_SOURCE_TYPES: EvidenceSourceType[] = [
  "OfficialRecord",
  "MarketDataAPI",
  "NewsArticle",
  "OnChainEvent",
  "Other",
];

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "64kb",
    },
  },
};

function parseMarketId(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return Number.NaN;
  return Number.parseInt(raw, 10);
}

function parseEvidenceSourceType(value: unknown): EvidenceSourceType | undefined {
  if (typeof value !== "string") return undefined;
  return EVIDENCE_SOURCE_TYPES.includes(value as EvidenceSourceType)
    ? (value as EvidenceSourceType)
    : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const marketId = parseMarketId(req.query.id);
  if (Number.isNaN(marketId)) {
    res.status(400).json({ error: "Invalid market id." });
    return;
  }

  if (req.method === "GET") {
    const disputes = store.listMarketDisputes(marketId).map((dispute) => ({
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
      evidence: dispute.evidence.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
      resolution: dispute.resolution
        ? {
            ...dispute.resolution,
            resolvedAt: dispute.resolution.resolvedAt.toISOString(),
          }
        : undefined,
    }));

    res.status(200).json({ disputes });
    return;
  }

  if (req.method === "POST") {
    if (!requireJson(req, res)) return;
    if (
      !(await enforceRateLimit(req, res, {
        key: rateLimitKey(req, "disputes:open"),
        limit: 8,
        windowMs: 60 * 60 * 1000,
      }))
    ) {
      return;
    }

    const walletRaw = typeof req.body?.wallet === "string" ? req.body.wallet.trim() : "";
    let wallet: string | undefined;
    try {
      wallet = normalizeWallet(walletRaw);
    } catch {
      res.status(400).json({ error: "Invalid wallet address." });
      return;
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const evidenceSummary =
      typeof req.body?.evidenceSummary === "string" ? req.body.evidenceSummary.trim() : "";
    const evidenceUri = typeof req.body?.evidenceUri === "string" ? req.body.evidenceUri.trim() : "";
    const evidenceSourceDomain =
      typeof req.body?.evidenceSourceDomain === "string"
        ? req.body.evidenceSourceDomain.trim()
        : "";
    const evidenceSourceType = parseEvidenceSourceType(req.body?.evidenceSourceType);
    const auth = typeof req.body?.auth === "object" ? req.body.auth : undefined;

    if (!reason || reason.length < 12) {
      res.status(400).json({ error: "Reason must be at least 12 characters." });
      return;
    }
    if (evidenceUri && !/^https:\/\//i.test(evidenceUri)) {
      res.status(400).json({ error: "Evidence URI must start with https://." });
      return;
    }
    // Wallet validation prevents anonymous dispute spam.
    if (!walletRaw || !wallet) {
      res.status(401).json({ error: "Valid wallet required to open disputes." });
      return;
    }
    if (
      !(await requireWalletAuth(req, res, {
        wallet,
        action: "disputes:open",
        auth,
      }))
    ) {
      return;
    }

    try {
      const dispute = store.openMarketDispute({
        marketId,
        submittedBy: wallet,
        reason,
        evidenceSummary: evidenceSummary || undefined,
        evidenceUri: evidenceUri || undefined,
        evidenceSourceDomain: evidenceSourceDomain || undefined,
        evidenceSourceType: evidenceSourceType ?? "Other",
      });

      res.status(201).json({
        dispute: {
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
          evidence: dispute.evidence.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
          })),
          resolution: dispute.resolution
            ? {
                ...dispute.resolution,
                resolvedAt: dispute.resolution.resolvedAt.toISOString(),
              }
            : undefined,
        },
      });
      return;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not open dispute.";
      res.status(409).json({ error: message });
      return;
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
}
