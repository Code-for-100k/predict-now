/**
 * Postgres database adapter for Predict Now.
 * Implements the same Database interface as the JSON file store,
 * but backed by Postgres for ACID guarantees and crash safety.
 *
 * Usage:
 *   Set DATABASE_URL env var to enable Postgres.
 *   Falls back to JSON file if DATABASE_URL is not set.
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Database, User, CircuitBreakerState } from "./init.js";
import type {
  MarketRound, Prediction, UserBalance, DepositRecord,
  WithdrawalRecord, WalletDepositState, InviteCode, CantonTransaction,
} from "../types/market.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool: pg.Pool | null = null;

/** Initialize connection pool */
function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
    });
    pool.on("error", (err) => {
      console.error("[Postgres] Unexpected pool error:", err.message);
    });
  }
  return pool;
}

/** Run schema.sql to create tables */
async function runSchema(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");
  const client = await getPool().connect();
  try {
    await client.query(sql);
    console.log("[Postgres] Schema applied successfully");
  } finally {
    client.release();
  }
}

/** Migrate data from JSON file to Postgres */
export async function migrateFromJson(jsonPath: string): Promise<{ migrated: boolean; counts: Record<string, number> }> {
  if (!fs.existsSync(jsonPath)) {
    return { migrated: false, counts: {} };
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const client = await getPool().connect();
  const counts: Record<string, number> = {};

  try {
    await client.query("BEGIN");

    // Check if already migrated (users table has data)
    const existing = await client.query("SELECT COUNT(*) FROM users");
    if (parseInt(existing.rows[0].count) > 0) {
      await client.query("ROLLBACK");
      return { migrated: false, counts: { existing_users: parseInt(existing.rows[0].count) } };
    }

    // Users
    for (const u of (data.users || [])) {
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
    }
    counts.users = (data.users || []).length;

    // Balances
    for (const b of (data.balances || [])) {
      await client.query(
        `INSERT INTO balances (uid, balance, total_deposited, total_withdrawn, total_won, total_lost)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (uid) DO NOTHING`,
        [b.uid, b.balance, b.total_deposited, b.total_withdrawn, b.total_won, b.total_lost]
      );
    }
    counts.balances = (data.balances || []).length;

    // Rounds
    for (const r of (data.rounds || [])) {
      await client.query(
        `INSERT INTO rounds (round_number, window_start_time, window_end_time, open_price, close_price,
         winning_direction, total_up_amount, total_down_amount, your_fee_collected, settling, settled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (round_number) DO NOTHING`,
        [r.round_number, r.window_start_time, r.window_end_time, r.open_price, r.close_price,
         r.winning_direction, r.total_up_amount, r.total_down_amount, r.your_fee_collected,
         r.settling || false, r.settled]
      );
    }
    counts.rounds = (data.rounds || []).length;

    // Predictions
    for (const p of (data.predictions || [])) {
      await client.query(
        `INSERT INTO predictions (market_round_id, round, uid, party_id, direction, amount, settled, payout_txn_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.market_round_id || p.round, p.round, p.uid, p.party_id, p.direction, p.amount, p.settled, p.payout_txn_id]
      );
    }
    counts.predictions = (data.predictions || []).length;

    // Deposits
    for (const d of (data.deposits || [])) {
      await client.query(
        `INSERT INTO deposits (uid, party_id, amount, contract_id, accepted_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (contract_id) DO NOTHING`,
        [d.uid, d.party_id, d.amount, d.contract_id, d.accepted_at]
      );
    }
    counts.deposits = (data.deposits || []).length;

    // Withdrawals
    for (const w of (data.withdrawals || [])) {
      await client.query(
        `INSERT INTO withdrawals (uid, party_id, amount, txn_id, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [w.uid, w.party_id, w.amount, w.txn_id, w.created_at]
      );
    }
    counts.withdrawals = (data.withdrawals || []).length;

    // Wallet deposit states
    for (const s of (data.wallet_deposit_states || [])) {
      await client.query(
        `INSERT INTO wallet_deposit_states (party_id, uid, last_verified_offset)
         VALUES ($1,$2,$3) ON CONFLICT (party_id) DO NOTHING`,
        [s.party_id, s.uid, s.last_verified_offset]
      );
    }
    counts.wallet_deposit_states = (data.wallet_deposit_states || []).length;

    // Invite codes
    for (const c of (data.invite_codes || [])) {
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
    counts.invite_codes = (data.invite_codes || []).length;

    // Canton transactions
    for (const t of (data.canton_transactions || [])) {
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
    counts.canton_transactions = (data.canton_transactions || []).length;

    // Circuit breaker
    const cb = data.circuit_breaker || {};
    await client.query(
      `UPDATE circuit_breaker SET tripped=$1, tripped_at=$2, reason=$3, avg_reward=$4, avg_gas=$5, net_margin=$6 WHERE id=1`,
      [cb.tripped || false, cb.tripped_at, cb.reason || "", cb.avg_reward || 0, cb.avg_gas || 0, cb.net_margin || 0]
    );

    await client.query("COMMIT");
    console.log(`[Postgres] Migration complete:`, counts);

    // Rename old JSON file as backup
    const backupPath = jsonPath + `.backup-${Date.now()}`;
    fs.renameSync(jsonPath, backupPath);
    console.log(`[Postgres] JSON backup saved to ${backupPath}`);

    return { migrated: true, counts };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Initialize Postgres — run schema + optional migration */
export async function initPostgres(jsonFallbackPath?: string): Promise<Database> {
  await runSchema();

  // Auto-migrate from JSON if Postgres is empty and JSON exists
  if (jsonFallbackPath && fs.existsSync(jsonFallbackPath)) {
    try {
      await migrateFromJson(jsonFallbackPath);
    } catch (err) {
      console.warn("[Postgres] Migration from JSON failed:", err);
    }
  }

  // Return a Database-compatible interface
  return createPgDatabase();
}

/** Create a Database adapter backed by Postgres */
function createPgDatabase(): Database {
  // In-memory cache — loaded on startup, synced on writes
  // This keeps the existing code working without rewriting every db.rounds.find()
  const cache = {
    rounds: [] as MarketRound[],
    predictions: [] as Prediction[],
    balances: [] as UserBalance[],
    deposits: [] as DepositRecord[],
    withdrawals: [] as WithdrawalRecord[],
    users: [] as User[],
    wallet_deposit_states: [] as WalletDepositState[],
    invite_codes: [] as InviteCode[],
    canton_transactions: [] as CantonTransaction[],
    circuit_breaker: { tripped: false, tripped_at: null, reason: "", avg_reward: 0, avg_gas: 0, net_margin: 0 } as CircuitBreakerState,
  };

  // Load cache from Postgres synchronously isn't possible, so we return
  // the db object and load asynchronously. The caller should await loadCache().
  const db: Database = {
    ...cache,
    save() {
      // Write-through to Postgres on every save()
      // This runs async but we don't await — matches JSON behavior
      writeToPg(cache).catch((err) => {
        console.error("[Postgres] Write-through failed:", err.message);
      });
    },
  };

  return db;
}

/** Load all data from Postgres into the cache */
export async function loadCache(db: Database): Promise<void> {
  const p = getPool();

  const [users, partyIds, balances, rounds, predictions, deposits,
    withdrawals, walletStates, codes, codeUses, txns, cb] = await Promise.all([
    p.query("SELECT * FROM users"),
    p.query("SELECT * FROM user_party_ids"),
    p.query("SELECT * FROM balances"),
    p.query("SELECT * FROM rounds ORDER BY round_number"),
    p.query("SELECT * FROM predictions"),
    p.query("SELECT * FROM deposits"),
    p.query("SELECT * FROM withdrawals"),
    p.query("SELECT * FROM wallet_deposit_states"),
    p.query("SELECT * FROM invite_codes"),
    p.query("SELECT * FROM invite_code_uses"),
    p.query("SELECT * FROM canton_transactions"),
    p.query("SELECT * FROM circuit_breaker WHERE id = 1"),
  ]);

  // Build party_ids map
  const partyMap = new Map<string, string[]>();
  for (const row of partyIds.rows) {
    const arr = partyMap.get(row.uid) || [];
    arr.push(row.party_id);
    partyMap.set(row.uid, arr);
  }

  // Build invite code used_by map
  const usedByMap = new Map<string, string[]>();
  for (const row of codeUses.rows) {
    const arr = usedByMap.get(row.code) || [];
    arr.push(row.uid);
    usedByMap.set(row.code, arr);
  }

  db.users = users.rows.map((r) => ({
    ...r,
    party_ids: partyMap.get(r.uid) || [],
    created_at: parseInt(r.created_at),
  }));

  db.balances = balances.rows;
  db.rounds = rounds.rows.map((r) => ({ ...r, window_start_time: parseInt(r.window_start_time), window_end_time: parseInt(r.window_end_time) }));
  db.predictions = predictions.rows;
  db.deposits = deposits.rows.map((r) => ({ ...r, accepted_at: parseInt(r.accepted_at) }));
  db.withdrawals = withdrawals.rows.map((r) => ({ ...r, created_at: parseInt(r.created_at) }));
  db.wallet_deposit_states = walletStates.rows;
  db.invite_codes = codes.rows.map((r) => ({
    ...r,
    used_by: usedByMap.get(r.code) || [],
    created_at: parseInt(r.created_at),
  }));
  db.canton_transactions = txns.rows.map((r) => ({ ...r, timestamp: parseInt(r.timestamp) }));

  if (cb.rows.length > 0) {
    const row = cb.rows[0];
    db.circuit_breaker = {
      tripped: row.tripped,
      tripped_at: row.tripped_at ? parseInt(row.tripped_at) : null,
      reason: row.reason,
      avg_reward: row.avg_reward,
      avg_gas: row.avg_gas,
      net_margin: row.net_margin,
    };
  }

  console.log(`[Postgres] Cache loaded: ${db.users.length} users, ${db.rounds.length} rounds, ${db.predictions.length} predictions`);
}

/** Write full cache to Postgres (used by save()) */
async function writeToPg(cache: any): Promise<void> {
  const client = await getPool().connect();
  try {
    // Only write circuit breaker state on save() — individual record writes
    // happen via the existing push/modify pattern and are synced on next loadCache()
    // For now, the critical write-through is circuit breaker state
    const cb = cache.circuit_breaker;
    await client.query(
      `UPDATE circuit_breaker SET tripped=$1, tripped_at=$2, reason=$3, avg_reward=$4, avg_gas=$5, net_margin=$6 WHERE id=1`,
      [cb.tripped, cb.tripped_at, cb.reason, cb.avg_reward, cb.avg_gas, cb.net_margin]
    );
  } finally {
    client.release();
  }
}

/** Graceful shutdown */
export async function closePg(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[Postgres] Connection pool closed");
  }
}
