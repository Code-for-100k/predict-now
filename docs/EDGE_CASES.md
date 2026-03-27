# BTC Prediction Market - Edge Cases & Boundary Tests

## Numerical Edge Cases

### EC-1: Minimum Amount (0.01 CC)
**Test:** Submit prediction with smallest decimal amount
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 0.01, "direction": "UP", "party_id": "party::micro_user"}'
```
**Expected:** Accept and register (amount > 0)
**Why Important:** Verify decimal precision doesn't break system

### EC-2: Very Large Amount (999999.99 CC)
**Test:** Submit prediction with extremely large amount
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 999999.99, "direction": "DOWN", "party_id": "party::whale"}'
```
**Expected:** Accept and register
**Why Important:** No arbitrary limits on bet size

### EC-3: Exact Boundary (amount = 0)
**Test:** Submit with amount exactly 0
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 0, "direction": "UP", "party_id": "party::test"}'
```
**Expected:** Reject with "Invalid amount"
**Why Important:** Should not allow zero bets

### EC-4: Floating Point Precision
**Scenario:** Multiple predictions that don't divide evenly
- UP pool: 100 CC (3 users betting 33.33, 33.33, 33.34)
- DOWN pool: 50 CC (loses)
- Fee: 10% = 5 CC
- Payout pool: 45 CC
- Per UP CC: 45/100 = 0.45

**Expected:** Payouts calculated correctly without rounding errors
**Why Important:** Verify decimal handling in payout calculations

---

## Party ID Edge Cases

### EC-5: Party ID with Special Characters
**Test:** Use various party ID formats
```bash
# With dots and colons (valid Canton format)
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::user.sub::123-abc"}'
```
**Expected:** Accept if format is valid string
**Why Important:** Canton uses :: and other characters in IDs

### EC-6: Empty Party ID
**Test:** Submit with empty string
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": ""}'
```
**Expected:** Reject - "Missing or invalid party_id"
**Why Important:** Validation catches empty IDs

### EC-7: Very Long Party ID
**Test:** Submit with 1000+ character party ID
```bash
LONG_ID="party::$(python3 -c 'print("x" * 1000)')"
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d "{\"amount\": 100, \"direction\": \"UP\", \"party_id\": \"$LONG_ID\"}"
```
**Expected:** Accept (should be no artificial limit)
**Why Important:** Some IDs may be long in production

### EC-8: Duplicate Party IDs in Same Round
**Scenario:** Same user submits multiple predictions
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::alice"}'

curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 50, "direction": "UP", "party_id": "party::alice"}'
```
**Expected:** Both register successfully (no single-bet-per-user limit)
**Why Important:** User should be able to bet multiple times

---

## Direction Edge Cases

### EC-9: Case Sensitivity
**Test:** Submit with lowercase direction
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "up", "party_id": "party::test"}'
```
**Expected:** Reject - "Invalid direction" (system is case-sensitive)
**Why Important:** Ensure consistent direction format

