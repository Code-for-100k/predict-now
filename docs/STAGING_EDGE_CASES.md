# BTC Prediction Market - Staging Edge Cases

**Environment:** https://predict-now-preview-production.up.railway.app
**Branch:** demo-prep (staging)
**Date:** 2026-03-25

> Extends production EDGE_CASES.md (EC-1 through EC-32) with staging-specific edge cases.
> Total: 50 edge cases (32 inherited + 18 new).

---

## Summary

| Range | Category | Source |
|-------|----------|--------|
| EC-1 to EC-32 | Production edge cases | EDGE_CASES.md (re-run as-is against staging URL) |
| EC-33 to EC-38 | Invite code edge cases | Staging |
| EC-39 to EC-43 | Withdrawal edge cases | Staging |
| EC-44 to EC-46 | Deposit edge cases | Staging |
| EC-47 to EC-50 | Tier routing edge cases | Staging |

```bash
BASE=https://predict-now-preview-production.up.railway.app
ADMIN_SECRET=$ADMIN_SECRET
TOKEN="<firebase-id-token>"
AUTH="Authorization: Bearer $TOKEN"
```

---

## Production Edge Cases (EC-1 to EC-32) - Re-run on Staging

All 32 production edge cases from EDGE_CASES.md must pass on staging. Replace `http://localhost:3000` with `$BASE` in all curl commands. Key changes:

- EC-4 through EC-8 now require Firebase auth token (POST /api/predict is auth-gated)
- EC-21 rapid-fire tests need auth headers on each request
- EC-23 server restart not applicable to Railway (skip or test via Railway CLI redeploy)

---

## Invite Code Edge Cases (EC-33 to EC-38)

### EC-33: Empty Invite Code
**Test:** Submit empty string as invite code.
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": ""}' | jq '.'
```
**Expected:** 400 with `{"error": "Missing or invalid invite code"}`
**Why Important:** Validation catches empty input before DB lookup.

### EC-34: Already-Used Single-Use Retail Code
**Precondition:** RET-00010 was redeemed by user A.
**Test:** User B tries to redeem same code.
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_USER_B" \
  -d '{"code": "RET-00010"}' | jq '.'
```
**Expected:** 400 with `{"error": "Invite code already used"}`
**Why Important:** Single-use enforcement is critical for retail codes.

### EC-35: 11th Use of 10-Use Institutional Code
**Precondition:** INST-CHARLIE has been redeemed by 10 different users.
**Test:** 11th user attempts redemption.
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_USER_11" \
  -d '{"code": "INST-CHARLIE"}' | jq '.'
```
**Expected:** 400 with `{"error": "Invite code usage limit reached"}`
**Why Important:** Institutional codes have a hard cap at 10 uses.

### EC-36: SQL Injection in Invite Code
**Test:** Attempt SQL injection via invite code field.
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "RET-00001'\'' OR 1=1; --"}' | jq '.'

curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "INST-ALPHA\"; DROP TABLE invite_codes; --"}' | jq '.'
```
**Expected:** 400 with "Invalid invite code" (not a SQL error). No data corruption.
**Why Important:** Invite codes are user-supplied strings that hit the database.

### EC-37: Master Code PREDICT-NOW - Unlimited Uses
**Test:** Redeem PREDICT-NOW with 5 different users sequentially.
```bash
for i in 1 2 3 4 5; do
  echo "--- User $i ---"
  curl -X POST $BASE/api/auth/redeem-invite \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN_USER_$i" \
    -d '{"code": "PREDICT-NOW"}' | jq '.tier'
done
```
**Expected:** All 5 succeed. Master code has no use limit.
**Why Important:** Master code is the demo fallback; must never exhaust.

### EC-38: Invite Code Case Sensitivity
**Test:** Submit codes with wrong casing.
```bash
# Lowercase
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "predict-now"}' | jq '.'

# Mixed case
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "Inst-Alpha"}' | jq '.'

# All caps (correct)
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "INST-ALPHA"}' | jq '.'
```
**Expected:** Only exact case match succeeds (or document if case-insensitive).
**Why Important:** Determine and verify whether matching is case-sensitive.

---

## Withdrawal Edge Cases (EC-39 to EC-43)

### EC-39: Concurrent Withdrawal Race Condition
**Test:** Fire two withdrawals simultaneously for the same user.
```bash
# User has balance of 1.00 CBTC
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 0.80}' &

curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 0.80}' &

wait
```
**Expected:** Only one succeeds (concurrent lock). The second returns 409 or 400. User balance never goes negative.
**Why Important:** Staging adds concurrent withdrawal lock to prevent double-spend.

### EC-40: Withdrawal Over Deposit Limit
**Precondition:** User deposited 2.00 CBTC, won 10.00 CBTC (balance = 12.00).
**Test:** Attempt to withdraw 3.00 CBTC (exceeds 2.00 deposit total).
```bash
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 3.00}' | jq '.'
```
**Expected:** 400 with error indicating withdrawal exceeds total deposits. Winnings require admin override.
**Why Important:** Staging adds deposit-capped withdrawals for security.

### EC-41: Withdrawal at Exact Deposit Limit
**Precondition:** User deposited exactly 5.00 CBTC.
**Test:** Withdraw exactly 5.00 CBTC.
```bash
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 5.00}' | jq '.'
```
**Expected:** Succeeds. Exact match of deposit total is allowed.
**Why Important:** Boundary condition: equal-to should pass, greater-than should fail.

### EC-42: Admin Override With Correct Secret
```bash
curl -X POST $BASE/api/admin/override-withdraw \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{"uid": "<target-uid>", "amount": 10.00, "reason": "Approved winnings"}' | jq '.'
```
**Expected:** Succeeds regardless of deposit limit. Transaction ID returned.
**Why Important:** Admin override is the escape hatch for legitimate winnings withdrawal.

