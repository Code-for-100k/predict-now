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
   * Per-wallet deposit verification:
   * 1. For each wallet, get its WalletDepositState (last_verified_offset)
   * 2. Fetch pool tx history, filter for TransferIn from that wallet
   * 3. Only process txns with offset > last_verified_offset for that wallet
   * 4. Credit to the user's uid-keyed balance
   * 5. Update last_verified_offset for that wallet
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

      // Fetch pool wallet transaction history (one API call for all wallets)
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
          message: "No transaction history found for pool wallet",
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

        // If wallet was never seeded (offset = -1), it means link-party didn't
        // seed it (API was down, or legacy wallet). Seed now with offset=0
        // so ALL transfers from this wallet get credited.
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
          const isCC =
            tx.instrumentId?.id === "Amulet" ||
            tx.instrumentId?.id === config.instrumentId;
          const notYetCredited = !existingDepositIds.has(tx.updateId);
          const isAfterLastVerified = tx.offset > walletState.last_verified_offset;

          return isIncoming && isCompleted && isFromThisWallet && isCC && notYetCredited && isAfterLastVerified;
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
            `  Deposit: +${amount} CC | uid:${uid} | wallet:${walletPartyId.substring(0, 20)}... | offset:${tx.offset}`
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
        per_wallet: perWalletResults,
        message:
          totalCredited > 0
            ? `Credited ${totalCredited.toFixed(4)} CC from ${totalTransfersFound} transfer(s)`
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

      const { amount } = req.body;
      if (typeof amount !== "number" || !isFinite(amount) || amount < 0.01) {
        return res.status(400).json({ error: "Invalid amount (min 0.01 CC)" });
      }

      const bal = getOrCreateBalance(db, uid);
      if (bal.balance < amount) {
        return res.status(400).json({
          error: `Insufficient balance: have ${bal.balance.toFixed(2)} CC, requested ${amount.toFixed(2)} CC`,
        });
      }

      const roundedAmount = Math.round(amount * 100) / 100;
      const amountString = roundedAmount.toFixed(2);

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
            // Calculate actual payout using the same formula as settlement
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

      const userPredictions = db.predictions.filter((p) => p.party_id === partyId);

      const bets = userPredictions.map((p) => {
        const round = db.rounds.find((r) => r.id === p.market_round_id);
        let status: "pending" | "won" | "lost" = "pending";
        let payout_amount = 0;

        if (round?.settled) {
          if (p.direction === round.winning_direction) {
            status = "won";
            payout_amount = p.payout_txn_id ? p.amount : 0;
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

  // ── GET /results/history ──────────────────────────────────────────────────
  router.get("/results/history", (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const settledRounds = db.rounds
        .filter((r) => r.settled)
        .sort((a, b) => b.round_number - a.round_number);

      const total = settledRounds.length;
      const pageRounds = settledRounds.slice(offset, offset + limit);

      const rounds = pageRounds.map((r) => ({
        round_number: r.round_number,
        open_price: r.open_price,
        close_price: r.close_price,
        winning_direction: r.winning_direction,
        total_up_amount: r.total_up_amount,
        total_down_amount: r.total_down_amount,
        fee_collected: r.your_fee_collected,
        window_start_time: r.window_start_time,
        window_end_time: r.window_end_time,
      }));

      res.json({ rounds, total, limit, offset });
    } catch (error) {
      console.error("Error in /api/results/history:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /pool-info ────────────────────────────────────────────────────────
  router.get("/pool-info", (req, res) => {
    const rawFee = parseFloat(process.env.FEE_PERCENTAGE || "10");
    const feePercentage = Math.max(0, Math.min(100, isNaN(rawFee) ? 10 : rawFee));

    res.json({
      pool_party_id: config.senderPartyId,
      fee_percentage: feePercentage,
    });
  });

  return router;
}
