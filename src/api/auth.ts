import express, { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getOrCreateUser, linkPartyId, getOrCreateWalletDepositState, type Database } from "../db/init.js";
import type { Config } from "../lib/types.js";
import { getPoolForTier } from "../lib/config.js";
import * as api from "../lib/api.js";
import type { UserTier } from "../types/market.js";

export function createAuthRouter(db: Database, config: Config): Router {
  const router = express.Router();

  /**
   * POST /api/auth/verify
   * Verifies Firebase ID token, creates or retrieves user document.
   * For NEW users: requires invite_code in body.
   * For EXISTING users: returns profile as-is.
   */
  router.post("/verify", requireAuth, (req, res) => {
    try {
      const uid = req.uid!;
      const email = req.user?.email || "";
      const displayName = req.user?.name;

      // Check if user already exists
      const existingUser = db.users.find((u) => u.uid === uid);
      if (existingUser) {
        // Returning user — no invite code needed
        return res.json({
          uid: existingUser.uid,
          email: existingUser.email,
          display_name: existingUser.display_name,
          party_ids: existingUser.party_ids,
          active_party_id: existingUser.active_party_id,
          has_party_id: existingUser.party_ids.length > 0,
          party_id: existingUser.active_party_id,
          tier: existingUser.tier || "retail",
        });
      }

      // New user — require invite code
      const { invite_code } = req.body || {};
      if (!invite_code || typeof invite_code !== "string") {
        return res.status(403).json({
          error: "Invite code required for new accounts",
          code: "INVITE_CODE_REQUIRED",
        });
      }

      const trimmedCode = invite_code.trim().toUpperCase();
      const codeRecord = db.invite_codes.find(
        (c) => c.code === trimmedCode
      );

      if (!codeRecord) {
        return res.status(400).json({
          error: "Invalid invite code",
          code: "INVALID_INVITE_CODE",
        });
      }

      if (codeRecord.used_by) {
        return res.status(400).json({
          error: "Invite code has already been used",
          code: "INVITE_CODE_USED",
        });
      }

      // Valid code — create user with tier
      const user = getOrCreateUser(db, uid, email, displayName);
      user.tier = codeRecord.tier;
      user.invite_code = trimmedCode;

      // Mark code as used
      codeRecord.used_by = uid;
      codeRecord.used_at = Date.now();

      db.save();

      console.log(`  New user ${email} signed up with invite code ${trimmedCode} (tier: ${codeRecord.tier})`);

      res.json({
        uid: user.uid,
        email: user.email,
        display_name: user.display_name,
        party_ids: user.party_ids,
        active_party_id: user.active_party_id,
        has_party_id: user.party_ids.length > 0,
        party_id: user.active_party_id,
        tier: user.tier,
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
        tier: user.tier || "retail",
      });
    } catch (error) {
      console.error("Error in /api/auth/me:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * POST /api/auth/link-party
   * Links a Canton party_id to the authenticated user's account.
   * Uses the user's tier to determine which pool wallet to seed from.
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

      // Get the user's tier-specific pool wallet for seeding
      const tier = user.tier || "retail";
      const pool = getPoolForTier(config, tier as UserTier);

      // Seed the wallet deposit state at link-time
      const walletState = getOrCreateWalletDepositState(db, trimmedPartyId, uid);
      if (walletState.last_verified_offset === -1) {
        try {
          const history = await api.getTransactionHistory(config, pool.partyId);
          if (history.transactions && history.transactions.length > 0) {
            const maxOffset = Math.max(...history.transactions.map((tx) => tx.offset));
            walletState.last_verified_offset = maxOffset;
            console.log(
              `  Wallet linked & seeded (${tier}): ${trimmedPartyId.substring(0, 30)}... offset=${maxOffset}`
            );
          } else {
            walletState.last_verified_offset = 0;
            console.log(
              `  Wallet linked (no history, ${tier}): ${trimmedPartyId.substring(0, 30)}... offset=0`
            );
          }
        } catch (error) {
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
        tier: user.tier || "retail",
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
