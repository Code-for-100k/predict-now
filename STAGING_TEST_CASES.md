# BTC Prediction Market - Staging Test Cases

**Environment:** https://predict-now-preview-production.up.railway.app
**Branch:** demo-prep (staging)
**Admin Secret:** `predict-now-admin-2026`
**Date:** 2026-03-25

> Extends production TEST_CASES.md (10 tests) with staging-specific API tests.
> Total: 28 test cases.

---

## Environment Setup

```bash
BASE=https://predict-now-preview-production.up.railway.app
ADMIN_SECRET=predict-now-admin-2026

# For auth-gated endpoints, obtain a Firebase ID token first:
# 1. Sign in via the UI
# 2. Open browser console: await firebase.auth().currentUser.getIdToken()
# 3. Export it:
TOKEN="<paste-firebase-id-token>"
AUTH="Authorization: Bearer $TOKEN"
```

---

## Test Summary

| # | Test | Endpoint | Method | Auth | Status |
|---|------|----------|--------|------|--------|
| 1 | Health check | `/health` | GET | No | |
| 2 | Market status (active) | `/api/market/status` | GET | No | |
| 3 | Market status (no round) | `/api/market/status` | GET | No | |
| 4 | Submit prediction (valid) | `/api/predict` | POST | Yes | |
| 5 | Submit prediction (invalid amount) | `/api/predict` | POST | Yes | |
| 6 | Submit prediction (invalid direction) | `/api/predict` | POST | Yes | |
| 7 | Submit prediction (no auth) | `/api/predict` | POST | No | |
| 8 | Submit prediction (settled round) | `/api/predict` | POST | Yes | |
| 9 | Get results by round | `/api/results/:round` | GET | No | |
| 10 | Get latest results | `/api/results/latest` | GET | No | |
| 11 | Invite code - valid retail | `/api/auth/redeem-invite` | POST | Yes | |
| 12 | Invite code - valid institutional | `/api/auth/redeem-invite` | POST | Yes | |
| 13 | Invite code - invalid code | `/api/auth/redeem-invite` | POST | Yes | |
| 14 | Invite code - already used (single-use) | `/api/auth/redeem-invite` | POST | Yes | |
| 15 | Invite code - master PREDICT-NOW | `/api/auth/redeem-invite` | POST | Yes | |
| 16 | Invite code - 11th use of 10-use | `/api/auth/redeem-invite` | POST | Yes | |
| 17 | Pool info (default) | `/api/pool-info` | GET | No | |
| 18 | Pool info per tier | `/api/pool-info?tier=retail` | GET | No | |
| 19 | Withdrawal within limit | `/api/withdraw` | POST | Yes | |
| 20 | Withdrawal exceeding deposits | `/api/withdraw` | POST | Yes | |
| 21 | Withdrawal admin override | `/api/admin/override-withdraw` | POST | Admin | |
| 22 | Admin tier breakdown | `/api/admin/tier-breakdown` | GET | Admin | |
| 23 | Admin retry-payout per tier | `/api/admin/retry-payout` | POST | Admin | |
| 24 | Analytics dashboard HTML | `/dashboard.html` | GET | No | |
| 25 | Analytics data endpoint | `/api/analytics` | GET | No | |
| 26 | History limit validation (valid) | `/api/results/history?limit=20` | GET | No | |
| 27 | History limit validation (invalid) | `/api/results/history?limit=-5` | GET | No | |
| 28 | BTC price endpoint | `/api/btc-price` | GET | No | |

---

## Production Re-run Tests (1-10)

### TC-1: Health Check
**Endpoint:** `GET /health`
**Expected:** `{"status": "ok", "timestamp": "<ISO>"}`
```bash
curl -s $BASE/health | jq '.'
```

### TC-2: Market Status - Active Round
**Endpoint:** `GET /api/market/status`
**Expected:** JSON with `status: "active"`, `round_number`, `time_remaining_ms`, pool counts.
```bash
curl -s $BASE/api/market/status | jq '.'
```

### TC-3: Market Status - No Active Round
**Endpoint:** `GET /api/market/status`
**Expected when between rounds:**
```json
{
  "status": "no_active_round",
  "next_round": "<N>",
  "next_start_time": "<ms>"
}
```

