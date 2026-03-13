import type { NextApiRequest, NextApiResponse } from "next";
import { isValidWalletAddress, normalizeWallet, store } from "../../../../lib/server/store";
import type { EvidenceSourceType } from "../../../../lib/server/services/dispute-engine";

const EVIDENCE_SOURCE_TYPES: EvidenceSourceType[] = [
  "OfficialRecord",
  "MarketDataAPI",
  "NewsArticle",
  "OnChainEvent",
  "Other",
];

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

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
    return;
  }

  const disputeId = parseDisputeId(req.query.id);
  const walletRaw = typeof req.body?.wallet === "string" ? req.body.wallet.trim() : "";
  const submittedBy = normalizeWallet(walletRaw);
  const summary = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
  const uri = typeof req.body?.uri === "string" ? req.body.uri.trim() : "";
  const sourceType = parseEvidenceSourceType(req.body?.sourceType);
  const sourceDomain =
    typeof req.body?.sourceDomain === "string" ? req.body.sourceDomain.trim() : "";

  if (!disputeId) {
    res.status(400).json({ error: "Dispute id is required." });
    return;
  }
  if (!summary || summary.length < 8) {
    res.status(400).json({ error: "Evidence summary must be at least 8 characters." });
    return;
  }
  if (uri && !/^https?:\/\//i.test(uri)) {
    res.status(400).json({ error: "Evidence URI must start with http:// or https://." });
    return;
  }
  // Require a valid wallet for evidence submissions.
  if (!walletRaw || !isValidWalletAddress(submittedBy)) {
    res.status(401).json({ error: "Valid wallet required to submit evidence." });
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
