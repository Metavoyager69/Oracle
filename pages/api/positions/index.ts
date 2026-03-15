import type { NextApiRequest, NextApiResponse } from "next";
import { serializePosition } from "../../../utils/api";
import { enforceRateLimit, rateLimitKey, requireJson, requireWalletAuth } from "../../../lib/server/api-guards";
import { isValidWalletAddress, normalizeWallet, store } from "../../../lib/server/store";

const BODY_LIMIT = "64kb";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "64kb",
    },
  },
};

// Positions API:
// - GET returns positions (optionally filtered by market or wallet)
// - POST submits a new private position (encrypted stake + choice)
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
  const c1 = maybe.c1.filter((item): item is number => typeof item === "number").slice(0, 32);
  const c2 = maybe.c2.filter((item): item is number => typeof item === "number").slice(0, 32);
  if (c1.length !== 32 || c2.length !== 32) return undefined;
  return { c1, c2 };
}

function parseCommitment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null;
  return trimmed;
}

function parseSealedAt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseVersion(value: unknown): "v1" | null {
  if (value === "v1") return "v1";
  return null;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    // Read-only list of positions. Wallet filter is optional.
    const marketId = parseId(req.query.marketId);
    const walletRaw = Array.isArray(req.query.wallet) ? req.query.wallet[0] : req.query.wallet;
    if (walletRaw && !isValidWalletAddress(walletRaw.trim())) {
      res.status(400).json({ error: "Invalid wallet filter." });
      return;
    }
    const wallet = walletRaw ? normalizeWallet(walletRaw) : undefined;
    const positions = store
      .listPositions({ marketId, wallet })
      .slice(0, 100)
      .map((position) => serializePosition(position));
    res.status(200).json({ positions });
    return;
  }

  if (req.method === "POST") {
    if (!requireJson(req, res)) return;
    if (
      !enforceRateLimit(req, res, {
        key: rateLimitKey(req, "positions:submit"),
        limit: 30,
        windowMs: 60_000,
      })
    ) {
      return;
    }

    // Create a new encrypted position for a market.
    const marketId =
      typeof req.body?.marketId === "number"
        ? req.body.marketId
        : Number.parseInt(String(req.body?.marketId), 10);
    const walletRaw = typeof req.body?.wallet === "string" ? req.body.wallet.trim() : "";
    const wallet = normalizeWallet(walletRaw);
    const encryptedStake = parseCipher(req.body?.encryptedStake);
    const encryptedChoice = parseCipher(req.body?.encryptedChoice);
    const commitment = parseCommitment(req.body?.commitment);
    const sealedAt = parseSealedAt(req.body?.sealedAt);
    const version = parseVersion(req.body?.version);
    const auth = typeof req.body?.auth === "object" ? req.body.auth : undefined;

    if (!Number.isFinite(marketId)) {
      res.status(400).json({ error: "A valid market id is required." });
      return;
    }
    if (!commitment) {
      res.status(400).json({ error: "Commitment hash is required." });
      return;
    }
    if (!encryptedStake || !encryptedChoice) {
      res.status(400).json({ error: "Encrypted stake and choice are required." });
      return;
    }
    if (!sealedAt) {
      res.status(400).json({ error: "Sealed timestamp is required." });
      return;
    }
    if (!version) {
      res.status(400).json({ error: "Unsupported payload version." });
      return;
    }
    // Require a valid wallet to avoid spoofed submissions.
    if (!walletRaw || !isValidWalletAddress(wallet)) {
      res.status(401).json({ error: "Valid wallet required to submit positions." });
      return;
    }
    if (
      !requireWalletAuth(req, res, {
        wallet,
        action: "positions:submit",
        auth,
      })
    ) {
      return;
    }

    try {
      const result = store.submitPosition({
        marketId,
        wallet,
        commitment,
        sealedAt,
        encryptedStake,
        encryptedChoice,
      });

      res.status(201).json({
        position: serializePosition(result.position),
        txSig: result.txSig,
      });
      return;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unable to submit position.";
      res.status(409).json({ error: message });
      return;
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
}
