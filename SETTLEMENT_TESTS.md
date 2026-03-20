# Settlement Engine - Test Cases & Verification

## Settlement Flow Overview

```
1. Market round expires (15-min window closes)
2. Oracle fetches BTC price → determines winning direction
3. Settlement engine:
   - Filters predictions by winner/loser
   - Calculates payouts using: payout = bet + (share of loser pool × (1 - fee%))
   - Executes Canton transfers to each winner
   - Executes fee transfer to operator wallet
   - Marks round as settled in database
4. Results available via API
5. Frontend displays winners/losers
```

---

## Settlement Logic Tests

### ST-1: Basic Settlement (1 Winner, 1 Loser)
**Setup:**
- Alice: 100 UP (wins)
- Bob: 50 DOWN (loses)
- FEE_PERCENTAGE: 10%

**Calculation:**
```
Total Winner Pool (UP): 100
Total Loser Pool (DOWN): 50
Fee: 50 × 0.10 = 5
Payout Pool: 50 - 5 = 45

Alice Payout:
  Original: 100
  Share of payout pool: 100/100 = 100%
  Payout pool amount: 45 × 100% = 45
  Total: 100 + 45 = 145
```

**Expected Result:**
```json
{
  "round_number": 1,
  "winning_direction": "UP",
  "total_up_amount": 100,
  "total_down_amount": 50,
  "fee_collected": 5,
  "predictions": [
    {"party_id": "alice", "amount": 100, "won": true},
    {"party_id": "bob", "amount": 50, "won": false}
  ]
}
```

### ST-2: Multiple Winners (Split Pool)
**Setup:**
- Alice: 100 UP
- Charlie: 50 UP
- Bob: 150 DOWN (loses)
- FEE_PERCENTAGE: 10%

**Calculation:**
```
Winner Pool: 100 + 50 = 150
Loser Pool: 150
Fee: 150 × 0.10 = 15
Payout Pool: 150 - 15 = 135

Alice Payout: 100 + (135 × 100/150) = 100 + 90 = 190
Charlie Payout: 50 + (135 × 50/150) = 50 + 45 = 95
```

**Verification:**
```bash
# After settlement, check results
curl -s http://localhost:3000/api/results/latest | jq '.predictions'
# Should show:
# - alice: 100 bet, won=true
# - charlie: 50 bet, won=true
# - bob: 150 bet, won=false
```

### ST-3: All Winners (No Losers)
**Setup:**
- Alice: 100 UP
- Bob: 50 UP
- Price goes UP (all predict correctly)

**Expected:**
- No losers = no payout pool to distribute
- No fee collected
- Winners get original bets only
- Fee collected: 0

**Verification:**
```bash
curl -s http://localhost:3000/api/results/latest | jq '.fee_collected'
# Should return: 0
```

### ST-4: All Losers (No Winners)
**Setup:**
- Alice: 100 UP
- Bob: 50 UP
- Price goes DOWN (all predict wrong)

**Expected:**
- No winners to payout
- Settlement completes without errors
- Fee transferred to operator
- Losers get nothing

**Verification:**
```bash
curl -s http://localhost:3000/api/results/latest | jq '.predictions | length'
# Should be 2 (both predictions recorded)
```

### ST-5: Unequal Distribution
**Setup:**
- Winner pool: 333 CC (3 winners with 111 each)
- Loser pool: 100 CC
- Fee: 10% = 10 CC
- Distribute: 90 CC

**Calculation:**
```
Per-CC ratio: 90 / 333 = 0.2702...

Winner 1: 111 + (90 × 111/333) = 111 + 30 = 141
Winner 2: 111 + (90 × 111/333) = 111 + 30 = 141
Winner 3: 111 + (90 × 111/333) = 111 + 30 = 141
Total: 141 + 141 + 141 = 423 ✓
```

**Verification:**
- Total distributed = Winner pool + (Loser pool - fee)
- 423 = 333 + (100 - 10) ✓

### ST-6: Decimal Precision
**Setup:**
- Winner: 1.23 CC (wins)
- Loser: 4.56 CC
- Fee: 10%

**Expected:**
- Calculations maintain 2 decimal precision
- No rounding errors accumulate
- Canton API receives: `amount.toFixed(2)` format

### ST-7: Zero Loser Pool
**Setup:**
- Winner: 100
- Loser: 0 (no one bet other direction)

**Expected:**
- Settlement runs without errors
- Winner gets original bet only
- Fee: 0
- No transfers executed (only settlement marks round complete)

---

## Canton API Integration Tests

### ST-8: Successful Transfer Execution
**Test:** Monitor settlement execution logs
```bash
# In terminal where market is running, you'll see:
# ✓ Transfer executed: txn_abc123
# Fee collection to operator: txn_xyz789
```

**Expected:**
- Each payout returns a `transactionId`
- Fee transfer also returns `transactionId`
- All marked with `settled: true` in database

### ST-9: Transfer Failure Handling
**Scenario:** Network fails during payout execution

**Current Behavior (from code):**
```typescript
try {
  const txnId = await executePayout(...);
  prediction.settled = true;
  prediction.payout_txn_id = txnId;
} catch (error) {
  console.error(`Failed to payout to ${prediction.party_id}:`, error);
  // Prediction remains unsettled, can retry later
}
```

**Expected:**
- Failed transfers don't mark prediction as settled
- Operator can retry settlement later
- Error logged with party ID for investigation

### ST-10: Operator Fee Transfer
**Test:** Verify fee reaches operator wallet

**Setup:**
- OPERATOR_PARTY_ID set in .env
- Settlement completes

