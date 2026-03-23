import type { Direction, MarketRound, Prediction, UserTier } from "../types/market.js";
import { getOrCreateBalance, getBalanceByPartyId, type Database } from "../db/init.js";
import type { Config, PoolWalletConfig } from "../lib/types.js";
import { getPoolForTier } from "../lib/config.js";
import * as api from "../lib/api.js";
import { signHash } from "../lib/sign.js";

const rawFee = parseFloat(process.env.FEE_PERCENTAGE || "10");
const FEE_PERCENTAGE = Math.max(0, Math.min(100, isNaN(rawFee) ? 10 : rawFee));

export interface SettlementResult {
  roundId: number;
  roundNumber: number;
  winningDirection: Direction;
  totalWinnerAmount: number;
  totalLoserAmount: number;
  feeCollected: number;
  payoutDetails: Array<{
    uid: string;
    partyId: string;
    amount: number;
    autoPayoutTxnId?: string;
    autoPayoutError?: string;
  }>;
}

function calculatePayout(
  prediction: Prediction,
  totalWinnerPool: number,
  totalLoserPool: number
): number {
  if (prediction.amount === 0) return 0;
  const winnerShare = prediction.amount / totalWinnerPool;
  const loserPoolAfterFee = totalLoserPool * (1 - FEE_PERCENTAGE / 100);
  const userShare = loserPoolAfterFee * winnerShare;
  return prediction.amount + userShare;
}

/**
 * Get balance for a prediction — uses uid if available, falls back to party_id lookup.
 */
function getBalForPrediction(db: Database, pred: Prediction) {
  if (pred.uid) {
    return getOrCreateBalance(db, pred.uid);
  }
  return getBalanceByPartyId(db, pred.party_id);
}

/**
 * Send CBTC from pool wallet to a user's Canton wallet.
 * Returns the transaction updateId on success, or throws on failure.
 */
async function sendPayout(
  config: Config,
  pool: PoolWalletConfig,
  recipientPartyId: string,
  amount: number
): Promise<string> {
  // Step 1: Prepare send (no choice-context needed for CBTC)
  const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const amountStr = amount.toString();

  console.log(`    prepareSend: ${amountStr} CBTC to ${recipientPartyId.substring(0, 30)}...`);

  const prepared = await api.prepareSend(config, {
    senderPartyId: pool.partyId,
    receiverPartyId: recipientPartyId,
    amount: amountStr,
    expiryDate,
    instrument: {
      id: config.instrumentId,
      admin: config.instrumentAdmin,
    },
  });

  // Step 2: Sign the transaction hash
  const signature = signHash(
    prepared.command.preparedTransactionHash,
    pool.privateKey
  );

  // Step 3: Broadcast
  const result = await api.broadcast(config, {
    signature,
    publicKey: pool.publicKey,
    commandId: prepared.commandId,
    command: prepared.command,
    partyId: pool.partyId,
  });

  console.log(`    Broadcast result: status=${result.status}, txnId=${result.transactionId}`);
  return result.updateId || result.transactionId || "unknown";
}

/** Get the pool wallet for a prediction's user based on their tier */
function getPoolForPrediction(db: Database, config: Config, pred: Prediction): PoolWalletConfig {
  const user = db.users.find((u) => u.uid === pred.uid);
  const tier = (user?.tier || "retail") as UserTier;
  return getPoolForTier(config, tier);
}

/**
 * Execute settlement for a market round.
 * 1. Calculate payouts (pure math on internal ledger)
 * 2. Credit winner balances
 * 3. Auto-send CBTC payouts from pool wallet to each winner's Canton wallet
 * 4. Deduct auto-payout from internal balance (balance goes back to 0 for that payout)
 */
