# BUG REPORT: Type Validation Vulnerability

## Issue: EC-32 - Invalid Data Types Accepted
**Severity:** 🔴 CRITICAL
**Status:** Discovered during edge case testing

### Description
The API endpoint `POST /api/predict` accepts non-numeric values for the `amount` field, causing data corruption and arithmetic errors in pool calculations.

### Root Cause
The validation at `src/api/prediction.ts:17` only checks:
```typescript
if (!amount || amount <= 0) {
  return res.status(400).json({ error: "Invalid amount" });
}
```

This check is insufficient because:
1. String values are truthy (pass `!amount` check)
2. String `<= 0` comparison in JavaScript can be unpredictable
3. No explicit type checking for numeric values

### Evidence
**Test Case:**
```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": "one hundred", "direction": "UP", "party_id": "party::test"}'
```

**Result:**
- API accepts request ❌
- Prediction ID 13 created with `amount: "one hundred"` (string) ❌
- Market status shows corrupted data: `"up_amount": "250.01one hundred"` ❌
- Pool calculation breaks: jq error "number and string cannot be added" ❌

### Database State After Bug
```json
{
  "party_id": "party::test",
  "direction": "UP",
  "amount": "one hundred",  // STRING instead of NUMBER
  "type": "string"
}
```

### Impact
1. **Data Corruption:** Pool totals become strings instead of numbers
2. **Calculation Failure:** Settlement engine cannot calculate payouts
3. **Frontend Issues:** Results display fails due to invalid arithmetic
4. **System Instability:** Subsequent operations fail with type errors

### Affected Code
**File:** `src/api/prediction.ts`
**Lines:** 14-18 (validation block)

Current (BROKEN):
```typescript
if (!amount || amount <= 0) {
  return res.status(400).json({ error: "Invalid amount" });
}
```

Fixed version needed:
```typescript
if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
  return res.status(400).json({ error: "Invalid amount" });
}
```

### Test Cases Affected
- ❌ EC-32: Wrong data type (amount as string)
- ❌ Settlement calculations with corrupted data
- ❌ Pool arithmetic operations
- ❌ Results calculation and display

### Recommendation
1. ✅ Add type checking: `typeof amount === 'number'`
2. ✅ Add finiteness check: `isFinite(amount)` (prevents Infinity, NaN)
3. ✅ Reject negative numbers, zero, and non-numeric values
4. ✅ Clean corrupted database or add migration logic
5. ✅ Add integration tests for type validation

### Test Results Summary
**Validation Tests:**
- ✅ EC-1: Minimum amount (0.01) - PASS
- ✅ EC-2: Large amount (999999.99) - PASS
- ✅ EC-3: Zero amount rejection - PASS
- ✅ EC-6: Empty party ID - PASS
- ✅ EC-9: Case sensitivity - PASS
- ❌ EC-32: Type validation (string as amount) - **FAIL** (critical)

### Priority
🔴 **CRITICAL** - Fix immediately before production deployment
