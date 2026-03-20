import type { NextApiRequest, NextApiResponse } from "next";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { WALLET_AUTH_TTL_MS, buildWalletAuthMessage, isWalletAuthFresh } from "../../utils/wallet-auth";
import { store } from "./store";
import { getRedisClient } from "./redis";

// [OBSERVABILITY UPGRADE] - Structured Logging helper
function log(level: string, message: string, data: any = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  }));
}

type RateLimitOptions = {
  key: string;
  limit: number;
  windowMs: number;
};

type RateLimitState = {
  count: number;
  resetAt: number;
};

type WalletAuthPayload = {
  message?: string;
  signature?: string;
  timestamp?: string;
  nonce?: string;
};

const buckets = new Map<string, RateLimitState>();
const MAX_BUCKETS = 10_000;
const nonceCache = new Map<string, number>();
const MAX_NONCE_CACHE = 25_000;

// [ISSUE 18 FIX] - Hardened IP detection. Only trust X-Forwarded-For in production (Vercel).
export function getClientIp(req: NextApiRequest): string {
  if (process.env.NODE_ENV === "production") {
    const headerValue = req.headers["x-forwarded-for"];
    const forwarded = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (forwarded) {
      return forwarded.split(",")[0]?.trim() || "unknown";
    }
  }
  return req.socket?.remoteAddress ?? "127.0.0.1";
}

export function rateLimitKey(req: NextApiRequest, scope: string): string {
  return `${scope}:${getClientIp(req)}`;
}

function enforceRateLimitMemory(
  req: NextApiRequest,
  res: NextApiResponse,
  options: RateLimitOptions
): boolean {
  const now = Date.now();
  const entry = buckets.get(options.key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(options.key, {
      count: 1,
      resetAt: now + options.windowMs,
    });
  } else {
    entry.count += 1;
  }

  const active = buckets.get(options.key);
  if (!active) return true;

  const remaining = Math.max(0, options.limit - active.count);
  res.setHeader("X-RateLimit-Limit", options.limit.toString());
  res.setHeader("X-RateLimit-Remaining", remaining.toString());
  res.setHeader("X-RateLimit-Reset", Math.ceil(active.resetAt / 1000).toString());

  if (active.count > options.limit) {
    log("WARN", "Rate limit exceeded", { key: options.key, limit: options.limit });
    const retryAfter = Math.max(1, Math.ceil((active.resetAt - now) / 1000));
    res.setHeader("Retry-After", retryAfter.toString());
    res.status(429).json({ error: "Rate limit exceeded. Please retry shortly." });
    return false;
  }

  if (buckets.size > MAX_BUCKETS) {
    for (const [key, value] of buckets.entries()) {
      if (value.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

  return true;
}

export async function enforceRateLimit(
  req: NextApiRequest,
  res: NextApiResponse,
  options: RateLimitOptions
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production") {
      log("CRITICAL", "Redis not configured for rate limiting", { key: options.key });
      res.status(503).json({ error: "Rate limiter unavailable. Configure Upstash Redis." });
      return false;
    }
    return enforceRateLimitMemory(req, res, options);
  }

  const now = Date.now();
  const redisKey = `oracle:ratelimit:${options.key}`;

  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, Math.ceil(options.windowMs / 1000));
    }

    let ttlSeconds = await redis.ttl(redisKey);
    if (!ttlSeconds || ttlSeconds < 0) {
      ttlSeconds = Math.ceil(options.windowMs / 1000);
    }
    const resetAt = now + ttlSeconds * 1000;
    const remaining = Math.max(0, options.limit - count);

    res.setHeader("X-RateLimit-Limit", options.limit.toString());
    res.setHeader("X-RateLimit-Remaining", remaining.toString());
    res.setHeader("X-RateLimit-Reset", Math.ceil(resetAt / 1000).toString());

    if (count > options.limit) {
      log("WARN", "Rate limit exceeded", { key: options.key, limit: options.limit });
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      res.setHeader("Retry-After", retryAfter.toString());
      res.status(429).json({ error: "Rate limit exceeded. Please retry shortly." });
      return false;
    }

    return true;
  } catch (error) {
    log("ERROR", "Redis rate limit failed, falling back to memory", { error: String(error) });
    return enforceRateLimitMemory(req, res, options);
  }
}

