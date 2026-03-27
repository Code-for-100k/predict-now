# Settlement Engine - Improvements & Hardening

## Current Implementation Analysis

### Strengths ✅
1. **Payout Calculation:** Mathematically correct formula
   ```
   payout = bet + (share of loser pool × (1 - fee%))
   ```

2. **Error Resilience:** Try/catch per winner prevents cascading failures
   ```typescript
   for (const prediction of winnerPredictions) {
     try {
       // Payout execution
     } catch (error) {
       // Individual failure logged, continues to next
     }
   }
   ```

3. **Two-Phase Settlement:** Operator can observe settlements as they execute

4. **Correct Sequencing:** Winners paid first, then operator fee

### Vulnerabilities & Improvements Needed 🔴

---

## Issue 1: No Validation of Canton API Responses

**Current:**
```typescript
const txnId = await executePayout(config, ...);
prediction.payout_txn_id = txnId;
// If txnId is undefined, marked as settled with no record
```

**Risk:**
- Failed transfers marked as success
- No record of failed transaction attempts
- Can't detect partial settlement failures

**Fix Needed:**
```typescript
if (!txnId) {
  throw new Error("Transfer returned no transaction ID");
}
// Ensure transaction actually happened before marking settled
```

---

## Issue 2: No Rollback on Partial Failure

**Current:**
- If 2nd of 3 winners fails to pay, first winner already paid
- System left in inconsistent state
- No way to retry just the failed winner

**Risk:**
- Some winners paid, others not
- No recovery mechanism
- Database doesn't track settlement state

**Fix Needed:**
```typescript
// Store settlement state: PENDING → IN_PROGRESS → COMPLETE
// Only mark as COMPLETE after all transfers succeed
// Failed settlements can be retried with settlement queue
```

---

## Issue 3: No Idempotency Protection

**Current:**
- If settlement runs twice (clock skew, process restart)
- Winners get paid twice
- Operator fee doubled

**Risk:**
- Double payments possible
- Fund loss to operator

**Fix Needed:**
```typescript
// Check: if (round.settled) return early
// Already handled in cron.ts getSettledRound() filter ✅
```

**Status:** ✅ Already protected by `!p.settled` filter in settlement

---

## Issue 4: No Transaction Verification

**Current:**
```typescript
const broadcastResult = await api.broadcast(...);
if (broadcastResult.transactionId) {
  console.log(`✓ Transfer executed: ${broadcastResult.transactionId}`);
}
return broadcastResult.transactionId;
// Returns undefined if no transactionId
```

**Risk:**
- Assumes broadcast always succeeds
- No confirmation that recipient received funds
- No balance verification

**Fix Needed:**
```typescript
// After broadcast, verify:
// 1. transactionId exists
// 2. (Optional) Query wallet to confirm funds received
// 3. Log failure with specific error code
```

---

## Issue 5: Incorrect Fee Payment Timing

**Current:**
```typescript
// Winners paid individually
for (const prediction of winnerPredictions) {
  // Payout to winner
}

// Then fee paid
if (feeCollected > 0) {
  // Payout to operator
}
```

**Problem:**
- All winners must be paid before fee is paid
- If any winner transfer fails, fee calculation based on ALL loser pool
- But some winners might not receive payout

**Better Approach:**
```typescript
// Calculate total commitments first
const totalCommitments =
  winnerPayouts.reduce((sum, p) => sum + p.amount, 0) + feeCollected;

// Verify loser pool covers all commitments
if (totalCommitments !== totalLoserPool) {
  throw new Error("Settlement math doesn't balance");
}

// Then execute all payouts (winners first, then fee)
```

---

## Issue 6: No Handling of Amount Precision

**Current:**
```typescript
const amount: amount.toFixed(2),
```

**Risk:**
- Floating point precision errors
- Canton API may reject amounts with 3+ decimals
- Different systems may round differently

**Fix Needed:**
```typescript
// Ensure amount is always exactly 2 decimals
const roundedAmount = Math.round(amount * 100) / 100;
const amountString = roundedAmount.toFixed(2);

// Validate format
if (!/^\d+\.\d{2}$/.test(amountString)) {
  throw new Error(`Invalid amount format: ${amountString}`);
}
```

---

## Issue 7: No Operator Wallet Validation

**Current:**
```typescript
const operatorPartyId = process.env.OPERATOR_PARTY_ID;
if (operatorPartyId) {
  // Send fee
}
```

**Risk:**
- Invalid operator ID silently fails
- Fee collected but not transferred
- No warning to operator

