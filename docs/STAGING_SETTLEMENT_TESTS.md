# BTC Prediction Market - Staging Settlement Tests

**Environment:** https://predict-now-preview-production.up.railway.app
**Branch:** demo-prep (staging)
**Admin Secret:** `predict-now-admin-2026`
**Date:** 2026-03-25

> Extends production SETTLEMENT_TESTS.md (ST-1 through ST-6) with tier-aware settlement tests.
> Total: 9 settlement test cases.

---

## Settlement Flow (Staging)

```
1. Market round expires (15-min window closes)
2. Oracle fetches BTC price (Binance WS primary, REST fallback)
3. Settlement engine:
   a. Groups predictions by TIER (retail vs institutional)
   b. For each tier:
      - Filters predictions by winner/loser within that tier's pool
      - Calculates payouts: payout = bet + (share of loser pool x (1 - fee%))
      - Executes Canton transfers FROM that tier's pool wallet
      - Executes fee transfer to operator wallet
   c. Marks round as settled in database
4. Results available via API (with tier annotations)
5. Admin tier-breakdown endpoint updated
```

```bash
BASE=https://predict-now-preview-production.up.railway.app
ADMIN_SECRET=predict-now-admin-2026
TOKEN="<firebase-id-token>"
AUTH="Authorization: Bearer $TOKEN"
```

---

## Test Summary

| # | Test | Tier Aspect | Status |
|---|------|-------------|--------|
| ST-1 | Basic settlement (1 winner, 1 loser) | Single tier | |
| ST-2 | Multiple winners (split pool) | Single tier | |
| ST-3 | All winners (no losers) | Single tier | |
| ST-4 | All losers (no winners) | Single tier | |
| ST-5 | Unequal distribution | Single tier | |
| ST-6 | Decimal precision | Single tier | |
| ST-7 | Settlement with tier-segregated pools | Multi-tier | |
| ST-8 | Retry-payout with tier awareness | Multi-tier | |
| ST-9 | Settlement when only one tier has bets | Mixed | |

---

## Production Settlement Tests (ST-1 to ST-6) - Re-run on Staging

All 6 production settlement tests from SETTLEMENT_TESTS.md apply. Key staging differences:
- Predictions are now tagged with a `tier` field
- Payouts execute from the user's tier-specific pool wallet
- Fee transfers still go to the single operator wallet

**Re-run verification for ST-1 through ST-6:**
```bash
# After a round settles, verify basic settlement math
curl -s $BASE/api/results/latest | jq '{
  winning_direction,
  total_up: .total_up_amount,
  total_down: .total_down_amount,
  fee: .fee_collected,
  num_predictions: (.predictions | length)
}'
```

---

## Staging Settlement Tests (ST-7 to ST-9)

### ST-7: Settlement with Tier-Segregated Pools

**Scenario:** Both retail and institutional users bet in the same round. Settlement must process each tier independently against its own pool wallet.

**Setup:**
- Retail user Alice (RET-XXXXX): 100 CBTC on UP
- Retail user Bob (RET-XXXXX): 50 CBTC on DOWN
- Institutional user Carol (INST-ALPHA): 500 CBTC on UP
- Institutional user Dave (INST-ALPHA): 300 CBTC on DOWN
- BTC goes UP (UP wins)

**Expected Retail Settlement:**
```
Retail Pool Wallet: 8324e2529b::1220efd7...
Winner Pool (UP): 100
Loser Pool (DOWN): 50
Fee: 50 x 0.10 = 5
Payout Pool: 50 - 5 = 45

Alice Payout: 100 + 45 = 145 (from retail pool)
Bob: loses 50
Fee: 5 to operator
```

**Expected Institutional Settlement:**
```
Institutional Pool Wallet: 0afed9241a::1220320c... (INST-ALPHA)
Winner Pool (UP): 500
Loser Pool (DOWN): 300
Fee: 300 x 0.10 = 30
Payout Pool: 300 - 30 = 270

Carol Payout: 500 + 270 = 770 (from INST-ALPHA pool)
Dave: loses 300
Fee: 30 to operator
```

**Critical checks:**
- Alice's payout comes from retail pool wallet, NOT institutional
- Carol's payout comes from INST-ALPHA pool wallet, NOT retail
- No funds cross between tiers
- Retail losers only subsidize retail winners
- Institutional losers only subsidize institutional winners

**Verification:**
```bash
# Check results with tier info
curl -s $BASE/api/results/latest | jq '.predictions[] | {party_id, tier, direction, amount, won}'

# Check tier breakdown
curl -s $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: $ADMIN_SECRET" | jq '.'
```

**Tier isolation test:**
```bash
# Verify retail pool balance changed by retail settlement only
# Verify institutional pool balance changed by institutional settlement only
# Compare pre/post settlement balances for each pool wallet
```

---

### ST-8: Retry-Payout with Tier Awareness

**Scenario:** Settlement partially fails. Some payouts in the retail tier succeed, but one in the institutional tier fails (Canton API transient error). Admin retries failed payouts for a specific tier.

**Setup:**
1. Round settles. 3 retail winners paid successfully. 1 institutional winner's payout fails.
2. Admin checks for failed payouts.
3. Admin retries payout for institutional tier only.

**Step 1: Identify failed payouts**
```bash
curl -s $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: $ADMIN_SECRET" | jq '.'

# Or check specific round for unsettled predictions
curl -s "$BASE/api/results/latest" | jq '.predictions[] | select(.settled == false)'
```

