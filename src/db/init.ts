import fs from "fs";
import type {
  MarketRound, Prediction, UserBalance, DepositRecord,
  WithdrawalRecord, WalletDepositState, InviteCode, UserTier,
  CantonTransaction
} from "../types/market.js";

export interface User {
  uid: string;              // Firebase UID (primary key)
  email: string;
  display_name?: string;
  party_ids: string[];      // All linked Canton wallets (many wallets per user)
  active_party_id?: string; // Currently selected wallet for bets/withdrawals
  tier?: UserTier;          // Assigned by invite code (retail | institutional)
  invite_code?: string;     // Which invite code was used to sign up
  pool_wallet_id?: string;  // Which pool wallet this user is assigned to (e.g. "retail", "inst-1")
  created_at: number;
}

export interface CircuitBreakerState {
  tripped: boolean;
  tripped_at: number | null;
  reason: string;
  avg_reward: number;
  avg_gas: number;
  net_margin: number;
}

export interface Database {
  rounds: MarketRound[];
  predictions: Prediction[];
  balances: UserBalance[];
  deposits: DepositRecord[];
  withdrawals: WithdrawalRecord[];
  users: User[];
  wallet_deposit_states: WalletDepositState[];  // per-wallet last-verified offset
  invite_codes: InviteCode[];                   // pre-generated invite codes
  canton_transactions: CantonTransaction[];     // all on-chain operations with gas tracking
  circuit_breaker: CircuitBreakerState;         // margin monitoring circuit breaker
  save(): void;
}

let dbWriteLock = false;

// ── User helpers ──────────────────────────────────────────────────────────────

/** Get or create a Firebase user record */
export function getOrCreateUser(db: Database, uid: string, email: string, displayName?: string): User {
  let user = db.users.find((u) => u.uid === uid);
  if (!user) {
    user = {
      uid,
      email,
      display_name: displayName,
      party_ids: [],
      created_at: Date.now(),
    };
    db.users.push(user);
  }
  // Migration: if old schema had party_id (string), convert to party_ids (array)
  if ((user as any).party_id && !user.party_ids?.length) {
    user.party_ids = [(user as any).party_id];
    user.active_party_id = (user as any).party_id;
    delete (user as any).party_id;
  }
  if (!user.party_ids) user.party_ids = [];
  return user;
}

/**
 * Check if a party_id is already linked to ANY user.
 * Returns the uid of the owner, or null if available.
 */
export function getPartyIdOwner(db: Database, partyId: string): string | null {
  const owner = db.users.find((u) =>
    u.party_ids?.includes(partyId) ||
    (u as any).party_id === partyId  // backward compat
  );
  return owner ? owner.uid : null;
}

/**
 * Link a party_id to a user.
 * - Rejects if already linked to a DIFFERENT user.
 * - Allows re-linking to the same user (idempotent).
 * - Sets it as the active wallet.
 */
export function linkPartyId(db: Database, uid: string, partyId: string): { ok: boolean; error?: string } {
  const existingOwner = getPartyIdOwner(db, partyId);
  if (existingOwner && existingOwner !== uid) {
    return { ok: false, error: "This Canton wallet is already linked to another account." };
  }

  const user = db.users.find((u) => u.uid === uid);
  if (!user) return { ok: false, error: "User not found." };

  if (!user.party_ids) user.party_ids = [];
  if (!user.party_ids.includes(partyId)) {
    user.party_ids.push(partyId);
  }
  user.active_party_id = partyId;
  return { ok: true };
}

// ── Balance helpers ───────────────────────────────────────────────────────────

/** Get or create a user balance record — keyed by uid */
export function getOrCreateBalance(db: Database, uid: string): UserBalance {
  let bal = db.balances.find((b) => b.uid === uid);
  if (!bal) {
    bal = {
      uid,
      balance: 0,
      total_deposited: 0,
      total_withdrawn: 0,
      total_won: 0,
      total_lost: 0,
    };
    db.balances.push(bal);
  }
  return bal;
}

