# Predict Now -- BTC Prediction Market: Code Review & Risk Audit

**Date:** 2026-03-22
**Branch:** `demo-prep`
**Reviewer:** Automated security & settlement risk audit
**Purpose:** Pre-demo review for leadership

---

## Executive Summary

The codebase implements a BTC prediction market with Firebase authentication, a JSON file database, Binance WebSocket price oracle, and Canton blockchain integration for deposits/withdrawals. The architecture is reasonable for a demo but has several issues that range from fund-loss risks to operational fragility. The most critical findings relate to floating-point arithmetic in financial calculations, race conditions in settlement, and the lack of withdrawal amount upper-bound validation.

**Issue counts by severity:**

| Severity | Count |
|----------|-------|
| CRITICAL | 4     |
| HIGH     | 8     |
| MEDIUM   | 10    |
| LOW      | 7     |
| INFO     | 5     |

---

## 1. SECURITY REVIEW

### SEC-01: Legacy balance/bets endpoints bypass authentication (HIGH)

**Files:** `src/api/account.ts` lines 365-384, 537-589

The legacy endpoints `GET /api/balance/:partyId` and `GET /api/bets/:partyId` have no `requireAuth` middleware. Anyone who knows (or guesses) a Canton party ID can read another user's balance, deposit totals, withdrawal totals, P&L, and full bet history. Party IDs are also exposed in the public `/api/results/latest` and `/api/results/:roundNumber` responses.

**Fix:** Remove these legacy endpoints or add `requireAuth` and verify that the `partyId` belongs to the authenticated user.

---

### SEC-02: Admin secret compared with simple equality -- timing attack (LOW)

**File:** `src/market.ts` line 123

```typescript
if (secret !== ADMIN_SECRET) {
```

String comparison using `!==` is not constant-time. An attacker could theoretically use timing differences to brute-force the admin secret one character at a time.

**Fix:** Use `crypto.timingSafeEqual` for the comparison.

---

### SEC-03: No rate limiting on admin endpoints (MEDIUM)

**File:** `src/market.ts` lines 118-127

The admin endpoints (`/admin/user`, `/admin/db-summary`, `/admin/retry-payout`) have no rate limiting. An attacker with a partial or leaked admin secret could brute-force it without throttling.

**Fix:** Add rate limiting (e.g., max 10 attempts per minute per IP) to the `requireAdmin` middleware.

---

### SEC-04: CORS wildcard default (MEDIUM)

**File:** `src/market.ts` lines 72-85

The CORS origin defaults to `*` if `CORS_ORIGIN` is not set. In production, this allows any website to make authenticated API requests on behalf of a logged-in user (CSRF via cross-origin requests with the Authorization header).

**Fix:** Remove the `*` fallback. Require `CORS_ORIGIN` to be explicitly set in production.

---

### SEC-05: No CSRF protection beyond CORS (MEDIUM)

**Files:** `src/market.ts`, `src/middleware/auth.ts`

The app relies on Bearer token auth (which provides some CSRF protection since tokens must be explicitly set in headers). However, the legacy endpoints (SEC-01) have no auth at all, making them vulnerable to cross-site data exfiltration when CORS is `*`.

**Fix:** Set restrictive CORS and remove unauthenticated endpoints.

---

### SEC-06: Firebase Web API key exposed via unauthenticated endpoint (INFO)

**File:** `src/market.ts` lines 103-105, `src/lib/config.ts` lines 48-54

The `/api/firebase-config` endpoint exposes `apiKey`, `authDomain`, and `projectId`. These are intentionally public Firebase client-side config values and are safe to expose. However, ensure Firebase Security Rules are properly configured on the Firebase project.

**No fix needed** -- this is by design for Firebase client SDK initialization.

---

### SEC-07: No input sanitization on display_name from Firebase (LOW)

**File:** `src/api/auth.ts` line 18, `src/db/init.ts` line 38

