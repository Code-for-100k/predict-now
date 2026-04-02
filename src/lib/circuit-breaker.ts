/**
 * Circuit breaker state management — extracted to avoid circular imports
 * between market.ts and settlement.ts.
 */

import type { Database } from "../db/init.js";
import { sendSlackAlert, formatCircuitBreakerAlert } from "./slack.js";
import { auditLog } from "./audit.js";

/** Trip the circuit breaker — pause agents + auto-payouts, notify Slack */
export async function tripCircuitBreaker(db: Database, avgReward: number, avgGas: number, reason: string) {
  const threshold = parseFloat(process.env.CB_MIN_MARGIN || "0.5");
  const netMargin = avgReward - avgGas;

  if (db.circuit_breaker.tripped) return; // already tripped

  db.circuit_breaker = {
    tripped: true,
    tripped_at: Date.now(),
    reason,
    avg_reward: avgReward,
    avg_gas: avgGas,
    net_margin: netMargin,
  };
  db.save();

  console.log(`[CircuitBreaker] TRIPPED — net margin ${netMargin.toFixed(4)} CC/txn (threshold: ${threshold})`);
  auditLog({
    event: "circuit_breaker_trip",
    timestamp: new Date().toISOString(),
    actor: "system",
    details: { reason, avgReward, avgGas, netMargin, threshold },
  });

  // Notify Slack
  const alert = formatCircuitBreakerAlert({ tripped: true, avgReward, avgGas, netMargin, threshold, reason });
  await sendSlackAlert(alert.text, alert.blocks);

  // Kill agents via global callback (set by market.ts at startup)
  if (_onTrip) _onTrip();
}

/** Reset the circuit breaker — notify Slack. Agent restart handled by caller. */
export async function resetCircuitBreaker(db: Database) {
  if (!db.circuit_breaker.tripped) return;

  const threshold = parseFloat(process.env.CB_MIN_MARGIN || "0.5");
  const prev = { ...db.circuit_breaker };

  db.circuit_breaker = { tripped: false, tripped_at: null, reason: "", avg_reward: 0, avg_gas: 0, net_margin: 0 };
  db.save();

  console.log("[CircuitBreaker] RESET — resuming operations");
  auditLog({
    event: "circuit_breaker_reset",
    timestamp: new Date().toISOString(),
    actor: "system",
    details: { previousReason: prev.reason, previousAvgGas: prev.avg_gas, previousAvgReward: prev.avg_reward },
  });

  // Notify Slack
  const alert = formatCircuitBreakerAlert({
    tripped: false,
    avgReward: prev.avg_reward,
    avgGas: prev.avg_gas,
    netMargin: prev.avg_reward - prev.avg_gas,
    threshold,
    reason: "Manual reset or margin recovered",
  });
  await sendSlackAlert(alert.text, alert.blocks);

  // Restart agents via global callback
  if (_onReset) _onReset();
}

// Callbacks set by market.ts to control agent process without circular import
let _onTrip: (() => void) | null = null;
let _onReset: (() => void) | null = null;

export function setCircuitBreakerCallbacks(onTrip: () => void, onReset: () => void) {
  _onTrip = onTrip;
  _onReset = onReset;
}
