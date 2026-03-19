import type { NextApiRequest, NextApiResponse } from "next";
import { store } from "../../../lib/server/store";
import { requireAdminAuth } from "../../../lib/server/api-guards";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
    return;
  }

  // [ISSUES 21 & 22 FIX] - Enforce admin auth for sensitive metrics
  if (!requireAdminAuth(req, res)) return;

  const report = store.reconcileIndexerState();
  res.status(200).json({
    report: {
      ...report,
      generatedAt: report.generatedAt.toISOString(),
    },
  });
}
