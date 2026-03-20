export const WALLET_AUTH_TTL_MS = 2 * 60 * 1000;

export function buildWalletAuthMessage(
  action: string,
  wallet: string,
  timestamp: string,
  nonce: string
): string {
  return `Oracle auth\nAction: ${action}\nWallet: ${wallet}\nTimestamp: ${timestamp}\nNonce: ${nonce}`;
}

export function parseWalletAuthTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function isWalletAuthFresh(timestamp: string, now = Date.now()): boolean {
  const parsed = parseWalletAuthTimestamp(timestamp);
  if (!parsed) return false;
  return Math.abs(now - parsed) <= WALLET_AUTH_TTL_MS;
}
