import "dotenv/config";
import type { Config } from "./types.js";

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
  const senderPartyId =
    process.env.POOL_PARTY_ID || process.env.SENDER_PARTY_ID || "";
  const senderPrivateKey =
    process.env.POOL_PRIVATE_KEY || process.env.SENDER_PRIVATE_KEY || "";
  const senderPublicKey =
    process.env.POOL_PUBLIC_KEY || process.env.SENDER_PUBLIC_KEY || "";

  if (requireKeys) {
    if (!senderPartyId) throw new Error("Missing required env var: POOL_PARTY_ID (or SENDER_PARTY_ID)");
    if (!senderPrivateKey) throw new Error("Missing required env var: POOL_PRIVATE_KEY (or SENDER_PRIVATE_KEY)");
    if (!senderPublicKey) throw new Error("Missing required env var: POOL_PUBLIC_KEY (or SENDER_PUBLIC_KEY)");
  }

  const config: Config = {
    baseUrl: env("ZORO_BASE_URL"),
    apiKey: env("ZORO_API_KEY"),
    senderPartyId,
    senderPrivateKey,
    senderPublicKey,
    instrumentId: env("INSTRUMENT_ID", false) || "Amulet",
    instrumentAdmin:
      env("INSTRUMENT_ADMIN", false) ||
      "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
  };

  if (!config.apiKey.startsWith("canton_")) {
    throw new Error("ZORO_API_KEY must start with 'canton_' prefix");
  }

  return config;
}

/** Public Firebase client config (safe to expose to browser) */
export function getFirebaseWebConfig() {
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
  };
}
