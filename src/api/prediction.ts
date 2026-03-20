import express, { Router } from "express";
import type { Direction } from "../types/market.js";
import { getActiveRound, getOrCreateBalance, type Database } from "../db/init.js";
import { requireAuth } from "../middleware/auth.js";

const MAX_BET = 21_000_000; // 21M BTC cap
const MIN_BET = 0.00001;   // 1000 satoshis

/** Format BTC amount: show up to 8 decimals, trim trailing zeros */
function formatBTC(amount: number): string {
  return parseFloat(amount.toFixed(8)).toString();
}

// Canton party IDs contain "::" separator and are 20+ chars
function isValidPartyId(id: string): boolean {
  return id.includes("::") && id.length >= 20 && id.length <= 300;
}

// Simple in-memory rate limiter: max 5 predictions per party per round
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_PER_ROUND = 5;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
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
      const { amount, direction } = req.body;

      // Validate amount: must be number, finite, within bounds
      if (typeof amount !== "number" || !isFinite(amount) || amount < MIN_BET || amount > MAX_BET) {
        return res.status(400).json({ error: `Invalid amount (must be ${MIN_BET}-${MAX_BET} CBTC)` });
      }

      // Validate direction
      if (!direction || !["UP", "DOWN"].includes(direction)) {
        return res.status(400).json({ error: "Invalid direction (must be UP or DOWN)" });
      }

      // Check internal balance (keyed by uid)
      const bal = getOrCreateBalance(db, uid);
      if (bal.balance < amount) {
        return res.status(400).json({
          error: `Insufficient balance: have ${formatBTC(bal.balance)} CBTC, need ${formatBTC(amount)} CBTC. Deposit first.`,
        });
      }

      // Rate limit per uid
      if (!checkRateLimit(uid)) {
        return res.status(429).json({ error: `Rate limit exceeded (max ${RATE_LIMIT_PER_ROUND} predictions per round)` });
      }

      // Get active market round
      const activeRound = getActiveRound(db);
      if (!activeRound) {
        return res.status(400).json({
          error: "No active market round",
        });
      }

      if (activeRound.settled) {
        return res.status(400).json({
          error: "Market round already settled",
        });
      }

      // Deduct from internal balance
      bal.balance -= amount;

      // Create prediction — store uid alongside party_id
      const prediction = {
        id: db.predictions.length + 1,
        market_round_id: activeRound.id,
        uid,
        party_id,
        direction: direction as Direction,
        amount,
        settled: false,
        payout_txn_id: undefined,
      };

      db.predictions.push(prediction);

      // Update market round totals
      if (direction === "UP") {
        activeRound.total_up_amount += amount;
      } else {
        activeRound.total_down_amount += amount;
      }

      db.save();

      res.json({
        prediction_id: prediction.id,
        market_round: activeRound.round_number,
        direction,
        amount,
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
      });
    } catch (error) {
      console.error("Error in /api/market/status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /api/results/:roundNumber
   * Get results for a specific round — public
   */
  router.get("/results/:roundNumber", (req, res) => {
    try {
      const roundNumber = parseInt(req.params.roundNumber, 10);

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

  /**
   * GET /api/results/latest
   * Get the most recent settled round — public
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

  return router;
}
