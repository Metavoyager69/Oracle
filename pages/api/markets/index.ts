import type { NextApiRequest, NextApiResponse } from "next";
import { MARKET_CATEGORIES, type MarketCategory, type MarketStatus } from "../../../utils/program";
import { serializeStoredMarket } from "../../../utils/api";
import { enforceRateLimit, rateLimitKey, requireJson, requireWalletAuth } from "../../../lib/server/api-guards";
import { normalizeWallet, store } from "../../../lib/server/store";

// Markets API is the backend boundary for discovery and creation. Right now it
// writes to the local application store; on mainnet, the store should mirror
// confirmed program state rather than being the only source of truth.
const STATUS_SET = new Set<MarketStatus>(["Open", "SettledPending", "Challenged", "Settled", "Invalid", "Cancelled"]);

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "64kb",
    },
  },
};

function parseCategory(raw: string | string[] | undefined): MarketCategory | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return MARKET_CATEGORIES.includes(value as MarketCategory) ? (value as MarketCategory) : undefined;
}

function parseStatus(raw: string | string[] | undefined): MarketStatus | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return STATUS_SET.has(value as MarketStatus) ? (value as MarketStatus) : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const status = parseStatus(req.query.status);
    const category = parseCategory(req.query.category);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;

    const markets = store
      .listMarkets({ status, category, search })
      .map((market) => serializeStoredMarket(market));
    res.status(200).json({ markets });
    return;
  }

  if (req.method === "POST") {
    if (!requireJson(req, res)) return;
    if (!(await enforceRateLimit(req, res, { key: rateLimitKey(req, "markets:create"), limit: 6, windowMs: 60_000 }))) return;

    const { title, description, resolutionSource, category, rules, creatorWallet: creatorWalletRaw, auth } = req.body;
    let creatorWallet: string | undefined;
    try {
      creatorWallet = normalizeWallet(creatorWalletRaw);
    } catch {
      res.status(400).json({ error: "Invalid wallet address." });
      return;
    }
    const resolutionTimestamp = new Date(req.body?.resolutionTimestamp ?? "");

    if (!title || !description || !category || !resolutionSource || !rules || rules.length < 2 || isNaN(resolutionTimestamp.getTime())) {
      res.status(400).json({ error: "Missing required market fields or invalid rules/date." });
      return;
    }

    if (!creatorWallet) {
      res.status(401).json({ error: "Valid wallet required." });
      return;
    }

    if (!(await requireWalletAuth(req, res, { wallet: creatorWallet, action: "markets:create", auth }))) return;

    try {
      // Mainnet note: this is where a confirmed on-chain market creation should
      // be recorded or verified before persisting any market metadata locally.
      const market = store.createMarket({
        title,
        description,
        category,
        resolutionTimestamp,
        resolutionSource,
        rules,
        creatorWallet,
      });
      res.status(201).json({ market: serializeStoredMarket(market) });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "Creation failed" });
    }
    return;
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).json({ error: `Method ${req.method} Not Allowed` });
}
