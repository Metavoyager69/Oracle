import type { NextApiRequest, NextApiResponse } from "next";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { buildWalletAuthMessage, isWalletAuthFresh } from "../../utils/wallet-auth";
import { store } from "./store";

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
};

const buckets = new Map<string, RateLimitState>();
const MAX_BUCKETS = 10_000;

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

export function enforceRateLimit(
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

// [ISSUES 21 & 22 FIX] - Protect internal API endpoints
export function requireAdminAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  const adminWallet = store.getRegistryAuthority();
  const walletInput = req.headers["x-admin-wallet"] as string;
  const authHeader = req.headers["x-admin-auth"] as string;

  if (!walletInput || !authHeader || walletInput !== adminWallet) {
    res.status(403).json({ error: "Admin access required." });
    return false;
  }

  try {
    const auth = JSON.parse(authHeader);
    return requireWalletAuth(req, res, { 
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

export function requireWalletAuth(
  req: NextApiRequest,
  res: NextApiResponse,
  options: { wallet: string; action: string; auth: WalletAuthPayload | undefined }
): boolean {
  const auth = options.auth;
  if (!auth?.message || !auth?.signature || !auth?.timestamp) {
    log("ERROR", "Wallet auth missing fields", { wallet: options.wallet, action: options.action });
    res.status(401).json({ error: "Wallet signature required." });
    return false;
  }

  if (!isWalletAuthFresh(auth.timestamp)) {
    log("WARN", "Wallet auth expired", { wallet: options.wallet, action: options.action, timestamp: auth.timestamp });
    res.status(401).json({ error: "Wallet signature expired. Please retry." });
    return false;
  }

  const expectedMessage = buildWalletAuthMessage(options.action, options.wallet, auth.timestamp);
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

  log("INFO", "Wallet auth success", { wallet: options.wallet, action: options.action });
  return true;
}
