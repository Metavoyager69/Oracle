import type { NextApiRequest, NextApiResponse } from "next";
import { enforceRateLimit, rateLimitKey, requireJson, requireWalletAuth } from "../../../../lib/server/api-guards";
import { normalizeWallet, store } from "../../../../lib/server/store";
import type { EvidenceSourceType } from "../../../../lib/server/services/dispute-engine";

const ALLOWED_EVIDENCE_DOMAINS = ["apnews.com", "reuters.com", "bloomberg.com", "bbc.co.uk", "wsj.com", "nytimes.com", "solscan.io", "explorer.solana.com"];
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

function parseDisputeId(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? "";
}

function parseEvidenceSourceType(value: unknown): EvidenceSourceType | undefined {
  if (typeof value !== "string") return undefined;
  return EVIDENCE_SOURCE_TYPES.includes(value as EvidenceSourceType)
    ? (value as EvidenceSourceType)
    : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
    return;
  }

  if (!requireJson(req, res)) return;
  if (
    !(await enforceRateLimit(req, res, {
      key: rateLimitKey(req, "disputes:evidence"),
      limit: 20,
      windowMs: 60 * 60 * 1000,
    }))
  ) {
    return;
  }

  const disputeId = parseDisputeId(req.query.id);
  const walletRaw = typeof req.body?.wallet === "string" ? req.body.wallet.trim() : "";
  let submittedBy: string | undefined;
  try {
    submittedBy = normalizeWallet(walletRaw);
  } catch {
    res.status(400).json({ error: "Invalid wallet address." });
    return;
  }
  const summary = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
  const uri = typeof req.body?.uri === "string" ? req.body.uri.trim() : "";
  const sourceType = parseEvidenceSourceType(req.body?.sourceType);
  const sourceDomain =
    typeof req.body?.sourceDomain === "string" ? req.body.sourceDomain.trim() : "";
  const auth = typeof req.body?.auth === "object" ? req.body.auth : undefined;

  if (!disputeId) {
    res.status(400).json({ error: "Dispute id is required." });
    return;
  }
  if (!summary || summary.length < 8) {
    res.status(400).json({ error: "Evidence summary must be at least 8 characters." });
    return;
  }
    if (uri) { try { const url = new URL(uri); if (!ALLOWED_EVIDENCE_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) { res.status(400).json({ error: "Evidence URI domain not in allow-list." }); return; } } catch { res.status(400).json({ error: "Invalid Evidence URI format." }); return; } }
  if (uri && !/^https:\/\//i.test(uri)) {
    res.status(400).json({ error: "Evidence URI must start with https://." });
    return;
  }
  // Require a valid wallet for evidence submissions.
  if (!walletRaw || !submittedBy) {
    res.status(401).json({ error: "Valid wallet required to submit evidence." });
    return;
  }
  if (
    !(await requireWalletAuth(req, res, {
      wallet: submittedBy,
      action: "disputes:evidence",
      auth,
    }))
  ) {
    return;
  }

  try {
    const dispute = store.addDisputeEvidence({
      disputeId,
      submittedBy,
      summary,
      uri: uri || undefined,
      sourceType,
      sourceDomain: sourceDomain || undefined,
    });

    res.status(200).json({
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
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Could not add evidence.";
    res.status(409).json({ error: message });
  }
}
