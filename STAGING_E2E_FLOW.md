# BTC Prediction Market - Staging End-to-End Test Flow

**Environment:** https://predict-now-preview-production.up.railway.app
**Branch:** demo-prep (staging)
**Admin Secret:** `predict-now-admin-2026`
**Date:** 2026-03-25

> Full end-to-end test flow exercising all staging features in sequence.
> 15 steps covering the complete user journey from landing page to withdrawal.

---

## Prerequisites

- Chrome/Firefox with DevTools available
- Two test email accounts (one retail, one institutional)
- Canton wallet with CBTC for deposit testing
- Admin secret for override tests

```bash
BASE=https://predict-now-preview-production.up.railway.app
ADMIN_SECRET=predict-now-admin-2026
```

---

## Flow Summary

| Step | Action | Type | Pass Criteria |
|------|--------|------|---------------|
| 1 | Landing page renders | UI | Page loads, CTA visible |
| 2 | Signup with retail invite code | API + UI | Tier = retail |
| 3 | Signup with institutional invite code | API + UI | Tier = institutional |
| 4 | Firebase auth verification | API | Token verified, user created |
| 5 | Tier assignment check | API | Correct tier persisted |
| 6 | Deposit with auto-retry | API | Balance credited |
| 7 | Place bets (UP/DOWN) | API | Predictions registered |
| 8 | Wait for settlement | Observe | Round settles autonomously |
| 9 | Check results per tier | API | Tier-segregated results |
| 10 | Withdrawal within limit | API | Funds returned |
| 11 | Withdrawal over limit (blocked) | API | 400 error |
| 12 | Admin override withdrawal | API | Override succeeds |
| 13 | Analytics dashboard data | UI + API | Dashboard renders |
| 14 | Music player (non-blocking) | UI | Audio plays, no lag |
| 15 | Price feed failover | API | Fallback works |

---

## Step 1: Landing Page Renders

**Action:** Navigate to `$BASE` in browser (unauthenticated).

**Expected:**
- Landing page loads (NOT the trading UI)
- PancakeSwap-style design visible (dark theme, neon accents)
- Orbitron font rendered for headings
- Glow effects on buttons and cards
- Call-to-action button: "Enter with Invite Code" or "Sign Up"
- No JavaScript console errors

**Verification (manual):**
```bash
# Verify landing page returns HTML (not redirect)
curl -s -o /dev/null -w "%{http_code}" $BASE
# Expected: 200

# Verify static assets load
curl -s -o /dev/null -w "%{http_code}" $BASE/css/style.css
curl -s -o /dev/null -w "%{http_code}" $BASE/js/app.js
```

**Checklist:**
- [ ] Page loads within 3 seconds
- [ ] No 404 errors for CSS/JS/fonts
- [ ] Mobile responsive (test at 375px width)
- [ ] Invite code input field visible
- [ ] Firebase auth UI components load

---

## Step 2: Signup with Retail Invite Code

**Action:** Enter a retail invite code and create an account.

**Manual flow:**
1. On landing page, enter invite code: `RET-00001`
2. Click "Continue" or "Enter"
3. Firebase auth popup appears (Google/email)
4. Complete sign-in with test email account 1

**API verification:**
```bash
# After Firebase auth, get the ID token from browser console:
# await firebase.auth().currentUser.getIdToken()
TOKEN_RETAIL="<paste-token>"

# Verify auth and redeem code
curl -X POST $BASE/api/auth/verify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_RETAIL" | jq '.'

curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_RETAIL" \
  -d '{"code": "RET-00001"}' | jq '.'
```

**Expected:**
```json
{
  "tier": "retail",
  "pool_party_id": "8324e2529b::1220efd7...",
  "message": "Invite code accepted"
}
```

**Checklist:**
- [ ] Invite code accepted
- [ ] User redirected to trading UI (not landing page)
- [ ] Tier displayed as "Retail" in profile/header
- [ ] Pool wallet assigned correctly

---

## Step 3: Signup with Institutional Invite Code

**Action:** In a separate browser/incognito, sign up with institutional code.

**Manual flow:**
1. Navigate to `$BASE`
2. Enter invite code: `INST-ALPHA`
3. Complete Firebase auth with test email account 2

**API verification:**
```bash
TOKEN_INST="<paste-institutional-token>"

curl -X POST $BASE/api/auth/verify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_INST" | jq '.'

curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_INST" \
  -d '{"code": "INST-ALPHA"}' | jq '.'
```

