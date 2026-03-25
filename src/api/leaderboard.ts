/**
 * Leaderboard API — DB-driven, no dependency on embedded AI engine.
 *
 * Any party_id that starts with "ai-trader::" or "agent::" is treated as
 * a bot and shown on the leaderboard. Stats are computed from settled
 * predictions in the DB.
 */

import express, { Router } from "express";
import type { Database } from "../db/init.js";
import { getOrCreateBalance, getBalanceByPartyId } from "../db/init.js";

const AI_INITIAL_BALANCE = parseFloat(process.env.AI_INITIAL_BALANCE ?? "1.0");
const BOT_PREFIXES = ["ai-trader::", "agent::"];

function isBot(partyId: string | undefined, isMarkedBot?: boolean): boolean {
  if (isMarkedBot) return true;
  if (!partyId) return false;
  return BOT_PREFIXES.some((p) => partyId.startsWith(p));
}

function displayName(partyId: string): string {
  // "ai-trader::steady-eddie" → "Steady Eddie"
  // "agent::momentum-v2" → "Momentum V2"
  const raw = partyId.split("::")[1] ?? partyId;
  return raw
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface TraderStats {
  partyId: string;
  name: string;
  displayName: string;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  totalProfit: number;
  roi: number;
  currentStreak: number;
  balance: number;
  active: boolean;
}

function computeTraderStats(db: Database, partyId: string): TraderStats {
  // Build round lookup
  const roundMap = new Map<number, (typeof db.rounds)[number]>();
  for (const r of db.rounds) {
    if (r.settled) roundMap.set(r.id, r);
  }

  // Get all predictions for this party
  const preds = db.predictions.filter((p) => p.party_id === partyId);
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let streak = 0;

  // Sort by round to compute streak correctly
  const settledPreds = preds
    .map((p) => {
      const round = roundMap.get(p.market_round_id);
      if (!round || !round.winning_direction) return null;
      const won = p.direction === round.winning_direction;

      // PnL: winner gets proportional share of combined pool minus fees
      let pnl = -p.amount;
      if (won) {
        const winPool = p.direction === "UP" ? round.total_up_amount : round.total_down_amount;
        const losePool = p.direction === "UP" ? round.total_down_amount : round.total_up_amount;
        const share = winPool > 0 ? p.amount / winPool : 0;
        pnl = (losePool - round.your_fee_collected) * share;
      }

      return { roundNumber: round.round_number, won, pnl, amount: p.amount };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.roundNumber - b.roundNumber);

  for (const pred of settledPreds) {
    if (pred.won) {
      wins++;
      streak = streak >= 0 ? streak + 1 : 1;
    } else {
      losses++;
      streak = streak <= 0 ? streak - 1 : -1;
    }
    totalPnl += pred.pnl;
  }

  const totalTrades = preds.length;
  const decided = wins + losses;
  const bal = getBalanceByPartyId(db, partyId);

  return {
    partyId,
    name: partyId.split("::")[1] ?? partyId,
    displayName: displayName(partyId),
    totalTrades,
    totalWins: wins,
    totalLosses: losses,
    winRate: decided > 0 ? Math.round((wins / decided) * 100) / 100 : 0,
    totalProfit: Math.round(totalPnl * 1e8) / 1e8,
    roi: Math.round((totalPnl / AI_INITIAL_BALANCE) * 10000) / 100,
    currentStreak: streak,
    balance: bal.balance,
    active: true,
  };
}

export function createLeaderboardRouter(db: Database): Router {
  const router = express.Router();

  /**
   * GET /api/leaderboard
   * All bot traders from the DB, sorted by profit.
   */
  router.get("/leaderboard", (_req, res) => {
    try {
      // Find all unique bot party IDs from predictions (excluding bots — hidden from leaderboard)
      // Bots are identified by is_bot flag (new) or legacy agent::/ai-trader:: prefix
      const botPartyIds = new Set<string>();
      for (const p of db.predictions) {
        if (isBot(p.party_id, (p as any).is_bot)) botPartyIds.add(p.party_id);
      }
      // Also check users with bot party_ids
      for (const u of db.users) {
        if (u.active_party_id && isBot(u.active_party_id)) {
          botPartyIds.add(u.active_party_id);
        }
      }

      // Return empty — bots are hidden from the public leaderboard
      const traders: TraderStats[] = [];

      // Market stats
      const settledRounds = db.rounds.filter((r) => r.settled);
      const totalPredictions = db.predictions.length;
      const totalVolume = db.predictions.reduce((sum, p) => sum + p.amount, 0);
      let uptimeHours = 0;
      if (db.rounds.length > 0) {
        const earliest = Math.min(...db.rounds.map((r) => r.window_start_time));
        uptimeHours = Math.round(((Date.now() - earliest) / 3_600_000) * 10) / 10;
      }

      res.json({
        traders,
        marketStats: {
          totalRounds: settledRounds.length,
          totalPredictions,
          totalVolume: Math.round(totalVolume * 100) / 100,
          uptimeHours,
        },
      });
    } catch (error) {
      console.error("Error in GET /api/leaderboard:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /api/trader/:name
   * Single trader detail. Name is the part after "::" (e.g. "steady-eddie").
   * Tries both "ai-trader::" and "agent::" prefixes.
   */
  router.get("/trader/:name", (req, res) => {
    try {
      const name = req.params.name;
      let partyId: string | null = null;

      // Find the party ID by name
      for (const prefix of BOT_PREFIXES) {
        const candidate = `${prefix}${name}`;
        const hasPreds = db.predictions.some((p) => p.party_id === candidate);
        const hasUser = db.users?.some((u) => u.active_party_id === candidate || u.party_ids?.includes(candidate));
        if (hasPreds || hasUser) {
          partyId = candidate;
          break;
        }
      }

      if (!partyId) {
        return res.status(404).json({ error: "Trader not found" });
      }

      const stats = computeTraderStats(db, partyId);

      // Recent trades
      const roundMap = new Map<number, (typeof db.rounds)[number]>();
      for (const r of db.rounds) {
        if (r.settled) roundMap.set(r.id, r);
      }

      const recentTrades = db.predictions
        .filter((p) => p.party_id === partyId)
        .map((p) => {
          const round = roundMap.get(p.market_round_id);
          if (!round) return null;
          const won = p.direction === round.winning_direction;
          const winPool = p.direction === "UP" ? round.total_up_amount : round.total_down_amount;
          const losePool = p.direction === "UP" ? round.total_down_amount : round.total_up_amount;
          const share = winPool > 0 ? p.amount / winPool : 0;
          const payout = won ? p.amount + (losePool - round.your_fee_collected) * share : 0;

          return {
            roundNumber: round.round_number,
            direction: p.direction,
            amount: p.amount,
            won,
            payout: Math.round(payout * 1e8) / 1e8,
            timestamp: round.window_start_time,
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .sort((a, b) => b.roundNumber - a.roundNumber)
        .slice(0, 20);

      res.json({ ...stats, recentTrades });
    } catch (error) {
      console.error("Error in GET /api/trader/:name:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