### TC-4: Submit Prediction - Valid
**Endpoint:** `POST /api/predict`
**Requires:** Firebase auth token, linked party_id, sufficient balance.
```bash
curl -X POST $BASE/api/predict \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 1, "direction": "UP"}' | jq '.'
```
**Expected:** `prediction_id`, `market_round`, `direction`, `amount`, `message`.

### TC-5: Submit Prediction - Invalid Amount
```bash
curl -X POST $BASE/api/predict \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": -50, "direction": "UP"}' | jq '.'
```
**Expected:** 400 with `{"error": "Invalid amount (must be 0.01-999999.99 CBTC)"}`

### TC-6: Submit Prediction - Invalid Direction
```bash
curl -X POST $BASE/api/predict \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 1, "direction": "LEFT"}' | jq '.'
```
**Expected:** 400 with `{"error": "Invalid direction (must be UP or DOWN)"}`

### TC-7: Submit Prediction - No Auth Token
```bash
curl -X POST $BASE/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 1, "direction": "UP"}' | jq '.'
```
**Expected:** 401 with auth error.

### TC-8: Submit Prediction - Settled Round
**Scenario:** Try to predict after round settlement.
**Expected:** 400 with `{"error": "No active market round"}` or similar.

### TC-9: Get Results by Round Number
```bash
curl -s $BASE/api/results/1 | jq '.'
```
**Expected (settled):** `round_number`, `open_price`, `close_price`, `winning_direction`, pool totals, predictions array.
**Expected (not settled/not found):** 404.

### TC-10: Get Latest Settled Round
```bash
curl -s $BASE/api/results/latest | jq '.'
```
**Expected:** Latest settled round data, or `{"error": "No settled rounds yet"}`.

---

## Staging-Specific Tests (11-28)

### TC-11: Invite Code - Valid Retail (Single-Use)
**Endpoint:** `POST /api/auth/redeem-invite`
**Precondition:** Use a fresh RET-XXXXX code.
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
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
**Verify:** User is assigned to retail tier. Subsequent call with same code returns error.

### TC-12: Invite Code - Valid Institutional
**Endpoint:** `POST /api/auth/redeem-invite`
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
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
**Verify:** Institutional codes allow up to 10 uses total.

### TC-13: Invite Code - Invalid Code
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "INVALID-CODE-12345"}' | jq '.'
```
**Expected:** 400 with `{"error": "Invalid invite code"}`

### TC-14: Invite Code - Already Used Single-Use
**Precondition:** Redeem RET-00002 once first, then try again with a different user.
```bash
# First use (succeeds)
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "RET-00002"}' | jq '.'

# Second use (should fail)
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"code": "RET-00002"}' | jq '.'
```
**Expected (2nd):** 400 with `{"error": "Invite code already used"}`

### TC-15: Invite Code - Master PREDICT-NOW
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "PREDICT-NOW"}' | jq '.'
```
**Expected:** Accepts and assigns to retail tier. Master code has unlimited uses.

### TC-16: Invite Code - 11th Use of 10-Use Institutional
**Precondition:** INST-BRAVO has been used 10 times already.
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "INST-BRAVO"}' | jq '.'
```
**Expected:** 400 with `{"error": "Invite code usage limit reached"}`

### TC-17: Pool Info - Default
```bash
curl -s $BASE/api/pool-info | jq '.'
```
**Expected:** `pool_party_id`, `fee_percentage` (default pool info).

### TC-18: Pool Info - Per Tier
```bash
# Retail tier
curl -s "$BASE/api/pool-info?tier=retail" | jq '.'