// [ISSUES 21 & 22 FIX] - Protect internal API endpoints
export async function requireAdminAuth(req: NextApiRequest, res: NextApiResponse): Promise<boolean> {
  const adminWallet = store.getRegistryAuthority();
  const walletInput = req.headers["x-admin-wallet"] as string;
  const authHeader = req.headers["x-admin-auth"] as string;

  if (!walletInput || !authHeader || walletInput !== adminWallet) {
    res.status(403).json({ error: "Admin access required." });
    return false;
  }

  try {
    const auth = JSON.parse(authHeader);
    return await requireWalletAuth(req, res, { 
      wallet: walletInput, 
      action: "admin:access", 
      auth 
    });
  } catch {
    res.status(400).json({ error: "Invalid admin auth header." });
    return false;
  }
}

export function requireJson(req: NextApiRequest, res: NextApiResponse): boolean {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    res.status(415).json({ error: "Expected application/json request body." });
    return false;
  }
  return true;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    return null;
  }
}

type NonceResult = "ok" | "replay" | "unavailable";

async function consumeNonce(wallet: string, nonce: string): Promise<NonceResult> {
  const redis = getRedisClient();
  const key = `oracle:auth:nonce:${wallet}:${nonce}`;

  if (redis) {
    try {
      const result = await redis.set(key, "1", { nx: true, px: WALLET_AUTH_TTL_MS });
      return result === "OK" ? "ok" : "replay";
    } catch (error) {
      log("ERROR", "Redis nonce store failed, falling back to memory", { error: String(error) });
    }
  }

  if (process.env.NODE_ENV === "production") {
    log("CRITICAL", "Redis not configured for nonce storage", { wallet });
    return "unavailable";
  }

  const now = Date.now();
  const existing = nonceCache.get(key);
  if (existing && existing > now) {
    return "replay";
  }
  nonceCache.set(key, now + WALLET_AUTH_TTL_MS);

  if (nonceCache.size > MAX_NONCE_CACHE) {
    for (const [nonceKey, expiresAt] of nonceCache.entries()) {
      if (expiresAt <= now) {
        nonceCache.delete(nonceKey);
      }
    }
  }

  return "ok";
}

export async function requireWalletAuth(
  req: NextApiRequest,
  res: NextApiResponse,
  options: { wallet: string; action: string; auth: WalletAuthPayload | undefined }
): Promise<boolean> {
  const auth = options.auth;
  if (!auth?.message || !auth?.signature || !auth?.timestamp || !auth?.nonce) {
    log("ERROR", "Wallet auth missing fields", { wallet: options.wallet, action: options.action });
    res.status(401).json({ error: "Wallet signature required." });
    return false;
  }

  if (!isWalletAuthFresh(auth.timestamp)) {
    log("WARN", "Wallet auth expired", { wallet: options.wallet, action: options.action, timestamp: auth.timestamp });
    res.status(401).json({ error: "Wallet signature expired. Please retry." });
    return false;
  }

  const expectedMessage = buildWalletAuthMessage(options.action, options.wallet, auth.timestamp, auth.nonce);
  if (auth.message !== expectedMessage) {
    log("ERROR", "Wallet auth message mismatch", { wallet: options.wallet, action: options.action });
    res.status(401).json({ error: "Wallet signature message mismatch." });
    return false;
  }

  const signatureBytes = decodeBase64(auth.signature);
  if (!signatureBytes) {
    res.status(401).json({ error: "Invalid wallet signature encoding." });
    return false;
  }

  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = new PublicKey(options.wallet).toBytes();
  } catch {
    res.status(401).json({ error: "Invalid wallet address." });
    return false;
  }

  const messageBytes = new TextEncoder().encode(auth.message);
  const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  if (!isValid) {
    log("CRITICAL", "Wallet signature verification failed", { wallet: options.wallet, action: options.action });
    res.status(401).json({ error: "Wallet signature verification failed." });
    return false;
  }

  const nonceResult = await consumeNonce(options.wallet, auth.nonce);
  if (nonceResult === "unavailable") {
    res.status(503).json({ error: "Wallet auth unavailable. Configure nonce storage." });
    return false;
  }
  if (nonceResult === "replay") {
    log("WARN", "Wallet auth replay detected", { wallet: options.wallet, action: options.action });
    res.status(401).json({ error: "Wallet signature replay detected. Please retry." });
    return false;
  }

  log("INFO", "Wallet auth success", { wallet: options.wallet, action: options.action });
  return true;
}
