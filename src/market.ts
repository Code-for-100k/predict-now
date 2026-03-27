import "dotenv/config";
import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { initDatabase, initDatabaseAuto, getOrCreateBalance, type Database } from "./db/init.js";
import { tripCircuitBreaker, resetCircuitBreaker, setCircuitBreakerCallbacks } from "./lib/circuit-breaker.js";
import { auditLog } from "./lib/audit.js";

// ── Global agent process control ──
let agentProc: import("child_process").ChildProcess | null = null;

export function getAgentProc() { return agentProc; }

export function killAgents() {
  if (agentProc && !agentProc.killed) {
    console.log("[CircuitBreaker] Killing agent process...");
    agentProc.kill("SIGTERM");
    agentProc = null;
  }
}

export async function startAgents(port: number) {
  if (agentProc && !agentProc.killed) return; // already running
  const { spawn } = await import("child_process");
  const agentEnv = {
    ...process.env,
    MARKET_URL: `http://localhost:${port}`,
    PARTY_ID_1: process.env.AGENT_PARTY_ID_1 || "",
    PARTY_ID_2: process.env.AGENT_PARTY_ID_2 || "",
    PARTY_ID_3: process.env.AGENT_PARTY_ID_3 || "",
    POLL_MS: process.env.AGENT_POLL_MS || "10000",
  };
  console.log("[CircuitBreaker] Starting agents...");
  agentProc = spawn("npx", ["tsx", "agents/src/cli.ts"], { env: agentEnv, stdio: ["ignore", "pipe", "pipe"] });
  agentProc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[AGENT] ${d}`));
  agentProc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[AGENT] ${d}`));
  agentProc.on("exit", (code: number | null) => {
    console.log(`[Agents] Exited (code=${code})`);
    agentProc = null;
    // Auto-restart if agents should be running and circuit breaker isn't tripped
    if (process.env.AGENT_ENABLED === "true") {
      console.log("[Agents] Auto-restarting in 5s...");
      setTimeout(() => startAgents(port), 5000);
    }
  });
}

// Re-export for admin endpoints
export { tripCircuitBreaker, resetCircuitBreaker } from "./lib/circuit-breaker.js";
import { createPredictionRouter } from "./api/prediction.js";
import { createAccountRouter } from "./api/account.js";
import { createAuthRouter } from "./api/auth.js";
import { requireAuth } from "./middleware/auth.js";
import { startMarketScheduler } from "./scheduler/cron.js";
import { loadConfig, getFirebaseWebConfig } from "./lib/config.js";
import { initFirebase } from "./lib/firebase.js";
import * as api from "./lib/api.js";
import { startBinancePriceService, getCachedPrice } from "./oracle/binance-ws.js";
import { createLeaderboardRouter } from "./api/leaderboard.js";

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
const DB_PATH = process.env.DB_PATH || "./market.db.json";

