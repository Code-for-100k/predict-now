# BTC Prediction Market - Staging Security Tests

**Environment:** https://predict-now-preview-production.up.railway.app
**Branch:** demo-prep (staging)
**Admin Secret:** `predict-now-admin-2026`
**Date:** 2026-03-25

> Based on CODE_REVIEW.md findings. Tests whether staging fixes production security issues
> and validates new staging-specific security features.

---

## Test Summary

| ID | Finding | Severity | Category | Status |
|----|---------|----------|----------|--------|
| SEC-01 | Legacy balance/bets endpoints auth | Medium | Auth bypass | |
| SEC-02 | Admin secret timing attack | Low | Crypto | |
| SEC-03 | Rate limiting on admin endpoints | Medium | DoS | |
| SEC-04 | CORS wildcard | Medium | Browser security | |
| SEC-05 | CSRF protection | Medium | Browser security | |
| SEC-06 | Firebase config exposure | Info | Config | |
| SEC-07 | displayName sanitization (XSS) | High | Injection | |
| SEC-08 | Concurrent withdrawal lock (double-spend) | Critical | Financial | |
| SEC-09 | Withdrawal amount validation | High | Financial | |
| SEC-10 | Invite code injection | High | Injection | |

```bash
BASE=https://predict-now-preview-production.up.railway.app
ADMIN_SECRET=predict-now-admin-2026
TOKEN="<firebase-id-token>"
AUTH="Authorization: Bearer $TOKEN"
```

---

## SEC-01: Legacy Balance/Bets Endpoints - Auth Bypass

**Finding:** Production has legacy endpoints `GET /api/balance/:partyId` and `GET /api/bets/:partyId` that do not require authentication. Any user who knows (or guesses) a party ID can view another user's balance and bet history.

**Test A: Access balance without auth**
```bash
# Known party ID format from Canton
VICTIM_PARTY="8324e2529b::1220efd7..."

curl -s $BASE/api/balance/$VICTIM_PARTY | jq '.'
```
**Expected (production):** Returns balance data (vulnerability).
**Expected (staging fix):** 401 Unauthorized, or 404 Not Found, or endpoint removed.

**Test B: Access bets without auth**
```bash
curl -s $BASE/api/bets/$VICTIM_PARTY | jq '.'
```
**Expected (production):** Returns bet history (vulnerability).
**Expected (staging fix):** 401 Unauthorized, or 404 Not Found, or endpoint removed.

**Test C: Enumeration via sequential party IDs**
```bash
for suffix in 01 02 03 04 05; do
  curl -s "$BASE/api/balance/8324e2529b::1220efd7${suffix}" | jq '.balance // "not found"'
done
```
**Expected (staging fix):** All return error, no data leakage.

**Remediation verification:**
- [ ] Legacy `/balance/:partyId` requires auth or is removed
- [ ] Legacy `/bets/:partyId` requires auth or is removed
- [ ] Authenticated endpoints `/balance` and `/bets` still work with token

---

## SEC-02: Admin Secret Timing Attack

**Finding:** String comparison of admin secret may be vulnerable to timing attacks. If the server uses `===` comparison, an attacker could measure response times to guess the secret character by character.

**Test: Measure response times for different-length secrets**
```bash
# Correct length, wrong value
time curl -s -o /dev/null -w "%{time_total}" \
  -X GET $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: predict-now-admin-xxxx"

# Wrong length
time curl -s -o /dev/null -w "%{time_total}" \
  -X GET $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: x"

# Correct secret
time curl -s -o /dev/null -w "%{time_total}" \
  -X GET $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: $ADMIN_SECRET"

# Repeat 20 times each and compare average response times
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{time_total}\n" \
    -X GET $BASE/api/admin/tier-breakdown \
    -H "X-Admin-Secret: predict-now-admin-xxxx"
done | awk '{sum+=$1} END {print "avg:", sum/NR}'
```
**Expected (staging fix):** Response times are constant regardless of input. Server uses `crypto.timingSafeEqual()` or equivalent.

**Remediation verification:**
- [ ] Admin secret comparison uses constant-time comparison
- [ ] No measurable timing difference between correct/incorrect secrets

---

## SEC-03: Rate Limiting on Admin Endpoints

**Finding:** Admin endpoints have no rate limiting. An attacker who discovers the admin path could brute-force the secret.

**Test: Rapid-fire admin requests**
```bash
for i in $(seq 1 50); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X GET $BASE/api/admin/tier-breakdown \
    -H "X-Admin-Secret: wrong-guess-$i")
  echo "Attempt $i: $STATUS"
done
```
**Expected (staging fix):** After N failed attempts (e.g., 10), subsequent requests return 429 Too Many Requests.

**Test: Rate limit resets after cooldown**
```bash
# Trigger rate limit
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X GET $BASE/api/admin/tier-breakdown \
    -H "X-Admin-Secret: wrong"
done

# Wait cooldown period
sleep 60

# Should work again
curl -s -o /dev/null -w "%{http_code}" \
  -X GET $BASE/api/admin/tier-breakdown \
  -H "X-Admin-Secret: $ADMIN_SECRET"
```
**Expected:** 200 after cooldown.

