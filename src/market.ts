import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDatabase } from "./db/init.js";
import { createPredictionRouter } from "./api/prediction.js";
import { createAccountRouter } from "./api/account.js";
import { createAuthRouter } from "./api/auth.js";
import { startMarketScheduler } from "./scheduler/cron.js";
import { loadConfig, getFirebaseWebConfig } from "./lib/config.js";
import { initFirebase } from "./lib/firebase.js";
import * as api from "./lib/api.js";
import { fetchBTCPrice as fetchBTCPriceOracle } from "./oracle/coingecko-oracle.js";

// ═══════════════════════════════════════════════════════════════════════════
// Server-side BTC price cache — avoids CoinGecko rate limits on frontend
// ═══════════════════════════════════════════════════════════════════════════
let cachedBTCPrice = 0;
let cachedBTC24hChange = 0;
let btcPriceLastUpdated = 0;

async function refreshBTCPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json() as { bitcoin?: { usd?: number; usd_24h_change?: number } };
    if (data.bitcoin?.usd) {
      cachedBTCPrice = data.bitcoin.usd;
      cachedBTC24hChange = data.bitcoin.usd_24h_change ?? 0;
      btcPriceLastUpdated = Date.now();
    }
  } catch (e) {
    console.warn('BTC price refresh failed:', e instanceof Error ? e.message : e);
  }
}

// Refresh every 15 seconds server-side (well within CoinGecko limits)
setInterval(refreshBTCPrice, 15_000);
refreshBTCPrice(); // initial fetch

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Predict Now — BTC Prediction Market
 *
 * Architecture:
 * - Multi-wallet: users can link multiple Canton wallets, one active at a time
 * - Per-wallet deposit tracking: each wallet has its own last_verified_offset
 * - Internal ledger: deposits verified via transaction history -> uid-keyed balance
 * - Settlement: pure math on internal ledger (no Canton API calls)
 * - Canton API: deposit verification (history), withdrawals, health check
 * - Firebase Auth: ID token verification via firebase-admin
 */

const PORT = parseInt(process.env.PORT || "3000", 10);
const DB_PATH = process.env.DB_PATH || "./market.db";

async function main() {
  console.log("=== Predict Now — BTC Prediction Market ===");

  // Initialize Firebase Admin SDK
  initFirebase();

  // Initialize database (includes migrations for old schema)
  const db = initDatabase(DB_PATH);

  // Load Canton config
  const config = loadConfig(true);
  console.log(`Config: ${config.baseUrl}`);
  console.log(`Pool wallet: ${config.senderPartyId}`);

  // Startup health check
  try {
    const balance = await api.getBalance(config, config.senderPartyId);
    const poolBalance = balance.balance || "0";
    console.log(`Canton API OK — pool balance: ${poolBalance} CC`);
  } catch (error) {
    console.warn(
      `Canton API health check failed: ${error instanceof Error ? error.message : error}`
    );
    console.warn(`Deposits and withdrawals will fail until API is reachable.`);
  }

  // Log wallet deposit states
  console.log(`Wallet deposit states: ${db.wallet_deposit_states.length}`);
  for (const ws of db.wallet_deposit_states) {
    console.log(`  ${ws.party_id.substring(0, 20)}... -> offset: ${ws.last_verified_offset} (uid: ${ws.uid})`);
  }

  // Initialize Express
  const app = express();
  app.use(express.json());

  // CORS
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    );
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Health check
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // BTC price endpoint — cached server-side, no rate limit issues for frontend
  app.get("/api/btc-price", (req, res) => {
    res.json({
      price: cachedBTCPrice,
      change_24h: cachedBTC24hChange,
      last_updated: btcPriceLastUpdated,
    });
  });

  // Firebase public config
  app.get("/api/firebase-config", (req, res) => {
    res.json(getFirebaseWebConfig());
  });

  // API routes
  app.use("/api/auth", createAuthRouter(db, config));
  app.use("/api", createAccountRouter(db, config));
  app.use("/api", createPredictionRouter(db));

  // Serve frontend
  const projectRoot = path.resolve(__dirname, "..");
  const publicPath = path.join(projectRoot, "public");
  app.use(express.static(publicPath));

  app.get("/", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
  });

  // Start server
  app.listen(PORT, () => {
    console.log(`\nAPI server: http://localhost:${PORT}`);
    console.log(`  POST /api/auth/verify            - Verify Firebase token`);
    console.log(`  POST /api/auth/link-party         - Link Canton wallet`);
    console.log(`  POST /api/auth/set-active-wallet  - Switch active wallet`);
    console.log(`  POST /api/deposit                 - Verify & credit deposits`);
    console.log(`  POST /api/predict                 - Place prediction`);
    console.log(`  POST /api/withdraw                - Withdraw CC`);
    console.log(`  GET  /api/balance                 - Check balance`);
    console.log(`  GET  /api/bets                    - Bet history`);
    console.log(`  GET  /api/market/status            - Current round`);
    console.log(`  GET  /api/results/history          - Round history`);
    console.log(`  GET  /api/pool-info                - Pool wallet info`);
  });

  // Start market scheduler (1-minute rounds for fast iteration)
  const ROUND_MINUTES = parseInt(process.env.ROUND_MINUTES || "1", 10);
  startMarketScheduler(db, config, ROUND_MINUTES);

  console.log("\nMarket running");
  console.log(`  Oracle: CoinGecko BTC price (rounds every ${ROUND_MINUTES} min)`);
  console.log("  Settlement: internal ledger");
  console.log("  Deposits: per-wallet tx history verification");
  console.log("  Auth: Firebase ID tokens\n");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
