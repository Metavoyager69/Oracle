import type { NextApiRequest, NextApiResponse } from "next";
import { MARKET_CATEGORIES, type MarketCategory, type MarketStatus } from "../../../utils/program";
import { serializeMarket } from "../../../utils/api";
import { enforceRateLimit, rateLimitKey, requireJson, requireWalletAuth } from "../../../lib/server/api-guards";
import { isValidWalletAddress, normalizeWallet, store } from "../../../lib/server/store";

const STATUS_SET = new Set<MarketStatus>(["Open", "Resolving", "Settled", "Cancelled", "Invalid"]);
const BODY_LIMIT = "64kb";

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

function parseRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const status = parseStatus(req.query.status);
    const category = parseCategory(req.query.category);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;

    const markets = store
      .listMarkets({ status, category, search })
      .map((market) => serializeMarket(market));
    res.status(200).json({ markets });
    return;
  }

  if (req.method === "POST") {
    if (!requireJson(req, res)) return;
    if (
      !enforceRateLimit(req, res, {
        key: rateLimitKey(req, "markets:create"),
        limit: 6,
        windowMs: 60_000,
      })
    ) {
      return;
    }

    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    const resolutionSource =
      typeof req.body?.resolutionSource === "string" ? req.body.resolutionSource.trim() : "";
    const category = parseCategory(req.body?.category);
    const resolutionTimestamp = new Date(req.body?.resolutionTimestamp ?? "");
    const rules = parseRules(req.body?.rules);
    const creatorWalletRaw =
      typeof req.body?.creatorWallet === "string" ? req.body.creatorWallet.trim() : "";
    const creatorWallet = normalizeWallet(creatorWalletRaw);
    const auth = typeof req.body?.auth === "object" ? req.body.auth : undefined;

    if (!title || title.length > 128) {
      res.status(400).json({ error: "Title is required and must be 128 chars or less." });
      return;
    }
    if (!description || description.length > 512) {
      res
        .status(400)
        .json({ error: "Resolution criteria is required and must be 512 chars or less." });
      return;
    }
    if (!category) {
      res.status(400).json({ error: "Category is required." });
      return;
    }
    if (!resolutionSource || resolutionSource.length > 160) {
      res.status(400).json({ error: "Resolution source is required and must be 160 chars or less." });
      return;
    }
    if (rules.length < 2) {
      res.status(400).json({
        error: "Provide at least 2 explicit settlement rules for a clear market contract.",
      });
      return;
    }
    if (Number.isNaN(resolutionTimestamp.getTime()) || resolutionTimestamp.getTime() <= Date.now()) {
      res.status(400).json({ error: "Resolution timestamp must be a valid future date." });
      return;
    }
    // Require a real wallet to prevent demo or malformed input from creating markets.
    if (!creatorWalletRaw || !isValidWalletAddress(creatorWallet)) {
      res.status(401).json({ error: "Valid wallet required to create a market." });
      return;
    }
    if (
      !requireWalletAuth(req, res, {
        wallet: creatorWallet,
        action: "markets:create",
        auth,
      })
    ) {
      return;
    }

    const market = store.createMarket({
      title,
      description,
      category,
      resolutionTimestamp,
      resolutionSource,
      rules,
      creatorWallet,
    });

    res.status(201).json({ market: serializeMarket(market) });
    return;
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
}
