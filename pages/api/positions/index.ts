import type { NextApiRequest, NextApiResponse } from "next";
import { serializePosition } from "../../../utils/api";
import { normalizeWallet, store } from "../../../lib/server/store";

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

function parseStake(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseFloat(value);
  return Number.NaN;
}

function parseSide(value: unknown): "YES" | "NO" | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  if (normalized === "YES" || normalized === "NO") return normalized;
  return null;
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

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    // Read-only list of positions. Wallet filter is optional.
    const marketId = parseId(req.query.marketId);
    const wallet = req.query.wallet ? normalizeWallet(req.query.wallet) : undefined;
    const positions = store
      .listPositions({ marketId, wallet })
      .slice(0, 100)
      .map((position) => serializePosition(position));
    res.status(200).json({ positions });
    return;
  }

  if (req.method === "POST") {
    // Create a new encrypted position for a market.
    const marketId =
      typeof req.body?.marketId === "number"
        ? req.body.marketId
        : Number.parseInt(String(req.body?.marketId), 10);
    const stakeSol = parseStake(req.body?.stakeSol);
    const side = parseSide(req.body?.side);
    const wallet = normalizeWallet(req.body?.wallet);
    const encryptedStake = parseCipher(req.body?.encryptedStake);
    const encryptedChoice = parseCipher(req.body?.encryptedChoice);

    if (!Number.isFinite(marketId)) {
      res.status(400).json({ error: "A valid market id is required." });
      return;
    }
    if (!side) {
      res.status(400).json({ error: "Side must be YES or NO." });
      return;
    }
    if (!Number.isFinite(stakeSol) || stakeSol <= 0 || stakeSol > 1_000_000) {
      res.status(400).json({ error: "Stake must be a positive number and below limit." });
      return;
    }

    try {
      const result = store.submitPosition({
        marketId,
        wallet,
        side,
        stakeSol,
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
