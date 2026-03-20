import type { NextApiRequest, NextApiResponse } from "next";
import { buildRevealMessage } from "../../../utils/arcium";
import { enforceRateLimit, rateLimitKey, requireJson } from "../../../lib/server/api-guards";
import { store } from "../../../lib/server/store";

function parseU64(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return null;
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = BigInt(value);
      return parsed < 0n ? null : parsed;
    } catch {
      return null;
    }
  }
  return null;
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "64kb",
    },
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
    return;
  }

  if (!requireJson(req, res)) return;
  if (!(await enforceRateLimit(req, res, { key: rateLimitKey(req, "arcium:relay"), limit: 30, windowMs: 60_000 }))) {
    return;
  }

  const marketIdRaw = req.body?.marketId;
  const yesTotalRaw = req.body?.yesTotal;
  const noTotalRaw = req.body?.noTotal;
  const relaySignature = typeof req.body?.relaySignature === "string" ? req.body.relaySignature.trim() : "";
  const relayActor = typeof req.body?.relayActor === "string" ? req.body.relayActor.trim() : undefined;

  const marketId = typeof marketIdRaw === "number" ? Math.floor(marketIdRaw) : Number.parseInt(String(marketIdRaw), 10);
  const yesTotal = parseU64(yesTotalRaw);
  const noTotal = parseU64(noTotalRaw);

  if (!Number.isFinite(marketId) || marketId < 0) {
    res.status(400).json({ error: "Invalid marketId." });
    return;
  }
  if (!yesTotal || !noTotal) {
    res.status(400).json({ error: "Invalid yesTotal/noTotal." });
    return;
  }
  if (!relaySignature || relaySignature.length < 32) {
    res.status(400).json({ error: "relaySignature required." });
    return;
  }

  const yesTotalNum = Number(yesTotal);
  const noTotalNum = Number(noTotal);
  if (!Number.isSafeInteger(yesTotalNum) || !Number.isSafeInteger(noTotalNum)) {
    res.status(400).json({ error: "Totals exceed safe integer range." });
    return;
  }

  try {
    const message = await buildRevealMessage(marketId, yesTotal, noTotal);
    const market = store.recordRelayReveal({
      marketId,
      yesTotal: yesTotalNum,
      noTotal: noTotalNum,
      relaySignature,
      relayActor,
    });

    res.status(200).json({
      ok: true,
      marketId: market.id,
      message: Buffer.from(message).toString("hex"),
    });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Relay failed." });
  }
}
