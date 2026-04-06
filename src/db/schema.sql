-- Predict Now — Postgres schema
-- Migrated from market.db.json (single-file JSON)
-- Provides ACID guarantees, concurrent access safety, and crash recovery

-- ══════════════════════════════════════════════════════════════════════════════
-- USERS
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  uid            TEXT PRIMARY KEY,          -- Firebase UID
  email          TEXT NOT NULL,
  display_name   TEXT,
  tier           TEXT CHECK (tier IN ('retail', 'institutional')),
  invite_code    TEXT,
  pool_wallet_id TEXT,                      -- e.g. "retail", "inst-1"
  active_party_id TEXT,                     -- currently selected Canton wallet
  copying_agent_uid TEXT,                   -- copy trading: agent UID to copy
  copy_amount    REAL,                      -- copy trading: bet size
  copy_rounds_remaining INTEGER DEFAULT 0,  -- copy trading: rounds left
  created_at     BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
);

-- Many wallets per user
CREATE TABLE IF NOT EXISTS user_party_ids (
  uid       TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  party_id  TEXT NOT NULL,
  linked_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
  PRIMARY KEY (uid, party_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_party_id_unique ON user_party_ids(party_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- BALANCES
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS balances (
  uid              TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  balance          REAL NOT NULL DEFAULT 0,
  total_deposited  REAL NOT NULL DEFAULT 0,
  total_withdrawn  REAL NOT NULL DEFAULT 0,
  total_won        REAL NOT NULL DEFAULT 0,
  total_lost       REAL NOT NULL DEFAULT 0
);

-- ══════════════════════════════════════════════════════════════════════════════
-- MARKET ROUNDS
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rounds (
  id                SERIAL PRIMARY KEY,
  round_number      INTEGER NOT NULL UNIQUE,
  window_start_time BIGINT NOT NULL,
  window_end_time   BIGINT NOT NULL,
  open_price        REAL,
  close_price       REAL,
  winning_direction TEXT CHECK (winning_direction IN ('UP', 'DOWN')),
  total_up_amount   REAL NOT NULL DEFAULT 0,
  total_down_amount REAL NOT NULL DEFAULT 0,
  your_fee_collected REAL NOT NULL DEFAULT 0,
  settling          BOOLEAN NOT NULL DEFAULT FALSE,
  settled           BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_rounds_settled ON rounds(settled, window_end_time);

-- ══════════════════════════════════════════════════════════════════════════════
-- PREDICTIONS (bets)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS predictions (
  id              SERIAL PRIMARY KEY,
  market_round_id INTEGER NOT NULL,         -- matches rounds.id (legacy: same as round_number)
  round           INTEGER,                   -- round_number shortcut for queries
  uid             TEXT NOT NULL REFERENCES users(uid),
  party_id        TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  amount          REAL NOT NULL CHECK (amount >= 0),
  settled         BOOLEAN NOT NULL DEFAULT FALSE,
  payout_txn_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_predictions_round ON predictions(round);
CREATE INDEX IF NOT EXISTS idx_predictions_uid ON predictions(uid);
CREATE INDEX IF NOT EXISTS idx_predictions_settled_round ON predictions(settled, market_round_id);
CREATE INDEX IF NOT EXISTS idx_predictions_direction ON predictions(direction);

-- ══════════════════════════════════════════════════════════════════════════════
-- DEPOSITS
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS deposits (
  id          SERIAL PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES users(uid),
  party_id    TEXT NOT NULL,
  amount      REAL NOT NULL,
  contract_id TEXT NOT NULL UNIQUE,          -- prevents double-credit
  accepted_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deposits_uid ON deposits(uid);

-- ══════════════════════════════════════════════════════════════════════════════
-- WITHDRAWALS
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS withdrawals (
  id         SERIAL PRIMARY KEY,
  uid        TEXT NOT NULL REFERENCES users(uid),
  party_id   TEXT NOT NULL,
  amount     REAL NOT NULL,
  txn_id     TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_uid ON withdrawals(uid);

-- ══════════════════════════════════════════════════════════════════════════════
-- WALLET DEPOSIT STATES (tracks last verified tx offset per wallet)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS wallet_deposit_states (
  party_id             TEXT PRIMARY KEY,
  uid                  TEXT NOT NULL REFERENCES users(uid),
  last_verified_offset INTEGER NOT NULL DEFAULT -1
);

-- ══════════════════════════════════════════════════════════════════════════════
-- INVITE CODES
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS invite_codes (
  code           TEXT PRIMARY KEY,
  tier           TEXT NOT NULL CHECK (tier IN ('retail', 'institutional')),
  pool_wallet_id TEXT NOT NULL,
  max_uses       INTEGER NOT NULL DEFAULT 1,
  created_at     BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
);

CREATE TABLE IF NOT EXISTS invite_code_uses (
  code TEXT NOT NULL REFERENCES invite_codes(code),
  uid  TEXT NOT NULL REFERENCES users(uid),
  used_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
  PRIMARY KEY (code, uid)
);

-- ══════════════════════════════════════════════════════════════════════════════
-- CANTON TRANSACTIONS (on-chain operations with gas tracking)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS canton_transactions (
  id                SERIAL PRIMARY KEY,
  timestamp         BIGINT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('payout', 'withdrawal', 'deposit_accept', 'admin_credit')),
  pool_wallet_id    TEXT NOT NULL,
  pool_party_id     TEXT NOT NULL,
  counterparty_id   TEXT NOT NULL,
  uid               TEXT,
  instrument_id     TEXT NOT NULL,
  amount            REAL NOT NULL,
  txn_id            TEXT,
  cc_balance_before REAL NOT NULL DEFAULT 0,
  cc_balance_after  REAL NOT NULL DEFAULT 0,
  cc_gas_cost       REAL NOT NULL DEFAULT 0,
  round_number      INTEGER,
  prediction_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_canton_txns_round ON canton_transactions(round_number);
CREATE INDEX IF NOT EXISTS idx_canton_txns_pool ON canton_transactions(pool_wallet_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- CIRCUIT BREAKER STATE (singleton row)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS circuit_breaker (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  tripped    BOOLEAN NOT NULL DEFAULT FALSE,
  tripped_at BIGINT,
  reason     TEXT NOT NULL DEFAULT '',
  avg_reward REAL NOT NULL DEFAULT 0,
  avg_gas    REAL NOT NULL DEFAULT 0,
  net_margin REAL NOT NULL DEFAULT 0
);
INSERT INTO circuit_breaker (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════
-- AUDIT LOG
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_log (
  id        SERIAL PRIMARY KEY,
  event     TEXT NOT NULL,
  actor     TEXT NOT NULL DEFAULT 'system',
  details   JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(timestamp);
