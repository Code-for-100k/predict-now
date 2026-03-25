// Market types for BTC prediction market

export type Direction = "UP" | "DOWN";
export type UserTier = "retail" | "institutional";

export interface InviteCode {
  code: string;              // e.g. "RET-A3X9K2" or "INST-ALPHA"
  tier: UserTier;
  pool_wallet_id: string;    // which pool wallet this code routes to (e.g. "retail", "inst-1")
  max_uses: number;          // 1 for retail, 10 for institutional
  used_by: string[];         // array of uids who redeemed
  created_at: number;
}

export interface MarketRound {
  id: number;
  round_number: number;
  window_start_time: number; // unix timestamp
  window_end_time: number; // unix timestamp
  open_price?: number;
  close_price?: number;
  winning_direction?: Direction;
  total_up_amount: number;
  total_down_amount: number;
  your_fee_collected: number;
  settling?: boolean; // true while settlement is in progress (idempotency guard)
  settled: boolean;
}

export interface Prediction {
  id: number;
  market_round_id: number;
  uid: string;          // Firebase UID — primary owner
  party_id: string;     // Canton party ID at time of bet (snapshot)
  direction: Direction;
  amount: number; // in CBTC
  settled: boolean;
  payout_txn_id?: string;
}

export interface PriceSnapshot {
  id: number;
  market_round_id: number;
  open_price: number;
  close_price: number;
  timestamp: number;
}

export interface UserBalance {
  uid: string;            // Firebase UID — primary key
  balance: number;
  total_deposited: number;
  total_withdrawn: number;
  total_won: number;
  total_lost: number;
}

/**
 * Per-wallet deposit tracking.
 * Stores the last verified tx offset for each party_id so we only
 * scan new transactions on subsequent verify calls.
 */
export interface WalletDepositState {
  party_id: string;       // Canton party ID (globally unique — one user only)
  uid: string;            // Firebase UID of the owner
  last_verified_offset: number;  // highest tx offset we've verified for this wallet
}

export interface DepositRecord {
  id: number;
  uid: string;            // Firebase UID — who triggered the deposit check
  party_id: string;       // Canton party ID that sent the funds
  amount: number;
  contract_id: string;    // Transaction updateId — prevents double-credit
  accepted_at: number;    // timestamp
}

export interface WithdrawalRecord {
  id: number;
  uid: string;            // Firebase UID — who requested the withdrawal
  party_id: string;       // Canton party ID that received the funds
  amount: number;
  txn_id: string;
  created_at: number;
}

export interface CantonTransaction {
  id: number;
  timestamp: number;           // when the txn occurred
  type: "payout" | "withdrawal" | "deposit_accept" | "admin_credit";
  pool_wallet_id: string;      // which pool wallet (retail, inst-1, etc.)
  pool_party_id: string;       // Canton party ID of the pool
  counterparty_id: string;     // user's Canton party ID
  uid?: string;                // Firebase UID if known
  instrument_id: string;       // "CBTC" or "Amulet"
  amount: number;              // CBTC amount transferred
  txn_id?: string;             // Canton transaction ID
  cc_balance_before: number;   // CC balance before the operation
  cc_balance_after: number;    // CC balance after the operation
  cc_gas_cost: number;         // cc_balance_before - cc_balance_after (the actual gas)
  round_number?: number;       // if related to a prediction round
  prediction_id?: number;      // if this was a payout
}

export interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: string;
  takerBuyQuoteAssetVolume: string;
  unused: string;
}