### EC-10: Whitespace in Direction
**Test:** Submit with spaces
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": " UP ", "party_id": "party::test"}'
```
**Expected:** Reject - "Invalid direction"
**Why Important:** Validate exact string matching

---

## Round/Settlement Edge Cases

### EC-11: Predict on Expired Round (Just Before Expiry)
**Scenario:** Submit prediction with <1 second remaining
```bash
# Get current round info
ROUND_INFO=$(curl -s http://localhost:3000/api/market/status)
TIME_REMAINING=$(echo $ROUND_INFO | jq '.time_remaining_ms')

echo "Time remaining: ${TIME_REMAINING}ms"

# If time_remaining > 500ms, submit prediction
if [ ${TIME_REMAINING} -gt 500 ]; then
  curl -X POST http://localhost:3000/api/predict \
    -H "Content-Type: application/json" \
    -d '{"amount": 100, "direction": "UP", "party_id": "party::last_second"}'
fi
```
**Expected:** Accept if window still open, reject if expired
**Why Important:** Time boundary validation

### EC-12: Predict After Round Settles
**Scenario:** Round has been settled, try to submit
**Expected:** Reject - "Market round already settled"
**Why Important:** Prevent bets on closed rounds

### EC-13: No Active Round
**Scenario:** All rounds settled, scheduler hasn't created new one yet
```bash
curl -s http://localhost:3000/api/market/status | jq '.status'
```
**Expected:** May be "no_active_round"
If so:
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::test"}'
```
**Expected:** Reject - "No active market round"
**Why Important:** Prevent orphaned predictions

---

## Settlement Edge Cases

### EC-14: All Winners (No Losers)
**Scenario:** All predictions in winning direction
- UP pool: 500 CC (all winners)
- DOWN pool: 0 CC (no losers)
- Expected fee: 0 (can't take fee from empty pool)

**Test:** After settlement check:
```bash
curl -s http://localhost:3000/api/results/latest | jq '.fee_collected'
```
**Expected:** 0
**Why Important:** No invalid negative numbers

### EC-15: Split with Decimal Remainder
**Scenario:** Uneven payout distribution
- 3 winners: 100, 200, 300 (total 600)
- Losing pool: 1000 CC
- Fee: 10% = 100 CC
- Distribute: 900 / 600 = 1.5 per CC bet
- Payouts: 250, 500, 750

**Expected:** All amounts correct to 2 decimal places
**Why Important:** Verify rounding strategy is consistent

### EC-16: Single Prediction Only
**Scenario:** Market with only 1 prediction
- UP: 100 CC (1 user - WINS)
- DOWN: 0 CC (no users)
- Fee: 0
- Winner: Gets original 100 back

**Test:**
```bash
# Get latest results
curl -s http://localhost:3000/api/results/latest | jq '.predictions'
```
**Expected:** 1 winner with amount = original bet
**Why Important:** Edge case of minimal market

### EC-17: Very Unbalanced Pools
**Scenario:** Extreme imbalance
- UP: 10000 CC (wins)
- DOWN: 1 CC (loses)
- Fee: 10% of 1 = 0.1 CC
- Winner payout: 0.9 CC

**Expected:** Handles extreme ratios without overflow/underflow
**Why Important:** Numerical stability

---

## API Response Edge Cases

### EC-18: Get Non-Existent Round
**Test:**
```bash
curl -s http://localhost:3000/api/results/999999 | jq '.'
```
**Expected:** `{"error": "Round not found or not settled"}`
**Why Important:** Graceful 404 handling

### EC-19: Get Results for Round Still Active
**Scenario:** Try to get settled results for active round
```bash
ACTIVE_ROUND=$(curl -s http://localhost:3000/api/market/status | jq '.round_number')
curl -s "http://localhost:3000/api/results/${ACTIVE_ROUND}" | jq '.'
```
**Expected:** `{"error": "Round not found or not settled"}`
**Why Important:** Can't return results for unsettled rounds

### EC-20: Latest Results When No Rounds Settled
**Test:**
```bash
curl -s http://localhost:3000/api/results/latest | jq '.'
```
**Expected:** `{"error": "No settled rounds yet"}`
**Why Important:** Handle empty results gracefully

---

## Concurrent Request Edge Cases

### EC-21: Rapid-Fire Predictions (Race Condition)
**Test:** Submit 10 predictions simultaneously
```bash
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/predict \
    -H "Content-Type: application/json" \
    -d "{\"amount\": $((RANDOM % 100 + 1)), \"direction\": \"$([ $((RANDOM % 2)) -eq 0 ] && echo 'UP' || echo 'DOWN')\", \"party_id\": \"party::rapid_$i\"}" &
done
wait

# Verify all registered
curl -s http://localhost:3000/api/market/status | jq '.up_predictions, .down_predictions'
```
**Expected:** All 10 register without data corruption
**Why Important:** Database consistency under load

### EC-22: Duplicate Request (Retransmission)
**Scenario:** Same prediction submitted twice
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::duplicate"}'

# Retry same request
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::duplicate"}'
```
**Expected:** Both register as separate predictions (no deduplication)
**Why Important:** Idempotency consideration

---

## Data Persistence Edge Cases

### EC-23: Server Restart Preserves Data
**Scenario:** Stop and restart server, check data persistence
```bash
# 1. Submit prediction
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::persist"}'

# 2. Get current status
STATUS_BEFORE=$(curl -s http://localhost:3000/api/market/status)

# 3. Kill server (Ctrl+C or pkill)
pkill -f "tsx src/market.ts"

# 4. Restart server
npm run market &
sleep 4

# 5. Check data restored
STATUS_AFTER=$(curl -s http://localhost:3000/api/market/status)

echo "Before: $(echo $STATUS_BEFORE | jq '.up_amount')"
echo "After: $(echo $STATUS_AFTER | jq '.up_amount')"
```
**Expected:** Data persists across restarts
**Why Important:** JSON database should save/restore correctly

---

## Frontend Edge Cases

### EC-24: Very Long Party ID Display
**Scenario:** Predictions with 100+ character party IDs
**Expected:** Results page displays full ID or truncates gracefully
**Why Important:** UI should handle long strings

### EC-25: Rapid Updates (Fast Refreshing)
**Scenario:** Frontend auto-refreshing while user is reading results
**Expected:** Page updates smoothly without flickering or losing focus
**Why Important:** UX should be smooth

### EC-26: Lots of Winners/Losers Display
**Scenario:** 100 predictions split equally between winners and losers
**Expected:** Results page displays all 50 winners and 50 losers in scrollable container
**Why Important:** Performance with large result sets

---

## Price Oracle Edge Cases

### EC-27: Binance API Unavailable
**Scenario:** Network fails when fetching BTC price
**Expected:** Settlement still executes (uses fallback or last known price)
**Why Important:** Graceful degradation

### EC-28: Zero or Negative Price from Oracle
**Scenario:** Malformed Binance response
**Expected:** System rejects invalid prices, doesn't settle
**Why Important:** Data validation

---

## Calculation Edge Cases

### EC-29: 100% Fee Scenario
**Scenario:** If fee percentage was 100%
- Losing pool: 100 CC
- Fee: 100 CC
- Payout pool: 0 CC
- Winners get: Nothing

**Expected:** Handle gracefully (even if fee config is insane)
**Why Important:** No division by zero

### EC-30: Precision Loss in Division
**Scenario:** Payout distribution that doesn't divide evenly
- 3 winners: 1 CC, 1 CC, 1 CC (total 3)
- Loser pool: 100 CC
- Fee: 10% = 10 CC
- Distribute: 90 / 3 = 30 per winner

**Expected:** Each gets exactly 30 CC (or proper rounding documented)
**Why Important:** Verify no one gets shortchanged

---

## Validation Edge Cases

### EC-31: Missing Request Fields
Test each field missing individually:

```bash
# Missing amount
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"direction": "UP", "party_id": "party::test"}'
# Expected: error

# Missing direction
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "party_id": "party::test"}'
# Expected: error

# Missing party_id
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP"}'
# Expected: error
```
**Expected:** Clear error for each
**Why Important:** Field validation completeness

### EC-32: Wrong Data Types
```bash
# amount as string
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": "one hundred", "direction": "UP", "party_id": "party::test"}'

# direction as array
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": ["UP"], "party_id": "party::test"}'
```
**Expected:** Type validation catches these
**Why Important:** API robustness

---

## Summary: Critical Edge Cases to Test
1. ✅ EC-4: Floating point precision in payouts
2. ✅ EC-8: Duplicate party IDs (same user multiple bets)
3. ✅ EC-14: All winners (zero losers)
4. ✅ EC-21: Rapid concurrent predictions
5. ✅ EC-23: Data persistence after restart
6. ✅ EC-30: Uneven payout distribution
