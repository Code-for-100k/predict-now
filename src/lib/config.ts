import "dotenv/config";
import type { Config, PoolWalletConfig } from "./types.js";
import type { UserTier } from "../types/market.js";

function env(key: string, required = true): string {
  const val = process.env[key] ?? "";
  if (required && !val) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val;
}

/** Load config from .env — only baseUrl and apiKey are always required */
export function loadConfig(requireKeys = false): Config {
  // Support both old SENDER_* names and new POOL_* names for backward compat
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

  // Build tier-based pool wallets
  // If RETAIL_POOL_* and INSTITUTIONAL_POOL_* env vars exist, use them
  // Otherwise, fall back to the single legacy pool wallet for both tiers
  const retailPool: PoolWalletConfig = {
    partyId: process.env.RETAIL_POOL_PARTY_ID || legacyPartyId,
    privateKey: process.env.RETAIL_POOL_PRIVATE_KEY || legacyPrivateKey,
    publicKey: process.env.RETAIL_POOL_PUBLIC_KEY || legacyPublicKey,
  };
  const institutionalPool: PoolWalletConfig = {
    partyId: process.env.INSTITUTIONAL_POOL_PARTY_ID || legacyPartyId,
    privateKey: process.env.INSTITUTIONAL_POOL_PRIVATE_KEY || legacyPrivateKey,
    publicKey: process.env.INSTITUTIONAL_POOL_PUBLIC_KEY || legacyPublicKey,
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
    poolWallets: {
      retail: retailPool,
      institutional: institutionalPool,
    },
  };

  if (!config.apiKey.startsWith("canton_")) {
    throw new Error("ZORO_API_KEY must start with 'canton_' prefix");
  }

  return config;
}

/** Get the pool wallet config for a specific tier */
export function getPoolForTier(config: Config, tier: UserTier): PoolWalletConfig {
  return config.poolWallets[tier];
}

/** Public Firebase client config (safe to expose to browser) */
export function getFirebaseWebConfig() {
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
  };
}