The `displayName` from the Firebase token is stored directly without sanitization. If this value were ever rendered in an admin UI or returned in API responses that are rendered as HTML, it could be an XSS vector.

**Fix:** Sanitize or escape `displayName` before storage.

---

### SEC-08: Pool wallet credentials in memory (INFO)

**File:** `src/lib/config.ts`

The pool wallet private key (`POOL_PRIVATE_KEY`) is loaded into memory and passed through the `Config` object. This is standard for server-side key management but means a memory dump or debug endpoint could expose the key.

**Fix:** For production, consider using a Hardware Security Module (HSM) or secure enclave for signing operations.

---

### SEC-09: Canton API key validation is minimal (LOW)

**File:** `src/lib/config.ts` line 40-42

The only validation on `ZORO_API_KEY` is that it starts with `canton_`. This is a basic sanity check but provides minimal security value.

**No action required** -- the real validation happens server-side at the Canton API.

---

### SEC-10: API logging can be enabled with env var (INFO)

**File:** `src/lib/api.ts` line 31

Setting `LOG_API_CALLS=true` enables full request/response logging. While sensitive fields are redacted (line 17-29), the redaction only checks key names containing "privateKey", "signature", "publicKey", "apiKey". Other sensitive data in request/response bodies (e.g., transaction hashes, party IDs) would be logged.

**Fix:** Ensure `LOG_API_CALLS` is never set in production, or expand the redaction list.

---

### SEC-11: XSS via innerHTML in frontend (HIGH)

**File:** `public/index.html` -- multiple locations

The frontend uses `innerHTML` extensively to render dynamic content. While most data comes from the API (which returns JSON), several places insert user-controlled values:

- `renderActiveBets()` / `renderHistoryBets()` -- bet amounts and directions come from the API, but `payout_txn_id` is inserted directly.
- `loadUserInfo()` -- `pid` (party ID) is inserted into HTML via template literals.
- `showToast()` -- uses `textContent` (safe).
- Error messages from API are displayed via `textContent` (safe).

A malicious party ID containing HTML/script tags could execute in the admin's or user's browser.

**Fix:** Use `textContent` instead of `innerHTML` where possible. When `innerHTML` is needed, escape all dynamic values with a function like:
```javascript
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
```

---

### SEC-12: No Content-Security-Policy header (MEDIUM)

**File:** `src/market.ts`

The server does not set CSP headers. The frontend loads scripts from CDNs (tailwindcss, lightweight-charts, Firebase) and connects to Binance WebSocket. Without CSP, injected scripts could exfiltrate data.

**Fix:** Add a CSP header allowing only the required CDN origins and WebSocket endpoints.

---

## 2. SETTLEMENT RISK REVIEW

### SET-01: Floating-point arithmetic in financial calculations (CRITICAL)

**Files:** `src/settlement/settlement.ts`, `src/api/prediction.ts`, `src/api/account.ts`

All financial calculations use JavaScript `number` (IEEE 754 double-precision float). This introduces rounding errors:

```typescript
const winnerShare = prediction.amount / totalWinnerPool;
const loserPoolAfterFee = totalLoserPool * (1 - FEE_PERCENTAGE / 100);
const userShare = loserPoolAfterFee * winnerShare;
return prediction.amount + userShare;
```

With many bets, the sum of all payouts may not exactly equal the available pool, causing the pool wallet to either owe more than it has (insolvency) or retain phantom dust amounts.

**Example:** If 3 users each bet 0.00000001 BTC, the division and multiplication chain can produce results that don't sum correctly.

**Fix:** Use integer arithmetic in satoshis (multiply all amounts by 1e8, operate on integers, divide only for display). Alternatively, use a decimal library like `decimal.js`. Also add a reconciliation check: verify that `sum(payouts) + fee <= totalPool` before executing payouts.

---

### SET-02: Race condition between bet placement and settlement (HIGH)

**Files:** `src/api/prediction.ts` lines 100-111, `src/scheduler/cron.ts` lines 66-83

