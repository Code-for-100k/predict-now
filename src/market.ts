import "dotenv/config";
import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { initDatabase, getOrCreateBalance } from "./db/init.js";
import { createPredictionRouter } from "./api/prediction.js";
import { createAccountRouter } from "./api/account.js";
import { createAuthRouter } from "./api/auth.js";
import { startMarketScheduler } from "./scheduler/cron.js";
import { loadConfig, getFirebaseWebConfig } from "./lib/config.js";
import { initFirebase } from "./lib/firebase.js";
import * as api from "./lib/api.js";
import { startBinancePriceService, getCachedPrice } from "./oracle/binance-ws.js";

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

  // Start Binance WebSocket price service (replaces CoinGecko)
  await startBinancePriceService();

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
  app.use(express.json());

  // CORS — use CORS_ORIGIN env var; omit header entirely if not set (same-origin only)
  const corsOrigin = process.env.CORS_ORIGIN || "";
  if (!corsOrigin) {
    console.warn("WARNING: CORS_ORIGIN env var not set — only same-origin requests allowed. Set CORS_ORIGIN to allow cross-origin access.");
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

  // API routes
  app.use("/api/auth", createAuthRouter(db, config));
  app.use("/api", createAccountRouter(db, config));
  app.use("/api", createPredictionRouter(db));

  // ── Admin endpoints (protected by ADMIN_SECRET) ──
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET) {
    console.warn("WARNING: ADMIN_SECRET env var not set — admin endpoints will be disabled.");
  }

  // SEC-03 fix: rate limit failed admin auth attempts (max 10 per minute per IP)
  const adminFailMap = new Map<string, { count: number; resetAt: number }>();

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
          const rawFee = parseFloat(process.env.FEE_PERCENTAGE || "10");
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

          let ccIn = 0, ccOut = 0;
          for (const t of txns) {
            if (!t || typeof t !== "object") continue;
            const instId = t.instrumentId?.id || "";
            const amount = parseFloat(t.amount || "0");
            if (instId === "Amulet") {
              if (t.type === "TransferIn") ccIn += amount;
              else if (t.type === "TransferOut") ccOut += amount;
            }
          }
          const expectedBalance = ccIn - ccOut;
          const gasSpent = Math.max(0, expectedBalance - ccBalance);
          totalGasSpent += gasSpent;

          poolDetails.push({
            name: id,
            tier: id === "retail" ? "retail" : "institutional",
            id: (pool as any).partyId,
            cc_balance: ccBalance,
            cbtc_balance: cbtcBalance,
            cc_received: ccIn,
            cc_sent: ccOut,
            gas_spent: gasSpent,
          });
        } catch {
          poolDetails.push({ name: id, tier: id === "retail" ? "retail" : "institutional", id: (pool as any).partyId });
        }
      }

      res.json({
        pool_wallets: poolIds.length,
        pool_wallets_detail: poolDetails,
        date_range: { start: qStart, end: qEnd },
        reward_summary: rewardAgg,
        daily_rewards: dailyRewards,
        total_cbtc_transfers: txnCount,
        total_gas_spent_cc: totalGasSpent,
      });
    } catch (error: any) {
      console.error("Error in /admin/rewards:", error.message);
      res.status(502).json({ error: "Activity Tracker API unavailable", detail: error.message });
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
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
