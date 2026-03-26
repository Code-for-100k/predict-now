#!/usr/bin/env node
/**
 * CLI — spin up agents against a live prediction market.
 *
 * Usage:
 *   cd agents && npm start
 *
 * Env vars:
 *   MARKET_URL   — base URL of the prediction market (default: Railway prod)
 *   AUTH_TOKEN   — Firebase auth token (required for placing real bets)
 *   PARTY_ID_1   — Canton party ID for agent 1
 *   PARTY_ID_2   — Canton party ID for agent 2
 *   POLL_MS      — polling interval in ms (default: 30000)
 *   DRY_RUN      — set to "true" to observe without betting
 */

import { AgentFactory } from "./factory.js";
import { DepositManager } from "./deposit-manager.js";
import { momentum } from "./strategies/momentum.js";
import { contrarian } from "./strategies/contrarian.js";
import { hybridEv } from "./strategies/hybrid-ev.js";

const MARKET_URL = process.env.MARKET_URL || "https://btc-prediction-market-production.up.railway.app";
const BOT_API_KEY = process.env.BOT_API_KEY;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyAALLUn5YsJNkXc0f7dKpgerJcmH4YPsUw";
const POLL_MS = parseInt(process.env.POLL_MS || "10000", 10); // 10s default for 1-min rounds
const DRY_RUN = process.env.DRY_RUN === "true";

// Firebase credentials per agent — MUST be set via env vars (never hardcode)
const AGENT_EMAIL_1 = process.env.AGENT_EMAIL_1 || "";
const AGENT_PASS_1 = process.env.AGENT_PASS_1 || "";
const AGENT_EMAIL_2 = process.env.AGENT_EMAIL_2 || "";
const AGENT_PASS_2 = process.env.AGENT_PASS_2 || "";
const AGENT_EMAIL_3 = process.env.AGENT_EMAIL_3 || "";
const AGENT_PASS_3 = process.env.AGENT_PASS_3 || "";

const PARTY_ID_1 = process.env.PARTY_ID_1;
const PARTY_ID_2 = process.env.PARTY_ID_2;
const PARTY_ID_3 = process.env.PARTY_ID_3;

// Canton API config for deposit manager (auto-forward CBTC to pool)
const ZORO_BASE_URL = process.env.ZORO_BASE_URL;
const ZORO_API_KEY = process.env.ZORO_API_KEY;
const INSTITUTIONAL_POOL_PARTY_ID = process.env.INSTITUTIONAL_POOL_PARTY_ID;
const INSTRUMENT_ID = process.env.INSTRUMENT_ID || "Amulet";
const INSTRUMENT_ADMIN = process.env.INSTRUMENT_ADMIN;

// Agent wallet keys (for accepting & forwarding CBTC)
const PRIVATE_KEY_1 = process.env.PRIVATE_KEY_1;
const PRIVATE_KEY_2 = process.env.PRIVATE_KEY_2;
const PRIVATE_KEY_3 = process.env.PRIVATE_KEY_3;
const PUBLIC_KEY_1 = process.env.PUBLIC_KEY_1;
const PUBLIC_KEY_2 = process.env.PUBLIC_KEY_2;
const PUBLIC_KEY_3 = process.env.PUBLIC_KEY_3;