The prediction endpoint checks `activeRound.window_end_time <= Date.now()` (line 107), but settlement checks `r.window_end_time <= Date.now()` in `getSettledRound()`. There is a race window: a bet could be placed at the exact moment a round expires but before settlement starts. The bet would be accepted (deducting balance) but the round might already be picked up for settlement by the 10-second interval.

The `!p.settled` filter in settlement (line 121) would include this late bet, so the user would participate in settlement. However, the round totals (`total_up_amount`, `total_down_amount`) are updated at bet-placement time (lines 131-135), while settlement reads them to determine pool sizes. If the totals are updated after settlement reads them, the payout math will be inconsistent.

**Fix:** Add a betting cutoff (e.g., stop accepting bets 5 seconds before `window_end_time`). Or lock the round totals at the start of settlement.

---

### SET-03: Double-settlement possible under specific crash scenario (HIGH)

**Files:** `src/settlement/settlement.ts` lines 108-113, `src/db/init.ts` lines 230-235

The `settling` flag is an in-memory guard that is also persisted to JSON. On startup, `initDatabase()` clears all `settling` flags (line 231-235). This is correct for crash recovery. However, the `settled` flag is set at the very end of settlement (line 260), after all payouts. If the process crashes after some payouts are made but before `settled = true`, the restart will clear `settling` and the round will be re-settled.

Each winner would receive their payout twice (once from the crashed run, once from the retry). The Canton blockchain payouts cannot be reversed.

**Mitigating factor:** The `prediction.settled = true` and `prediction.payout_txn_id` are set per-prediction and saved after each payout (line 189). On retry, the filter `!p.settled` (line 121) would exclude already-settled predictions. So the retry would only process predictions that were not yet settled in the previous run.

**Remaining risk:** The balance credits (`bal.balance += payout` on line 148) are also persisted per-prediction. The concern is that on-chain payouts are fire-and-forget: if the process crashes after `sendPayout` succeeds but before `prediction.payout_txn_id` is written and `db.save()` completes, the same prediction would be paid out on-chain again on retry.

**Fix:** Write `prediction.payout_txn_id` and call `db.save()` immediately after a successful `sendPayout`, before any balance adjustments. Consider using the Canton transaction as the source of truth for idempotency.

---

### SET-04: Fee sent to operator balance but never withdrawn on-chain (MEDIUM)

**File:** `src/settlement/settlement.ts` lines 249-258

The fee is credited to an operator's internal balance record (looked up by `OPERATOR_PARTY_ID`), but there is no mechanism to withdraw it to the Canton blockchain. The fee accumulates in the internal ledger indefinitely.

Also, if `OPERATOR_PARTY_ID` is not set, the fee is silently not credited (line 252), but the fee is still deducted from the loser pool in the payout calculation. This means the fee amount stays in the pool wallet on-chain with no internal ledger entry -- phantom funds.

**Fix:** Either implement operator fee withdrawal, or track unclaimed fees separately and ensure they are accounted for in pool reconciliation.

---

### SET-05: `price === open_price` always resolves as UP (MEDIUM)

**File:** `src/oracle/binance-ws.ts` lines 284-289

```typescript
return close_price >= open_price ? "UP" : "DOWN";
```

When the price is unchanged, the direction is "UP". This means in low-volatility periods (or if the price oracle returns a cached stale value), UP bettors are systematically favored.

**Fix:** Add a "DRAW" direction that refunds all bets, or document this as intentional behavior.

---

### SET-06: Single bet in a round -- winner gets nothing extra (INFO)

**File:** `src/settlement/settlement.ts` lines 140-145

If there is only one bet (e.g., one UP bet and no DOWN bets), the winner gets back their original bet (`payout = prediction.amount` on line 144) and the auto-payout sends it back on-chain. This is correct behavior (no losers = no profit).

**No fix needed** -- this is working as designed.

---

### SET-07: All bets same direction -- no counterparty (INFO)