**Remediation verification:**
- [ ] Admin endpoints have rate limiting (N attempts per IP per window)
- [ ] Rate limit applies per IP, not globally
- [ ] Successful auth resets the counter (or does not)

---

## SEC-04: CORS Wildcard

**Finding:** Server sets `Access-Control-Allow-Origin: *` which allows any website to make API requests on behalf of authenticated users.

**Test: Verify CORS headers**
```bash
curl -s -I -X OPTIONS $BASE/api/market/status \
  -H "Origin: https://evil-site.com" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Authorization"
```
**Expected (production):** `Access-Control-Allow-Origin: *` (vulnerable).
**Expected (staging fix):** `Access-Control-Allow-Origin: https://predict-now-preview-production.up.railway.app` or a whitelist.

**Test: Cross-origin request with credentials**
```bash
curl -s -I -X OPTIONS $BASE/api/predict \
  -H "Origin: https://evil-site.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Authorization, Content-Type"
```
**Expected (staging fix):** Origin not in `Access-Control-Allow-Origin` for non-whitelisted domains.

**Remediation verification:**
- [ ] CORS origin is restricted to known domains (not wildcard)
- [ ] `Access-Control-Allow-Credentials` is not set to `true` with wildcard origin
- [ ] Pre-flight requests properly filtered

---

## SEC-05: CSRF Protection

**Finding:** State-changing endpoints (POST /predict, POST /withdraw, POST /deposit) lack CSRF tokens. Combined with CORS wildcard (SEC-04), this allows cross-site request forgery.

**Test: Submit prediction from cross-origin without CSRF token**
```bash
# Simulate cross-origin POST (browser would include cookies)
curl -X POST $BASE/api/predict \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -H "Origin: https://evil-site.com" \
  -d '{"amount": 1, "direction": "UP"}' | jq '.'
```
**Expected (staging fix):** Request blocked due to origin check, or CSRF token required.

**Note:** Firebase ID tokens are bearer tokens (not cookies), so CSRF risk is mitigated if tokens are only stored in JavaScript memory (not cookies). Verify:
- [ ] Firebase tokens are NOT stored in cookies
- [ ] Authorization header is the only auth mechanism
- [ ] If cookies are used for sessions, CSRF token is required

**Remediation verification:**
- [ ] State-changing endpoints validate Origin header (if CORS is not fixed)
- [ ] OR: Auth is purely bearer-token based (no cookie auth)

---

## SEC-06: Firebase Config Exposure

**Finding (Info only):** Firebase web config is exposed via `GET /api/firebase-config`. This is standard practice for Firebase but worth documenting.

**Test: Verify config contents**
```bash
curl -s $BASE/api/firebase-config | jq '.'
```
**Expected:** Returns `apiKey`, `authDomain`, `projectId`, etc. These are public by design.

**Verify no sensitive keys are exposed:**
- [ ] No service account private key
- [ ] No admin SDK credentials
- [ ] No Canton private keys
- [ ] Only standard Firebase web SDK config fields

**Risk assessment:** Low. Firebase web config is designed to be public. Security is enforced via Firebase Security Rules and backend token verification.

---

## SEC-07: displayName Sanitization (XSS)

**Finding:** User display names from Firebase are stored and displayed without sanitization. A malicious user could set their display name to `<script>alert('xss')</script>` and attack other users viewing the leaderboard.

**Test A: XSS in display name via API**
```bash
# Set display name with script tag (would be done via Firebase Auth profile update)
# Then check if leaderboard renders it safely
curl -s $BASE/api/leaderboard | jq '.[].display_name'
```
**Expected (staging fix):** Display names are HTML-escaped in API responses, or sanitized on storage.

**Test B: Check leaderboard HTML rendering**
1. Navigate to `$BASE` in browser
2. Open DevTools Console
3. Check if any leaderboard entries contain unescaped HTML

**Expected (staging fix):** All display names rendered as text content, not innerHTML. No script execution.

**Test C: Stored XSS vectors**
Common payloads to check if stored:
- `<img src=x onerror=alert(1)>`
- `"><script>alert(1)</script>`
- `javascript:alert(1)`
- `<svg onload=alert(1)>`

**Remediation verification:**
- [ ] Display names sanitized on input (strip HTML tags)
- [ ] OR: Display names escaped on output (HTML entity encoding)
- [ ] Leaderboard uses `textContent` not `innerHTML`
- [ ] Results page uses safe rendering for party_id display

---

## SEC-08: Concurrent Withdrawal Lock (Double-Spend) [NEW - Staging]

**Finding:** Production had no locking on withdrawals. Two simultaneous withdrawal requests could both pass the balance check and execute, resulting in negative balance (double-spend).

