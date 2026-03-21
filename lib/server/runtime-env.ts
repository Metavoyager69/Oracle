const PROD_NODE_ENVS = new Set(["production", "prod"]);

let validated = false;

export function isProdLike(): boolean {
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  const vercelEnv = process.env.VERCEL_ENV?.toLowerCase();
  return Boolean(
    (nodeEnv && PROD_NODE_ENVS.has(nodeEnv)) || vercelEnv === "production"
  );
}

function requireEnv(name: string, message?: string): string {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  throw new Error(message ?? `[oracle-env] ${name} must be set in production.`);
}

export function assertRuntimeConfig(): void {
  if (validated) return;
  validated = true;
  if (!isProdLike()) return;

  const backendRaw = requireEnv(
    "ORACLE_STORE_BACKEND",
    "[oracle-env] ORACLE_STORE_BACKEND must be set to 'sqlite' or 'file' in production."
  );
  const backend = backendRaw.toLowerCase();
  if (backend !== "sqlite" && backend !== "file") {
    throw new Error("[oracle-env] ORACLE_STORE_BACKEND must be 'sqlite' or 'file'.");
  }

  if (backend === "sqlite") {
    requireEnv(
      "ORACLE_DB_PATH",
      "[oracle-env] ORACLE_DB_PATH must be set for sqlite persistence in production."
    );
  } else {
    requireEnv(
      "ORACLE_STORE_PATH",
      "[oracle-env] ORACLE_STORE_PATH must be set for file persistence in production."
    );
  }

  const adminWallet = process.env.ORACLE_ADMIN_WALLET?.trim();
  const adminKeypairPath = process.env.ORACLE_ADMIN_KEYPAIR_PATH?.trim();
  if (!adminWallet && !adminKeypairPath) {
    throw new Error(
      "[oracle-env] ORACLE_ADMIN_WALLET or ORACLE_ADMIN_KEYPAIR_PATH must be set in production."
    );
  }

  requireEnv(
    "UPSTASH_REDIS_REST_URL",
    "[oracle-env] UPSTASH_REDIS_REST_URL must be set in production for rate limiting."
  );
  requireEnv(
    "UPSTASH_REDIS_REST_TOKEN",
    "[oracle-env] UPSTASH_REDIS_REST_TOKEN must be set in production for rate limiting."
  );
}