/** Find balance by party_id (for settlement — looks up uid from users table) */
export function getBalanceByPartyId(db: Database, partyId: string): UserBalance {
  // First try to find user who owns this party_id
  const owner = db.users.find((u) =>
    u.party_ids?.includes(partyId) ||
    (u as any).party_id === partyId
  );
  if (owner) {
    return getOrCreateBalance(db, owner.uid);
  }
  // Legacy fallback
  let bal = db.balances.find((b) => (b as any).party_id === partyId);
  if (bal) return bal;
  // Create with synthetic uid
  const syntheticUid = `legacy_${partyId.substring(0, 16)}`;
  return getOrCreateBalance(db, syntheticUid);
}

// ── Wallet deposit state helpers ──────────────────────────────────────────────

/**
 * Get or create the deposit state for a specific wallet.
 * Tracks the last verified tx offset so we only scan new txns.
 */
export function getOrCreateWalletDepositState(
  db: Database, partyId: string, uid: string
): WalletDepositState {
  let state = db.wallet_deposit_states.find((s) => s.party_id === partyId);
  if (!state) {
    state = {
      party_id: partyId,
      uid,
      last_verified_offset: -1,  // -1 means never verified — will be seeded on first check
    };
    db.wallet_deposit_states.push(state);
  }
  return state;
}

// ── Database initialization ───────────────────────────────────────────────────

export function initDatabase(dbPath = "./market.db.json"): Database {
  let data: {
    rounds: MarketRound[];
    predictions: Prediction[];
    balances: UserBalance[];
    deposits: DepositRecord[];
    withdrawals: WithdrawalRecord[];
    users: User[];
    wallet_deposit_states: WalletDepositState[];
    invite_codes: InviteCode[];
    canton_transactions: CantonTransaction[];
    circuit_breaker: CircuitBreakerState;
  } = {
    rounds: [],
    predictions: [],
    balances: [],
    deposits: [],
    withdrawals: [],
    users: [],
    wallet_deposit_states: [],
    invite_codes: [],
    canton_transactions: [],
    circuit_breaker: { tripped: false, tripped_at: null, reason: "", avg_reward: 0, avg_gas: 0, net_margin: 0 },
  };

  // Load existing data if available
  if (fs.existsSync(dbPath)) {
    try {
      const fileContent = fs.readFileSync(dbPath, "utf-8");
      const loaded = JSON.parse(fileContent);
      data.rounds = loaded.rounds || [];
      data.predictions = loaded.predictions || [];
      data.balances = loaded.balances || [];
      data.deposits = loaded.deposits || [];
      data.withdrawals = loaded.withdrawals || [];
      data.users = loaded.users || [];
      data.wallet_deposit_states = loaded.wallet_deposit_states || [];
      data.invite_codes = loaded.invite_codes || [];
      data.canton_transactions = loaded.canton_transactions || [];
      data.circuit_breaker = loaded.circuit_breaker || { tripped: false, tripped_at: null, reason: "", avg_reward: 0, avg_gas: 0, net_margin: 0 };
    } catch (error) {
      console.warn(`Could not load existing database, starting fresh`);
    }
  }

  // ── Migration: convert old single party_id to party_ids array ──
  for (const user of data.users) {
    if ((user as any).party_id && !user.party_ids?.length) {
      user.party_ids = [(user as any).party_id];
      user.active_party_id = (user as any).party_id;
      delete (user as any).party_id;
      console.log(`  Migrated user ${user.uid}: party_id -> party_ids[]`);
    }
    if (!user.party_ids) user.party_ids = [];
  }

  // ── Migration: add uid to balances that only have party_id ──
  for (const bal of data.balances) {
    if (!(bal as any).uid) {
      const pid = (bal as any).party_id;
      if (pid) {
        const user = data.users.find((u) => u.party_ids?.includes(pid));
        (bal as any).uid = user?.uid || `legacy_${pid.substring(0, 16)}`;
      }
    }
  }

  // ── Migration: add uid to deposits/withdrawals ──
  for (const dep of data.deposits) {
    if (!(dep as any).uid && dep.party_id) {
      const user = data.users.find((u) => u.party_ids?.includes(dep.party_id));
      (dep as any).uid = user?.uid || `seed_${dep.party_id.substring(0, 16)}`;
    }
  }
  for (const w of data.withdrawals) {
    if (!(w as any).uid && w.party_id) {
      const user = data.users.find((u) => u.party_ids?.includes(w.party_id));
      (w as any).uid = user?.uid || `legacy_${w.party_id.substring(0, 16)}`;
    }
  }

  // ── Migration: add uid to predictions ──
  for (const pred of data.predictions) {
    if (!pred.uid && pred.party_id) {
      const user = data.users.find((u) => u.party_ids?.includes(pred.party_id));
      pred.uid = user?.uid || `legacy_${pred.party_id.substring(0, 16)}`;
    }
  }

  // Clear any stale settling flags from previous crash
  for (const round of data.rounds) {
    if (round.settling && !round.settled) {
      console.warn(`  Round ${round.round_number} was mid-settlement — clearing settling flag for retry.`);
      round.settling = false;
    }
  }

  const db: Database = {
    rounds: data.rounds,
    predictions: data.predictions,
    balances: data.balances,
    deposits: data.deposits,
    withdrawals: data.withdrawals,
    users: data.users,
    wallet_deposit_states: data.wallet_deposit_states,
    invite_codes: data.invite_codes,
    canton_transactions: data.canton_transactions,
    circuit_breaker: data.circuit_breaker,
    save() {
      if (dbWriteLock) {
        console.warn("  DB write attempted while another write in progress — queuing");
      }
      dbWriteLock = true;
      try {
        const tmpPath = dbPath + ".tmp";
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
        fs.renameSync(tmpPath, dbPath);
      } finally {
        dbWriteLock = false;
      }
    },
  };

  // ── Seed invite codes if none exist ──
  if (data.invite_codes.length === 0) {
    console.log("  Seeding invite codes (100 retail + 3 institutional + 1 master)...");
    seedInviteCodes(data.invite_codes);
  }

  // ── Ensure master code always exists ──
  if (!data.invite_codes.find((c) => c.code === "PREDICT-NOW")) {
    data.invite_codes.push({
      code: "PREDICT-NOW",
      tier: "retail",
      pool_wallet_id: "retail",
      max_uses: 999,
      used_by: [],
      created_at: Date.now(),
    });
    console.log("  Added master invite code: PREDICT-NOW");
  }

  // ── Migration: add pool_wallet_id to existing users based on tier ──
  for (const user of data.users) {
    if (!user.pool_wallet_id && user.tier) {
      user.pool_wallet_id = user.tier === "retail" ? "retail" : "inst-1";
    }
  }

  db.save();
  console.log(`DB initialized at ${dbPath} (${data.users.length} users, ${data.wallet_deposit_states.length} wallet states, ${data.invite_codes.length} invite codes)`);
  return db;
}

