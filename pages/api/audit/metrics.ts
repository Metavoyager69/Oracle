import type { NextApiRequest, NextApiResponse } from "next";
import { store } from "../../../lib/server/store";
import { requireAdminAuth } from "../../../lib/server/api-guards";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    return;
  }

  // [ISSUES 21 & 22 FIX] - Enforce admin auth for sensitive metrics
  if (!requireAdminAuth(req, res)) return;

  const auditLog = store.getAuditLog(10);
  const reconcile = store.reconcileIndexerState();
  const markets = store.listMarkets();
  
  // Aggregate high-level metrics
  const stats = {
    totalVolumeSol: markets.reduce((sum, m) => sum + (m.totalParticipants * 0.5), 0), // Estimate for demo
    activeMarkets: markets.filter(m => m.status === "Open").length,
    settledMarkets: markets.filter(m => m.status === "Settled").length,
    disputeCount: reconcile.openDisputes,
    indexerEvents: reconcile.totalEvents,
    lastEventSlot: auditLog[0]?.slot ?? 0,
    systemStatus: reconcile.openDisputes > 5 ? "DEGRADED" : "HEALTHY"
  };

  res.status(200).json({
    stats,
    recentAudit: auditLog
  });
}
