import type { NextApiRequest, NextApiResponse } from "next";
import { serializePosition } from "../../../utils/api";
import { enforceRateLimit, rateLimitKey, requireJson, requireWalletAuth } from "../../../lib/server/api-guards";
import { isValidWalletAddress, normalizeWallet, store } from "../../../lib/server/store";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "64kb",
    },
  },
};

interface CipherPayload {
  c1: number[];
  c2: number[];
}

function parseId(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseCipher(value: unknown): CipherPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as { c1?: unknown; c2?: unknown };
  if (!Array.isArray(maybe.c1) || !Array.isArray(maybe.c2)) return undefined;
  return { 
    c1: maybe.c1.filter((item): item is number => typeof item === "number").slice(0, 32),
    c2: maybe.c2.filter((item): item is number => typeof item === "number").slice(0, 32)
  };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const marketId = parseId(req.query.marketId);
    const walletRaw = Array.isArray(req.query.wallet) ? req.query.wallet[0] : req.query.wallet;
    const wallet = walletRaw ? normalizeWallet(walletRaw) : undefined;
    
    // [ISSUE 12 FIX] - Enforce auth on GET history
    if (wallet && wallet !== "demo_wallet") {
      let auth;
      try {
        auth = req.query.auth ? JSON.parse(req.query.auth as string) : undefined;
      } catch {
        res.status(400).json({ error: "Invalid auth payload in query." });
        return;
      }
      
      if (!requireWalletAuth(req, res, { wallet, action: "positions:list", auth })) return;
    }

    const positions = store.listPositions({ marketId, wallet }).map(p => serializePosition(p));
    res.status(200).json({ positions });
    return;
  }

  if (req.method === "POST") {
    if (!requireJson(req, res)) return;
    if (!enforceRateLimit(req, res, { key: rateLimitKey(req, "positions:submit"), limit: 30, windowMs: 60_000 })) return;

    const marketId = Number.parseInt(String(req.body?.marketId), 10);
    const wallet = normalizeWallet(req.body?.wallet);
    const commitment = req.body?.commitment;
    const sealedAt = new Date(req.body?.sealedAt);
    const choice = typeof req.body?.choice === "boolean" ? req.body.choice : undefined;
    const auth = req.body?.auth;

    if (!Number.isFinite(marketId) || !commitment || choice === undefined || isNaN(sealedAt.getTime())) {
      res.status(400).json({ error: "Invalid submission payload. Choice, commitment, and valid timestamps are required." });
      return;
    }

    if (!requireWalletAuth(req, res, { wallet, action: "positions:submit", auth })) return;

    try {
      const result = store.submitPosition({
        marketId,
        wallet,
        commitment,
        sealedAt,
        choice,
        encryptedStake: parseCipher(req.body?.encryptedStake),
        encryptedChoice: parseCipher(req.body?.encryptedChoice),
      });

      res.status(201).json({
        position: serializePosition(result.position),
        txSig: result.txSig,
      });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Submission failed" });
    }
    return;
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
}
