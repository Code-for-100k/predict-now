import type { Direction, MarketRound, Prediction } from "../types/market.js";
import { getOrCreateBalance, getBalanceByPartyId, type Database } from "../db/init.js";
import type { Config, PoolWalletConfig } from "../lib/types.js";
import { getPoolForUser } from "../lib/config.js";
import * as api from "../lib/api.js";
import { signHash } from "../lib/sign.js";
import * as fs from "fs";
import { tripCircuitBreaker, resetCircuitBreaker } from "../market.js";

// ── Pre-approved wallets (cannot earn rewards as receivers) ──
export const PRE_APPROVED_PARTY_IDS = new Set([
  "df0c3fdb58::12200a976df35fa70038966d8fc1fdd86a3c1310e30d7e3d1d3d43dbe5f372c3ea94", // Agent 1
  "689e91029e::12202e732753e42faa1577be9f9efb22daaa1f85e8a3874695e2ed292e2883f0d0bc", // Agent 2
  "1ca79f9918::12206e3ad664f644c87a3dc169d5d4cf442fd897a32f2daaf1b165df975ce7a2f16d", // Agent 3
  "0afed9241a::1220320c5994fd50d10e15a687d336acf65d0ba07f94744d16d68291ac8bb65e2825", // Inst-1
]);

// ── Agent wallet keys lookup (for inline acceptance) ──
interface WalletKeys { partyId: string; privateKey: string; publicKey: string; }
let agentWalletMap: Map<string, WalletKeys> | null = null;

function getAgentWalletKeys(): Map<string, WalletKeys> {
  if (agentWalletMap) return agentWalletMap;
  agentWalletMap = new Map();
  try {
    const raw = fs.readFileSync("./wallets-batch.json", "utf-8");
    const wallets: Array<{ index: number; partyId: string; privateKey: string; publicKey: string }> = JSON.parse(raw);
    for (const w of wallets) {
      // Only load non-pre-approved wallets (4+)
      if (!PRE_APPROVED_PARTY_IDS.has(w.partyId)) {
        agentWalletMap.set(w.partyId, { partyId: w.partyId, privateKey: w.privateKey, publicKey: w.publicKey });
      }
    }
    console.log(`[Settlement] Loaded ${agentWalletMap.size} agent wallet keys for inline acceptance`);
  } catch {
    console.warn("[Settlement] wallets-batch.json not found — inline acceptance disabled");
  }
  return agentWalletMap;
}

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

  const signature = signHash(
    prepared.command.preparedTransactionHash,
    pool.privateKey
  );

  const result = await api.broadcast(config, {
    signature,
    publicKey: pool.publicKey,
    commandId: prepared.commandId,
    command: prepared.command,
    partyId: pool.partyId,
  });

  const txnId = result.updateId || result.transactionId || "unknown";
  console.log(`    Broadcast: txn=${txnId}`);
  return txnId;
}

/**
 * Accept a pending CBTC transfer on the receiver's wallet.
 * This is required for the transaction to earn CC rewards.
 * Pre-approved wallets auto-accept and do NOT earn rewards.
 * Only works for wallets we control (agent wallets from wallets-batch.json).
 */