**Test A: Simultaneous withdrawals**
```bash
# User has exactly 1.00 CBTC balance
# Fire two 0.80 withdrawals simultaneously
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 0.80}' &
PID1=$!

curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 0.80}' &
PID2=$!

wait $PID1 $PID2
```
**Expected (staging fix):** Exactly one succeeds, one fails with lock error or insufficient balance. Total withdrawn never exceeds balance.

**Test B: Verify balance after concurrent attempt**
```bash
curl -s $BASE/api/balance \
  -H "$AUTH" | jq '.balance'
```
**Expected:** Balance >= 0. Never negative.

**Test C: Rapid sequential withdrawals**
```bash
for i in $(seq 1 10); do
  curl -X POST $BASE/api/withdraw \
    -H "Content-Type: application/json" \
    -H "$AUTH" \
    -d '{"amount": 0.10}' &
done
wait

curl -s $BASE/api/balance -H "$AUTH" | jq '.balance'
```
**Expected:** Balance is never negative. Exactly as many withdrawals succeed as balance allows.

**Remediation verification:**
- [ ] Withdrawal endpoint uses mutex/lock per user
- [ ] Balance check and deduction are atomic
- [ ] Lock timeout prevents deadlocks
- [ ] Balance can never go negative under any concurrency scenario

---

## SEC-09: Withdrawal Amount Validation [NEW - Staging]

**Finding:** Staging introduces deposit-capped withdrawals. Users can only withdraw up to their total deposited amount. Winnings withdrawal requires admin override.

**Test A: Withdraw more than deposited**
```bash
# User deposited 2.00, won 8.00 (balance = 10.00)
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 3.00}' | jq '.'
```
**Expected:** 400 error. Withdrawal blocked because 3.00 > 2.00 (total deposited).

**Test B: Withdraw negative amount**
```bash
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": -1.00}' | jq '.'
```
**Expected:** 400 with "Invalid amount".

**Test C: Withdraw zero**
```bash
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 0}' | jq '.'
```
**Expected:** 400 with "Invalid amount (min 0.01 CBTC)".

**Test D: Withdraw with string amount**
```bash
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": "all"}' | jq '.'
```
**Expected:** 400 type validation error.

**Test E: Withdraw Infinity/NaN**
```bash
curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": 1e999}' | jq '.'

curl -X POST $BASE/api/withdraw \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"amount": "NaN"}' | jq '.'
```
**Expected:** 400 for both. `isFinite()` check catches Infinity; type check catches NaN string.

**Remediation verification:**
- [ ] Withdrawal capped at `total_deposited - total_withdrawn`
- [ ] Amount validated: number, finite, >= 0.01
- [ ] Admin override endpoint exists for amounts exceeding deposit cap
- [ ] Type coercion attacks (string, boolean, array) are rejected

---

## SEC-10: Invite Code Injection [NEW - Staging]

**Finding:** Invite codes are user-supplied strings passed to database queries. Without proper parameterization, they could enable injection attacks.

**Test A: SQL injection**
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "x'\'' OR '\''1'\''='\''1"}' | jq '.'
```
**Expected:** 400 "Invalid invite code". No SQL error in response.

**Test B: NoSQL injection (if using JSON db)**
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": {"$gt": ""}}' | jq '.'
```
**Expected:** 400 error (type validation: code must be string).

**Test C: Prototype pollution**
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "TEST", "__proto__": {"admin": true}}' | jq '.'
```
**Expected:** No effect on server state. `__proto__` property ignored.

**Test D: Very long invite code (buffer overflow)**
```bash
LONG_CODE=$(python3 -c "print('A' * 10000)")
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{\"code\": \"$LONG_CODE\"}" | jq '.'
```
**Expected:** 400 error with length validation, not a server crash.

**Test E: Special characters**
```bash
curl -X POST $BASE/api/auth/redeem-invite \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"code": "RET-\u0000NULL"}' | jq '.'
```
**Expected:** 400 error. Null bytes and control characters rejected.

**Remediation verification:**
- [ ] Invite code input validated: string type, max length, alphanumeric + hyphen only
- [ ] Database queries use parameterized lookups (not string interpolation)
- [ ] Object/array inputs rejected (must be string)
- [ ] No stack traces or internal errors leaked in responses

---

## Overall Security Checklist

### Critical (must fix before demo)
- [ ] SEC-08: Concurrent withdrawal lock verified (no double-spend)
- [ ] SEC-09: Withdrawal amount capped at deposits
- [ ] SEC-10: Invite code injection protection

### High (should fix before demo)
- [ ] SEC-01: Legacy endpoints require auth or removed
- [ ] SEC-07: XSS in display names sanitized

### Medium (fix before production)
- [ ] SEC-03: Admin endpoint rate limiting
- [ ] SEC-04: CORS restricted to known origins
- [ ] SEC-05: CSRF protection (or verify bearer-only auth)

### Low/Info
- [ ] SEC-02: Timing-safe admin secret comparison
- [ ] SEC-06: Firebase config (acceptable, document)