export async function settleMarketRound(
  db: Database,
  round: MarketRound,
  winningDirection: Direction,
  openPrice: number,
  closePrice: number,
  config: Config
): Promise<SettlementResult> {
  if (round.settled) {
    throw new Error(`Round ${round.round_number} is already settled`);
  }
  if (round.settling) {
    throw new Error(`Round ${round.round_number} is currently being settled`);
  }

  round.settling = true;
  db.save();

  try {
  const predictions = db.predictions.filter(
    (p) => p.market_round_id === round.id && !p.settled
  );

  const winnerPredictions = predictions.filter((p) => p.direction === winningDirection);
  const loserPredictions = predictions.filter((p) => p.direction !== winningDirection);

  const totalWinnerAmount = winnerPredictions.reduce((sum, p) => sum + p.amount, 0);
  const totalLoserAmount = loserPredictions.reduce((sum, p) => sum + p.amount, 0);
  const feeCollected = totalLoserAmount * (FEE_PERCENTAGE / 100);

  console.log(`\n=== Settling Round ${round.round_number} (${winningDirection}) ===`);
  console.log(`Winners pool: ${totalWinnerAmount}, Losers pool: ${totalLoserAmount}, Fee: ${feeCollected}`);

  const payoutDetails: SettlementResult["payoutDetails"] = [];

  // --- Process winners ---
  if (winnerPredictions.length > 0) {
    for (const prediction of winnerPredictions) {
      let payout: number;

      if (totalLoserAmount > 0) {
        payout = calculatePayout(prediction, totalWinnerAmount, totalLoserAmount);
      } else {
        // No losers — refund the original bet
        payout = prediction.amount;
      }

      const bal = getBalForPrediction(db, prediction);
      bal.balance += payout;
      bal.total_won += totalLoserAmount > 0 ? (payout - prediction.amount) : 0;
      prediction.settled = true;

      const detail: SettlementResult["payoutDetails"][0] = {
        uid: prediction.uid || bal.uid,
        partyId: prediction.party_id,
        amount: payout,
      };

      // --- Auto-payout: send CBTC from pool to winner's Canton wallet ---
      try {
        console.log(`  Auto-payout ${payout.toFixed(8)} CBTC -> ${prediction.party_id.substring(0, 30)}...`);
        const predPool = getPoolForPrediction(db, config, prediction);
        const txnId = await sendPayout(config, predPool, prediction.party_id, payout);
        detail.autoPayoutTxnId = txnId;
        prediction.payout_txn_id = txnId;

        // Deduct from internal balance since it's been sent on-chain
        bal.balance -= payout;
        bal.total_withdrawn += payout;

        // Record the withdrawal
        db.withdrawals.push({
          id: db.withdrawals.length + 1,
          uid: prediction.uid || bal.uid,
          party_id: prediction.party_id,
          amount: payout,
          txn_id: txnId,
          created_at: Date.now(),
        });

        console.log(`  ✓ Auto-payout sent: txn=${txnId.substring(0, 20)}...`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        detail.autoPayoutError = errMsg;
        console.error(`  ✗ Auto-payout failed for ${prediction.party_id.substring(0, 30)}...: ${errMsg}`);
        console.log(`    Balance kept in internal ledger — user can withdraw manually.`);
        // Balance stays in internal ledger — user can still withdraw manually
      }

      payoutDetails.push(detail);
      db.save(); // Save after each payout for crash safety
    }
  }

  // --- Process losers ---
  if (loserPredictions.length > 0 && totalWinnerAmount === 0) {
    // No winners — refund all losers (no counterparty = no real market)
    console.log(`  No winners — refunding ${loserPredictions.length} loser(s)`);
    for (const prediction of loserPredictions) {
      prediction.settled = true;
      const bal = getBalForPrediction(db, prediction);
      bal.balance += prediction.amount; // Refund the bet
      // Don't count as a loss since it's a refund

      const detail: SettlementResult["payoutDetails"][0] = {
        uid: prediction.uid || bal.uid,
        partyId: prediction.party_id,
        amount: prediction.amount,
      };

      // Auto-payout the refund back to the user's Canton wallet
      try {
        console.log(`  Refund ${prediction.amount.toFixed(8)} CBTC -> ${prediction.party_id.substring(0, 30)}...`);
        const refundPool = getPoolForPrediction(db, config, prediction);
        const txnId = await sendPayout(config, refundPool, prediction.party_id, prediction.amount);
        detail.autoPayoutTxnId = txnId;
        prediction.payout_txn_id = txnId;

        bal.balance -= prediction.amount;
        bal.total_withdrawn += prediction.amount;

        db.withdrawals.push({
          id: db.withdrawals.length + 1,
          uid: prediction.uid || bal.uid,
          party_id: prediction.party_id,
          amount: prediction.amount,
          txn_id: txnId,
          created_at: Date.now(),
        });

        console.log(`  ✓ Refund sent: txn=${txnId.substring(0, 20)}...`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        detail.autoPayoutError = errMsg;
        console.error(`  ✗ Refund failed for ${prediction.party_id.substring(0, 30)}...: ${errMsg}`);
        console.log(`    Balance kept in internal ledger — user can withdraw manually.`);
      }

      payoutDetails.push(detail);
      db.save();
    }
  } else {
    // Normal case: losers lose their bet
    for (const prediction of loserPredictions) {
      prediction.settled = true;
      const bal = getBalForPrediction(db, prediction);
      bal.total_lost += prediction.amount;
    }
  }

  // --- Fee to operator ---
  if (feeCollected > 0) {
    const operatorPartyId = process.env.OPERATOR_PARTY_ID;
    if (!operatorPartyId) {
      console.warn("OPERATOR_PARTY_ID not configured - fee not credited!");
    } else {
      const operatorBal = getBalanceByPartyId(db, operatorPartyId);
      operatorBal.balance += feeCollected;
      console.log(`  Fee ${feeCollected.toFixed(8)} CBTC -> operator`);
    }
  }

  round.settled = true;
  round.settling = false;
  round.winning_direction = winningDirection;
  round.open_price = openPrice;
  round.close_price = closePrice;
  round.your_fee_collected = feeCollected;

  db.save();

  return {
    roundId: round.id,
    roundNumber: round.round_number,
    winningDirection,
    totalWinnerAmount,
    totalLoserAmount,
    feeCollected,
    payoutDetails,
  };
  } catch (error) {
    // Clear settling flag on error so it can be retried
    round.settling = false;
    db.save();
    throw error;
  }
}
