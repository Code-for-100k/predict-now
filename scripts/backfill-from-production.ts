#!/usr/bin/env npx tsx
/**
 * Backfill Postgres from production Railway instance.
 *
 * Pulls live data from the admin API endpoints and inserts into Postgres.
 * Requires:
 *   DATABASE_URL - Postgres connection string
 *   PROD_URL     - Production Railway URL (default: https://btc-prediction-market-production.up.railway.app)
 *   ADMIN_SECRET - Admin secret for the production API
 *
 * Usage:
 *   DATABASE_URL=postgres://... ADMIN_SECRET=your-admin-secret npx tsx scripts/backfill-from-production.ts
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD_URL = process.env.PROD_URL || "https://btc-prediction-market-production.up.railway.app";
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}
if (!ADMIN_SECRET) {
  console.error("ERROR: ADMIN_SECRET is required");
  process.exit(1);
}

async function fetchAdmin(endpoint: string): Promise<any> {
  const res = await fetch(`${PROD_URL}${endpoint}`, {
    headers: { "x-admin-secret": ADMIN_SECRET! },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${endpoint}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchPublic(endpoint: string): Promise<any> {
  const res = await fetch(`${PROD_URL}${endpoint}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${endpoint}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  console.log(`Backfilling from ${PROD_URL} → ${DATABASE_URL!.split("@")[1] || "postgres"}`);

  // 1. Apply schema
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const schemaPath = path.join(__dirname, "..", "src", "db", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(schema);
  console.log("Schema applied.");

  // 2. Pull production data via admin endpoints
  console.log("Fetching production data...");

  // Get the full DB dump from admin
  const dump = await fetchAdmin("/admin/db-dump");

  if (!dump || !dump.users) {
    // If no db-dump endpoint, try activity summary
    console.log("No /admin/db-dump endpoint — using available admin endpoints...");

    // Get results history (all rounds)
    let allRounds: any[] = [];
    const history = await fetchPublic("/api/results/history?limit=10000");
    allRounds = history.rounds || history.history || [];
    console.log(`  Fetched ${allRounds.length} rounds from history`);

    // Get activity summary for aggregate stats
    const summary = await fetchAdmin("/admin/activity-summary");
    console.log(`  Activity: ${summary.total_predictions} predictions, ${summary.total_users} users`);

    // Insert rounds
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let roundCount = 0;
      for (const r of allRounds) {
        await client.query(
          `INSERT INTO rounds (round_number, window_start_time, window_end_time, open_price, close_price,
           winning_direction, total_up_amount, total_down_amount, your_fee_collected, settled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (round_number) DO NOTHING`,
          [r.round_number, r.window_start_time || 0, r.window_end_time || 0,
           r.open_price, r.close_price, r.winning_direction,
           r.total_up_amount || 0, r.total_down_amount || 0, r.your_fee_collected || 0,
           r.settled !== false]
        );
        roundCount++;
      }
      console.log(`  Inserted ${roundCount} rounds`);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log("\nPartial backfill complete (rounds only from public API).");
    console.log("For full backfill, add a /admin/db-dump endpoint that returns the full market.db.json contents.");
    await pool.end();
    return;
  }

  // Full dump available — insert everything
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Users
    let userCount = 0;
    for (const u of (dump.users || [])) {
      await client.query(
        `INSERT INTO users (uid, email, display_name, tier, invite_code, pool_wallet_id, active_party_id,
         copying_agent_uid, copy_amount, copy_rounds_remaining, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (uid) DO NOTHING`,
        [u.uid, u.email, u.display_name, u.tier, u.invite_code, u.pool_wallet_id,
         u.active_party_id, u.copying_agent_uid, u.copy_amount, u.copy_rounds_remaining || 0, u.created_at]
      );
      for (const pid of (u.party_ids || [])) {
        await client.query(
          `INSERT INTO user_party_ids (uid, party_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [u.uid, pid]
        );
      }
      userCount++;
    }
    console.log(`  Users: ${userCount}`);

    // Balances
    for (const b of (dump.balances || [])) {
      await client.query(
        `INSERT INTO balances (uid, balance, total_deposited, total_withdrawn, total_won, total_lost)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (uid) DO NOTHING`,
        [b.uid, b.balance, b.total_deposited, b.total_withdrawn, b.total_won, b.total_lost]
      );
    }
    console.log(`  Balances: ${(dump.balances || []).length}`);

    // Rounds
    for (const r of (dump.rounds || [])) {
      await client.query(
        `INSERT INTO rounds (round_number, window_start_time, window_end_time, open_price, close_price,
         winning_direction, total_up_amount, total_down_amount, your_fee_collected, settling, settled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (round_number) DO NOTHING`,
        [r.round_number, r.window_start_time, r.window_end_time, r.open_price, r.close_price,
         r.winning_direction, r.total_up_amount, r.total_down_amount, r.your_fee_collected,
         r.settling || false, r.settled]
      );
    }
    console.log(`  Rounds: ${(dump.rounds || []).length}`);

    // Predictions — skip if already populated (no natural unique key besides serial id)
    const existingPreds = await client.query("SELECT COUNT(*) FROM predictions");
    if (parseInt(existingPreds.rows[0].count) > 0) {
      console.log(`  Predictions: skipped (${existingPreds.rows[0].count} already exist)`);
    } else {
      for (const p of (dump.predictions || [])) {
        await client.query(
          `INSERT INTO predictions (market_round_id, round, uid, party_id, direction, amount, settled, payout_txn_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [p.market_round_id || p.round, p.round, p.uid, p.party_id, p.direction, p.amount, p.settled, p.payout_txn_id]
        );
      }
    }
    console.log(`  Predictions: ${(dump.predictions || []).length}`);

    // Deposits
    for (const d of (dump.deposits || [])) {
      await client.query(
        `INSERT INTO deposits (uid, party_id, amount, contract_id, accepted_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (contract_id) DO NOTHING`,
        [d.uid, d.party_id, d.amount, d.contract_id, d.accepted_at]
      );
    }
    console.log(`  Deposits: ${(dump.deposits || []).length}`);

    // Withdrawals
    for (const w of (dump.withdrawals || [])) {
      await client.query(
        `INSERT INTO withdrawals (uid, party_id, amount, txn_id, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [w.uid, w.party_id, w.amount, w.txn_id, w.created_at]
      );
    }
    console.log(`  Withdrawals: ${(dump.withdrawals || []).length}`);

    // Invite codes
    for (const c of (dump.invite_codes || [])) {
      await client.query(
        `INSERT INTO invite_codes (code, tier, pool_wallet_id, max_uses, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING`,
        [c.code, c.tier, c.pool_wallet_id, c.max_uses, c.created_at]
      );
      for (const uid of (c.used_by || [])) {
        await client.query(
          `INSERT INTO invite_code_uses (code, uid) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [c.code, uid]
        );
      }
    }
    console.log(`  Invite codes: ${(dump.invite_codes || []).length}`);

    // Canton transactions
    for (const t of (dump.canton_transactions || [])) {
      await client.query(
        `INSERT INTO canton_transactions (timestamp, type, pool_wallet_id, pool_party_id, counterparty_id,
         uid, instrument_id, amount, txn_id, cc_balance_before, cc_balance_after, cc_gas_cost,
         round_number, prediction_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [t.timestamp, t.type, t.pool_wallet_id, t.pool_party_id, t.counterparty_id,
         t.uid, t.instrument_id, t.amount, t.txn_id, t.cc_balance_before, t.cc_balance_after,
         t.cc_gas_cost, t.round_number, t.prediction_id]
      );
    }
    console.log(`  Canton transactions: ${(dump.canton_transactions || []).length}`);

    // Wallet deposit states
    for (const s of (dump.wallet_deposit_states || [])) {
      await client.query(
        `INSERT INTO wallet_deposit_states (party_id, uid, last_verified_offset)
         VALUES ($1,$2,$3) ON CONFLICT (party_id) DO NOTHING`,
        [s.party_id, s.uid, s.last_verified_offset]
      );
    }
    console.log(`  Wallet deposit states: ${(dump.wallet_deposit_states || []).length}`);

    // Circuit breaker
    const cb = dump.circuit_breaker || {};
    await client.query(
      `UPDATE circuit_breaker SET tripped=$1, tripped_at=$2, reason=$3, avg_reward=$4, avg_gas=$5, net_margin=$6 WHERE id=1`,
      [cb.tripped || false, cb.tripped_at, cb.reason || "", cb.avg_reward || 0, cb.avg_gas || 0, cb.net_margin || 0]
    );
    console.log(`  Circuit breaker: synced`);

    await client.query("COMMIT");
    console.log("\nFull backfill complete!");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
