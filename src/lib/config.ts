import "dotenv/config";
import type { Config, PoolWalletConfig } from "./types.js";

function env(key: string, required = true): string {
  const val = process.env[key] ?? "";
  if (required && !val) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val;
}

/** Load a pool wallet from env vars, returns undefined if not configured */
function loadPool(prefix: string): PoolWalletConfig | undefined {
  const partyId = process.env[`${prefix}_PARTY_ID`] || "";
  const privateKey = process.env[`${prefix}_PRIVATE_KEY`] || "";
  const publicKey = process.env[`${prefix}_PUBLIC_KEY`] || "";
  if (!partyId || !privateKey || !publicKey) return undefined;
  return { partyId, privateKey, publicKey };
}

/** Load config from .env — only baseUrl and apiKey are always required */
export function loadConfig(requireKeys = false): Config {
  // Legacy single-pool fields (for CLI scripts)
  const legacyPartyId =
    process.env.POOL_PARTY_ID || process.env.SENDER_PARTY_ID || "";
  const legacyPrivateKey =
    process.env.POOL_PRIVATE_KEY || process.env.SENDER_PRIVATE_KEY || "";
  const legacyPublicKey =
    process.env.POOL_PUBLIC_KEY || process.env.SENDER_PUBLIC_KEY || "";

  if (requireKeys) {
    if (!legacyPartyId) throw new Error("Missing required env var: POOL_PARTY_ID (or SENDER_PARTY_ID)");
    if (!legacyPrivateKey) throw new Error("Missing required env var: POOL_PRIVATE_KEY (or SENDER_PRIVATE_KEY)");
    if (!legacyPublicKey) throw new Error("Missing required env var: POOL_PUBLIC_KEY (or SENDER_PUBLIC_KEY)");
  }

  // Build named pool wallets
  const legacyPool: PoolWalletConfig = {
    partyId: legacyPartyId,
    privateKey: legacyPrivateKey,
    publicKey: legacyPublicKey,
  };

  const poolWallets: Record<string, PoolWalletConfig> = {
    retail: loadPool("POOL_RETAIL") || legacyPool,
    "inst-1": loadPool("POOL_INST1") || legacyPool,
    "inst-2": loadPool("POOL_INST2") || legacyPool,
    "inst-3": loadPool("POOL_INST3") || legacyPool,
  };

  const config: Config = {
    baseUrl: env("ZORO_BASE_URL"),
    apiKey: env("ZORO_API_KEY"),
    senderPartyId: legacyPartyId,
    senderPrivateKey: legacyPrivateKey,
    senderPublicKey: legacyPublicKey,
    instrumentId: env("INSTRUMENT_ID", false) || "CBTC",
    instrumentAdmin:
      env("INSTRUMENT_ADMIN", false) ||
      "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262",
    poolWallets,
  };

  if (!config.apiKey.startsWith("canton_")) {
    throw new Error("ZORO_API_KEY must start with 'canton_' prefix");
  }

  return config;
}

/** Get the pool wallet config by pool_wallet_id (e.g. "retail", "inst-1") */
export function getPoolById(config: Config, poolWalletId: string): PoolWalletConfig {
  const pool = config.poolWallets[poolWalletId];
  if (!pool) {
    console.warn(`[Config] Unknown pool_wallet_id "${poolWalletId}", falling back to retail`);
    return config.poolWallets["retail"];
  }
  return pool;
}

/** Get the pool wallet for a user based on their pool_wallet_id */
export function getPoolForUser(config: Config, user: { pool_wallet_id?: string }): PoolWalletConfig {
  return getPoolById(config, user?.pool_wallet_id || "retail");
}

/** Public Firebase client config (safe to expose to browser) */
export function getFirebaseWebConfig() {
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
  };
}