**Step 2: Retry payout for institutional tier only**
```bash
curl -X POST $BASE/api/admin/retry-payout \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{"round_number": 5, "tier": "institutional"}' | jq '.'
```

**Expected Response:**
```json
{
  "round_number": 5,
  "tier": "institutional",
  "retried": 1,
  "succeeded": 1,
  "failed": 0,
  "details": [
    {
      "party_id": "...",
      "amount": 770,
      "txn_id": "<new_txn_id>",
      "status": "success"
    }
  ]
}
```

**Critical checks:**
- Retry only processes the specified tier
- Retail payouts (already settled) are not re-executed
- Only unsettled predictions in the target tier are retried
- Retry uses the correct tier pool wallet as the source
- No duplicate payments (idempotency on prediction.settled flag)

**Step 3: Verify no double-payment**
```bash
# After retry, check that settled predictions are not retried again
curl -X POST $BASE/api/admin/retry-payout \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{"round_number": 5, "tier": "institutional"}' | jq '.'
```
**Expected:** `retried: 0` (all already settled).

**Step 4: Retry all tiers**
```bash
curl -X POST $BASE/api/admin/retry-payout \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{"round_number": 5}' | jq '.'
```
**Expected:** Retries all unsettled predictions across all tiers.

---

### ST-9: Settlement When Only One Tier Has Bets

**Scenario:** A round where only retail users placed bets. No institutional bets exist. Settlement should process the retail tier normally and skip the institutional tier entirely.

**Setup:**
- Retail user Alice: 100 CBTC on UP
- Retail user Bob: 200 CBTC on DOWN
- No institutional users bet this round
- BTC goes DOWN (DOWN wins)

**Expected:**
```
Retail Settlement:
  Winner Pool (DOWN): 200 (Bob)
  Loser Pool (UP): 100 (Alice)
  Fee: 100 x 0.10 = 10
  Payout Pool: 100 - 10 = 90

  Bob Payout: 200 + 90 = 290 (from retail pool)
  Alice: loses 100
  Fee: 10 to operator

Institutional Settlement:
  No bets. Skip entirely. No errors.
```

**Verification:**
```bash
curl -s $BASE/api/results/latest | jq '{
  winning_direction,
  predictions: [.predictions[] | {party_id, tier, amount, won}]
}'
```

**Expected output:**
```json
{
  "winning_direction": "DOWN",
  "predictions": [
    {"party_id": "...", "tier": "retail", "amount": 200, "won": true},
    {"party_id": "...", "tier": "retail", "amount": 100, "won": false}
  ]
}
```

**Critical checks:**
- No errors thrown when a tier has zero bets
- Settlement completes successfully for the active tier
- No phantom transactions on institutional pool wallets
- Admin tier-breakdown correctly shows zero activity for institutional

```bash
curl -s $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: $ADMIN_SECRET" | jq '.institutional'
```
**Expected:** `active_bets: 0` or empty pools for this round.

---

## Settlement Math Verification Script

Use this script to verify settlement calculations for any round:

```bash
#!/bin/bash
BASE=https://predict-now-preview-production.up.railway.app
ROUND=${1:-"latest"}

echo "=== Settlement Verification: Round $ROUND ==="
RESULT=$(curl -s "$BASE/api/results/$ROUND")

DIRECTION=$(echo $RESULT | jq -r '.winning_direction')
UP_TOTAL=$(echo $RESULT | jq '.total_up_amount')
DOWN_TOTAL=$(echo $RESULT | jq '.total_down_amount')
FEE=$(echo $RESULT | jq '.fee_collected')

echo "Direction: $DIRECTION"
echo "UP Pool:   $UP_TOTAL"
echo "DOWN Pool: $DOWN_TOTAL"
echo "Fee:       $FEE"

if [ "$DIRECTION" = "UP" ]; then
  WINNER_POOL=$UP_TOTAL
  LOSER_POOL=$DOWN_TOTAL
else
  WINNER_POOL=$DOWN_TOTAL
  LOSER_POOL=$UP_TOTAL
fi

EXPECTED_FEE=$(echo "$LOSER_POOL * 0.10" | bc)
echo ""
echo "Expected fee (10% of loser pool): $EXPECTED_FEE"
echo "Actual fee:                       $FEE"

if [ "$EXPECTED_FEE" = "$FEE" ]; then
  echo "FEE CHECK: PASS"
else
  echo "FEE CHECK: FAIL"
fi

PAYOUT_POOL=$(echo "$LOSER_POOL - $FEE" | bc)
echo "Payout pool (loser - fee):        $PAYOUT_POOL"

echo ""
echo "Predictions:"
echo $RESULT | jq '.predictions[] | "\(.party_id) | \(.direction) | \(.amount) | won=\(.won) | tier=\(.tier // "unknown")"'
```

---

## Verification Checklist

### Pre-Settlement:
- [ ] Both retail and institutional users have placed bets
- [ ] Bets are tagged with correct tier in the database
- [ ] Pool wallets have sufficient balance for payouts

### Post-Settlement:
- [ ] Retail payouts sourced from retail pool wallet
- [ ] Institutional payouts sourced from correct institutional pool wallet
- [ ] Fee collected from each tier independently
- [ ] No cross-tier fund leakage
- [ ] All winners marked as `settled: true`
- [ ] Results API returns tier annotations on predictions
- [ ] Admin tier-breakdown reflects post-settlement state

### Retry-Payout:
- [ ] Retry targets specific tier when specified
- [ ] Retry targets all tiers when tier is omitted
- [ ] No duplicate payments on retry
- [ ] Uses correct pool wallet per tier
- [ ] Failed retries logged with error details