/** Generate a random alphanumeric code */
function randomCode(prefix: string, length: number = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid confusion
  let code = prefix;
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/** Seed the initial set of invite codes: 100 retail (single-use) + 3 institutional (10 uses each) */
function seedInviteCodes(codes: InviteCode[]): void {
  const now = Date.now();

  // 100 retail codes — all point to "retail" pool wallet
  for (let i = 0; i < 100; i++) {
    codes.push({
      code: randomCode("RET-"),
      tier: "retail",
      pool_wallet_id: "retail",
      max_uses: 1,
      used_by: [],
      created_at: now,
    });
  }

  // 3 institutional codes — each points to its own pool wallet
  const instCodes = [
    { code: "INST-ALPHA", pool: "inst-1" },
    { code: "INST-BRAVO", pool: "inst-2" },
    { code: "INST-CHARLIE", pool: "inst-3" },
  ];
  for (const ic of instCodes) {
    codes.push({
      code: ic.code,
      tier: "institutional",
      pool_wallet_id: ic.pool,
      max_uses: 10,
      used_by: [],
      created_at: now,
    });
  }

  // Master code — unlimited uses, for the team
  codes.push({
    code: "PREDICT-NOW",
    tier: "retail",
    pool_wallet_id: "retail",
    max_uses: 999,
    used_by: [],
    created_at: now,
  });

  console.log(`  Seeded ${codes.length} invite codes (100 retail + 3 institutional + 1 master)`);
}

export function getCurrentRound(db: Database): number {
  const max = db.rounds.reduce((m, r) => Math.max(m, r.round_number), 0);
  return max + 1;
}

export function getActiveRound(db: Database, now = Date.now()): MarketRound | null {
  return db.rounds.find(
    (r) => r.window_start_time <= now && r.window_end_time > now && !r.settled
  ) || null;
}

export function getSettledRound(db: Database): MarketRound | null {
  return db.rounds.find(
    (r) => !r.settled && !r.settling && r.window_end_time <= Date.now()
  ) || null;
}
