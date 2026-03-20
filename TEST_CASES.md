# BTC Prediction Market - Test Cases

## Test Environment Setup
- Server running on `http://localhost:3000`
- Test market database at `./market.db`
- Pool wallet pre-funded with test CC
- All timestamps in milliseconds (Unix epoch)

---

## API Endpoint Tests

### 1. Health Check
**Endpoint:** `GET /health`
**Expected:** Returns `{"status": "ok", "timestamp": "ISO_STRING"}`
```bash
curl -s http://localhost:3000/health | jq '.'
```

### 2. Market Status - Active Round
**Endpoint:** `GET /api/market/status`
**Expected when active:**
```json
{
  "status": "active",
  "round_number": 1,
  "window_start_ms": 1773690252870,
  "window_end_ms": 1773691152870,
  "time_remaining_ms": 576143,
  "up_predictions": 1,
  "down_predictions": 0,
  "up_amount": 100,
  "down_amount": 0
}
```
```bash
curl -s http://localhost:3000/api/market/status | jq '.'
```

### 3. Market Status - No Active Round
**Endpoint:** `GET /api/market/status`
**Expected when no active round:**
```json
{
  "status": "no_active_round",
  "next_round": 2,
  "next_start_time": 1773691152870
}
```

### 4. Submit Prediction - Valid
**Endpoint:** `POST /api/predict`
**Request Body:**
```json
{
  "amount": 100,
  "direction": "UP",
  "party_id": "party::user_1"
}
```
**Expected Response:**
```json
{
  "prediction_id": 1,
  "market_round": 1,
  "direction": "UP",
  "amount": 100,
  "party_id": "party::user_1",
  "message": "Prediction registered successfully"
}
```
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::user_1"}' | jq '.'
```

### 5. Submit Prediction - Invalid Amount
**Request:** `{"amount": -50, "direction": "UP", "party_id": "party::user_1"}`
**Expected:** `{"error": "Invalid amount"}`

### 6. Submit Prediction - Invalid Direction
**Request:** `{"amount": 100, "direction": "LEFT", "party_id": "party::user_1"}`
**Expected:** `{"error": "Invalid direction"}`

### 7. Submit Prediction - Missing Party ID
**Request:** `{"amount": 100, "direction": "UP"}`
**Expected:** `{"error": "Missing or invalid party_id"}`

### 8. Submit Prediction - Settled Round
**Scenario:** Try to submit prediction for a settled round
**Expected:** `{"error": "Market round already settled"}`

### 9. Get Results by Round Number
**Endpoint:** `GET /api/results/:roundNumber`
**Example:** `GET /api/results/1`
**Expected (when settled):**
```json
{
  "round_number": 1,
  "open_price": 74145.96,
  "close_price": 73963,
  "winning_direction": "DOWN",
  "total_up_amount": 150,
  "total_down_amount": 100,
  "fee_collected": 10,
  "predictions": [
    {
      "party_id": "party::user_1",
      "direction": "DOWN",
      "amount": 100,
      "won": true,
      "payout_txn_id": "txn_abc123"
    },
    {
      "party_id": "party::user_2",
      "direction": "UP",
      "amount": 150,
      "won": false,
      "payout_txn_id": null
    }
  ]
}
```

### 10. Get Latest Settled Round
**Endpoint:** `GET /api/results/latest`
**Expected (when no settled rounds):** `{"error": "No settled rounds yet"}`
**Expected (when settled):** Same as Test 9

---

## Market Mechanics Tests

### Test Case A: Single Prediction (UP Wins)
**Setup:**
1. Market round active with 15-min window
2. User submits: `{amount: 100, direction: "UP", party_id: "alice"}`

**Oracle Behavior:**
- Opening price: $74,000
- Closing price: $74,100 (UP wins)

**Expected Result:**
- Alice's prediction marked as `won: true`
- Alice receives payout
- Market DB shows `winning_direction: "UP"`

**Verification:**
```bash
curl -s http://localhost:3000/api/results/latest | jq '.predictions[] | select(.party_id == "alice")'
```

### Test Case B: Multiple Predictions (DOWN Wins)
**Setup:**
1. User A: `{amount: 100, direction: "UP", party_id: "alice"}`
2. User B: `{amount: 150, direction: "DOWN", party_id: "bob"}`
3. User C: `{amount: 50, direction: "UP", party_id: "charlie"}`

**Oracle Behavior:**
- Opening: $74,000
- Closing: $73,900 (DOWN wins)

**Expected Results:**
- UP pool: 150 CC (100 + 50) - LOSES
- DOWN pool: 150 CC (150) - WINS
- Fee (10%): 15 CC from losing pool = 15 CC
- Remaining for winners: 150 - 15 = 135 CC
- Bob receives: 135 CC (sole winner)

**Verification:**
```bash
curl -s http://localhost:3000/api/results/latest | jq '.'
```

### Test Case C: Continuous Betting (No Wait Requirement)
**Setup:**
1. T=0s: User A bets 100 UP
2. T=5s: User B bets 150 DOWN
3. T=10s: User C bets 50 UP
4. T=14m59s: Round ends automatically (no user action needed)

**Expected:**
- All three bets registered in same round
- Settlement runs autonomously
- Winners paid automatically

**Verification:**
```bash
# Check all predictions in round
curl -s http://localhost:3000/api/market/status | jq '.up_predictions, .down_predictions'
```

### Test Case D: Fee Collection
**Setup:**
- UP pool: 200 CC (loses)
- DOWN pool: 300 CC (wins)
- Fee percentage: 10%

**Calculation:**
- Fee from loser pool: 200 × 0.10 = 20 CC
- Winners share: 200 - 20 = 180 CC
- Distribution: 180 / 300 = 0.6 per CC wagered
- Winner receives: 300 × 0.6 = 180 CC

**Expected in Results:**
```json
{
  "total_up_amount": 200,
  "total_down_amount": 300,
  "fee_collected": 20,
  "predictions": [
    {"party_id": "winner", "amount": 300, "won": true}
  ]
}
```

---

## Settlement Logic Tests

### Test Case E: Zero Fee Scenario
**Setup:**
- All predictions in winning direction
- No losing predictions
- Expected fee: 0 CC

**Oracle:** Any direction change
**Verification:** `fee_collected` should be 0

### Test Case F: Split Winners
**Setup:**
- 3 winners with amounts: 100, 200, 300 (total 600)
- Losing pool: 400 CC
- Fee: 10% = 40 CC
- Payout pool: 360 CC

**Expected Payouts:**
- User 1: 100 + (360 × 100/600) = 160 CC
- User 2: 200 + (360 × 200/600) = 320 CC
- User 3: 300 + (360 × 300/600) = 480 CC
- Total: 160 + 320 + 480 = 960 CC ✓

### Test Case G: Autonomous Settlement (No Manual Intervention)
**Setup:**
- Start market
- Submit predictions
- Wait for 15-min window to expire

**Expected:**
- Oracle runs automatically
- Settlement executes automatically
- No manual cron trigger needed
- Results display in `/api/results/latest`

---

## Frontend Integration Tests

### Test Case 1: Market Status Display
**Action:** Load `http://localhost:3000`
**Expected:**
- ✓ BTC live price displayed (updates every 2s)
- ✓ Current round number shown
- ✓ Time remaining countdown
- ✓ UP and DOWN pool amounts visible

