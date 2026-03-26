/**
 * Contrarian strategy — with learning.
 *
 * Base logic: bet against the crowd when pools are lopsided.
 * Learning: tracks which lopsidedness thresholds actually win, adjusts over time.
 *
 * Config params:
 *   threshold     — how lopsided the pool must be to trigger (default 0.65 = 65%)
 *   baseFraction  — bet size as % of balance (default 0.02)
 *   minBet        — floor (default 0.01)
 *   maxBet        — ceiling (default 0.08)
 *   adaptRate     — how fast threshold adjusts (default 0.02)
 */

import type { Strategy, TradeContext } from "../agent.js";

/** Always-bet fallback: bet AGAINST the price trend (true contrarian) */
function fallback(ctx: TradeContext, reason: string) {
  const dir = ctx.price && ctx.price.change24h >= 0 ? "DOWN" as const : "UP" as const;
  const amount = Math.min(0.0000001, ctx.balance);
  if (amount <= 0) return null;
  return { direction: dir, amount, reason: `contrarian: ${reason}` };
}

export const contrarian: Strategy = (ctx) => {
  const {
    threshold = 0.65,
    baseFraction = 0.02,
    minBet = 0.0000001,
    maxBet = 0.08,
    adaptRate = 0.02,
  } = ctx.config;

  const upPool = ctx.round.total_up_amount ?? 0;
  const downPool = ctx.round.total_down_amount ?? 0;
  const totalPool = upPool + downPool;

  // Empty pool or no pool data — fallback to minimum bet
  if (totalPool === 0) return fallback(ctx, "empty pool");

  const upRatio = upPool / totalPool;

  // ── Adapt threshold based on outcomes ──
  // If our recent contrarian bets won, tighten threshold (bet more often)
  // If they lost, widen it (be more selective)
  const recentBets = ctx.myBets.slice(0, 10);
  if (recentBets.length >= 3) {
    const recentWR = recentBets.filter((b) => b.won).length / recentBets.length;
    if (recentWR >= 0.6) {
      // Winning — lower threshold to trigger more
      ctx.config.threshold = Math.max(0.55, threshold - adaptRate);
    } else if (recentWR <= 0.35) {
      // Losing — raise threshold to be pickier
      ctx.config.threshold = Math.min(0.70, threshold + adaptRate);
    }
  }

  // Check if pool is lopsided enough
  let direction: "UP" | "DOWN";
  let reason: string;

  if (upRatio > threshold) {
    direction = "DOWN"; // fade the bulls
    reason = `crowd is ${(upRatio * 100).toFixed(0)}% UP, fading (threshold: ${(threshold * 100).toFixed(0)}%)`;
  } else if (upRatio < 1 - threshold) {
    direction = "UP"; // fade the bears
    reason = `crowd is ${((1 - upRatio) * 100).toFixed(0)}% DOWN, fading (threshold: ${(threshold * 100).toFixed(0)}%)`;
  } else {
    // Pool not lopsided enough — bet minimum on price-favored side
    return fallback(ctx, `pool balanced (${(upRatio * 100).toFixed(0)}% UP)`);
  }

  // Always bet minimum
  let amount = minBet;
  amount = Math.round(amount * 1e8) / 1e8;

  if (amount > ctx.balance) return null;

  return { direction, amount, reason };
};
