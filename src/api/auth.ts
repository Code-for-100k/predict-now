import express, { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getOrCreateUser, linkPartyId, getOrCreateWalletDepositState, type Database } from "../db/init.js";
import type { Config } from "../lib/types.js";
import * as api from "../lib/api.js";

export function createAuthRouter(db: Database, config: Config): Router {
  const router = express.Router();

  /**
   * POST /api/auth/verify
   * Verifies Firebase ID token, creates or retrieves user document.
   */
  router.post("/verify", requireAuth, (req, res) => {
    try {
      const uid = req.uid!;
      const email = req.user?.email || "";
      const displayName = req.user?.name;

      const user = getOrCreateUser(db, uid, email, displayName);
      db.save();

      res.json({
        uid: user.uid,
        email: user.email,
        display_name: user.display_name,
        party_ids: user.party_ids,
        active_party_id: user.active_party_id,
        has_party_id: user.party_ids.length > 0,
        party_id: user.active_party_id, // backward compat
      });
    } catch (error) {
      console.error("Error in /api/auth/verify:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /api/auth/me
   */
  router.get("/me", requireAuth, (req, res) => {
    try {
      const uid = req.uid!;
      const user = db.users.find((u) => u.uid === uid);
      if (!user) {
        return res.status(404).json({ error: "User not found. Call /api/auth/verify first." });
      }

      res.json({
        uid: user.uid,
        email: user.email,
        display_name: user.display_name,
        party_ids: user.party_ids,
        active_party_id: user.active_party_id,
        has_party_id: user.party_ids.length > 0,
        party_id: user.active_party_id,
      });
    } catch (error) {
      console.error("Error in /api/auth/me:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /api/auth/link-party
   * Links a Canton party_id to the authenticated user's account.
   * Body: { party_id: string }
   *
   * On link, we snapshot the current pool transaction history offset for this wallet.
   * This means only transfers sent AFTER linking will be credited on verify.
   */
  router.post("/link-party", requireAuth, async (req, res) => {
    try {
      const uid = req.uid!;
      const { party_id } = req.body;

      if (!party_id || typeof party_id !== "string" || party_id.trim() === "") {
        return res.status(400).json({ error: "Missing or invalid party_id" });
      }

      const trimmedPartyId = party_id.trim();

      if (!trimmedPartyId.includes("::") || trimmedPartyId.length < 20 || trimmedPartyId.length > 300) {
        return res.status(400).json({
          error: "Invalid party_id format (must be Canton format with :: separator)",
        });
      }

      const user = db.users.find((u) => u.uid === uid);
      if (!user) {
        return res.status(404).json({ error: "User not found. Call /api/auth/verify first." });
      }

      const result = linkPartyId(db, uid, trimmedPartyId);
      if (!result.ok) {
        return res.status(409).json({ error: result.error });
      }

      // Seed the wallet deposit state at link-time:
      // Fetch pool history and set last_verified_offset to current max offset
      // so only transfers AFTER this moment get credited.
      const walletState = getOrCreateWalletDepositState(db, trimmedPartyId, uid);
      if (walletState.last_verified_offset === -1) {
        try {
          const history = await api.getTransactionHistory(config, config.senderPartyId);
          if (history.transactions && history.transactions.length > 0) {
            // Get the max offset of ALL pool transactions (not just from this wallet)
            const maxOffset = Math.max(...history.transactions.map((tx) => tx.offset));
            walletState.last_verified_offset = maxOffset;
            console.log(
              `  Wallet linked & seeded: ${trimmedPartyId.substring(0, 30)}... offset=${maxOffset}`
            );
          } else {
            walletState.last_verified_offset = 0;
            console.log(
              `  Wallet linked (no history): ${trimmedPartyId.substring(0, 30)}... offset=0`
            );
          }
        } catch (error) {
          // If API fails, set to 0 — first verify will handle it
          walletState.last_verified_offset = 0;
          console.warn(
            `  Could not seed wallet offset at link-time: ${error instanceof Error ? error.message : error}`
          );
        }
      }

      db.save();

      res.json({
        uid: user.uid,
        email: user.email,
        display_name: user.display_name,
        party_ids: user.party_ids,
        active_party_id: user.active_party_id,
        has_party_id: true,
        party_id: user.active_party_id,
      });
    } catch (error) {
      console.error("Error in /api/auth/link-party:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /api/auth/set-active-wallet
   * Switch the active wallet for bets and withdrawals.
   */
  router.post("/set-active-wallet", requireAuth, (req, res) => {
    try {
      const uid = req.uid!;
      const { party_id } = req.body;

      const user = db.users.find((u) => u.uid === uid);
      if (!user) {
        return res.status(404).json({ error: "User not found." });
      }

      if (!party_id || !user.party_ids.includes(party_id)) {
        return res.status(400).json({
          error: "Wallet not linked to your account.",
          linked_wallets: user.party_ids,
        });
      }

      user.active_party_id = party_id;
      db.save();

      res.json({
        active_party_id: user.active_party_id,
        party_ids: user.party_ids,
      });
    } catch (error) {
      console.error("Error in /api/auth/set-active-wallet:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