async function main() {
  // Require real Canton party IDs when running live
  if (!DRY_RUN && BOT_API_KEY) {
    if (!PARTY_ID_1 || !PARTY_ID_2 || !PARTY_ID_3) {
      console.error("ERROR: PARTY_ID_1, PARTY_ID_2, and PARTY_ID_3 env vars are required for live trading.");
      console.error("Set these to real Canton wallet addresses.");
      process.exit(1);
    }
  }

  console.log("=== Agent Factory ===");
  console.log(`Market: ${MARKET_URL}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (observe only)" : BOT_API_KEY ? "LIVE (with bot API key)" : "OBSERVE (no API key)"}`);
  console.log(`Poll interval: ${POLL_MS / 1000}s\n`);

  const factory = new AgentFactory({
    baseUrl: MARKET_URL,
    authToken: DRY_RUN ? undefined : BOT_API_KEY,
    pollIntervalMs: POLL_MS,
  });

  // Verify market is reachable
  try {
    const client = factory.getClient();
    const price = await client.getPrice();
    const status = await client.getMarketStatus();
    console.log(`BTC: $${price.price.toLocaleString()} (${price.change24h >= 0 ? "+" : ""}${price.change24h.toFixed(2)}%)`);
    console.log(`Market: ${status.status}${status.round_number ? ` (round ${status.round_number})` : ""}`);

    // Check agent balances (no seeding — agents use real CBTC deposits)
    if (!DRY_RUN && PARTY_ID_1 && PARTY_ID_2 && PARTY_ID_3) {
      const client = factory.getClient();
      for (const id of [PARTY_ID_1, PARTY_ID_2, PARTY_ID_3]) {
        try {
          const bal = await client.getBalance(id);
          console.log(`${id}: ${bal.balance.toFixed(8)} CBTC`);
        } catch {
          console.log(`${id}: balance check failed`);
        }
      }
    }
    console.log();
  } catch (err) {
    console.error("Failed to connect to market:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Create agents with per-agent Firebase auth
  // All agents bet minimum size (10 sats = 0.0000001 CBTC) every round
  factory.create({
    name: "momentum-v2",
    partyId: PARTY_ID_1 || "dry-run::momentum-v2",
    strategy: momentum,
    params: { baseFraction: 0, minBet: 0.0000001, maxBet: 0.0000001, streakCutoff: 999 },
    firebaseAuth: { email: AGENT_EMAIL_1, password: AGENT_PASS_1, apiKey: FIREBASE_API_KEY },
  });

  factory.create({
    name: "contrarian-v2",
    partyId: PARTY_ID_2 || "dry-run::contrarian-v2",
    strategy: contrarian,
    params: { threshold: 0.65, baseFraction: 0, minBet: 0.0000001, maxBet: 0.0000001 },
    firebaseAuth: { email: AGENT_EMAIL_2, password: AGENT_PASS_2, apiKey: FIREBASE_API_KEY },
  });

  factory.create({
    name: "hybrid-ev",
    partyId: PARTY_ID_3 || "dry-run::hybrid-ev",
    strategy: hybridEv,
    params: { sensitivity: 2.0, minEvThreshold: 0, minBet: 0.0000001, maxBet: 0.0000001, emptyPoolBet: 0.0000001 },
    firebaseAuth: { email: AGENT_EMAIL_3, password: AGENT_PASS_3, apiKey: FIREBASE_API_KEY },
  });

  // Start all agents
  await factory.startAll();

  // Start deposit manager if Canton config is available
  let depositManager: DepositManager | null = null;
  if (
    ZORO_BASE_URL && ZORO_API_KEY && INSTITUTIONAL_POOL_PARTY_ID && INSTRUMENT_ADMIN &&
    PARTY_ID_1 && PARTY_ID_2 && PARTY_ID_3 &&
    PRIVATE_KEY_1 && PRIVATE_KEY_2 && PRIVATE_KEY_3 &&
    PUBLIC_KEY_1 && PUBLIC_KEY_2 && PUBLIC_KEY_3
  ) {
    depositManager = new DepositManager({
      agents: [
        { partyId: PARTY_ID_1, privateKey: PRIVATE_KEY_1, publicKey: PUBLIC_KEY_1 },
        { partyId: PARTY_ID_2, privateKey: PRIVATE_KEY_2, publicKey: PUBLIC_KEY_2 },
        { partyId: PARTY_ID_3, privateKey: PRIVATE_KEY_3, publicKey: PUBLIC_KEY_3 },
      ],
      poolPartyId: INSTITUTIONAL_POOL_PARTY_ID,
      marketClient: factory.getClient(),
      cantonBaseUrl: ZORO_BASE_URL,
      cantonApiKey: ZORO_API_KEY,
      instrumentId: INSTRUMENT_ID,
      instrumentAdmin: INSTRUMENT_ADMIN,
    });
    depositManager.start();
  } else {
    console.log("[DepositManager] Skipped — Canton wallet config not set (deposits won't auto-forward)\n");
  }

  // Print stats every 5 minutes
  setInterval(() => factory.printStats(), 5 * 60 * 1000);

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    depositManager?.stop();
    factory.stopAll();
    factory.printStats();
    process.exit(0);
  });
}

main().catch(console.error);