**File:** `src/settlement/settlement.ts` lines 136-145, 193-238

If all bets are in the winning direction, `totalLoserAmount = 0`, and all winners are refunded their original bet. If all bets are in the losing direction, `totalWinnerAmount = 0`, and all losers are refunded (lines 194-238). Both cases are handled correctly.

**No fix needed** -- edge cases are covered.

---

### SET-08: Withdrawal ID collision (MEDIUM)

**Files:** `src/settlement/settlement.ts` line 171, `src/api/account.ts` line 465

Withdrawal IDs are assigned as `db.withdrawals.length + 1`. If two settlement payouts or a payout and a withdrawal happen concurrently (Node.js is single-threaded but async operations interleave), two records could get the same ID. This is unlikely to cause data loss but makes audit trails unreliable.

**Fix:** Use a monotonically increasing counter or UUID for IDs.

---

### SET-09: Prediction ID collision (MEDIUM)

**File:** `src/api/prediction.ts` line 118

Same issue as SET-08: `db.predictions.length + 1` can collide if a prediction is added during an async yield (unlikely in the sync predict handler, but the pattern is fragile).

**Fix:** Use `Math.max(...db.predictions.map(p => p.id)) + 1` or UUIDs.

---

## 3. USER EXPERIENCE RISK

### UX-01: User can lose funds if withdrawal fails after balance deduction (CRITICAL)

**File:** `src/api/account.ts` lines 462-474

The withdrawal flow deducts the balance (line 462) before confirming the on-chain transaction is finalized. If the Canton API call succeeds (returning a `txnId`) but the actual on-chain transfer later fails (e.g., insufficient pool wallet funds, network error during finalization), the user's internal balance is already reduced but they never received the funds.

**Fix:** Implement a pending-withdrawal state. Deduct balance optimistically but track the withdrawal as "pending". Verify on-chain completion before marking it as "completed". Provide a mechanism to refund if the on-chain transfer fails.

---

### UX-02: Deposit verification has a 3-second hardcoded wait (LOW)

**File:** `src/api/account.ts` lines 211-213

After accepting pending transfers, the code waits 3 seconds for them to appear in transaction history. If the Canton network is slow, the transfers may not appear yet, and the user sees "No new deposits found."

**Fix:** Document this behavior in the UI ("deposits may take a few seconds to appear") or implement a retry mechanism.

---

### UX-03: Balance can go negative (CRITICAL)

**Files:** `src/settlement/settlement.ts` line 148, `src/api/account.ts` line 462

In settlement, the balance is credited (`bal.balance += payout`) and then immediately debited for auto-payout (`bal.balance -= payout`). If auto-payout fails, the balance stays positive (correct). But in the admin retry-payout endpoint (`src/market.ts` line 249), the balance is debited again:

```typescript
bal.balance -= payout;
```

If the user has already withdrawn the balance manually (since the auto-payout failed and the balance was left in their account), this retry deduction will make the balance negative. There is no check for sufficient balance before the admin retry deduction.

**Fix:** Check `bal.balance >= payout` before deducting in the retry-payout flow. If the user already withdrew, the retry should be rejected.

---

### UX-04: Bets cannot be cancelled (INFO)

Once a prediction is placed, there is no cancel/undo mechanism. The balance is deducted immediately. This is standard for prediction markets but should be clearly communicated in the UI.

---

### UX-05: No withdrawal confirmation or limits (HIGH)

**File:** `src/api/account.ts` lines 387-485

There is no maximum withdrawal amount, no daily withdrawal limit, and no confirmation step. A compromised Firebase token could drain the entire balance in one API call.

**Fix:** Add configurable withdrawal limits and/or require re-authentication for large withdrawals.

---

### UX-06: Server restart during active round (HIGH)

**Files:** `src/scheduler/cron.ts`, `src/db/init.ts`