### EC-43: Admin Override Without Secret
```bash
# Missing header entirely
curl -X POST $BASE/api/admin/override-withdraw \
  -H "Content-Type: application/json" \
  -d '{"uid": "<target-uid>", "amount": 10.00, "reason": "Hack attempt"}' | jq '.'

# Wrong secret
curl -X POST $BASE/api/admin/override-withdraw \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: wrong-secret" \
  -d '{"uid": "<target-uid>", "amount": 10.00, "reason": "Hack attempt"}' | jq '.'
```
**Expected:** Both return 401/403 unauthorized. No withdrawal executes.
**Why Important:** Admin endpoints must be protected.

---

## Deposit Edge Cases (EC-44 to EC-46)

### EC-44: Deposit Deduplication (updateId)
**Scenario:** Same pending transfer appears in two consecutive deposit calls.
```bash
# Call deposit twice rapidly
curl -X POST $BASE/api/deposit \
  -H "Content-Type: application/json" \
  -H "$AUTH" | jq '.'

# Wait 11 seconds (past rate limit)
sleep 11

curl -X POST $BASE/api/deposit \
  -H "Content-Type: application/json" \
  -H "$AUTH" | jq '.'
```
**Expected:** Second call credits 0 (transfer already accepted and recorded via contract_id dedup). Balance does not double-credit.
**Why Important:** Staging fixes updateId dedup to prevent double-crediting deposits.

### EC-45: Deposit Auto-Retry (3x)
**Scenario:** Canton API returns transient error during deposit accept.
**Test:** This is best verified via server logs. Trigger a deposit when Canton API is temporarily slow.
```bash
curl -X POST $BASE/api/deposit \
  -H "Content-Type: application/json" \
  -H "$AUTH" | jq '.'
```
**Expected behavior in logs:**
```
  Deposit accept attempt 1/3 failed: timeout
  Deposit accept attempt 2/3 failed: timeout
  Deposit accept attempt 3/3: success
  Deposit accepted: 1.00 CBTC from <party>
```
**Why Important:** Staging adds auto-retry 3x for transient Canton API failures.

### EC-46: Deposit with beginOffset
**Scenario:** Large number of pending transfers in the Canton ledger. The beginOffset parameter ensures pagination works.
```bash
# Trigger deposit — server internally uses beginOffset to paginate
curl -X POST $BASE/api/deposit \
  -H "Content-Type: application/json" \
  -H "$AUTH" | jq '.transfers_found'
```
**Expected:** Server correctly paginates through all pending transfers, not just the first page.
**Why Important:** Staging adds beginOffset to handle Canton's paginated pending transfers API.

---

## Tier Routing Edge Cases (EC-47 to EC-50)

### EC-47: Retail User Routes to Retail Pool
**Precondition:** User signed up with retail invite code (RET-XXXXX).
**Test:** Check that deposits are accepted by the retail pool wallet.
```bash
# Verify user's tier
curl -s $BASE/api/auth/me \
  -H "$AUTH" | jq '.tier'
# Expected: "retail"

# Deposit goes to retail pool
curl -X POST $BASE/api/deposit \
  -H "Content-Type: application/json" \
  -H "$AUTH" | jq '.'
```
**Expected:** Deposit accepted by pool `8324e2529b::1220efd7...`. No cross-contamination with institutional pools.

### EC-48: Institutional User Routes to Correct Pool
**Precondition:** User signed up with INST-ALPHA.
```bash
curl -s $BASE/api/auth/me \
  -H "Authorization: Bearer $TOKEN_INST" | jq '.tier, .pool_party_id'
```
**Expected:** `tier: "institutional"`, `pool_party_id: "0afed9241a::1220320c..."` (INST-ALPHA pool).

### EC-49: Cross-Tier Isolation - Bets
**Scenario:** Retail and institutional users bet in the same round.
**Test:** After settlement, verify:
1. Retail bets are settled against the retail pool
2. Institutional bets are settled against their respective institutional pool
3. No fund mixing between tiers
```bash
# Check results with tier info
curl -s $BASE/api/results/latest | jq '.predictions[] | {party_id, tier, amount, won}'
```
**Expected:** Each prediction tagged with correct tier. Payouts come from the user's own tier pool.

### EC-50: Tier Assignment Persistence
**Test:** Redeem invite code, log out, log back in, verify tier is still assigned.
```bash
# Step 1: Redeem code
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "PREDICT-NOW"}' | jq '.tier'

# Step 2: Re-auth (simulate re-login)
curl -X POST $BASE/api/auth/verify \
  -H "Content-Type: application/json" \
  -H "$AUTH" | jq '.tier'
```
**Expected:** Tier persists across sessions. Not re-assignable.

---

## Critical Staging Edge Cases Summary

| Priority | Edge Case | Risk |
|----------|-----------|------|
| P0 | EC-39: Concurrent withdrawal (double-spend) | Financial loss |
| P0 | EC-40: Withdrawal over deposit limit | Unauthorized fund extraction |
| P0 | EC-36: SQL injection in invite code | Data breach |
| P0 | EC-44: Deposit dedup (double-credit) | Financial discrepancy |
| P1 | EC-35: Institutional code 11th use | Access control bypass |
| P1 | EC-43: Admin override without secret | Unauthorized admin action |
| P1 | EC-49: Cross-tier isolation | Fund mixing |
| P2 | EC-37: Master code unlimited | Demo reliability |
| P2 | EC-38: Case sensitivity | UX confusion |
| P2 | EC-45: Auto-retry | Deposit reliability |