### Test Case 2: Prediction Form Submission
**Action:**
1. Select "UP" direction
2. Enter amount: 100
3. Enter party_id: `party::test_user`
4. Click "Submit Prediction"

**Expected:**
- ✓ Form validates inputs
- ✓ Success message appears: "✓ Prediction submitted! Round X"
- ✓ Form resets
- ✓ Pool amounts update immediately

### Test Case 3: Prediction Form Validation
**Actions:**
1. Submit with no direction selected → Error: "Please select UP or DOWN"
2. Submit with amount 0 → Error: "Please enter a valid amount"
3. Submit with no party_id → Error: "Please enter your party ID"

**Expected:** Error messages display and form doesn't submit

### Test Case 4: Results Display (No Settled Rounds)
**Action:** Load frontend on fresh market
**Expected:** Results section shows "No settled rounds yet"

### Test Case 5: Results Display (Settled Round)
**Action:** After settlement completes, check results section
**Expected:**
- ✓ Round number and winning direction shown
- ✓ Open and close prices displayed
- ✓ Pool amounts displayed
- ✓ **Winners list** (green) shows:
  - Winner party IDs
  - Payout amounts
- ✓ **Losers list** (red) shows:
  - Loser party IDs
  - Lost amounts
- ✓ Fee collected displayed