async function acceptPendingOnReceiver(
  config: Config,
  recipientPartyId: string
): Promise<string | null> {
  // Skip if receiver is pre-approved (auto-accepts, no rewards anyway)
  if (PRE_APPROVED_PARTY_IDS.has(recipientPartyId)) {
    console.log(`    Skipping inline accept — receiver is pre-approved (no rewards)`);
    return null;
  }

  // Look up receiver keys — only works for our agent wallets
  const walletKeys = getAgentWalletKeys().get(recipientPartyId);
  if (!walletKeys) {
    // Regular user wallet — they accept via Zoro app
    return null;
  }

  const { privateKey: recipientPrivateKey, publicKey: recipientPublicKey } = walletKeys;

  // Brief delay for Canton to register the pending transfer
  await new Promise((r) => setTimeout(r, 3000));

  try {
    const pending = await api.getPendingTransfers(config, recipientPartyId);
    const txns = (pending as any).transactions || [];
    if (txns.length === 0) {
      console.log(`    No pending transfers found on receiver`);
      return null;
    }

    // Accept the most recent pending transfer (the one we just sent)
    const latest = txns[txns.length - 1];
    const prepared = await api.prepareAccept(config, {
      partyId: recipientPartyId,
      transferContractId: latest.contractId,
      instrument: {
        id: config.instrumentId,
        admin: config.instrumentAdmin,
      },
    });

    const signature = signHash(
      prepared.command.preparedTransactionHash,
      recipientPrivateKey
    );

    const result = await api.broadcast(config, {
      signature,
      publicKey: recipientPublicKey,
      commandId: prepared.commandId,
      command: prepared.command,
      partyId: recipientPartyId,
    });

    const acceptTxnId = result.updateId || result.transactionId || "unknown";
    console.log(`    ✓ Inline accept: txn=${acceptTxnId.substring(0, 20)}... (earns rewards)`);
    return acceptTxnId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    ✗ Inline accept failed: ${msg.substring(0, 100)}`);
    return null;
  }
}

/** Get the pool wallet for a prediction's user based on their pool_wallet_id */
function getPoolForPrediction(db: Database, config: Config, pred: Prediction): PoolWalletConfig {
  const user = db.users.find((u) => u.uid === pred.uid);
  return getPoolForUser(config, user || {});
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

  // Measure CC balance on all active pools BEFORE payouts
  const poolBalancesBefore: Record<string, number> = {};
  const hasPredictions = db.predictions.some((p) => p.market_round_id === round.id && !p.settled);
  if (hasPredictions) {
    for (const [poolId, pool] of Object.entries(config.poolWallets || {})) {
      if (!pool) continue;
      try {
        poolBalancesBefore[poolId] = await api.getCCBalance(config, (pool as any).partyId);
      } catch { /* ignore */ }
    }
  }

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
      // Skip on-chain payout if circuit breaker is tripped (balance stays in internal ledger)
      if (db.circuit_breaker.tripped) {
        console.log(`  Circuit breaker active — skipping on-chain payout, balance kept in ledger`);
        payoutDetails.push(detail);
        db.save();
        continue;
      }
      try {
        console.log(`  Auto-payout ${payout.toFixed(8)} CBTC -> ${prediction.party_id.substring(0, 30)}...`);
        const predPool = getPoolForPrediction(db, config, prediction);
        const txnId = await sendPayout(config, predPool, prediction.party_id, payout);
        detail.autoPayoutTxnId = txnId;
        prediction.payout_txn_id = txnId;

        bal.balance -= payout;
        bal.total_withdrawn += payout;

        db.withdrawals.push({
          id: db.withdrawals.length + 1,
          uid: prediction.uid || bal.uid,
          party_id: prediction.party_id,
          amount: payout,
          txn_id: txnId,
          created_at: Date.now(),
        });

        console.log(`  ✓ Auto-payout sent: txn=${txnId.substring(0, 20)}...`);

        // Inline accept: if receiver is an agent wallet we control, accept immediately to earn rewards
        await acceptPendingOnReceiver(config, prediction.party_id);
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
      if (db.circuit_breaker.tripped) {
        console.log(`  Circuit breaker active — skipping refund payout, balance kept in ledger`);
        payoutDetails.push(detail);
        db.save();
        continue;
      }
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

        // Inline accept on agent wallets to earn rewards
        await acceptPendingOnReceiver(config, prediction.party_id);
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

  // Measure CC balance AFTER all payouts — record gas per pool
  const payoutCount = payoutDetails.filter((d) => d.autoPayoutTxnId).length;
  if (payoutCount > 0) {
    for (const [poolId, pool] of Object.entries(config.poolWallets || {})) {
      if (!pool || !(poolId in poolBalancesBefore)) continue;
      try {
        const ccAfter = await api.getCCBalance(config, (pool as any).partyId);
        const ccBefore = poolBalancesBefore[poolId];
        const gasCost = Math.max(0, +(ccBefore - ccAfter).toFixed(6));
        if (gasCost > 0) {
          db.canton_transactions.push({
            id: db.canton_transactions.length + 1,
            timestamp: Date.now(),
            type: "payout",
            pool_wallet_id: poolId,
            pool_party_id: (pool as any).partyId,
            counterparty_id: "round-settlement",
            uid: undefined,
            instrument_id: config.instrumentId,
            amount: payoutDetails.filter((d) => d.autoPayoutTxnId).reduce((s, d) => s + d.amount, 0),
            txn_id: `round-${round.round_number}`,
            cc_balance_before: ccBefore,
            cc_balance_after: ccAfter,
            cc_gas_cost: gasCost,
            round_number: round.round_number,
          });
          console.log(`  Gas: ${gasCost.toFixed(4)} CC for ${poolId} pool (${ccBefore.toFixed(2)} → ${ccAfter.toFixed(2)})`);
        }
      } catch { /* ignore */ }
    }
  }

  db.save();

  // ── Circuit Breaker: check margin after gas measurement ──
  const lookback = parseInt(process.env.CB_LOOKBACK || "10", 10);
  const minMargin = parseFloat(process.env.CB_MIN_MARGIN || "0.5");
  const recentTxns = db.canton_transactions
    .filter((t: any) => t.type === "payout" && t.cc_gas_cost > 0)
    .slice(-lookback);

  if (recentTxns.length >= 3) {
    const avgGas = recentTxns.reduce((s: number, t: any) => s + t.cc_gas_cost, 0) / recentTxns.length;
    const avgReward = parseFloat(process.env.CB_REWARD_PER_TX || "3.45");
    const netMargin = avgReward - avgGas;

    if (!db.circuit_breaker.tripped && netMargin < minMargin) {
      // Trip: margin too thin
      await tripCircuitBreaker(db, avgReward, avgGas,
        `Net margin ${netMargin.toFixed(4)} CC/txn < threshold ${minMargin} CC (avg gas: ${avgGas.toFixed(4)}, avg reward: ${avgReward.toFixed(4)})`
      );
    } else if (db.circuit_breaker.tripped && process.env.CB_AUTO_RECOVER !== "false" && netMargin >= minMargin * 1.5) {
      // Auto-recover: margin healthy again (50% above threshold)
      const PORT = parseInt(process.env.PORT || "3000", 10);
      await resetCircuitBreaker(db, PORT);
    }
  }

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
