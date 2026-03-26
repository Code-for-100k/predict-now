import express, { Router } from "express";
import type { Direction } from "../types/market.js";
import { getActiveRound, getOrCreateBalance, type Database } from "../db/init.js";
import { requireAuth } from "../middleware/auth.js";

const MAX_BET = 21_000_000; // 21M BTC cap
const MIN_BET = 0.0000001;   // 10 satoshis

// Parse FEE_PERCENTAGE from env — default 0% (no platform fee)
const rawFeeEnv = parseFloat(process.env.FEE_PERCENTAGE || "0");
const FEE_PERCENTAGE = Math.max(0, Math.min(100, isNaN(rawFeeEnv) ? 0 : rawFeeEnv));

/** Format BTC amount: show up to 8 decimals, trim trailing zeros */
function formatBTC(amount: number): string {
  return parseFloat(amount.toFixed(8)).toString();
}

// Canton party IDs contain "::" separator and are 20+ chars
function isValidPartyId(id: string): boolean {
  return id.includes("::") && id.length >= 20 && id.length <= 300;
}

// Simple in-memory rate limiter: max 5 predictions per party per round
const rateLimitMap = new Map<string, { count: number; round: number; resetAt: number }>();
const RATE_LIMIT_PER_ROUND = 5;

function checkRateLimit(key: string, roundNumber: number): boolean {
  const entry = rateLimitMap.get(key);
  // Reset counter when a new round starts (not on a fixed timer)
  if (!entry || entry.round !== roundNumber) {
    rateLimitMap.set(key, { count: 1, round: roundNumber, resetAt: 0 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_PER_ROUND) return false;
  entry.count++;
  return true;
}

export function createPredictionRouter(db: Database): Router {
  const router = express.Router();

  /**
   * POST /api/predict
   * Register a prediction for the current market round.
   *
   * requireAuth: uses req.uid to look up linked party_id.
   * Bet amount is deducted from internal balance immediately.
   */
  router.post("/predict", requireAuth, (req, res) => {
    try {
      const uid = req.uid!;
      const user = db.users.find((u) => u.uid === uid);

      if (!user || !user.party_ids?.length || !user.active_party_id) {
        return res.status(400).json({
          error: "No Canton wallet linked to your account. Use /api/auth/link-party first.",
        });
      }

      const party_id = user.active_party_id;
      const { direction } = req.body;
      // Coerce string amounts to number (fixes string amount bug from frontend)
      const rawAmount = req.body.amount;
      const amount = typeof rawAmount === "string" ? parseFloat(rawAmount) : rawAmount;

      // Validate amount: must be number, finite, within bounds
      if (typeof amount !== "number" || !isFinite(amount) || isNaN(amount) || amount < MIN_BET || amount > MAX_BET) {
        return res.status(400).json({ error: `Invalid amount (must be ${MIN_BET}-${MAX_BET} CBTC)` });
      }

      // Round to satoshi precision to avoid floating point issues
      const roundedAmount = Math.round(amount * 1e8) / 1e8;

      // Validate direction
      if (!direction || !["UP", "DOWN"].includes(direction)) {
        return res.status(400).json({ error: "Invalid direction (must be UP or DOWN)" });
      }

      // Check internal balance (keyed by uid)
      const bal = getOrCreateBalance(db, uid);
      if (bal.balance < roundedAmount) {
        return res.status(400).json({
          error: `Insufficient balance: have ${formatBTC(bal.balance)} CBTC, need ${formatBTC(roundedAmount)} CBTC. Deposit first.`,
        });
      }

      // Get active market round
      const activeRound = getActiveRound(db);
      if (!activeRound) {
        return res.status(400).json({
          error: "No active market round",
        });
      }

      // Rate limit per uid per round
      if (!checkRateLimit(uid, activeRound.round_number)) {
        return res.status(429).json({ error: `Rate limit exceeded (max ${RATE_LIMIT_PER_ROUND} predictions per round)` });
      }

      if (activeRound.settled) {
        return res.status(400).json({
          error: "Market round already settled",
        });
      }

      // Check round hasn't expired (race between client time and server time)
      if (activeRound.window_end_time <= Date.now()) {
        return res.status(400).json({
          error: "Market round has expired — settlement pending",
        });
      }

      // Deduct from internal balance
      bal.balance -= roundedAmount;

      // Create prediction — store uid alongside party_id
      const prediction = {
        id: db.predictions.length + 1,
        market_round_id: activeRound.id,
        uid,
        party_id,
        direction: direction as Direction,
        amount: roundedAmount,
        settled: false,
        payout_txn_id: undefined,
      };

      db.predictions.push(prediction);

      // Update market round totals
      if (direction === "UP") {
        activeRound.total_up_amount += roundedAmount;
      } else {
        activeRound.total_down_amount += roundedAmount;
      }

      db.save();

      // Copy trading: if this bet is from an agent, auto-place bets for users copying them
      const betterUser = db.users.find((u) => u.uid === uid);
      if (betterUser?.tier === "institutional") {
        const copiers = db.users.filter(
          (u) => u.copying_agent_uid === uid && (u.copy_rounds_remaining || 0) > 0
        );
        for (const copier of copiers) {
          try {
            const copyBal = getOrCreateBalance(db, copier.uid);
            const copyAmount = Math.min(copier.copy_amount || 0.0000001, copyBal.balance);
            if (copyAmount < 0.0000001) continue; // insufficient balance

            const copyPred = {
              id: db.predictions.length + 1,
              market_round_id: activeRound.id,
              uid: copier.uid,
              party_id: copier.active_party_id || "",
              direction: direction as Direction,
              amount: copyAmount,
              settled: false,
              payout_txn_id: undefined,
            };
            copyBal.balance -= copyAmount;
            db.predictions.push(copyPred);
            if (direction === "UP") activeRound.total_up_amount += copyAmount;
            else activeRound.total_down_amount += copyAmount;

            copier.copy_rounds_remaining = (copier.copy_rounds_remaining || 1) - 1;
            if (copier.copy_rounds_remaining <= 0) {
              copier.copying_agent_uid = null;
            }
            console.log(`  [CopyTrade] ${copier.email} copied ${betterUser.email} → ${direction} ${copyAmount} CBTC (${copier.copy_rounds_remaining} rounds left)`);
          } catch (err) {
            console.error(`  [CopyTrade] Error for ${copier.uid}:`, err);
          }
        }
        db.save();
      }

      res.json({
        prediction_id: prediction.id,
        market_round: activeRound.round_number,
        direction,
        amount: roundedAmount,
        party_id,
        remaining_balance: bal.balance,
        message: "Prediction registered successfully",
      });
    } catch (error) {
      console.error("Error in /api/predict:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /api/market/status
   * Get current market round status — public
   */
  router.get("/market/status", (req, res) => {
    try {
      const activeRound = getActiveRound(db);

      if (!activeRound) {
        const lastRound = db.rounds[db.rounds.length - 1];

        return res.json({
          status: "no_active_round",
          next_round: (lastRound?.round_number ?? 0) + 1,
          next_start_time: lastRound
            ? lastRound.window_end_time
            : Date.now(),
        });
      }

      const predictions = db.predictions.filter(
        (p) => p.market_round_id === activeRound.id
      );

      const up_count = predictions.filter((p) => p.direction === "UP").length;
      const down_count = predictions.filter(
        (p) => p.direction === "DOWN"
      ).length;
      const up_amount = predictions
        .filter((p) => p.direction === "UP")
        .reduce((sum, p) => sum + p.amount, 0);
      const down_amount = predictions
        .filter((p) => p.direction === "DOWN")
        .reduce((sum, p) => sum + p.amount, 0);

      res.json({
        status: "active",
        round_number: activeRound.round_number,
        open_price: activeRound.open_price ?? null,
        window_start_ms: activeRound.window_start_time,
        window_end_ms: activeRound.window_end_time,
        time_remaining_ms: activeRound.window_end_time - Date.now(),
        up_predictions: up_count,
        down_predictions: down_count,
        up_amount,
        down_amount,
        fee_percentage: FEE_PERCENTAGE,
      });
    } catch (error) {
      console.error("Error in /api/market/status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /api/results/history
   * Get recent settled rounds — public
   * Query: ?limit=20 (default 20, max 100)
   */
  router.get("/results/history", (req, res) => {
    try {
      const rawLimit = parseInt(req.query.limit as string, 10);
      if (req.query.limit !== undefined && (isNaN(rawLimit) || rawLimit < 1)) {
        return res.status(400).json({ error: "Invalid limit (must be a positive integer)" });
      }
      const limit = Math.min(100, rawLimit || 20);
      const totalSettled = db.rounds.filter((r) => r.settled).length;
      const settledRounds = db.rounds
        .filter((r) => r.settled)
        .sort((a, b) => b.round_number - a.round_number)
        .slice(0, limit);

      res.json({
        rounds: settledRounds.map((r) => ({
          round_number: r.round_number,
          open_price: r.open_price,
          close_price: r.close_price,
          winning_direction: r.winning_direction,
          total_up_amount: r.total_up_amount,
          total_down_amount: r.total_down_amount,
          fee_collected: r.your_fee_collected,
        })),
        total: totalSettled,
        capped: settledRounds.length < totalSettled,
      });
    } catch (error) {
      console.error("Error in /api/results/history:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /api/results/latest
   * Get the most recent settled round — public
   * IMPORTANT: This must be registered BEFORE /results/:roundNumber
   */
  router.get("/results/latest", (req, res) => {
    try {
      const settledRounds = db.rounds
        .filter((r) => r.settled)
        .sort((a, b) => b.round_number - a.round_number);

      if (settledRounds.length === 0) {
        return res.status(404).json({
          error: "No settled rounds yet",
        });
      }

      const round = settledRounds[0];
      const predictions = db.predictions.filter(
        (p) => p.market_round_id === round.id
      );

      res.json({
        round_number: round.round_number,
        open_price: round.open_price,
        close_price: round.close_price,
        winning_direction: round.winning_direction,
        total_up_amount: round.total_up_amount,
        total_down_amount: round.total_down_amount,
        fee_collected: round.your_fee_collected,
        predictions: predictions.map((p) => ({
          party_id: p.party_id,
          direction: p.direction,
          amount: p.amount,
          won: p.direction === round.winning_direction,
          payout_txn_id: p.payout_txn_id,
        })),
      });
    } catch (error) {
      console.error("Error in /api/results/latest:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /api/results/:roundNumber
   * Get results for a specific round — public
   * IMPORTANT: Must be AFTER /results/latest and /results/history to avoid catching those paths
   */
  router.get("/results/:roundNumber", (req, res) => {
    try {
      const roundNumber = parseInt(req.params.roundNumber, 10);
      if (isNaN(roundNumber) || roundNumber < 1) {
        return res.status(400).json({ error: "Invalid round number" });
      }

      const round = db.rounds.find(
        (r) => r.round_number === roundNumber && r.settled
      );

      if (!round) {
        return res.status(404).json({
          error: "Round not found or not settled",
        });
      }

      const predictions = db.predictions.filter(
        (p) => p.market_round_id === round.id
      );

      res.json({
        round_number: round.round_number,
        open_price: round.open_price,
        close_price: round.close_price,
        winning_direction: round.winning_direction,
        total_up_amount: round.total_up_amount,
        total_down_amount: round.total_down_amount,
        fee_collected: round.your_fee_collected,
        predictions: predictions.map((p) => ({
          party_id: p.party_id,
          direction: p.direction,
          amount: p.amount,
          won: p.direction === round.winning_direction,
          payout_txn_id: p.payout_txn_id,
        })),
      });
    } catch (error) {
      console.error("Error in /api/results:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