### Test Case 6: Auto-Refresh Behavior
**Action:** Submit prediction and wait
**Expected:**
- ✓ Market status refreshes every 2s
- ✓ Price updates in real-time
- ✓ Pool amounts update when new predictions come in
- ✓ Results refresh every 10s (displays latest settlement)

### Test Case 7: Responsive Design
**Actions:**
1. Load on desktop (1280px)
2. Load on tablet (768px)
3. Load on mobile (375px)

**Expected:** Layout adapts properly, all elements readable

---

## End-to-End Test Flow

### Complete Market Cycle
```
1. START SERVER
   npm run market

2. SUBMIT PREDICTIONS (while market active)
   curl -X POST http://localhost:3000/api/predict \
     -H "Content-Type: application/json" \
     -d '{"amount": 100, "direction": "UP", "party_id": "alice"}'

   curl -X POST http://localhost:3000/api/predict \
     -H "Content-Type: application/json" \
     -d '{"amount": 150, "direction": "DOWN", "party_id": "bob"}'

3. CHECK MARKET STATUS
   curl -s http://localhost:3000/api/market/status | jq '.'

4. WAIT FOR SETTLEMENT (15 minutes or check logs)
   tail -f market-server.log

5. CHECK RESULTS
   curl -s http://localhost:3000/api/results/latest | jq '.'

6. VERIFY FRONTEND
   Open http://localhost:3000
   - Check results display with winners/losers
   - Verify pool amounts and fee
```

---

## Error Cases

### Invalid Direction Value
**Request:** `{"amount": 100, "direction": "SIDEWAYS", "party_id": "user"}`
**Expected:** `400 Bad Request` with error message

### Negative Amount
**Request:** `{"amount": -100, "direction": "UP", "party_id": "user"}`
**Expected:** `400 Bad Request` - "Invalid amount"

### Zero Amount
**Request:** `{"amount": 0, "direction": "UP", "party_id": "user"}`
**Expected:** `400 Bad Request` - "Invalid amount"

### Missing Active Round
**Scenario:** All rounds settled, none in progress
**Request:** `POST /api/predict`
**Expected:** `400 Bad Request` - "No active market round"

### Non-existent Round Results
**Request:** `GET /api/results/999`
**Expected:** `404 Not Found` - "Round not found or not settled"

---

## Performance Tests

### Load Test: 100 Predictions
**Setup:** Submit 100 predictions rapidly to same round
```bash
for i in {1..100}; do
  curl -X POST http://localhost:3000/api/predict \
    -H "Content-Type: application/json" \
    -d "{\"amount\": $((RANDOM % 500 + 1)), \"direction\": \"$([ $((RANDOM % 2)) -eq 0 ] && echo 'UP' || echo 'DOWN')\", \"party_id\": \"user_$i\"}" &
done
wait
```

**Expected:**
- ✓ All requests succeed
- ✓ Server remains responsive
- ✓ Market status shows correct totals
- ✓ Settlement completes within reasonable time

---

## Checklist for Full Validation

- [ ] All API endpoints return correct response formats
- [ ] Invalid inputs are properly rejected with error messages
- [ ] Predictions can be submitted while market is active
- [ ] Settlement runs autonomously every 15 minutes
- [ ] Winner/loser calculations are mathematically correct
- [ ] Fee is deducted from losing pool, not winning pool
- [ ] Frontend displays latest settled round automatically
- [ ] Winners list shows correct party IDs and payout amounts
- [ ] Losers list shows correct party IDs and lost amounts
- [ ] Live BTC price updates every 2 seconds
- [ ] Market status updates in real-time
- [ ] No manual intervention needed after market starts
- [ ] Results persist across server restarts
