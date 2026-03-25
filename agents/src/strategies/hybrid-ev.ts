/**
 * Hybrid EV strategy — expected-value driven with adaptive thresholds.
 *
 * Combines price-signal probability estimation with parimutuel pool math
 * to compute EV for each side, then uses Kelly-fraction bet sizing.
 *
 * Learning: tracks recent outcomes and self-adjusts the minimum EV
 * threshold — gets pickier on losing streaks, more aggressive when winning.
 *
 * Config params (tunable at runtime):
 *   sensitivity     — how strongly 24h change maps to probability (default 2.0)
 *   minEvThreshold  — minimum EV to place a bet (default 0.05 = 5% edge)
 *   minBet          — floor as fraction of balance (default 0.01)
 *   maxBet          — ceiling as fraction of balance (default 0.05)
 *   lookback        — how many recent bets to evaluate (default 10)
 *   emptyPoolBet    — fixed small bet when both pools are empty (default 0.01)
 */

import type { Strategy, TradeContext } from "../agent.js";

/** Always-bet fallback: minimum bet on price-favored side */
function fallback(ctx: TradeContext, reason: string) {
  const dir = ctx.price && ctx.price.change24h < 0 ? "DOWN" as const : "UP" as const;
  const amount = Math.min(0.0000001, ctx.balance);
  if (amount <= 0) return null;
  return { direction: dir, amount, reason: `fallback: ${reason}` };
}

export const hybridEv: Strategy = (ctx) => {
  const {
    sensitivity = 2.0,
    minEvThreshold = 0.05,
    minBet = 0.0000001,
    maxBet = 0.05,
    lookback = 10,
    emptyPoolBet = 0.0000001,
  } = ctx.config;

  // Need price data
  if (!ctx.price || ctx.price.price <= 0) return fallback(ctx, "no price data");

  // Need an active round with time
  if (!ctx.round.time_remaining_seconds || ctx.round.time_remaining_seconds < 5) {
    return fallback(ctx, "round ending");
  }

  // ── 1. Estimate P(UP) from price signals ──
  const change24hPct = ctx.price.change24h; // already a percentage
  let pUp = 0.5 + (change24hPct / 100) * sensitivity;
  pUp = Math.max(0.2, Math.min(0.8, pUp)); // clamp
  const pDown = 1 - pUp;

  // ── 2. Adaptive EV threshold based on recent win rate ──
  let evThreshold = minEvThreshold;
  const recentBets = ctx.myBets.slice(0, lookback);
  if (recentBets.length >= 5) {
    const recentWR = recentBets.filter((b) => b.won).length / recentBets.length;
    if (recentWR < 0.4) {
      // Losing — become pickier
      evThreshold = minEvThreshold * 1.5;
    } else if (recentWR > 0.6) {
      // Winning — be slightly more aggressive
      evThreshold = minEvThreshold * 0.75;
    }
  }

  // ── 3. Pool amounts ──
  const upPool = ctx.round.total_up_amount ?? 0;
  const downPool = ctx.round.total_down_amount ?? 0;
  const totalPool = upPool + downPool;

  // ── Empty pool: first-mover edge ──
  if (totalPool === 0) {
    const direction = pUp >= 0.5 ? "UP" as const : "DOWN" as const;
    const amount = Math.min(emptyPoolBet, ctx.balance);
    if (amount <= 0) return null;
    return {
      direction,
      amount: Math.round(amount * 1e8) / 1e8,
      reason: "first mover (empty pool)",
    };
  }

  // ── 4. Compute EV for each side ──
  // EV(UP) = P(UP) * (totalPool / upPool) - 1
  // EV(DOWN) = P(DOWN) * (totalPool / downPool) - 1
  const evUp = upPool > 0 ? pUp * (totalPool / upPool) - 1 : Infinity;
  const evDown = downPool > 0 ? pDown * (totalPool / downPool) - 1 : Infinity;

  // Pick the better side
  let direction: "UP" | "DOWN";
  let ev: number;
  let poolRatio: number;

  if (evUp >= evDown) {
    direction = "UP";
    ev = evUp;
    poolRatio = upPool > 0 ? totalPool / upPool : 1;
  } else {
    direction = "DOWN";
    ev = evDown;
    poolRatio = downPool > 0 ? totalPool / downPool : 1;
  }

  // If the better side still doesn't meet threshold, fallback to minimum bet
  if (!isFinite(ev) || ev < evThreshold) {
    return fallback(ctx, `EV too low (${(ev * 100).toFixed(1)}% < ${(evThreshold * 100).toFixed(1)}%)`);
  }

  // ── 5. Kelly-fraction bet sizing ──
  // Kelly: edge / odds, then half-Kelly for safety
  const odds = poolRatio - 1; // net odds (e.g. 2:1 pool ratio = 1:1 odds)
  // Always bet minimum
  let amount = minBet;
  amount = Math.round(amount * 1e8) / 1e8; // satoshi precision

  if (amount <= 0 || amount > ctx.balance) return null;

  const pct = (direction === "UP" ? pUp : pDown) * 100;
  return {
    direction,
    amount,
    reason: `EV=${(ev * 100).toFixed(1)}% P=${pct.toFixed(0)}% min-bet`,
  };
};