**Expected:**
- Fee transfer executes with correct amount
- Transaction ID recorded
- Operator receives fee in wallet

---

## Edge Cases - Settlement

### ST-11: Very Small Amounts (Rounding)
**Setup:**
- Winner: 0.01 CC
- Loser: 0.01 CC
- Fee: 10% = 0.001 CC → rounds to 0.00
- Payout pool: 0.01 - 0.00 = 0.01

**Expected:**
- Handles gracefully
- Winner gets original 0.01 + share of payout

### ST-12: Very Large Amounts (Overflow)
**Setup:**
- Winner: 999,999 CC
- Loser: 1,000,000 CC

**Expected:**
- Calculations don't overflow
- JSON serialization handles large numbers
- Canton API accepts large amounts

### ST-13: Single Prediction Only
**Setup:**
- Only 1 prediction in entire round: 100 UP, and DOWN wins

**Expected:**
- That 1 user loses their 100 CC
- No winners to pay
- Fee: 0 (no loser pool)
- Settlement completes without errors

### ST-14: Duplicate Party IDs (Same User, Multiple Bets)
**Setup:**
- Alice bets: 100 UP, 50 UP (2 predictions, same user)
- Bob bets: 150 DOWN

**Expected:**
- Both of Alice's predictions treated as separate
- Alice receives 2 separate transfers if she wins
- Or both losses recorded if she loses

### ST-15: Settlement After Server Restart
**Scenario:**
1. Round expires
2. Server crashes mid-settlement
3. Server restarts

**Expected:**
- On next market cycle, settlement resumes
- Only unsettled predictions are processed
- No duplicate payments
- Database marks what was already settled

---

## Error Scenarios

### ST-16: Missing OPERATOR_PARTY_ID
**Setup:**
- OPERATOR_PARTY_ID not set in .env

**Expected:**
```typescript
if (operatorPartyId) {
  // Only pays fee if OPERATOR_PARTY_ID exists
  // Otherwise skips fee transfer (logs warning)
}
```

**Verification:**
- Settlement completes
- Fee is collected but not transferred
- Logged in console for operator awareness

### ST-17: Invalid Pool Wallet (Config)
**Setup:**
- SENDER_PARTY_ID misconfigured
- Settlement tries to execute payout

**Expected:**
- Canton API returns error
- Error caught in try/catch
- Settlement continues for other winners
- Failed payout logged with retry instructions

### ST-18: Mathematical Edge Case
**Setup:**
```
Winners: 1 CC
Losers: 3 CC
Fee: 10% = 0.3 CC
Distribute: 2.7 CC

Payout: 1 + (2.7 × 1/1) = 1 + 2.7 = 3.7 CC
Total: Winners (1) + Losers (3) - Fee (0.3) = 3.7 ✓
```

**Expected:** Math checks out

---

## Monitoring & Logging

### Settlement Logs Expected:
```
═══ Settling Round 1 (UP) ═══
Total UP: 250, Total DOWN: 150
Fee collected: 15 (10%)
Num winners: 2

Payingout 165.00 CC to party::alice (bet: 100)
  ✓ Transfer executed: txn_abc123

Payingout 100.00 CC to party::charlie (bet: 75)
  ✓ Transfer executed: txn_def456

Payingout fee 15.00 to operator
  ✓ Transfer executed: txn_ghi789

Round 1 settled successfully
```

---

## Test Execution Plan

### Manual Test Flow (Wait for Settlement)
```bash
# 1. Start market
npm run market

# 2. Submit predictions
curl -X POST http://localhost:3000/api/predict \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::alice"}'

curl -X POST http://localhost:3000/api/predict \
  -d '{"amount": 150, "direction": "DOWN", "party_id": "party::bob"}'

# 3. Check active round
curl -s http://localhost:3000/api/market/status | jq '.time_remaining_ms'

# 4. WAIT 15 minutes OR check logs for "Settling Round"

# 5. After settlement completes
curl -s http://localhost:3000/api/results/latest | jq '.'

# 6. Verify all calculations match expected payouts
```

### Automated Test (Mocked Time)
Could be implemented to:
- Mock Date.now() for faster testing
- Skip 15-minute waits
- Run full settlement in seconds

---

## Verification Checklist

### Before Settlement Completes:
- [ ] All predictions registered correctly
- [ ] Market status shows correct pools
- [ ] Oracle has fetched prices (check logs)

### After Settlement Completes:
- [ ] Round marked as settled in database
- [ ] Prices recorded (open_price, close_price)
- [ ] Winning direction determined correctly
- [ ] Fee calculated correctly
- [ ] Winner payouts calculated correctly
- [ ] All winners have settled=true
- [ ] All losers have settled=true (won=false)
- [ ] Results available via `/api/results/latest`
- [ ] Frontend displays winners and losers
- [ ] Canton transfers executed (TxnIDs present)
- [ ] Operator fee transfer executed
- [ ] Logs show successful settlement

---

## Known Limitations & Future Improvements

### Current:
- ✅ Synchronous settlement (waits for all transfers)
- ✅ Error handling per-winner (one failure doesn't block others)
- ✅ Fee-based model (fixed 10% default)

### Potential Improvements:
- [ ] Async payout execution (settle faster, retry failed transfers later)
- [ ] Batch transfers (reduce Canton API calls)
- [ ] Rollback mechanism (if settlement fails mid-way)
- [ ] Settlement retry queue (automatic retry of failed transfers)
- [ ] Adjustable fee percentage per round
- [ ] Settlement state machine (PENDING → EXECUTING → COMPLETE)
- [ ] Settlement hooks (webhooks when round settles)
- [ ] Settlement audit trail (immutable log of all transfers)

