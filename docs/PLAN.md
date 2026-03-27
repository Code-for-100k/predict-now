# Plan: Invite Code System with Multi-Pool Wallets

## Summary

Add an invite code gating system where each invite code maps to a specific Canton pool wallet. 100 single-use retail codes share 1 pool wallet. 3 institutional codes (10 uses each) each have their own dedicated pool wallet. All users bet in the same market rounds — only the CBTC deposit/withdrawal/payout wallet differs.

## Data Model

### Invite Codes (4 pool wallets, 103 codes total)

| Pool Wallet | Tier | Invite Code | Max Uses |
|-------------|------|-------------|----------|
| Pool A (retail) | retail | 100 codes (e.g. RET-XXXXX) | 1 each |
| Pool B (inst-1) | institutional | 1 code (e.g. INST-ALPHA) | 10 |
| Pool C (inst-2) | institutional | 1 code (e.g. INST-BRAVO) | 10 |
| Pool D (inst-3) | institutional | 1 code (e.g. INST-CHARLIE) | 10 |

### New/Changed Types

```typescript
// types/market.ts — CHANGE
export type UserTier = "retail" | "institutional";

// InviteCode — CHANGE: add pool_wallet_id and max_uses
export interface InviteCode {
  code: string;
  tier: UserTier;
  pool_wallet_id: string;     // NEW: which pool wallet this code routes to
  max_uses: number;           // NEW: 1 for retail, 10 for institutional
  used_by: string[];          // CHANGE: array of uids (was single uid)
  created_at: number;
}

// User — ADD invite_code and pool_wallet_id
export interface User {
  uid: string;
  email: string;
  party_ids: string[];
  active_party_id?: string;
  tier?: UserTier;
  invite_code?: string;
  pool_wallet_id?: string;    // NEW: which pool wallet this user is assigned to
  created_at: number;
}
```

### Config Changes

```typescript
// lib/types.ts — CHANGE poolWallets from Record<UserTier> to Record<string>
export interface Config {
  // ... existing fields ...
  poolWallets: Record<string, PoolWalletConfig>;  // keyed by wallet ID (e.g. "retail", "inst-1", "inst-2", "inst-3")
}
```

### Environment Variables (NEW)

```bash
# Retail pool wallet (1 wallet for all retail users)
POOL_RETAIL_PARTY_ID=...
POOL_RETAIL_PRIVATE_KEY=...
POOL_RETAIL_PUBLIC_KEY=...

# Institutional pool wallets (1 per institutional invite code)
POOL_INST1_PARTY_ID=...
POOL_INST1_PRIVATE_KEY=...
POOL_INST1_PUBLIC_KEY=...

POOL_INST2_PARTY_ID=...
POOL_INST2_PRIVATE_KEY=...
POOL_INST2_PUBLIC_KEY=...

POOL_INST3_PARTY_ID=...
POOL_INST3_PRIVATE_KEY=...
POOL_INST3_PUBLIC_KEY=...
```

## Files to Change

### 1. `src/types/market.ts`
- Update `InviteCode` interface: add `pool_wallet_id`, `max_uses`, change `used_by` to `string[]`
- Add `pool_wallet_id` to User interface (already has `tier` and `invite_code`)

### 2. `src/lib/types.ts`
- Change `poolWallets` type from `Record<UserTier, PoolWalletConfig>` to `Record<string, PoolWalletConfig>`

### 3. `src/lib/config.ts`
- Load 4 pool wallets from env vars
- Change `getPoolForTier` → `getPoolForUser` that looks up by `user.pool_wallet_id`
- Fallback to legacy single wallet if new env vars not set

### 4. `src/db/init.ts`
- Add `invite_codes` array to Database interface
- Seed invite codes on first startup (100 retail + 3 institutional)
- Admin endpoint to generate more codes if needed

### 5. `src/api/auth.ts`
- `POST /api/auth/verify`: check invite code for new users
  - Find code in `db.invite_codes`
  - Check `used_by.length < max_uses`
  - Add uid to `used_by[]`
  - Set `user.tier` and `user.pool_wallet_id` from the code
- Returning users: no change (already authenticated)

### 6. `src/api/account.ts`
- `getUserPool()`: change from tier-based lookup to `user.pool_wallet_id` lookup
- Deposit: use user's assigned pool wallet
- Withdrawal: use user's assigned pool wallet
- Pool-info: return user's specific pool wallet party ID

### 7. `src/settlement/settlement.ts`
- `getPoolForPrediction()`: change from tier-based to `user.pool_wallet_id` lookup
- Each winner's payout is sent from THEIR assigned pool wallet
- This means a single settlement round may send payouts from multiple different pool wallets

### 8. `src/market.ts`
- Startup: log all 4 pool wallets and their balances
- Health check: verify all 4 wallets are reachable

### 9. `public/index.html`
- Login flow: add invite code input field
- Pass invite code in `/api/auth/verify` request body
- Show appropriate pool wallet party ID in deposit instructions

### 10. Admin endpoints
- `GET /admin/invite-codes`: list all codes with usage stats
- `POST /admin/invite-codes`: generate new codes (admin secret required)

## Settlement Flow (Multi-Pool)

When a round settles with users from different pools:
1. Calculate winners/losers as usual (all in same round)
2. For each winner, look up their `pool_wallet_id`
3. Send payout FROM that specific pool wallet TO the user's Canton wallet
4. This means Pool B might send 0.001 CBTC to winner Alice, while Pool A sends 0.002 CBTC to winner Bob, in the same settlement

**Critical consideration:** Each pool wallet must have sufficient CBTC to cover its users' payouts. The internal ledger tracks balances per-user regardless of pool — but the actual CBTC comes from the user's assigned pool wallet.

## Execution Order

1. Types & config (types/market.ts, lib/types.ts, lib/config.ts)
2. Database schema + code generation (db/init.ts)
3. Auth flow with invite codes (api/auth.ts)
4. Account routing by pool_wallet_id (api/account.ts)
5. Settlement routing by pool_wallet_id (settlement/settlement.ts)
6. Startup + admin endpoints (market.ts)
7. Frontend invite code UI (index.html)
8. Test all flows
9. Deploy to preview

## Open Questions

1. Do you already have 4 Canton party IDs created, or do I need to onboard 3 new ones using `npx tsx src/onboard.ts`?
2. For the demo: should the invite code entry be a separate screen before the main app, or a modal/dialog?
