import type { Config } from "../lib/types.js";
import {
  determineDirection,
  getCurrentWindowPrices,
} from "../oracle/coingecko-oracle.js";
import { settleMarketRound } from "../settlement/settlement.js";
import {
  getCurrentRound,
  getActiveRound,
  getSettledRound,
  type Database,
} from "../db/init.js";

/**
 * Start the market automation scheduler.
 *
 * Uses setInterval for settlement checks (every 10s) so that
 * short rounds (e.g. 1 min) settle promptly.
 * A new round is created immediately after settlement.
 */
export function startMarketScheduler(
  db: Database,
  config: Config,
  intervalMinutes: number = 1
): void {
  console.log(`\n✓ Market scheduler started (rounds every ${intervalMinutes} min, settlement check every 10s)`);

  // Run immediately on startup
  runMarketCycle(db, config, intervalMinutes).catch(console.error);

  // Check for settlement every 10 seconds via setInterval
  setInterval(() => {
    checkAndSettle(db, config, intervalMinutes).catch(console.error);
  }, 10_000);
}

/**
 * Full market cycle: create round if needed + settle if needed
 */
async function runMarketCycle(db: Database, config: Config, intervalMinutes: number): Promise<void> {
  try {
    await checkAndSettle(db, config, intervalMinutes);
    await ensureActiveRound(db, intervalMinutes);
  } catch (error) {
    console.error("Error in market cycle:", error);
  }
}

/**
 * Ensure there's an active round — create one if not
 */
async function ensureActiveRound(db: Database, intervalMinutes: number): Promise<void> {
  const activeRound = getActiveRound(db);
  if (!activeRound) {
    const newRoundNumber = getCurrentRound(db);
    createNewRound(db, newRoundNumber, intervalMinutes);
  }
}

/**
 * Check for expired rounds and settle them, then create a new round
 */
async function checkAndSettle(db: Database, config: Config, intervalMinutes: number): Promise<void> {
  const expiredRound = getSettledRound(db);
  if (expiredRound) {
    await settleExpiredRound(db, config, expiredRound);

    // After settling, create a new round immediately
    const activeRound = getActiveRound(db);
    if (!activeRound) {
      const newRoundNumber = getCurrentRound(db);
      createNewRound(db, newRoundNumber, intervalMinutes);
    }
  }
}

/**
 * Create a new market round
 */
function createNewRound(db: Database, roundNumber: number, intervalMinutes: number = 1): void {
  const now = Date.now();
  const windowStart = now;
  const windowEnd = now + intervalMinutes * 60 * 1000;

  const newRound = {
    id: db.rounds.length + 1,
    round_number: roundNumber,
    window_start_time: windowStart,
    window_end_time: windowEnd,
    open_price: undefined,
    close_price: undefined,
    winning_direction: undefined,
    total_up_amount: 0,
    total_down_amount: 0,
    your_fee_collected: 0,
    settled: false,
  };

  db.rounds.push(newRound);
  db.save();

  console.log(
    `✓ Created market round ${roundNumber} (${intervalMinutes}min: ${new Date(windowStart).toISOString()} - ${new Date(windowEnd).toISOString()})`
  );
}

/**
 * Settle an expired market round — calculates payouts and auto-sends CBTC to winners
 */
async function settleExpiredRound(
  db: Database,
  config: Config,
  round: any
): Promise<void> {
  console.log(`\n🏁 Settling expired round ${round.round_number}...`);

  try {
    // Get prices for this round
    const { open_price, close_price } = await getCurrentWindowPrices();
    const direction = determineDirection(open_price, close_price);

    console.log(
      `Price: open=${open_price.toFixed(2)}, close=${close_price.toFixed(2)} → ${direction}`
    );

    // Execute settlement (calculates payouts + auto-sends CBTC to winners)
    const result = await settleMarketRound(
      db,
      round,
      direction,
      open_price,
      close_price,
      config
    );

    console.log(`✓ Round ${round.round_number} settled successfully`);
    console.log(`  Winners: ${result.payoutDetails.length}`);
    console.log(`  Fee collected: ${result.feeCollected.toFixed(2)}`);

    const autoPayoutSuccess = result.payoutDetails.filter((d) => d.autoPayoutTxnId).length;
    const autoPayoutFailed = result.payoutDetails.filter((d) => d.autoPayoutError).length;
    if (result.payoutDetails.length > 0) {
      console.log(`  Auto-payouts: ${autoPayoutSuccess} sent, ${autoPayoutFailed} failed`);
    }
  } catch (error) {
    console.error(`✗ Failed to settle round ${round.round_number}:`, error);
    throw error;
  }
}