// ── Startup env var validation ──
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid PORT: must be an integer between 1 and 65535 (got "${process.env.PORT}")`);
}

const feeRaw = process.env.FEE_PERCENTAGE;
if (feeRaw !== undefined) {
  const fee = parseFloat(feeRaw);
  if (isNaN(fee) || fee < 0 || fee > 100) {
    throw new Error(`Invalid FEE_PERCENTAGE: must be a number between 0 and 100 (got "${feeRaw}")`);
  }
}

const roundRaw = process.env.ROUND_MINUTES;
if (roundRaw !== undefined) {
  const round = parseInt(roundRaw, 10);
  if (isNaN(round) || round < 1 || round > 60) {
    throw new Error(`Invalid ROUND_MINUTES: must be an integer between 1 and 60 (got "${roundRaw}")`);
  }
}

async function main() {
  console.log("=== Predict Now — BTC Prediction Market ===");

  // Initialize Firebase Admin SDK
  initFirebase();

  // Initialize database — Postgres if DATABASE_URL set, else JSON file
  const db = process.env.DATABASE_URL
    ? await initDatabaseAuto(DB_PATH)
    : initDatabase(DB_PATH);

  // Load Canton config
  const config = loadConfig(true);
  console.log(`Config: ${config.baseUrl}`);
  console.log(`Pool wallet: ${config.senderPartyId}`);

  // Start Binance WebSocket price service (replaces CoinGecko)
  await startBinancePriceService();

  // Set up circuit breaker callbacks (avoids circular import)
  setCircuitBreakerCallbacks(
    () => killAgents(),
    () => { if (process.env.AGENT_ENABLED === "true") startAgents(PORT); }
  );

  // Startup health check — both pool wallets
  for (const [tier, pool] of Object.entries(config.poolWallets)) {
    try {
      const balance = await api.getBalance(config, pool.partyId);
      const poolBalance = balance.balance || "0";
      console.log(`Canton API OK — ${tier} pool (${pool.partyId.substring(0, 20)}...): ${poolBalance} CBTC`);
    } catch (error) {
      console.warn(
        `Canton API health check failed for ${tier} pool: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  console.log(`Deposits and withdrawals will fail if Canton API is unreachable.`);

  // Log wallet deposit states
  console.log(`Wallet deposit states: ${db.wallet_deposit_states.length}`);
  for (const ws of db.wallet_deposit_states) {
    console.log(`  ${ws.party_id.substring(0, 20)}... -> offset: ${ws.last_verified_offset} (uid: ${ws.uid})`);
  }

  // Initialize Express
  const app = express();

  // Security headers — early in the pipeline
  app.use((req, res, next) => {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' https://cdn.tailwindcss.com https://unpkg.com https://www.gstatic.com https://apis.google.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://*.googleusercontent.com",
        "connect-src 'self' https://cbtc-data-api.bitsafe.finance https://dev-api.zorowallet.com https://ccview.io wss://stream.binance.com:9443 https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://*.firebaseapp.com",
        "frame-src https://apis.google.com https://*.firebaseapp.com",
        "media-src 'self' https://stream.nightride.fm",
        "frame-ancestors 'none'",
      ].join("; ")
    );
    next();
  });

  app.use(express.json({ limit: "10kb" }));

  // CORS — use CORS_ORIGIN env var; omit header entirely if not set (same-origin only)
  const corsOrigin = process.env.CORS_ORIGIN || "";
  if (!corsOrigin) {
    console.warn("WARNING: CORS_ORIGIN env var not set — only same-origin requests allowed. Set CORS_ORIGIN to allow cross-origin access.");
  } else if (corsOrigin === "*") {
    console.warn("WARNING: CORS_ORIGIN is set to '*' — all origins are allowed. This is insecure in production.");
  } else {
    try {
      new URL(corsOrigin);
    } catch {
      throw new Error(`Invalid CORS_ORIGIN: "${corsOrigin}" is not a valid URL. Use a full origin like "https://example.com" or "*".`);
    }
  }
  app.use((req, res, next) => {
    if (corsOrigin) {
      res.header("Access-Control-Allow-Origin", corsOrigin);
    }
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-admin-secret"
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

  // BTC price endpoint — real-time from Binance WebSocket
  app.get("/api/btc-price", (req, res) => {
    const cached = getCachedPrice();
    res.json({
      price: cached.price,
      change_24h: cached.change24h,
      last_updated: cached.lastUpdated,
    });
  });

  // Firebase public config
  app.get("/api/firebase-config", (req, res) => {
    res.json(getFirebaseWebConfig());
  });

  // ── Public Agent Stats (no auth needed) ──
  app.get("/api/agents/public", (_req, res) => {
    const agentUsers = db.users.filter((u) => u.tier === "institutional");
    const agentUids = new Set(agentUsers.map((u) => u.uid));
    const roundMap = new Map(db.rounds.map((r: any) => [r.id, r]));

    const agents = agentUsers.map((u: any) => {
      const preds = db.predictions.filter((p: any) => p.uid === u.uid);
      let wins = 0, losses = 0;
      let totalPayout = 0;
      const totalVolume = preds.reduce((s: number, p: any) => s + (p.amount || 0), 0);
      for (const p of preds) {
        if (!p.settled) continue;
        const round = roundMap.get(p.market_round_id) as any;
        if (!round?.winning_direction) continue;
        if (p.direction === round.winning_direction) {
          wins++;
          const rPreds = db.predictions.filter((rp: any) => rp.market_round_id === round.id && rp.settled);
          const wp = rPreds.filter((rp: any) => rp.direction === round.winning_direction).reduce((s: number, rp: any) => s + (rp.amount || 0), 0);
          const lp = rPreds.filter((rp: any) => rp.direction !== round.winning_direction).reduce((s: number, rp: any) => s + (rp.amount || 0), 0);
          totalPayout += wp > 0 && lp > 0 ? (p.amount || 0) + ((p.amount || 0) / wp) * lp : (p.amount || 0);
        } else { losses++; }
      }
      const settled = wins + losses;
      const pnl = totalPayout - totalVolume;
      return {
        uid: u.uid,
        name: (u.email || "").replace("@predictnow.cc", ""),
        total_bets: preds.length,
        wins, losses,
        win_rate: settled > 0 ? Math.round((wins / settled) * 100) : 0,
        pnl_pct: totalVolume > 0 ? parseFloat(((pnl / totalVolume) * 100).toFixed(1)) : 0,
      };
    });
    res.json({ agents });
  });

  // ── Copy Trading Endpoints (auth required) ──
  app.post("/api/copy-agent", requireAuth, (req: any, res) => {
    const { agent_uid, amount, rounds } = req.body;
    const uid = req.uid;
    if (!agent_uid || !rounds) return res.status(400).json({ error: "agent_uid and rounds required" });

    const agent = db.users.find((u) => u.uid === agent_uid && u.tier === "institutional");
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const copyAmount = typeof amount === "string" ? parseFloat(amount) : (amount || 0.0000001);
    const copyRounds = Math.min(Math.max(1, parseInt(rounds, 10) || 10), 1000);

    const user = db.users.find((u) => u.uid === uid);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.copying_agent_uid = agent_uid;
    user.copy_amount = copyAmount;
    user.copy_rounds_remaining = copyRounds;
    db.save();

    res.json({
      copying: agent.email?.replace("@predictnow.cc", "") || agent_uid,
      amount: copyAmount,
      rounds_remaining: copyRounds,
    });
  });

  app.post("/api/stop-copy", requireAuth, (req: any, res) => {
    const user = db.users.find((u) => u.uid === req.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.copying_agent_uid = null;
    user.copy_rounds_remaining = 0;
    db.save();
    res.json({ stopped: true });
  });

  app.get("/api/copy-status", requireAuth, (req: any, res) => {
    const user = db.users.find((u) => u.uid === req.uid);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.copying_agent_uid) return res.json({ copying: false });
    const agent = db.users.find((u) => u.uid === user.copying_agent_uid);
    res.json({
      copying: true,
      agent_name: agent?.email?.replace("@predictnow.cc", "") || user.copying_agent_uid,
      amount: user.copy_amount || 0.0000001,
      rounds_remaining: user.copy_rounds_remaining || 0,
    });
  });

  // API routes
  app.use("/api/auth", createAuthRouter(db, config));
  app.use("/api", createAccountRouter(db, config));
  app.use("/api", createPredictionRouter(db));
  app.use("/api", createLeaderboardRouter(db));

  // ── Rewards API (protected by REWARDS_API_KEY — shared with selected partners) ──
  const REWARDS_API_KEY = process.env.REWARDS_API_KEY;

  function requireRewardsKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!REWARDS_API_KEY) {
      return res.status(403).json({ error: "Rewards API not configured" });
    }
    const key = req.headers["x-rewards-key"] as string;
    if (!key || key !== REWARDS_API_KEY) {
      return res.status(401).json({ error: "Invalid or missing x-rewards-key header" });
    }
    next();
  }

  // GET /api/rewards — reward/gas metrics (defaults to all pool wallets)
  // POST /api/rewards — same but accepts { wallets: ["partyId1", ..."] } to filter
  const handleRewards = async (req: express.Request, res: express.Response) => {
    try {
      const YAC = "https://cbtc-data-api.bitsafe.finance";
      const allPoolIds = Object.values(config.poolWallets).map((p: any) => p.partyId).filter(Boolean);
      // Agent pre-approved wallets (not in pool config but part of the system)
      const agentPreApprovedIds = [
        'df0c3fdb58::12200a976df35fa70038966d8fc1fdd86a3c1310e30d7e3d1d3d43dbe5f372c3ea94',
        '689e91029e::12202e732753e42faa1577be9f9efb22daaa1f85e8a3874695e2ed292e2883f0d0bc',
        '1ca79f9918::12206e3ad664f644c87a3dc169d5d4cf442fd897a32f2daaf1b165df975ce7a2f16d',
        '0afed9241a::1220320c5994fd50d10e15a687d336acf65d0ba07f94744d16d68291ac8bb65e2825', // inst-1
      ];
      const allSystemIds = [...new Set([...allPoolIds, ...agentPreApprovedIds])];

      // Custom wallets from POST body or query param (comma-separated)
      let walletIds: string[] = allSystemIds;
      const bodyWallets = req.body?.wallets;
      const queryWallets = req.query.wallets as string | undefined;
      if (Array.isArray(bodyWallets) && bodyWallets.length > 0) {
        walletIds = bodyWallets.filter((w: string) => typeof w === "string" && w.includes("::") && w.length >= 20 && w.length <= 300);
      } else if (queryWallets) {
        walletIds = queryWallets.split(",").map(w => w.trim()).filter(w => w.includes("::") && w.length >= 20 && w.length <= 300);
      }

      if (walletIds.length === 0) {
        return res.status(400).json({ error: "No valid wallet IDs provided. Each must contain '::'." });
      }
      if (walletIds.length > 100) {
        return res.status(400).json({ error: "Maximum 100 wallets per request." });
      }

      // Date range from query or default 30 days
      const days = parseInt(req.query.days as string || "30", 10);
      const now = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - Math.min(days, 365) * 86400000).toISOString().slice(0, 10);

      // Query YAC for reward aggregation
      const [rewardRes, dailyRes] = await Promise.all([
        fetch(`${YAC}/api/v1/analytics/transfer-reward-aggregation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parties: walletIds, start_date: startDate, end_date: now }),
          signal: AbortSignal.timeout(120000),
        }),
        fetch(`${YAC}/api/v1/analytics/daily-rewards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parties: walletIds, start_date: startDate, end_date: now }),
          signal: AbortSignal.timeout(120000),
        }),
      ]);
      const rewardData = await rewardRes.json() as any;
      const dailyData = await dailyRes.json() as any;
      const rewardAgg = rewardData.success ? rewardData.data : null;
      const dailyRewards = dailyData.success ? dailyData.data?.daily_rewards : null;

      // Gas from DB (filtered to matching pool wallets)
      const walletSet = new Set(walletIds);
      const matchingTxns = db.canton_transactions.filter((t: any) =>
        walletSet.has(t.pool_party_id) && (t.type === "payout" || t.type === "withdrawal")
      );
      const totalGas = matchingTxns.reduce((s: number, t: any) => s + (t.cc_gas_cost || 0), 0);
      const totalSends = matchingTxns.length;

      const rewardPerTx = rewardAgg ? parseFloat(rewardAgg.reward_per_tx || "0") : 0;
      const gasPerTx = totalSends > 0 ? totalGas / totalSends : 0;
      const totalTxns = rewardAgg ? (rewardAgg.total_transfer_offers || 0) : 0;
      const acceptedTxns = rewardAgg ? (rewardAgg.accepted_transfer_offers || 0) : 0;
      const totalReward = rewardAgg ? parseFloat(rewardAgg.total_cc_reward || "0") : 0;

      res.json({
        period: { start: startDate, end: now, days },
        wallets_queried: walletIds.length,
        reward_per_transaction_cc: parseFloat(rewardPerTx.toFixed(4)),
        gas_cost_per_transaction_cc: parseFloat(gasPerTx.toFixed(4)),
        net_per_transaction_cc: parseFloat((rewardPerTx - gasPerTx).toFixed(4)),
        total_cc_reward: parseFloat(totalReward.toFixed(4)),
        total_gas_spent_cc: parseFloat(totalGas.toFixed(4)),
        total_transactions: totalTxns,
        accepted_transactions: acceptedTxns,
        fee_percentage: parseFloat(process.env.FEE_PERCENTAGE || "0"),
        daily_breakdown: dailyRewards || [],
        circuit_breaker: db.circuit_breaker,
      });
    } catch (error) {
      console.error("Error in /api/rewards:", error);
      res.status(500).json({ error: "Failed to fetch reward metrics" });
    }
  };
  app.get("/api/rewards", requireRewardsKey, handleRewards);
  app.post("/api/rewards", requireRewardsKey, handleRewards);

  // ── Circuit Breaker admin endpoints (uses admin secret) ──
  // Note: these are defined after ADMIN_SECRET is set up below, see the registerAdminCB() call

  // ── Admin endpoints (protected by ADMIN_SECRET) ──
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET) {
    console.warn("WARNING: ADMIN_SECRET env var not set — admin endpoints will be disabled.");
  }

  // SEC-03 fix: rate limit failed admin auth attempts (max 10 per minute per IP)
  const adminFailMap = new Map<string, { count: number; resetAt: number }>();
  // Cleanup stale entries every 5 minutes to prevent memory leak
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of adminFailMap) {
      if (now > entry.resetAt) adminFailMap.delete(ip);
    }
  }, 5 * 60_000);

  function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!ADMIN_SECRET) {
      return res.status(403).json({ error: "Admin endpoints disabled (ADMIN_SECRET not configured)" });
    }

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = adminFailMap.get(ip);

    // Check if IP is rate-limited
    if (entry && entry.count >= 10 && now < entry.resetAt) {
      return res.status(429).json({ error: "Too many failed attempts. Try again later." });
    }

    // SEC-02 fix: use HMAC comparison to prevent timing attacks (including length leak)
    const secret = req.headers["x-admin-secret"] as string | undefined;
    const inputHash = crypto.createHmac("sha256", "admin-compare").update(secret || "").digest();
    const expectedHash = crypto.createHmac("sha256", "admin-compare").update(ADMIN_SECRET).digest();
    const isValid = crypto.timingSafeEqual(inputHash, expectedHash);

    if (!isValid) {
      // Track failed attempt
      if (!entry || now >= entry.resetAt) {
        adminFailMap.set(ip, { count: 1, resetAt: now + 60_000 });
      } else {
        entry.count++;
      }
      return res.status(403).json({ error: "Forbidden" });
    }

    // Reset on success
    adminFailMap.delete(ip);
    auditLog({
      event: "admin_access",
      timestamp: new Date().toISOString(),
      actor: ip,
      details: { method: req.method, path: req.path },
    });
    next();
  }

  // GET /admin/user?email=... — view user account data
  app.get("/admin/user", requireAdmin, (req, res) => {
    const email = req.query.email as string;
    const uid = req.query.uid as string;
    const user = email
      ? db.users.find((u) => u.email === email)
      : uid
      ? db.users.find((u) => u.uid === uid)
      : null;

    if (!user) return res.status(404).json({ error: "User not found" });

    const balance = db.balances.find((b) => b.uid === user.uid);
    const predictions = db.predictions.filter((p) => p.uid === user.uid);
    const deposits = db.deposits.filter((d) => d.uid === user.uid);
    const withdrawals = db.withdrawals.filter((w) => (w as any).uid === user.uid);

    res.json({
      user,
      balance,
      predictions,
      deposits,
      withdrawals,
      failed_payouts: predictions.filter((p) => p.settled && !p.payout_txn_id && db.rounds.find((r) => r.id === p.market_round_id)?.winning_direction === p.direction),
    });
  });

  // GET /admin/db-summary — overview of database state
  app.get("/admin/db-summary", requireAdmin, (req, res) => {
    const retailUsers = db.users.filter((u) => (u.tier || "retail") === "retail");
    const institutionalUsers = db.users.filter((u) => u.tier === "institutional");

    res.json({
      users: db.users.length,
      users_by_tier: {
        retail: retailUsers.length,
        institutional: institutionalUsers.length,
      },
      invite_codes: {
        total: db.invite_codes.length,
        retail: {
          total: db.invite_codes.filter((c) => c.tier === "retail").length,
          available: db.invite_codes.filter((c) => c.tier === "retail" && (!Array.isArray(c.used_by) || c.used_by.length < c.max_uses)).length,
          used: db.invite_codes.filter((c) => c.tier === "retail" && Array.isArray(c.used_by) && c.used_by.length >= c.max_uses).length,
        },
        institutional: db.invite_codes.filter((c) => c.tier === "institutional").map((c) => ({
          code: c.code,
          pool: c.pool_wallet_id,
          uses: `${Array.isArray(c.used_by) ? c.used_by.length : 0}/${c.max_uses}`,
        })),
      },
      rounds: db.rounds.length,
      predictions: db.predictions.length,
      deposits: db.deposits.length,
      withdrawals: db.withdrawals.length,
      balances: db.balances.map((b) => {
        const user = db.users.find((u) => u.uid === b.uid);
        return { uid: b.uid, tier: user?.tier || "retail", balance: b.balance, won: b.total_won, lost: b.total_lost };
      }),
      pool_wallets: Object.fromEntries(
        Object.entries(config.poolWallets).map(([id, pool]) => [id, pool.partyId.substring(0, 30) + "..."])
      ),
      active_round: db.rounds.find((r) => !r.settled && r.window_end_time > Date.now()),
      settled_rounds_with_bets: db.rounds.filter((r) => r.settled && (r.total_up_amount > 0 || r.total_down_amount > 0)),
    });
  });

  // POST /admin/invite-codes — generate invite codes
  app.post("/admin/invite-codes", requireAdmin, (req, res) => {
    try {
      const { tier, count = 1, prefix, pool_wallet_id, max_uses } = req.body;

      if (!tier || (tier !== "retail" && tier !== "institutional")) {
        return res.status(400).json({ error: 'tier must be "retail" or "institutional"' });
      }
      if (typeof count !== "number" || count < 1 || count > 100) {
        return res.status(400).json({ error: "count must be 1-100" });
      }

      const poolId = pool_wallet_id || (tier === "retail" ? "retail" : "inst-1");
      const uses = max_uses || (tier === "retail" ? 1 : 10);
      const pfx = prefix ? prefix.toUpperCase() : tier === "retail" ? "RET" : "INST";
      const codes: string[] = [];

      for (let i = 0; i < count; i++) {
        const random = Math.random().toString(36).substring(2, 8).toUpperCase();
        const code = `${pfx}-${random}`;
        db.invite_codes.push({
          code,
          tier,
          pool_wallet_id: poolId,
          max_uses: uses,
          used_by: [],
          created_at: Date.now(),
        });
        codes.push(code);
      }

      db.save();
      console.log(`  Admin generated ${count} ${tier} invite codes (pool: ${poolId}, max: ${uses}): ${codes.join(", ")}`);

      res.json({ tier, pool_wallet_id: poolId, max_uses: uses, codes, count: codes.length });
    } catch (error) {
      console.error("Error generating invite codes:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /admin/invite-codes — list all invite codes
  app.get("/admin/invite-codes", requireAdmin, (req, res) => {
    const tierFilter = req.query.tier as string | undefined;
    const usedFilter = req.query.used as string | undefined;

    let codes = [...db.invite_codes];
    if (tierFilter) codes = codes.filter((c) => c.tier === tierFilter);
    if (usedFilter === "true") codes = codes.filter((c) => Array.isArray(c.used_by) && c.used_by.length >= c.max_uses);
    if (usedFilter === "false") codes = codes.filter((c) => !Array.isArray(c.used_by) || c.used_by.length < c.max_uses);

    res.json({
      total: codes.length,
      available: codes.filter((c) => !Array.isArray(c.used_by) || c.used_by.length < c.max_uses).length,
      exhausted: codes.filter((c) => Array.isArray(c.used_by) && c.used_by.length >= c.max_uses).length,
      codes: codes.map((c) => ({
        code: c.code,
        tier: c.tier,
        pool_wallet_id: c.pool_wallet_id,
        max_uses: c.max_uses,
        current_uses: Array.isArray(c.used_by) ? c.used_by.length : 0,
        used_by: c.used_by,
      })),
    });
  });

  // POST /admin/retry-payout — retry a failed auto-payout
  app.post("/admin/retry-payout", requireAdmin, async (req, res) => {
    const { prediction_id, uid: targetUid, email } = req.body;

    try {
      let predsToRetry: typeof db.predictions = [];

      if (prediction_id) {
        const pred = db.predictions.find((p) => p.id === prediction_id);
        if (pred) predsToRetry = [pred];
      } else {
        // Find user
        const user = email
          ? db.users.find((u) => u.email === email)
          : targetUid
          ? db.users.find((u) => u.uid === targetUid)
          : null;
        if (!user) return res.status(404).json({ error: "User not found" });

        // Find all winning predictions without payout txn
        predsToRetry = db.predictions.filter((p) => {
          if (p.uid !== user.uid || !p.settled || p.payout_txn_id) return false;
          const round = db.rounds.find((r) => r.id === p.market_round_id);
          return round?.winning_direction === p.direction;
        });
      }

      if (predsToRetry.length === 0) {
        return res.json({ message: "No failed payouts found to retry" });
      }

      const results: Array<{ prediction_id: number; amount: number; status: string; txn_id?: string; error?: string }> = [];

      for (const pred of predsToRetry) {
        const round = db.rounds.find((r) => r.id === pred.market_round_id);
        if (!round) continue;

        // Recalculate payout
        const winnerPool = round.winning_direction === "UP" ? round.total_up_amount : round.total_down_amount;
        const loserPool = round.winning_direction === "UP" ? round.total_down_amount : round.total_up_amount;
        let payout = pred.amount;
        if (loserPool > 0 && winnerPool > 0) {
          const rawFee = parseFloat(process.env.FEE_PERCENTAGE || "0");
          const feeRate = Math.max(0, Math.min(100, isNaN(rawFee) ? 10 : rawFee)) / 100;
          const winnerShare = pred.amount / winnerPool;
          payout = pred.amount + (loserPool * (1 - feeRate) * winnerShare);
        }

        try {
          // Get the user's tier-specific pool wallet
          const predUser = db.users.find((u) => u.uid === pred.uid);
          const predTier = (predUser?.tier || "retail") as import("./types/market.js").UserTier;
          const pool = config.poolWallets[predTier];
          console.log(`\n[ADMIN] Retrying payout: ${payout} CBTC to ${pred.party_id.substring(0, 30)}... (${predTier} pool)`);

          const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          const prepared = await api.prepareSend(config, {
            senderPartyId: pool.partyId,
            receiverPartyId: pred.party_id,
            amount: payout.toString(),
            expiryDate,
            instrument: {
              id: config.instrumentId,
              admin: config.instrumentAdmin,
            },
          });

          const { signHash } = await import("./lib/sign.js");
          const signature = signHash(prepared.command.preparedTransactionHash, pool.privateKey);

          const result = await api.broadcast(config, {
            signature,
            publicKey: pool.publicKey,
            commandId: prepared.commandId,
            command: prepared.command,
            partyId: pool.partyId,
          });

          const txnId = result.updateId || result.transactionId || "unknown";
          pred.payout_txn_id = txnId;

          // Deduct from internal balance
          const bal = db.balances.find((b) => b.uid === pred.uid);
          if (bal) {
            bal.balance -= payout;
            bal.total_withdrawn += payout;
          }

          db.withdrawals.push({
            id: db.withdrawals.length + 1,
            uid: pred.uid || "",
            party_id: pred.party_id,
            amount: payout,
            txn_id: txnId,
            created_at: Date.now(),
          });

          db.save();
          results.push({ prediction_id: pred.id, amount: payout, status: "success", txn_id: txnId });
          console.log(`[ADMIN] ✓ Payout sent: ${txnId}`);
        } catch (err: any) {
          results.push({ prediction_id: pred.id, amount: payout, status: "failed", error: err.message });
          console.error(`[ADMIN] ✗ Payout failed: ${err.message}`);
        }
      }

      res.json({ retried: results.length, results });
    } catch (error) {
      console.error("Error in /admin/retry-payout:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /admin/credit — manually credit a user's balance
  app.post("/admin/credit", requireAdmin, (req, res) => {
    try {
      const { uid, email, amount, reason } = req.body;
      const targetUid = uid || db.users.find((u) => u.email === email)?.uid;
      if (!targetUid) return res.status(404).json({ error: "User not found" });
      if (typeof amount !== "number" || amount <= 0) return res.status(400).json({ error: "Amount must be a positive number" });

      const bal = getOrCreateBalance(db, targetUid);
      bal.balance += amount;
      bal.total_deposited += amount;
      db.deposits.push({
        id: db.deposits.length + 1,
        uid: targetUid,
        party_id: "admin-credit",
        amount,
        contract_id: `admin-credit-${Date.now()}`,
        accepted_at: Date.now(),
      });
      db.save();

      console.log(`  [ADMIN] Credited ${amount} CBTC to ${targetUid} (reason: ${reason || "manual"})`);
      res.json({ uid: targetUid, credited: amount, new_balance: bal.balance, reason });
    } catch (error) {
      console.error("Error in /admin/credit:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /admin/link-party — admin-link a Canton wallet to a user (for agents)
  app.post("/admin/link-party", requireAdmin, (req, res) => {
    try {
      const { email, party_id } = req.body || {};
      if (!email || !party_id) return res.status(400).json({ error: "email and party_id required" });
      const user = db.users.find((u: any) => u.email === email);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.party_ids) user.party_ids = [];
      if (!user.party_ids.includes(party_id)) user.party_ids.push(party_id);
      user.active_party_id = party_id;
      db.save();
      console.log(`  [ADMIN] Linked ${party_id.substring(0, 30)}... to ${email}`);
      res.json({ linked: true, email, party_id, active_party_id: user.active_party_id });
    } catch (error) {
      console.error("Error in /admin/link-party:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /admin/delete-user — remove a user account (unlinks wallets, preserves predictions/deposits)
  app.post("/admin/delete-user", requireAdmin, (req, res) => {
    try {
      const { uid, email } = req.body || {};
      const targetUid = uid || db.users.find((u: any) => u.email === email)?.uid;
      if (!targetUid) return res.status(404).json({ error: "User not found" });

      const userIdx = db.users.findIndex((u: any) => u.uid === targetUid);
      if (userIdx === -1) return res.status(404).json({ error: "User not found" });

      const user = db.users[userIdx];
      const removedEmail = user.email;
      const removedPartyIds = user.party_ids || [];

      // Remove user
      db.users.splice(userIdx, 1);
      db.save();

      console.log(`  [ADMIN] Deleted user ${removedEmail} (uid: ${targetUid}, wallets: ${removedPartyIds.join(", ")})`);
      res.json({ deleted: true, uid: targetUid, email: removedEmail, unlinked_wallets: removedPartyIds });
    } catch (error) {
      console.error("Error in /admin/delete-user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /admin/approve-withdrawal — force-execute a withdrawal that was blocked by the anti-fraud check
  app.post("/admin/approve-withdrawal", requireAdmin, async (req, res) => {
    try {
      const { email, uid: targetUid, amount, party_id } = req.body;
      const resolvedUid = targetUid || db.users.find((u) => u.email === email)?.uid;
      if (!resolvedUid) return res.status(404).json({ error: "User not found" });

      const user = db.users.find((u) => u.uid === resolvedUid);
      if (!user) return res.status(404).json({ error: "User not found" });

      const withdrawTo = party_id || user.active_party_id;
      if (!withdrawTo || !user.party_ids?.includes(withdrawTo)) {
        return res.status(400).json({ error: "Invalid withdrawal wallet" });
      }

      if (typeof amount !== "number" || amount <= 0) {
        return res.status(400).json({ error: "Amount must be a positive number" });
      }

      const bal = getOrCreateBalance(db, resolvedUid);
      if (bal.balance < amount) {
        return res.status(400).json({ error: `Insufficient balance: ${bal.balance}` });
      }

      const pool = config.poolWallets[user.pool_wallet_id || "retail"] || config.poolWallets["retail"];
      const roundedAmount = Math.round(amount * 1e8) / 1e8;

      const prepared = await api.prepareSend(config, {
        senderPartyId: pool.partyId,
        receiverPartyId: withdrawTo,
        amount: roundedAmount.toFixed(8),
        expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        memo: "Admin-approved withdrawal",
        instrument: { id: config.instrumentId, admin: config.instrumentAdmin },
      });

      const { signHash } = await import("./lib/sign.js");
      const signature = signHash(prepared.command.preparedTransactionHash, pool.privateKey);

      const result = await api.broadcast(config, {
        signature,
        publicKey: pool.publicKey,
        commandId: prepared.commandId,
        command: prepared.command,
        partyId: pool.partyId,
      });

      const txnId = result.updateId || result.transactionId;
      bal.balance -= roundedAmount;
      bal.total_withdrawn += roundedAmount;
      db.withdrawals.push({
        id: db.withdrawals.length + 1,
        uid: resolvedUid,
        party_id: withdrawTo,
        amount: roundedAmount,
        txn_id: txnId || "admin-approved",
        created_at: Date.now(),
      });
      db.save();

      console.log(`  [ADMIN] Approved withdrawal: ${roundedAmount} CBTC to ${withdrawTo.substring(0, 20)}... | txn: ${txnId}`);
      res.json({ txn_id: txnId, amount: roundedAmount, remaining_balance: bal.balance });
    } catch (error) {
      console.error("Error in /admin/approve-withdrawal:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /admin/zoro-stats — aggregate on-chain tx counts + gas from Zoro wallet history
  app.get("/admin/zoro-stats", requireAdmin, async (_req, res) => {
    const ZORO = "https://dev-api.zorowallet.com";
    const ZORO_KEY = process.env.ZORO_API_KEY || "canton_-KPOgjYXFL_DoI-S3wMhFCIbxaElqbjVJxUc69T7wbI";
    const allPoolIds = Object.values(config.poolWallets).map((p: any) => p.partyId).filter(Boolean);
    const agentPreApprovedIds = [
      'df0c3fdb58::12200a976df35fa70038966d8fc1fdd86a3c1310e30d7e3d1d3d43dbe5f372c3ea94',
      '689e91029e::12202e732753e42faa1577be9f9efb22daaa1f85e8a3874695e2ed292e2883f0d0bc',
      '1ca79f9918::12206e3ad664f644c87a3dc169d5d4cf442fd897a32f2daaf1b165df975ce7a2f16d',
    ];
    const allIds = [...new Set([...allPoolIds, ...agentPreApprovedIds])];

    try {
      const results = await Promise.all(allIds.map(async (partyId) => {
        const resp = await fetch(`${ZORO}/canton/transaction/history`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ZORO_KEY}` },
          body: JSON.stringify({ partyId }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json() as any;
        const txns = data.transactions || [];
        const getInst = (t: any) => {
          const i = t.instrumentId;
          return typeof i === "object" ? i?.id : i;
        };
        const cbtcAll = txns.filter((t: any) => getInst(t) === "CBTC");
        // Only count TransferOut for gas denominator (TransferIn = receiving, no gas paid)
        const cbtcSends = cbtcAll.filter((t: any) => t.type === "TransferOut");

        // Gas = CC TransferOut < 5 CC (per Zoro skill: gas is ~1.85-3.02 CC range)
        // CC TransferOut >= 5 CC are manual wallet-to-wallet funding transfers, NOT gas
        const GAS_THRESHOLD = 5.0;
        const ccOuts = txns.filter((t: any) => t.type === "TransferOut" && getInst(t) === "Amulet");
        let gasTotal = 0;
        let gasCount = 0;
        for (const co of ccOuts) {
          const amt = parseFloat(co.amount || 0);
          if (amt > 0 && amt < GAS_THRESHOLD) {
            gasTotal += amt;
            gasCount++;
          }
        }

        return {
          partyId: partyId.substring(0, 10) + "...",
          total_txns: data.count || txns.length,
          cbtc_transfers: cbtcAll.length,
          cbtc_sends: cbtcSends.length, // outgoing only — no double-counting
          gas_payments: gasCount,
          total_gas_cc: parseFloat(gasTotal.toFixed(4)),
          avg_gas_per_send: cbtcSends.length > 0 ? parseFloat((gasTotal / cbtcSends.length).toFixed(4)) : 0,
          is_pre_approved: agentPreApprovedIds.includes(partyId),
        };
      }));

      const preApproved = results.filter(r => r.is_pre_approved);
      const twoStep = results.filter(r => !r.is_pre_approved);
      const preGas = preApproved.reduce((s, r) => s + r.total_gas_cc, 0);
      const preCbtc = preApproved.reduce((s, r) => s + r.cbtc_transfers, 0);
      const tsGas = twoStep.reduce((s, r) => s + r.total_gas_cc, 0);
      const tsCbtc = twoStep.reduce((s, r) => s + r.cbtc_transfers, 0);
      const totals = {
        total_cbtc_transfers: results.reduce((s, r) => s + r.cbtc_transfers, 0),
        total_gas_cc: parseFloat(results.reduce((s, r) => s + r.total_gas_cc, 0).toFixed(4)),
        avg_gas_per_cbtc: 0 as number,
        pre_approved_cbtc: preCbtc,
        pre_approved_gas_cc: parseFloat(preGas.toFixed(4)),
        pre_approved_avg_gas: preCbtc > 0 ? parseFloat((preGas / preCbtc).toFixed(4)) : 0,
        two_step_cbtc: tsCbtc,
        two_step_gas_cc: parseFloat(tsGas.toFixed(4)),
        two_step_avg_gas: tsCbtc > 0 ? parseFloat((tsGas / tsCbtc).toFixed(4)) : 0,
      };
      totals.avg_gas_per_cbtc = totals.total_cbtc_transfers > 0
        ? parseFloat((totals.total_gas_cc / totals.total_cbtc_transfers).toFixed(4)) : 0;

      res.json({ wallets: results, totals, source: "zoro" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "Zoro API error: " + msg });
    }
  });

  // GET /admin/circuit-breaker/status — check circuit breaker state
  // GET /admin/db-dump — full database export for Postgres migration
  app.get("/admin/db-dump", requireAdmin, (_req, res) => {
    res.json({
      users: db.users,
      rounds: db.rounds,
      predictions: db.predictions,
      balances: db.balances,
      deposits: db.deposits,
      withdrawals: db.withdrawals,
      wallet_deposit_states: db.wallet_deposit_states,
      invite_codes: db.invite_codes,
      canton_transactions: db.canton_transactions,
      circuit_breaker: db.circuit_breaker,
    });
  });

  app.get("/admin/circuit-breaker/status", requireAdmin, (_req, res) => {
    res.json({
      ...db.circuit_breaker,
      config: {
        min_margin: parseFloat(process.env.CB_MIN_MARGIN || "0.5"),
        lookback: parseInt(process.env.CB_LOOKBACK || "10", 10),
        auto_recover: process.env.CB_AUTO_RECOVER !== "false",
      },
      agents_running: agentProc !== null && !agentProc.killed,
    });
  });

  // POST /admin/circuit-breaker/reset — manually reset circuit breaker
  app.post("/admin/circuit-breaker/reset", requireAdmin, async (_req, res) => {
    try {
      await resetCircuitBreaker(db);
      res.json({ reset: true, circuit_breaker: db.circuit_breaker });
    } catch (error) {
      console.error("Error resetting circuit breaker:", error);
      res.status(500).json({ error: "Failed to reset circuit breaker" });
    }
  });

  // POST /admin/circuit-breaker/trip — manually trip circuit breaker (for testing)
  app.post("/admin/circuit-breaker/trip", requireAdmin, async (_req, res) => {
    try {
      await tripCircuitBreaker(db, 0, 0, "Manual trip via admin endpoint");
      res.json({ tripped: true, circuit_breaker: db.circuit_breaker });
    } catch (error) {
      console.error("Error tripping circuit breaker:", error);
      res.status(500).json({ error: "Failed to trip circuit breaker" });
    }
  });

  // GET /admin/activity-summary — high-level platform stats
  app.get("/admin/activity-summary", requireAdmin, (_req, res) => {
    const settledRounds = db.rounds.filter((r) => r.settled);
    const roundsWithBets = settledRounds.filter((r) => r.total_up_amount > 0 || r.total_down_amount > 0);
    const allPreds = db.predictions;
    const totalVolume = allPreds.reduce((sum, p) => sum + (p.amount || 0), 0);
    const uniqueUsers = new Set(allPreds.map((p) => p.uid));
    const agentPreds = allPreds.filter((p) => {
      const user = db.users.find((u) => u.uid === p.uid);
      return user?.tier === "institutional";
    });
    const retailPreds = allPreds.filter((p) => {
      const user = db.users.find((u) => u.uid === p.uid);
      return !user || user.tier !== "institutional";
    });

    res.json({
      total_rounds: db.rounds.length,
      settled_rounds: settledRounds.length,
      rounds_with_bets: roundsWithBets.length,
      total_predictions: allPreds.length,
      total_volume_cbtc: totalVolume,
      unique_users: uniqueUsers.size,
      agent_predictions: agentPreds.length,
      retail_predictions: retailPreds.length,
      total_deposits: db.deposits.length,
      total_withdrawals: db.withdrawals.length,
      total_users: db.users.length,
      fee_percentage: parseFloat(process.env.FEE_PERCENTAGE || "0"),
      circuit_breaker: db.circuit_breaker,
    });
  });

  // GET /admin/agents/status — agent process health + per-agent stats
  app.get("/admin/agents/status", requireAdmin, (_req, res) => {
    const isRunning = agentProc !== null && !agentProc.killed;
    const agentUsers = db.users.filter((u) => u.tier === "institutional");
    const agentUids = new Set(agentUsers.map((u) => u.uid));

    // Fix: use market_round_id (not round_number) to match predictions
    const recentRounds = db.rounds.filter((r) => r.settled).slice(-20);
    const roundsWithAgentBets = recentRounds.filter((r) => {
      return db.predictions.some((p) => p.market_round_id === r.id && agentUids.has(p.uid));
    });

    // Per-agent breakdown — determine win/loss by matching prediction direction vs round winner
    const roundMap = new Map(db.rounds.map((r: any) => [r.id, r]));
    const agentPreds = db.predictions.filter((p: any) => agentUids.has(p.uid));
    const perAgent = agentUsers.map((u: any) => {
      const preds = agentPreds.filter((p: any) => p.uid === u.uid);
      let wins = 0, losses = 0, refunds = 0;
      let totalPayout = 0;
      let totalLost = 0;
      for (const p of preds) {
        if (!p.settled) continue;
        const round = roundMap.get(p.market_round_id) as any;
        if (!round || !round.winning_direction) { refunds++; continue; }
        if (p.direction === round.winning_direction) {
          wins++;
          // Estimate actual payout: bet + (bet/winnerPool)*loserPool
          // Use round data to calculate
          const roundPreds = db.predictions.filter((rp: any) => rp.market_round_id === round.id && rp.settled);
          const winnerPool = roundPreds.filter((rp: any) => rp.direction === round.winning_direction).reduce((s: number, rp: any) => s + (rp.amount || 0), 0);
          const loserPool = roundPreds.filter((rp: any) => rp.direction !== round.winning_direction).reduce((s: number, rp: any) => s + (rp.amount || 0), 0);
          const payout = winnerPool > 0 && loserPool > 0
            ? (p.amount || 0) + ((p.amount || 0) / winnerPool) * loserPool
            : (p.amount || 0); // refund if no losers
          totalPayout += payout;
        } else {
          losses++;
          totalLost += p.amount || 0;
        }
      }
      const totalVolume = preds.reduce((s: number, p: any) => s + (p.amount || 0), 0);
      const recentPreds = preds.filter((p: any) => recentRounds.some((r: any) => r.id === p.market_round_id));
      const settled = wins + losses;
      const netPnl = totalPayout - totalLost - totalVolume; // payout - losses - original bets (for wins, already included in payout)
      // Simpler: P&L = totalPayout - totalVolume (payout includes original bet back for winners)
      const pnl = totalPayout - totalVolume;
      return {
        uid: u.uid,
        name: (u.email || "").replace("@predictnow.cc", ""),
        total_bets: preds.length,
        wins,
        losses,
        refunds,
        win_rate: settled > 0 ? Math.round((wins / settled) * 100) : 0,
        total_volume: parseFloat(totalVolume.toFixed(8)),
        total_payout: parseFloat(totalPayout.toFixed(8)),
        total_lost: parseFloat(totalLost.toFixed(8)),
        pnl_pct: totalVolume > 0 ? parseFloat(((pnl / totalVolume) * 100).toFixed(1)) : 0,
        recent_bets: recentPreds.length,
      };
    });

    // Recent rounds with bet detail
    const recentWithBets = recentRounds.slice(-10).reverse().map((r) => {
      const preds = db.predictions.filter((p) => p.market_round_id === r.id);
      const agentBets = preds.filter((p) => agentUids.has(p.uid));
      return {
        round: r.round_number,
        winning_direction: r.winning_direction || null,
        total_bets: preds.length,
        agent_bets: agentBets.length,
        agents: agentBets.map((p: any) => ({
          name: (agentUsers.find((u: any) => u.uid === p.uid)?.email || "").replace("@predictnow.cc", ""),
          direction: p.direction,
          amount: p.amount,
          won: p.settled && r.winning_direction ? p.direction === r.winning_direction : null,
        })),
      };
    });

    res.json({
      process_running: isRunning,
      process_pid: agentProc?.pid || null,
      agent_enabled: process.env.AGENT_ENABLED === "true",
      agents: perAgent,
      recent_rounds: recentWithBets,
      coverage: {
        last_20_rounds: recentRounds.length,
        rounds_with_agent_bets: roundsWithAgentBets.length,
        coverage_pct: recentRounds.length > 0
          ? Math.round((roundsWithAgentBets.length / recentRounds.length) * 100)
          : 0,
      },
      totals: {
        total_agent_bets: agentPreds.length,
        total_retail_bets: db.predictions.length - agentPreds.length,
      },
      circuit_breaker: db.circuit_breaker,
    });
  });

  // GET /admin/rewards — CBTC reward data from Activity Tracker API
  app.get("/admin/rewards", requireAdmin, async (req, res) => {
    const YAC_BASE = "https://cbtc-data-api.bitsafe.finance";
    const TIMEOUT_MS = 120_000;

    // Collect all pool wallet party IDs
    const poolIds = Object.values(config.poolWallets || {})
      .filter(Boolean)
      .map((p: any) => p.partyId);

    // Default date range: last 30 days
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const qStart = (req.query.start as string) || startDate;
    const qEnd = (req.query.end as string) || endDate;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const yacPost = async (path: string, body: any) => {
        const r = await fetch(`${YAC_BASE}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`YAC ${path}: ${r.status}`);
        const data = await r.json() as any;
        if (!data.success) throw new Error(`YAC ${path}: ${data.error}`);
        return data.data;
      };

      // Parallel queries
      const [rewardAgg, dailyRewards, txnCount] = await Promise.all([
        yacPost("/api/v1/analytics/transfer-reward-aggregation", {
          parties: poolIds, start_date: qStart, end_date: qEnd,
        }).catch(() => null),
        yacPost("/api/v1/analytics/daily-rewards", {
          parties: poolIds, start_date: qStart, end_date: qEnd,
        }).catch(() => null),
        yacPost("/api/v1/events/transfer-offers/count", {
          sender: poolIds, instrument_id: "CBTC",
        }).catch(() => null),
      ]);

      clearTimeout(timer);

      // Calculate gas spent per pool wallet from Zoro CC balance delta
      let totalGasSpent = 0;
      const poolDetails = [];
      for (const [id, pool] of Object.entries(config.poolWallets || {})) {
        if (!pool) continue;
        try {
          // Get Zoro balance
          const balRes = await fetch(`${config.baseUrl}/canton/wallet/balance`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify({ partyId: (pool as any).partyId }),
            signal: controller.signal,
          });
          const balData = await balRes.json() as any;
          const ccBalance = parseFloat(balData?.balances?.Amulet || "0");
          const cbtcBalance = parseFloat(balData?.balances?.CBTC || "0");

          // Get CC transaction history to calculate total CC in/out
          const histRes = await fetch(`${config.baseUrl}/canton/transaction/history`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify({ partyId: (pool as any).partyId, limit: 500 }),
            signal: controller.signal,
          });
          const histData = await histRes.json() as any;
          const txns = Array.isArray(histData) ? histData : histData?.transactions || [];

          // Gas: match CC TransferOut co-occurring with CBTC events by timestamp
          // The fees field is always 0 — real gas appears as separate CC transfers
          const AVG_GAS = 2.49; // measured average per CBTC operation
          const byTs: Record<string, any[]> = {};
          let cbtcSends = 0;
          for (const t of txns) {
            if (!t || typeof t !== "object") continue;
            const ts = (t.recordTime || "").slice(0, 19);
            if (!byTs[ts]) byTs[ts] = [];
            byTs[ts].push(t);
            if (t.instrumentId?.id === "CBTC" && t.type === "TransferOut") cbtcSends++;
          }
          let measuredGas = 0, measuredCount = 0;
          for (const group of Object.values(byTs)) {
            const hasCbtc = group.some((t: any) => t.instrumentId?.id === "CBTC");
            if (!hasCbtc) continue;
            for (const t of group) {
              if (t.instrumentId?.id === "Amulet" && t.type === "TransferOut") {
                const amt = parseFloat(t.amount || "0");
                if (amt > 0 && amt < 5) { measuredGas += amt; measuredCount++; } // match GAS_THRESHOLD in /admin/zoro-stats
              }
            }
          }
          const unmeasured = Math.max(0, cbtcSends - measuredCount);
          const gasSpent = +(measuredGas + unmeasured * AVG_GAS).toFixed(4);
          totalGasSpent += gasSpent;

          poolDetails.push({
            name: id,
            tier: id === "retail" ? "retail" : "institutional",
            id: (pool as any).partyId,
            cc_balance: ccBalance,
            cbtc_balance: cbtcBalance,
            cbtc_sends: cbtcSends,
            gas_spent: gasSpent,
            gas_measured: +measuredGas.toFixed(4),
            gas_estimated: +(unmeasured * AVG_GAS).toFixed(4),
            gas_formula: `${measuredCount} measured + ${unmeasured} × ${AVG_GAS} avg`,
          });
        } catch {
          poolDetails.push({ name: id, tier: id === "retail" ? "retail" : "institutional", id: (pool as any).partyId });
        }
      }

      // Gas from DB (precise, recorded per-transaction)
      const dbGas = db.canton_transactions.reduce((sum, t) => sum + (t.cc_gas_cost || 0), 0);
      const dbGasByPool: Record<string, number> = {};
      for (const t of db.canton_transactions) {
        dbGasByPool[t.pool_wallet_id] = (dbGasByPool[t.pool_wallet_id] || 0) + (t.cc_gas_cost || 0);
      }

      res.json({
        pool_wallets: poolIds.length,
        pool_wallets_detail: poolDetails,
        date_range: { start: qStart, end: qEnd },
        reward_summary: rewardAgg,
        daily_rewards: dailyRewards,
        total_cbtc_transfers: txnCount,
        total_gas_spent_cc: totalGasSpent,
        // DB-recorded gas (precise — available for new transactions only)
        db_gas_total_cc: +dbGas.toFixed(6),
        db_gas_by_pool: dbGasByPool,
        db_gas_txn_count: db.canton_transactions.length,
      });
    } catch (error: any) {
      console.error("Error in /admin/rewards:", error.message);
      res.status(502).json({ error: "Activity Tracker API unavailable", detail: error.message });
    }
  });

  // CC View proxy (browser can't call ccview.io directly due to CORS)
  app.get("/api/ccview/*", async (req, res) => {
    const ccviewPath = req.params[0]; // everything after /api/ccview/
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `https://ccview.io/api/${ccviewPath}${qs ? '?' + qs : ''}`;
    try {
      const resp = await fetch(url, {
        headers: { "x-api-key": process.env.CCVIEW_API_KEY || "mainnet_7c5f36dd52033c5c" },
      });
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: "CC View proxy error", details: String(err) });
    }
  });

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
    console.log(`  POST /api/withdraw                - Withdraw CBTC`);
    console.log(`  GET  /api/balance                 - Check balance`);
    console.log(`  GET  /api/bets                    - Bet history`);
    console.log(`  GET  /api/market/status            - Current round`);
    console.log(`  GET  /api/results/history          - Round history`);
    console.log(`  GET  /api/pool-info                - Pool wallet info`);
  });

  // Start market scheduler (1-minute rounds for fast iteration)
  const parsedRoundMinutes = parseInt(process.env.ROUND_MINUTES || "1", 10);
  const ROUND_MINUTES = isNaN(parsedRoundMinutes) || parsedRoundMinutes < 1 ? 1 : parsedRoundMinutes;
  startMarketScheduler(db, config, ROUND_MINUTES);

  console.log("\nMarket running");
  console.log(`  Oracle: Binance WebSocket BTC price (rounds every ${ROUND_MINUTES} min)`);
  console.log("  Settlement: internal ledger");
  console.log("  Deposits: per-wallet tx history verification");
  console.log("  Auth: Firebase ID tokens\n");

  // ── Auto-start trading agents (if AGENT_ENABLED=true and circuit breaker not tripped) ──
  if (process.env.AGENT_ENABLED === "true" && !db.circuit_breaker.tripped) {
    await startAgents(PORT);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