**Expected:**
```json
{
  "tier": "institutional",
  "pool_party_id": "0afed9241a::1220320c...",
  "message": "Invite code accepted"
}
```

**Checklist:**
- [ ] Institutional code accepted
- [ ] Tier displayed as "Institutional"
- [ ] Correct pool wallet (INST-ALPHA = `0afed9241a::1220320c...`)

---

## Step 4: Firebase Auth Verification

**Action:** Verify that both users' Firebase tokens are correctly validated by the server.

```bash
# Retail user
curl -s $BASE/api/auth/me \
  -H "Authorization: Bearer $TOKEN_RETAIL" | jq '.'

# Institutional user
curl -s $BASE/api/auth/me \
  -H "Authorization: Bearer $TOKEN_INST" | jq '.'
```

**Expected for each:**
```json
{
  "uid": "<firebase-uid>",
  "email": "<test-email>",
  "display_name": "<name>",
  "party_id": "<canton-party-id-if-linked>",
  "has_party_id": true,
  "tier": "<retail|institutional>"
}
```

**Negative test: expired/invalid token**
```bash
curl -s $BASE/api/auth/me \
  -H "Authorization: Bearer invalid-token-123" | jq '.'
```
**Expected:** 401 Unauthorized.

**Checklist:**
- [ ] Valid tokens return user profile
- [ ] Invalid tokens return 401
- [ ] Expired tokens return 401
- [ ] Missing Authorization header returns 401

---

## Step 5: Tier Assignment Check

**Action:** Verify tier assignments are correct and persistent.

```bash
# Retail user's tier
curl -s $BASE/api/auth/me \
  -H "Authorization: Bearer $TOKEN_RETAIL" | jq '.tier'
# Expected: "retail"

# Institutional user's tier
curl -s $BASE/api/auth/me \
  -H "Authorization: Bearer $TOKEN_INST" | jq '.tier'
# Expected: "institutional"

# Pool info per tier
curl -s "$BASE/api/pool-info?tier=retail" | jq '.'
curl -s "$BASE/api/pool-info?tier=institutional" | jq '.'
```

**Checklist:**
- [ ] Retail user: `tier = "retail"`
- [ ] Institutional user: `tier = "institutional"`
- [ ] Pool info returns correct wallet per tier
- [ ] Tier persists after page refresh / re-auth

---

## Step 6: Deposit with Auto-Retry

**Action:** Both users deposit CBTC from their Canton wallets to the pool.

**Precondition:** Users have linked their Canton party_id and sent CBTC to the pool wallet.

```bash
# Retail user deposits
curl -X POST $BASE/api/deposit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_RETAIL" | jq '.'

# Institutional user deposits
curl -X POST $BASE/api/deposit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_INST" | jq '.'
```

**Expected:**
```json
{
  "credited": 5.00,
  "balance": 5.00,
  "transfers_found": 1
}
```

**Auto-retry verification (check server logs):**
If Canton API has transient failures, logs should show:
```
  Deposit accept attempt 1/3 failed: timeout
  Deposit accept attempt 2/3: success
  Deposit accepted: 5.00 CBTC from <party>
```

**Dedup verification:**
```bash
# Call deposit again — should credit 0 (already accepted)
sleep 11  # Wait past rate limit
curl -X POST $BASE/api/deposit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_RETAIL" | jq '.credited'
# Expected: 0
```

**Checklist:**
- [ ] Deposit credited to correct balance
- [ ] Auto-retry works for transient failures (check logs)
- [ ] Dedup prevents double-crediting
- [ ] Rate limit enforced (1 call per 10s per user)
- [ ] Deposits route to correct tier pool wallet

---

## Step 7: Place Bets (UP/DOWN)

**Action:** Both users place bets during an active round.

```bash
# Check market is active
curl -s $BASE/api/market/status | jq '.status, .time_remaining_ms'

# Retail user bets UP
curl -X POST $BASE/api/predict \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_RETAIL" \
  -d '{"amount": 1.00, "direction": "UP"}' | jq '.'

# Institutional user bets DOWN
curl -X POST $BASE/api/predict \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_INST" \
  -d '{"amount": 2.00, "direction": "DOWN"}' | jq '.'
```

**Expected (each):**
```json
{
  "prediction_id": "<id>",
  "market_round": "<N>",
  "direction": "UP",
  "amount": 1.00,
  "message": "Prediction registered successfully"
}
```