If the server restarts during an active round:
1. The JSON DB is reloaded (rounds preserved).
2. `initDatabase()` clears any `settling` flags.
3. `startMarketScheduler()` runs `runMarketCycle()` immediately.
4. If the round has expired, it will be settled. If not, it continues.

The price oracle (`binance-ws.ts`) restarts and fetches a new price. If the round's lock price was set before the restart, it is preserved in the DB. The close price will be fetched fresh at settlement time. This is correct.

**Remaining risk:** If the server is down for the entire duration of a round, the round will be settled with a close price from after the restart, which may be significantly different from what it would have been at the scheduled end time. Users who made bets based on real-time price movements during the round would get a result based on a much later price.

**Fix:** If a round is settled more than N seconds after its `window_end_time`, log a warning and consider using a historical price API for the close price.

---

## 4. OPERATIONAL RISK

### OPS-01: JSON file database -- no concurrency safety (CRITICAL)

**File:** `src/db/init.ts` lines 246-257

The database is a single JSON file written synchronously. The `dbWriteLock` is a boolean flag, not a true mutex. In Node.js, while the event loop is single-threaded, the `writeFileSync` + `renameSync` pattern means:
1. If two async operations both call `db.save()` in the same tick, the second one logs a warning but proceeds anyway (the lock is released in `finally`).
2. The write-then-rename pattern (`tmp -> actual`) is good for atomicity against crashes, but doesn't protect against concurrent writes.