**Fix Needed:**
```typescript
if (!operatorPartyId) {
  console.warn("⚠️  OPERATOR_PARTY_ID not set - fee collected but not paid!");
  return; // or throw error in production
}

// Validate format
if (!operatorPartyId.includes("::")) {
  throw new Error("Invalid OPERATOR_PARTY_ID format");
}
```

---

## Issue 8: No Settlement Timeout Handling

**Current:**
```typescript
const txnId = await executePayout(config, ...);
// Waits indefinitely if Canton API hangs
```

**Risk:**
- Settlement hangs if network fails
- Market scheduler stuck
- Next round doesn't start

**Fix Needed:**
```typescript
const txnId = await Promise.race([
  executePayout(config, ...),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Transfer timeout")), 30000)
  )
]);
```

---

## Issue 9: Insufficient Logging

**Current:**
```typescript
console.log(`Payingout ${payout.toFixed(2)} CC to ${prediction.party_id}`);
```

**Risk:**
- Hard to debug settlement issues
- No audit trail for compliance
- Missing context for failed transfers

**Fix Needed:**
```typescript
// Enhanced logging with timestamps and context
logger.info("settlement_start", {
  roundId: round.id,
  roundNumber: round.round_number,
  timestamp: new Date().toISOString(),
  winnerCount: winnerPredictions.length,
  loserCount: loserPredictions.length,
});

// Per-payout logging
logger.info("payout_initiated", {
  roundId: round.id,
  partyId: prediction.party_id,
  amount: payout,
  txnId: undefined, // filled in on success
  status: "pending",
});

// Error logging with full context
logger.error("payout_failed", {
  roundId: round.id,
  partyId: prediction.party_id,
  amount: payout,
  error: error.message,
  timestamp: new Date().toISOString(),
});
```

---

## Issue 10: No Settlement Metrics

**Current:**
- No way to monitor settlement performance
- No metrics on payout success/failure rates
- No visibility into market health

**Fix Needed:**
```typescript
// Track metrics
const metrics = {
  settlementDuration: Date.now() - startTime,
  totalPayouts: payoutDetails.length,
  successfulPayouts: successCount,
  failedPayouts: failureCount,
  totalAmountDistributed: totalAmount,
  avgPayoutAmount: totalAmount / payoutDetails.length,
};

// Log for monitoring
console.log("settlement_complete", metrics);
```

---

## Recommended Fixes (Priority Order)

### 🔴 CRITICAL (Fix Immediately)
1. **Validate transaction IDs after broadcast** - Prevent marking failed transfers as success
2. **No double-payment on restart** - Already protected ✅
3. **Operator wallet validation** - Ensure fee is actually paid

### 🟠 HIGH (Fix Before Production)
4. **Amount precision validation** - Prevent format rejections from Canton
5. **Settlement math verification** - Ensure total commitments balance
6. **Timeout handling** - Prevent settlement hangs

### 🟡 MEDIUM (Fix Soon)
7. **Enhanced logging** - Critical for debugging
8. **Settlement metrics** - Monitor market health
9. **Operator fee timing verification** - Ensure correct amount collected

### 🔵 LOW (Future Improvements)
10. **Rollback mechanism** - Complex but valuable for consistency
11. **Async settlement queue** - For better scalability
12. **Retry mechanism** - Automatic retry of failed transfers

---

## Implementation Recommendations

### Option A: Minimal Fix (Recommended for MVP)
```typescript
// Add validation after broadcast
const broadcastResult = await api.broadcast(...);

if (!broadcastResult.transactionId) {
  throw new Error(
    `Broadcast failed for ${receiverPartyId}: No transaction ID`
  );
}

// Add amount validation before sending
if (!/^\d+\.\d{2}$/.test(amount.toFixed(2))) {
  throw new Error(`Invalid amount format: ${amount}`);
}

// Add operator validation
if (!operatorPartyId || !operatorPartyId.includes("::")) {
  throw new Error("Invalid or missing OPERATOR_PARTY_ID configuration");
}
```

### Option B: Production-Grade Fix
- Add full logging system
- Add settlement state machine (PENDING/IN_PROGRESS/COMPLETE)
- Add timeout handling
- Add metrics collection
- Add settlement retry queue
- Add comprehensive audit trail

---

## Testing Strategy for Improvements

1. **Unit Tests:** Test payout calculations with edge cases
2. **Integration Tests:** Test full settlement flow with mock Canton API
3. **Chaos Tests:** Simulate network failures, timeouts, partial failures
4. **Compliance Tests:** Verify audit trail, no double payments
5. **Load Tests:** Settle 100+ predictions, verify no data corruption

