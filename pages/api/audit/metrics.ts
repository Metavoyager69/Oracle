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
  const totalPositions = store.listPositions().length;
  const disputes = store.listDisputes();
  const openDisputes = disputes.filter((dispute) => dispute.status === "Open").length;
  
  // Aggregate high-level metrics
  const stats = {
    totalVolumeSol: 0,
    totalPositions,
    volumeVisibility: "encrypted",
    activeMarkets: markets.filter(m => m.status === "Open").length,
    settledMarkets: markets.filter(m => m.status === "Settled").length,
    disputeCount: openDisputes,
    indexerEvents: reconcile.totalEvents,
    lastEventSlot: reconcile.lastSlot ?? auditLog[0]?.slot ?? 0,
    integrityVerified: reconcile.integrityVerified,
    systemStatus: openDisputes > 5 ? "DEGRADED" : "HEALTHY"
  };

  res.status(200).json({
    stats,
    recentAudit: auditLog
  });
}
