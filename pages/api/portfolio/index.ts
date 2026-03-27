import type { NextApiRequest, NextApiResponse } from "next";
import { serializeStoredPosition } from "../../../utils/api";
import { normalizeWallet, store } from "../../../lib/server/store";
import { requireWalletAuth } from "../../../lib/server/api-guards";

// Portfolio API is the safe pattern to copy for private reads on mainnet: it
// requires a wallet, verifies a signed auth payload, then returns only that
// wallet's redacted position history and summary metrics.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ error: `Method ${req.method ?? "UNKNOWN"} Not Allowed` });
    return;
  }

  const walletInput = Array.isArray(req.query.wallet) ? req.query.wallet[0] : req.query.wallet;
  if (!walletInput) {
    res.status(401).json({ error: "Connect wallet to access portfolio." });
    return;
  }

  let wallet: string | undefined;
  try {
    wallet = normalizeWallet(walletInput);
  } catch {
    res.status(400).json({ error: "Invalid wallet address." });
    return;
  }
  if (!wallet) {
    res.status(401).json({ error: "Valid wallet required to access portfolio." });
    return;
  }

  // [ISSUE 13 FIX] - Enforce auth on GET portfolio
  let auth;
  try {
    auth = req.query.auth ? JSON.parse(req.query.auth as string) : undefined;
  } catch {
    res.status(400).json({ error: "Invalid auth payload in query." });
    return;
  }

  if (!(await requireWalletAuth(req, res, { wallet, action: "portfolio:view", auth }))) return;

  const portfolio = store.getPortfolio(wallet);

  res.status(200).json({
    wallet,
    summary: portfolio.summary,
    positions: portfolio.positions.map((position) => serializeStoredPosition(position)),
  });
}