**Verify market status reflects bets:**
```bash
curl -s $BASE/api/market/status | jq '{
  up_predictions, down_predictions,
  up_amount, down_amount
}'
```

**Checklist:**
- [ ] Both bets registered successfully
- [ ] Balance deducted immediately
- [ ] Market status shows updated pool amounts
- [ ] Bets appear in user's bet history (`GET /api/bets`)

---

## Step 8: Wait for Settlement

**Action:** Wait for the 15-minute round to expire and settlement to execute.

**Monitoring:**
```bash
# Poll market status every 30 seconds
while true; do
  STATUS=$(curl -s $BASE/api/market/status | jq -r '.status')
  REMAINING=$(curl -s $BASE/api/market/status | jq '.time_remaining_ms')
  echo "$(date): status=$STATUS remaining=${REMAINING}ms"
  if [ "$STATUS" != "active" ]; then
    echo "Round ended!"
    break
  fi
  sleep 30
done
```

**After settlement, verify:**
```bash
curl -s $BASE/api/results/latest | jq '.'
```

**Checklist:**
- [ ] Settlement executes autonomously (no manual trigger)
- [ ] BTC price fetched from Binance (WS or REST)
- [ ] Winning direction determined
- [ ] Results available via API

---

## Step 9: Check Results Per Tier

**Action:** Verify settlement results show tier-segregated data.

```bash
# Full results
curl -s $BASE/api/results/latest | jq '.'

# Per-prediction tier check
curl -s $BASE/api/results/latest | jq '.predictions[] | {party_id, tier, direction, amount, won}'

# Admin tier breakdown
curl -s $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: $ADMIN_SECRET" | jq '.'
```

**Expected:** Each prediction has a `tier` field. Payouts sourced from correct pool wallet.

**Checklist:**
- [ ] Retail predictions tagged as `tier: "retail"`
- [ ] Institutional predictions tagged as `tier: "institutional"`
- [ ] Settlement math correct per tier (independently calculated)
- [ ] Fee collected from each tier independently
- [ ] Admin tier-breakdown shows correct totals

---

## Step 10: Withdrawal Within Limit

**Action:** Winner withdraws an amount within their deposit total.

```bash
# Check balance and deposit total
curl -s $BASE/api/balance \
  -H "Authorization: Bearer $TOKEN_RETAIL" | jq '.'

# Withdraw within deposit limit (e.g., deposited 5.00, withdraw 2.00)
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_RETAIL" \
  -d '{"amount": 2.00}' | jq '.'
```

**Expected:**
```json
{
  "txn_id": "<canton_txn_id>",
  "amount": 2.00,
  "remaining_balance": 3.00
}
```

**Checklist:**
- [ ] Withdrawal executes on Canton blockchain
- [ ] Transaction ID returned
- [ ] Internal balance updated
- [ ] Withdrawal recorded in history

---

## Step 11: Withdrawal Over Limit (Blocked)

**Action:** Attempt to withdraw more than total deposited.

```bash
# User deposited 5.00 total, has 8.00 balance (3.00 from winnings)
# Try to withdraw 6.00 (exceeds 5.00 deposit total)
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_RETAIL" \
  -d '{"amount": 6.00}' | jq '.'
```

**Expected:**
```json
{
  "error": "Withdrawal amount exceeds total deposits. Use admin override for winnings withdrawal."
}
```
HTTP status: 400.

**Checklist:**
- [ ] Withdrawal blocked with clear error message
- [ ] Balance unchanged
- [ ] No Canton transaction executed
- [ ] Error mentions admin override as the path forward

---

## Step 12: Admin Override Withdrawal

**Action:** Admin approves winnings withdrawal.

```bash
# Get the user's UID
USER_UID=$(curl -s $BASE/api/auth/me \
  -H "Authorization: Bearer $TOKEN_RETAIL" | jq -r '.uid')

# Admin override
curl -X POST $BASE/api/admin/override-withdraw \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d "{\"uid\": \"$USER_UID\", \"amount\": 6.00, \"reason\": \"Approved winnings payout\"}" | jq '.'
```

**Expected:**
```json
{
  "txn_id": "<canton_txn_id>",
  "amount": 6.00,
  "override": true,
  "reason": "Approved winnings payout"
}
```

**Verify balance after:**
```bash
curl -s $BASE/api/balance \
  -H "Authorization: Bearer $TOKEN_RETAIL" | jq '.balance'
```

