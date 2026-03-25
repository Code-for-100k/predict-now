/**
 * Momentum strategy — with learning.
 *
 * Base logic: follow short-term price direction.
 * Learning: adjusts bet size based on recent win rate and streak.
 *
 * Config params (tunable at runtime):
 *   baseFraction  — default bet as % of balance (default 0.03 = 3%)
 *   minBet        — floor (default 0.01)
 *   maxBet        — ceiling (default 0.1)
 *   streakCutoff  — pause after this many consecutive losses (default 5)
 *   lookback      — how many of my own bets to evaluate (default 10)
 */

import type { Strategy, TradeContext } from "../agent.js";

export const momentum: Strategy = (ctx) => {
  const {
    baseFraction = 0.03,
    minBet = 0.0000001,
    maxBet = 0.1,
    streakCutoff = 5,
    lookback = 10,
  } = ctx.config;

  // Need price data
  if (!ctx.price || ctx.price.price <= 0) return fallback(ctx, "no price data");

  // Bet even if round is ending — always participate
  if (!ctx.round.time_remaining_seconds || ctx.round.time_remaining_seconds < 5) {
    return fallback(ctx, "round ending");
  }

  // ── Direction: follow recent price movement ──
  // Use 24h change as a proxy for momentum (we don't have candle data from the API)
  const direction = ctx.price.change24h >= 0 ? "UP" : "DOWN" as const;

  // If last N rounds show a strong opposite trend, flip
  const recentRounds = ctx.history.slice(0, 5);
  if (recentRounds.length >= 3) {
    const recentDirs = recentRounds.map((r) => r.winning_direction);
    const upCount = recentDirs.filter((d) => d === "UP").length;
    const downCount = recentDirs.filter((d) => d === "DOWN").length;

    // Strong recent trend overrides 24h momentum
    if (upCount >= 4) return makeBet("UP", ctx, baseFraction, minBet, maxBet);
    if (downCount >= 4) return makeBet("DOWN", ctx, baseFraction, minBet, maxBet);
  }

  return makeBet(direction, ctx, baseFraction, minBet, maxBet);
};

/** Always-bet fallback: minimum bet on price-favored side (or UP if no signal) */
function fallback(ctx: TradeContext, reason: string) {
  const dir = ctx.price && ctx.price.change24h < 0 ? "DOWN" as const : "UP" as const;
  const amount = Math.min(0.0000001, ctx.balance);
  if (amount <= 0) return null;
  return { direction: dir, amount, reason: `fallback: ${reason}` };
}

function makeBet(
  direction: "UP" | "DOWN",
  ctx: TradeContext,
  baseFraction: number,
  minBet: number,
  maxBet: number,
) {
  // ── Adaptive bet sizing ──
  let fraction = baseFraction;
  let reason = "";

  // Scale up on winning streaks, down on losing
  if (ctx.stats.currentStreak >= 3) {
    fraction *= 1.5;
    reason = `hot streak (+${ctx.stats.currentStreak})`;
  } else if (ctx.stats.currentStreak <= -2) {
    fraction *= 0.5;
    reason = `cooling off (${ctx.stats.currentStreak})`;
  }

  // If recent win rate is strong, increase confidence
  const recentBets = ctx.myBets.slice(0, 10);
  if (recentBets.length >= 5) {
    const recentWR = recentBets.filter((b) => b.won).length / recentBets.length;
    if (recentWR >= 0.7) {
      fraction *= 1.3;
      reason = `high WR (${(recentWR * 100).toFixed(0)}%)`;
    } else if (recentWR <= 0.3) {
      fraction *= 0.5;
      reason = `low WR (${(recentWR * 100).toFixed(0)}%)`;
    }
  }

  // Always bet minimum
  let amount = minBet;
  amount = Math.round(amount * 1e8) / 1e8; // satoshi precision

  if (amount > ctx.balance) return null;

  return { direction, amount, reason };
}