More critically, the entire database is in memory. If the process crashes between a balance mutation and `db.save()`, the in-memory state is lost. The saved state on disk could be inconsistent with on-chain state (e.g., a Canton payout was sent but the balance deduction wasn't saved).

**Fix:** For the demo, this is acceptable. For production, migrate to a proper database (SQLite at minimum, PostgreSQL recommended) with transactions.

---

### OPS-02: Binance WebSocket reconnection -- potential memory leak (LOW)

**File:** `src/oracle/binance-ws.ts` lines 128-175

On disconnect, `scheduleReconnect()` sets a timeout to reconnect. In `connectTradeStream()`, if `ws` exists, it calls `ws.close()`. However, event listeners on the old WebSocket may not be cleaned up, potentially leaking memory over many reconnection cycles.

The client-side WebSocket in `index.html` (line 1362-1394) has the same pattern.

**Fix:** Remove event listeners before closing the old WebSocket, or set `ws = null` after close to allow garbage collection.

---

### OPS-03: No health check for Canton API availability (MEDIUM)

**File:** `src/market.ts` lines 50-59

The startup health check is a one-time balance query. If the Canton API goes down later, deposits and withdrawals will fail with generic "Internal server error" messages. There is no periodic health check or circuit breaker.

**Fix:** Add a periodic Canton API health check. Set a flag when the API is unreachable and return informative error messages to users. Consider a circuit breaker pattern.

---

### OPS-04: No database backup mechanism (MEDIUM)

**File:** `src/db/init.ts`

The JSON database file has no backup or snapshot mechanism. If the file gets corrupted (e.g., disk full during write, even with the tmp-rename pattern), all data is lost.

**Fix:** Implement periodic backups (copy the JSON file every N minutes). The tmp-rename pattern protects against mid-write corruption but not disk-full scenarios.

---

### OPS-05: Server clock drift affects round timing (LOW)

**Files:** `src/scheduler/cron.ts`, `src/api/prediction.ts`

Round start/end times use `Date.now()`. If the server clock drifts, rounds will be longer or shorter than configured. The Binance WebSocket timestamps are not used for round timing.

**Fix:** For the demo, this is acceptable. For production, use NTP-synced system clocks and consider using the Binance server timestamp as a reference.

---

### OPS-06: No graceful shutdown (LOW)

**File:** `src/market.ts`

The server does not handle `SIGTERM` or `SIGINT`. On shutdown, active WebSocket connections are not closed, pending settlements are not completed, and the database may not be saved.

**Fix:** Add signal handlers that close WebSocket connections, wait for in-progress settlements, and save the database.

---

### OPS-07: Settlement interval is 10 seconds -- rounds can settle up to 10s late (LOW)

**File:** `src/scheduler/cron.ts` line 34

The settlement check runs every 10 seconds via `setInterval`. This means a round could be settled up to 10 seconds after its `window_end_time`. During this window, the BTC price continues to move, and the close price captured at settlement time may differ from the price at the exact end time.

For 1-minute rounds, a 10-second delay is significant (up to 16.7% of the round duration).

**Fix:** Reduce the interval to 1-2 seconds, or schedule settlement via `setTimeout` targeting the exact `window_end_time`.

---

### OPS-08: Pool wallet info endpoint is unauthenticated (INFO)

**File:** `src/api/account.ts` lines 592-598

The `/api/pool-info` endpoint exposes the pool wallet's party ID, instrument ID, and instrument admin. This is needed for users to send deposits but also reveals the pool wallet address to anyone.

**No fix needed** for a demo -- pool addresses are typically public.

---

## 5. ADDITIONAL FINDINGS

### ADD-01: FEE_PERCENTAGE parsed in multiple places (LOW)

**Files:** `src/api/prediction.ts` line 10-11, `src/settlement/settlement.ts` line 7-8, `src/api/account.ts` line 493, `src/market.ts` line 212

The fee percentage is parsed from environment variables in at least 4 different places. If these parse differently (e.g., one defaults to 10, another to 1), payouts displayed to users will not match actual settlement.

**Fix:** Parse `FEE_PERCENTAGE` once in a shared config module and export it.

---

### ADD-02: Admin retry-payout recalculates payouts independently (HIGH)

**File:** `src/market.ts` lines 208-216

The admin retry-payout endpoint recalculates the payout amount using the same formula as settlement. However, it reads `FEE_PERCENTAGE` from the env at call time. If the fee was changed between settlement and retry, the retry payout will be a different amount than the original calculation.

**Fix:** Store the calculated payout amount on the prediction record at settlement time. Use the stored amount for retries.

---

### ADD-03: No monitoring or alerting (MEDIUM)

The application has no structured logging, no metrics, and no alerting. Failed payouts, API errors, and price oracle failures are logged to `console.error` but not tracked.

**Fix:** Add structured logging (e.g., pino/winston) and error tracking (e.g., Sentry). For the demo, console logging is acceptable.

---

### ADD-04: Frontend connects directly to Binance WebSocket (INFO)

**File:** `public/index.html` line 1365

The frontend opens its own WebSocket connection to Binance.US. This means each connected client maintains a separate WebSocket. For a demo this is fine, but at scale this could cause issues with Binance rate limits.

**No action needed for demo.**

---

## Summary of Recommended Priorities

### Before demo (must-fix):
1. **SET-01:** Add a reconciliation check that `sum(payouts) + fee <= totalPool` before executing payouts.
2. **UX-03:** Add balance check in admin retry-payout to prevent negative balances.
3. **SEC-01:** Remove or protect legacy unauthenticated endpoints.

### Before any real-money usage:
1. **SET-01:** Switch to integer (satoshi) arithmetic for all financial math.
2. **OPS-01:** Migrate from JSON file to a proper database.
3. **SET-03:** Ensure payout_txn_id is persisted immediately after on-chain send.
4. **UX-01:** Implement pending-withdrawal state machine.
5. **UX-05:** Add withdrawal limits.
6. **SEC-11:** Fix XSS via innerHTML in frontend.
7. **SEC-04:** Enforce restrictive CORS.
8. **ADD-02:** Store calculated payout on prediction record.

### Nice-to-have improvements:
1. **OPS-07:** Reduce settlement check interval or use precise setTimeout.
2. **SET-05:** Handle price-unchanged case explicitly.
3. **ADD-01:** Centralize fee percentage configuration.
4. **ADD-03:** Add structured logging and monitoring.
5. **OPS-06:** Add graceful shutdown handling.