**Checklist:**
- [ ] Admin override succeeds with valid secret
- [ ] Canton transaction executes
- [ ] Balance deducted correctly
- [ ] Override logged with reason

---

## Step 13: Analytics Dashboard Data

**Action:** Load the analytics dashboard and verify data.

**Browser test:**
1. Navigate to `$BASE/dashboard.html`
2. Verify charts render with data

**API test:**
```bash
# Dashboard HTML loads
curl -s -o /dev/null -w "%{http_code}" $BASE/dashboard.html
# Expected: 200

# Analytics data endpoint
curl -s $BASE/api/analytics | jq '.'
```

**Expected analytics data:**
```json
{
  "total_rounds": 10,
  "total_volume": 500.00,
  "total_users": 5,
  "total_fees_collected": 25.00,
  "by_tier": {
    "retail": { "volume": 200.00, "users": 3 },
    "institutional": { "volume": 300.00, "users": 2 }
  }
}
```

**Checklist:**
- [ ] Dashboard HTML loads (200)
- [ ] Charts render without JS errors
- [ ] Analytics API returns aggregated data
- [ ] Tier breakdown included
- [ ] Data matches actual settlement history

---

## Step 14: Music Player (Non-Blocking)

**Action:** Verify the Nightride FM synthwave music player loads and plays without blocking the UI.

**Manual test:**
1. Navigate to `$BASE` (authenticated)
2. Find the music player widget (typically bottom bar or floating element)
3. Click play
4. While music is playing:
   - Place a bet (should work without lag)
   - Check market status (should update normally)
   - Navigate between pages (music should continue or gracefully handle)

**Checklist:**
- [ ] Music player widget visible
- [ ] Play/pause works
- [ ] Volume control works
- [ ] Audio plays without blocking UI thread
- [ ] Placing bets while music plays: no lag or errors
- [ ] Page navigation does not cause audio errors
- [ ] Music player does not cause JavaScript errors
- [ ] Muting/disabling persists across page loads (localStorage)

---

## Step 15: Price Feed Failover

**Action:** Verify BTC price feed works via WebSocket and falls back to REST.

**Test A: Normal operation (WebSocket)**
```bash
curl -s $BASE/api/btc-price | jq '.'
```
**Expected:**
```json
{
  "price": 87654.32,
  "source": "binance_ws",
  "timestamp": 1773690252870
}
```

**Test B: Verify price freshness**
```bash
# Get price twice, 5 seconds apart
P1=$(curl -s $BASE/api/btc-price | jq '.price')
sleep 5
P2=$(curl -s $BASE/api/btc-price | jq '.price')
echo "Price 1: $P1, Price 2: $P2"
```
**Expected:** Prices may differ slightly (live data). Timestamps should be recent (within last 10 seconds).

**Test C: Fallback verification**
The REST fallback is automatic when the WebSocket connection drops. Verify by checking the `source` field:
```bash
# Poll price source over time
for i in $(seq 1 10); do
  curl -s $BASE/api/btc-price | jq -r '.source'
  sleep 2
done
```
**Expected:** Mostly `binance_ws`. If WS drops, switches to `binance_rest` temporarily, then reconnects to WS.

**Checklist:**
- [ ] Price endpoint returns current BTC price
- [ ] `source` field indicates data source (ws or rest)
- [ ] Price updates at least every 5 seconds
- [ ] REST fallback activates when WS is unavailable
- [ ] Price is within reasonable range ($50k-$150k for current market)
- [ ] Frontend displays live price updates

---

## E2E Flow Execution Summary

Run all 15 steps sequentially. Record pass/fail for each.

| Step | Description | Result | Notes |
|------|-------------|--------|-------|
| 1 | Landing page | | |
| 2 | Retail signup | | |
| 3 | Institutional signup | | |
| 4 | Firebase auth | | |
| 5 | Tier assignment | | |
| 6 | Deposit | | |
| 7 | Place bets | | |
| 8 | Settlement | | |
| 9 | Results per tier | | |
| 10 | Withdrawal (ok) | | |
| 11 | Withdrawal (blocked) | | |
| 12 | Admin override | | |
| 13 | Analytics | | |
| 14 | Music player | | |
| 15 | Price feed | | |

**Overall:** __ / 15 passed

---

## Cleanup

After E2E testing, reset staging data if needed:
```bash
# This depends on whether a reset endpoint exists
# Otherwise, redeploy the staging branch to reset the JSON database
```