# Institutional tier
curl -s "$BASE/api/pool-info?tier=institutional" | jq '.'
```
**Expected (retail):**
```json
{
  "pool_party_id": "8324e2529b::1220efd7...",
  "fee_percentage": 10,
  "tier": "retail"
}
```
**Expected (institutional):** Returns the correct institutional pool party_id for the requesting user's assigned institutional wallet.

### TC-19: Withdrawal Within Limit
**Precondition:** User has deposited at least 1.00 CBTC and has sufficient balance.
```bash
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 0.50}' | jq '.'
```
**Expected:**
```json
{
  "txn_id": "<canton_txn_id>",
  "amount": 0.50,
  "remaining_balance": "<updated>"
}
```

### TC-20: Withdrawal Exceeding Deposits
**Precondition:** User has deposited 1.00 CBTC, won 5.00 CBTC. Attempt to withdraw 2.00 CBTC (more than deposited).
```bash
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 2.00}' | jq '.'
```
**Expected:** 400 with `{"error": "Withdrawal amount exceeds total deposits. Use admin override for winnings withdrawal."}`

### TC-21: Admin Override Withdrawal
**Requires:** Admin secret header.
```bash
curl -X POST $BASE/api/admin/override-withdraw \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{"uid": "<user-uid>", "amount": 5.00, "reason": "Winnings payout approved"}' | jq '.'
```
**Expected:**
```json
{
  "txn_id": "<canton_txn_id>",
  "amount": 5.00,
  "override": true,
  "reason": "Winnings payout approved"
}
```

### TC-22: Admin Tier Breakdown
```bash
curl -s $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: $ADMIN_SECRET" | jq '.'
```
**Expected:**
```json
{
  "retail": {
    "pool_party_id": "8324e2529b::1220efd7...",
    "total_users": 5,
    "total_deposited": 100.00,
    "total_volume": 500.00,
    "active_bets": 3
  },
  "institutional": {
    "pools": [
      {
        "code": "INST-ALPHA",
        "pool_party_id": "0afed9241a::1220320c...",
        "total_users": 2,
        "total_deposited": 1000.00,
        "total_volume": 5000.00,
        "active_bets": 1
      }
    ]
  }
}
```

### TC-23: Admin Retry-Payout Per Tier
```bash
curl -X POST $BASE/api/admin/retry-payout \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{"round_number": 5, "tier": "retail"}' | jq '.'
```
**Expected:** Retries failed payouts for the specified tier only. Returns count of retried and succeeded.

### TC-24: Analytics Dashboard HTML
```bash
curl -s -o /dev/null -w "%{http_code}" $BASE/dashboard.html
```
**Expected:** HTTP 200. Page loads with charts and analytics data.

### TC-25: Analytics Data Endpoint
```bash
curl -s $BASE/api/analytics | jq '.'
```
**Expected:** JSON with aggregated stats:
```json
{
  "total_rounds": 50,
  "total_volume": 25000.00,
  "total_users": 30,
  "total_fees_collected": 1200.00,
  "avg_pool_size": 500.00,
  "up_win_rate": 0.52,
  "by_tier": {
    "retail": { "volume": 10000.00, "users": 25 },
    "institutional": { "volume": 15000.00, "users": 5 }
  }
}
```

### TC-26: History Limit Validation - Valid
```bash
curl -s "$BASE/api/results/history?limit=5&offset=0" | jq '.'
```
**Expected:** JSON with `rounds` array (max 5), plus `total`, `limit`, `offset`, and `capped` fields.
```json
{
  "rounds": [...],
  "total": 50,
  "limit": 5,
  "offset": 0,
  "capped": false
}
```

### TC-27: History Limit Validation - Invalid
```bash
# Negative limit
curl -s "$BASE/api/results/history?limit=-5" | jq '.'

# Non-numeric limit
curl -s "$BASE/api/results/history?limit=abc" | jq '.'

# Over max limit
curl -s "$BASE/api/results/history?limit=9999" | jq '.'
```
**Expected:** 400 for negative/non-numeric with `{"error": "Invalid limit parameter"}`.
For over-max: returns capped results with `capped: true`.

### TC-28: BTC Price Endpoint (Binance + Fallback)
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
**Verify:** `source` is `binance_ws` (WebSocket) or `binance_rest` (REST fallback). Price should be within reasonable BTC range.

---

## Execution Checklist

- [ ] TC-1 through TC-10: Production regression (all pass on staging)
- [ ] TC-11 through TC-16: Invite code system (all tiers and edge cases)
- [ ] TC-17 through TC-18: Pool info per tier
- [ ] TC-19 through TC-21: Withdrawal limits and admin override
- [ ] TC-22 through TC-23: Admin tier-aware endpoints
- [ ] TC-24 through TC-25: Analytics dashboard
- [ ] TC-26 through TC-27: History limit validation
- [ ] TC-28: Price feed with fallback
