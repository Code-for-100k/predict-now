import express, { Router } from "express";
import type { Config } from "../lib/types.js";
import * as api from "../lib/api.js";
import * as sign from "../lib/sign.js";
import {
  getOrCreateBalance, getBalanceByPartyId,
  getOrCreateWalletDepositState, type Database
} from "../db/init.js";
import { requireAuth } from "../middleware/auth.js";

const ACCEPT_TIMEOUT_MS = 30_000;

/** Format BTC amount: show up to 8 decimals, trim trailing zeros */
function formatBTC(amount: number): string {
  return parseFloat(amount.toFixed(8)).toString();
}

function isValidPartyId(id: string): boolean {
  return id.includes("::") && id.length >= 20 && id.length <= 300;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Accept a single pending CBTC transfer offer on the pool wallet.
 * Steps: prepare accept → sign → broadcast
 * Returns the broadcast result or null on failure.
 */
async function acceptPendingTransfer(
  config: Config,
  contractId: string,
  amount: string,
  sender: string
): Promise<{ updateId?: string; transactionId?: string; status: string } | null> {
  try {
    console.log(`  Accepting pending transfer: ${amount} CBTC from ${sender.substring(0, 20)}... (contract: ${contractId.substring(0, 20)}...)`);

    // Step 1: Prepare accept
    const prepared = await withTimeout(
      api.prepareAccept(config, {
        partyId: config.senderPartyId,
        transferContractId: contractId,
        instrument: {
          id: config.instrumentId,
          admin: config.instrumentAdmin,
        },
      }),
      ACCEPT_TIMEOUT_MS,
      "prepareAccept"
    );

    // Step 2: Sign
    const signature = sign.signHash(
      prepared.command.preparedTransactionHash,
      config.senderPrivateKey
    );

    // Step 3: Broadcast
    const result = await withTimeout(
      api.broadcast(config, {
        signature,
        publicKey: config.senderPublicKey,
        commandId: prepared.commandId,
        command: prepared.command,
        partyId: config.senderPartyId,
      }),
      ACCEPT_TIMEOUT_MS,
      "broadcast accept"
    );

    console.log(`  ✓ Accepted transfer: ${amount} CBTC | status: ${result.status} | txn: ${result.updateId || result.transactionId}`);
    return result;
  } catch (err: any) {
    console.error(`  ✗ Failed to accept transfer ${contractId.substring(0, 20)}...: ${err.message}`);
    return null;
  }
}

/**
 * Accept ALL pending CBTC transfer offers from the given wallet addresses.
 * Returns the number of successfully accepted transfers.
 */
async function acceptPendingTransfersFromWallets(
  config: Config,
  walletPartyIds: string[]
): Promise<{ accepted: number; failed: number; details: Array<{ sender: string; amount: string; contractId: string; success: boolean }> }> {
  const walletSet = new Set(walletPartyIds);
  let accepted = 0;
  let failed = 0;
  const details: Array<{ sender: string; amount: string; contractId: string; success: boolean }> = [];

  try {
    // Fetch all pending transfers on the pool wallet
    const pending = await withTimeout(
      api.getPendingTransfers(config, config.senderPartyId),
      ACCEPT_TIMEOUT_MS,
      "getPendingTransfers"
    );

    if (!pending.transactions || pending.transactions.length === 0) {
      console.log("  No pending transfers on pool wallet");
      return { accepted: 0, failed: 0, details: [] };
    }

    console.log(`  Found ${pending.transactions.length} pending transfer(s) on pool wallet`);

    // Filter for transfers from the user's linked wallets
    const relevantTransfers = pending.transactions.filter((tx) => {
      const isFromUserWallet = walletSet.has(tx.sender);
      const isCBTC = tx.instrumentId?.id === config.instrumentId;
      return isFromUserWallet && isCBTC;
    });

    if (relevantTransfers.length === 0) {
      console.log(`  No pending transfers from user's wallets (checked ${walletPartyIds.length} wallet(s))`);
      // Also log what we did find for debugging
      if (pending.transactions.length > 0) {
        console.log(`  (Pool has ${pending.transactions.length} pending transfers from other senders)`);
      }
      return { accepted: 0, failed: 0, details: [] };
    }

    console.log(`  ${relevantTransfers.length} pending transfer(s) from user's wallet(s) — accepting...`);

    // Accept each one sequentially (to avoid nonce/ordering issues)
    for (const tx of relevantTransfers) {
      const result = await acceptPendingTransfer(config, tx.contractId, tx.amount, tx.sender);
      if (result) {
        accepted++;
        details.push({ sender: tx.sender, amount: tx.amount, contractId: tx.contractId, success: true });
      } else {
        failed++;
        details.push({ sender: tx.sender, amount: tx.amount, contractId: tx.contractId, success: false });
      }
    }
  } catch (err: any) {
    console.error(`  Error fetching/accepting pending transfers: ${err.message}`);
  }

  return { accepted, failed, details };
}

export function createAccountRouter(db: Database, config: Config): Router {
  const router = express.Router();

  // Rate limiter: 1 deposit call per uid per 10s
  const depositRateMap = new Map<string, number>();

  // ── POST /deposit ─────────────────────────────────────────────────────────
  /**
   * POST /api/deposit
   * Body (optional): { party_id?: string }
   *   - If provided, verifies deposits from that specific wallet (must be linked)
   *   - If omitted, verifies deposits from ALL linked wallets
   *
   * CBTC Offer/Accept flow:
   * 1. Fetch pending transfer offers on the pool wallet
   * 2. Accept any offers from the user's linked wallet(s) (prepare → sign → broadcast)
   * 3. Wait briefly for settlement
   * 4. Fetch pool tx history, filter for completed TransferIn from user's wallet(s)
   * 5. Only process txns with offset > last_verified_offset for that wallet
   * 6. Credit to the user's uid-keyed balance
   * 7. Update last_verified_offset for that wallet
   */
  router.post("/deposit", requireAuth, async (req, res) => {
    try {
      const uid = req.uid!;
      const user = db.users.find((u) => u.uid === uid);

      if (!user || !user.party_ids?.length) {
        return res.status(400).json({
          error: "No Canton wallet linked to your account. Use /api/auth/link-party first.",
        });
      }

      // Rate limit per uid
      const now = Date.now();
      const lastCall = depositRateMap.get(uid) || 0;
      if (now - lastCall < 10_000) {
        return res.status(429).json({ error: "Please wait before checking deposits again" });
      }
      depositRateMap.set(uid, now);

      // Determine which wallets to check
      const requestedPartyId = req.body?.party_id;
      let walletsToCheck: string[];

      if (requestedPartyId) {
        if (!user.party_ids.includes(requestedPartyId)) {
          return res.status(400).json({
            error: "This wallet is not linked to your account.",
          });
        }
        walletsToCheck = [requestedPartyId];
      } else {
        walletsToCheck = [...user.party_ids];
      }

      // ── STEP 1: Accept pending CBTC transfer offers ──
      console.log(`\n── Deposit check for uid:${uid} (${walletsToCheck.length} wallet(s)) ──`);
      const acceptResult = await acceptPendingTransfersFromWallets(config, walletsToCheck);

      if (acceptResult.accepted > 0) {
        console.log(`  Accepted ${acceptResult.accepted} transfer(s), waiting 3s for settlement...`);
        // Brief wait for the accepted transfers to appear in transaction history
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      // ── STEP 2: Check transaction history for completed transfers ──
      const history = await withTimeout(
        api.getTransactionHistory(config, config.senderPartyId),
        ACCEPT_TIMEOUT_MS,
        "getTransactionHistory"
      );

      if (!history.transactions || history.transactions.length === 0) {
        return res.json({
          credited: 0,
          balance: getOrCreateBalance(db, uid).balance,
          transfers_found: 0,
          wallets_checked: walletsToCheck.length,
          offers_accepted: acceptResult.accepted,
          message: acceptResult.accepted > 0
            ? `Accepted ${acceptResult.accepted} transfer(s) but no completed deposits found yet. Try again in a few seconds.`
            : "No transaction history found for pool wallet",
        });
      }

      // Global idempotency: set of ALL already-credited updateIds across ALL users
      const existingDepositIds = new Set(db.deposits.map((d) => d.contract_id));

      let totalCredited = 0;
      let totalTransfersFound = 0;
      const perWalletResults: Array<{ party_id: string; credited: number; found: number }> = [];

      for (const walletPartyId of walletsToCheck) {
        // Get per-wallet deposit state
        const walletState = getOrCreateWalletDepositState(db, walletPartyId, uid);

        // If wallet was never seeded (offset = -1), seed now with offset=0
        if (walletState.last_verified_offset === -1) {
          walletState.last_verified_offset = 0;
          console.log(
            `  Wallet ${walletPartyId.substring(0, 20)}... not seeded at link-time, setting offset=0`
          );
        }

        // Filter txns for THIS wallet only, after its last verified offset
        const newTransfers = history.transactions.filter((tx) => {
          const isIncoming = tx.type === "TransferIn";
          const isCompleted = tx.status === "TransferInstructionResult_Completed";
          const isFromThisWallet = tx.sender === walletPartyId;
          const isCBTC =
            tx.instrumentId?.id === config.instrumentId;
          const notYetCredited = !existingDepositIds.has(tx.updateId);
          const isAfterLastVerified = tx.offset > walletState.last_verified_offset;

          return isIncoming && isCompleted && isFromThisWallet && isCBTC && notYetCredited && isAfterLastVerified;
        });

        let walletCredited = 0;

        for (const tx of newTransfers) {
          const amount = parseFloat(tx.amount);
          if (isNaN(amount) || amount <= 0) {
            console.warn(`Skipping invalid transfer amount: ${tx.amount}`);
            continue;
          }

          db.deposits.push({
            id: db.deposits.length + 1,
            uid,
            party_id: walletPartyId,
            amount,
            contract_id: tx.updateId,
            accepted_at: Date.now(),
          });
          existingDepositIds.add(tx.updateId);

          const bal = getOrCreateBalance(db, uid);
          bal.balance += amount;
          bal.total_deposited += amount;

          walletCredited += amount;
          console.log(
            `  Deposit: +${amount} CBTC | uid:${uid} | wallet:${walletPartyId.substring(0, 20)}... | offset:${tx.offset}`
          );
        }

        // Update per-wallet highwater offset
        if (newTransfers.length > 0) {
          const maxOffset = Math.max(...newTransfers.map((tx) => tx.offset));
          walletState.last_verified_offset = maxOffset;
        }

        totalCredited += walletCredited;
        totalTransfersFound += newTransfers.length;
        perWalletResults.push({
          party_id: walletPartyId,
          credited: walletCredited,
          found: newTransfers.length,
        });
      }

      db.save();

      const balance = getOrCreateBalance(db, uid);
      res.json({
        credited: totalCredited,
        balance: balance.balance,
        transfers_found: totalTransfersFound,
        wallets_checked: walletsToCheck.length,
        offers_accepted: acceptResult.accepted,
        per_wallet: perWalletResults,
        message:
          totalCredited > 0
            ? `Credited ${formatBTC(totalCredited)} CBTC from ${totalTransfersFound} transfer(s)`
            : acceptResult.accepted > 0
            ? `Accepted ${acceptResult.accepted} transfer(s) but they haven't settled yet. Click verify again in a few seconds.`
            : "No new deposits found",
      });
    } catch (error) {
      console.error("Error in /api/deposit:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /balance ──────────────────────────────────────────────────────────
  router.get("/balance", requireAuth, (req, res) => {
    try {
      const uid = req.uid!;
      const user = db.users.find((u) => u.uid === uid);

      if (!user || !user.party_ids?.length) {
        return res.status(400).json({
          error: "No Canton wallet linked to your account. Use /api/auth/link-party first.",
        });
      }

      const bal = getOrCreateBalance(db, uid);
      res.json({
        uid: bal.uid,
        active_party_id: user.active_party_id,
        linked_wallets: user.party_ids.length,
        balance: bal.balance,
        total_deposited: bal.total_deposited,
        total_withdrawn: bal.total_withdrawn,
        total_won: bal.total_won,
        total_lost: bal.total_lost,
      });
    } catch (error) {
      console.error("Error in /api/balance:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Legacy GET /balance/:partyId ──────────────────────────────────────────
  router.get("/balance/:partyId", (req, res) => {
    try {
      const partyId = req.params.partyId;
      if (!partyId || !isValidPartyId(partyId)) {
        return res.status(400).json({ error: "Invalid party_id format" });
      }

      const bal = getBalanceByPartyId(db, partyId);
      res.json({
        balance: bal.balance,
        total_deposited: bal.total_deposited,
        total_withdrawn: bal.total_withdrawn,
        total_won: bal.total_won,
        total_lost: bal.total_lost,
      });
    } catch (error) {
      console.error("Error in /api/balance:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /withdraw ────────────────────────────────────────────────────────
  router.post("/withdraw", requireAuth, async (req, res) => {
    try {
      const uid = req.uid!;
      const user = db.users.find((u) => u.uid === uid);

      if (!user || !user.party_ids?.length || !user.active_party_id) {
        return res.status(400).json({
          error: "No Canton wallet linked to your account. Use /api/auth/link-party first.",
        });
      }

      // Withdraw to the active wallet (or a specified one)
      const party_id = req.body?.party_id || user.active_party_id;
      if (!user.party_ids.includes(party_id)) {
        return res.status(400).json({ error: "Specified wallet is not linked to your account." });
      }

      // Coerce string amounts to number (same fix as predict endpoint)
      const rawAmount = req.body.amount;
      const amount = typeof rawAmount === "string" ? parseFloat(rawAmount) : rawAmount;
      if (typeof amount !== "number" || !isFinite(amount) || isNaN(amount) || amount < 0.00001) {
        return res.status(400).json({ error: "Invalid amount (min 0.00001 CBTC / 1000 sats)" });
      }

      const bal = getOrCreateBalance(db, uid);
      if (bal.balance < amount) {
        return res.status(400).json({
          error: `Insufficient balance: have ${formatBTC(bal.balance)} CBTC, requested ${formatBTC(amount)} CBTC`,
        });
      }

      const roundedAmount = Math.round(amount * 1e8) / 1e8; // satoshi precision
      const amountString = roundedAmount.toFixed(8);

      const prepared = await withTimeout(
        api.prepareSend(config, {
          senderPartyId: config.senderPartyId,
          receiverPartyId: party_id,
          amount: amountString,
          expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          memo: "Withdrawal",
          instrument: {
            id: config.instrumentId,
            admin: config.instrumentAdmin,
          },
        }),
        ACCEPT_TIMEOUT_MS,
        "prepareSend withdrawal"
      );

      const signature = sign.signHash(
        prepared.command.preparedTransactionHash,
        config.senderPrivateKey
      );

      const result = await withTimeout(
        api.broadcast(config, {
          signature,
          publicKey: config.senderPublicKey,
          commandId: prepared.commandId,
          command: prepared.command,
          partyId: config.senderPartyId,
        }),
        ACCEPT_TIMEOUT_MS,
        "broadcast withdrawal"
      );

      // Zoro API returns updateId (not transactionId)
      const txnId = result.updateId || result.transactionId;
      if (!txnId) {
        throw new Error("Withdrawal broadcast failed: no updateId or transactionId in response");
      }

      bal.balance -= roundedAmount;
      bal.total_withdrawn += roundedAmount;

      db.withdrawals.push({
        id: db.withdrawals.length + 1,
        uid,
        party_id,
        amount: roundedAmount,
        txn_id: txnId,
        created_at: Date.now(),
      });

      db.save();

      res.json({
        txn_id: txnId,
        amount: roundedAmount,
        remaining_balance: bal.balance,
      });
    } catch (error) {
      console.error("Error in /api/withdraw:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /bets ─────────────────────────────────────────────────────────────
  router.get("/bets", requireAuth, (req, res) => {
    try {
      const uid = req.uid!;
      const userPredictions = db.predictions.filter((p) => p.uid === uid);

      const rawFee = parseFloat(process.env.FEE_PERCENTAGE || "10");
      const feeRate = Math.max(0, Math.min(100, isNaN(rawFee) ? 10 : rawFee)) / 100;

      const bets = userPredictions.map((p) => {
        const round = db.rounds.find((r) => r.id === p.market_round_id);
        let status: "pending" | "won" | "lost" = "pending";
        let payout_amount = 0;

        if (round?.settled) {
          if (p.direction === round.winning_direction) {
            status = "won";
            const winnerPool = round.winning_direction === "UP" ? round.total_up_amount : round.total_down_amount;
            const loserPool = round.winning_direction === "UP" ? round.total_down_amount : round.total_up_amount;
            if (loserPool > 0 && winnerPool > 0) {
              const winnerShare = p.amount / winnerPool;
              const loserPoolAfterFee = loserPool * (1 - feeRate);
              payout_amount = p.amount + (loserPoolAfterFee * winnerShare);
            } else {
              payout_amount = p.amount; // refund if no losers
            }
          } else {
            status = "lost";
          }
        }

        return {
          round_number: round?.round_number,
          direction: p.direction,
          amount: p.amount,
          status,
          payout_amount,
          payout_txn_id: p.payout_txn_id || null,
          settled: p.settled,
        };
      });

      res.json(bets);
    } catch (error) {
      console.error("Error in /api/bets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Legacy GET /bets/:partyId ─────────────────────────────────────────────
  router.get("/bets/:partyId", (req, res) => {
    try {
      const partyId = req.params.partyId;
      if (!partyId || !isValidPartyId(partyId)) {
        return res.status(400).json({ error: "Invalid party_id format" });
      }

      const userPredictions = db.predictions.filter(
        (p) => p.party_id === partyId
      );

      const rawFee = parseFloat(process.env.FEE_PERCENTAGE || "10");
      const feeRate = Math.max(0, Math.min(100, isNaN(rawFee) ? 10 : rawFee)) / 100;

      const bets = userPredictions.map((p) => {
        const round = db.rounds.find((r) => r.id === p.market_round_id);
        let status: "pending" | "won" | "lost" = "pending";
        let payout_amount = 0;

        if (round?.settled) {
          if (p.direction === round.winning_direction) {
            status = "won";
            const winnerPool = round.winning_direction === "UP" ? round.total_up_amount : round.total_down_amount;
            const loserPool = round.winning_direction === "UP" ? round.total_down_amount : round.total_up_amount;
            if (loserPool > 0 && winnerPool > 0) {
              const winnerShare = p.amount / winnerPool;
              const loserPoolAfterFee = loserPool * (1 - feeRate);
              payout_amount = p.amount + (loserPoolAfterFee * winnerShare);
            } else {
              payout_amount = p.amount;
            }
          } else {
            status = "lost";
          }
        }

        return {
          round_number: round?.round_number,
          direction: p.direction,
          amount: p.amount,
          status,
          payout_amount,
          payout_txn_id: p.payout_txn_id || null,
          settled: p.settled,
        };
      });

      res.json(bets);
    } catch (error) {
      console.error("Error in /api/bets:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /pool-info ──────────────────────────────────────────────────────
  router.get("/pool-info", (req, res) => {
    res.json({
      pool_party_id: config.senderPartyId,
      instrument_id: config.instrumentId,
      instrument_admin: config.instrumentAdmin,
    });
  });

  return router;
}
