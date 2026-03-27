# Staging (demo-prep) Test Results

**Target**: https://predict-now-preview-production.up.railway.app
**Date**: 2026-03-25T05:00 UTC
**Branch**: demo-prep
**Tester**: Automated (Claude Opus 4.6)
**Total Tests**: 31 | **Passed**: 27 | **Failed**: 2 | **Warnings**: 2

---

## Summary

| # | Test | Expected | Actual | Verdict | Notes |
|---|------|----------|--------|---------|-------|
| 1 | GET /health | 200, status:"ok" | 200, status:"ok" | **PASS** | |
| 2 | GET /api/btc-price | 200, price>0 | 200, price=70919.27 | **PASS** | Price fresh (within minutes) |
| 3 | GET /api/market/status | 200, active round | 200, round 2442 | **PASS** | 60s windows, 1% fee |
| 4 | GET /api/results/latest | 200, settled round | 200, round 2441 | **PASS** | |
| 5 | GET /api/results/history?limit=5 | 200, 5 rounds | 200, 5 rounds | **PASS** | |
| 6 | GET /api/pool-info | 200, pool data | 200, retail pool | **PASS** | |
| 7 | GET /api/firebase-config | 200, config | 200, cpredict | **PASS** | |
| 8 | POST /api/predict (no auth) | 401 | 401 | **PASS** | |
| 9 | POST /api/deposit (no auth) | 401 | 401 | **PASS** | |
| 10 | POST /api/withdraw (no auth) | 401 | 401 | **PASS** | |
| 11 | GET /api/balance (no auth) | 401 | 401 | **PASS** | |
| 12 | GET /api/bets (no auth) | 401 | 401 | **PASS** | |
| 13 | GET /admin/db-summary (no secret) | 403 | 403 | **PASS** | |
| 14 | GET /admin/db-summary (with secret) | 200 | 200, full data | **PASS** | Includes tier breakdowns |
| 15 | GET /api/results/99999 | 404 | 404 | **PASS** | |
| 16 | POST /api/predict (fake token) | 401 | 401 | **PASS** | |
| 17 | GET /api/results/history?limit=-1 | 400 or 200 | **400** | **PASS** | IMPROVED: now validates limit |
| 18 | GET /api/results/history?limit=1000000 | capped | 200, capped at 100 | **PASS** | |
| 19 | GET / (landing page) | 200, HTML | 200, HTML returned | **PASS** | |
| 20 | GET /dashboard.html | 200, HTML | 200, dashboard HTML | **PASS** | |
| 21 | GET /api/balance/:partyId (legacy) | 401 or 404 | **400** (no auth) | **FAIL** | SEC-01 NOT FIXED |
| 22 | GET /api/bets/:partyId (legacy) | 401 or 404 | **400** (no auth) | **FAIL** | SEC-01 NOT FIXED |
| 23 | OPTIONS / (CORS) | Restrictive | `*` wildcard | **WARN** | SEC-04 NOT FIXED |
| 24 | Admin tier breakdown | Tier data | users_by_tier, invite_codes, pools | **PASS** | Full segregation data |
| 25 | History total/capped fields | Present | `total` and `capped` in response | **PASS** | New fields working |
| 26 | POST /api/auth/verify (invalid invite) | 401 | 401 | **PASS** | Auth blocks first |
| 27 | POST /api/auth/verify (master code) | 401 (fake token) | 401 | **PASS** | Auth validates token before code |
| 28 | POST /api/auth/link-party (no auth) | 401 | 401 | **PASS** | |
| 29 | POST /admin/retry-payout | Response | 404 "User not found" | **PASS** | Endpoint exists, validates input |
| 30 | SQL injection in invite code | No crash | 401 (auth blocks) | **PASS** | |
| 31 | Rate limit on admin (5 rapid) | Rate limited | All 403, no limiting | **WARN** | SEC-03 NOT FIXED |

---

## Detailed Findings

### REGRESSIONS: None Found
All 18 production tests pass identically on staging. No regressions detected.

### IMPROVEMENTS on Staging vs Production
1. **History limit validation** (Test 17): Production returned 200 with 1 round for `limit=-1`. Staging now returns **400** with `{"error":"Invalid limit (must be a positive integer)"}`.
2. **total/capped fields** (Test 25): History endpoint now returns `total` and `capped` boolean alongside `rounds` array.
3. **Admin tier breakdowns** (Test 24): Admin summary now includes `users_by_tier`, detailed `invite_codes` with per-code usage, and `pool_wallets` by tier.

### BUGS / SECURITY ISSUES Found

#### BUG-1: Legacy Endpoints Still Unauthenticated (CRITICAL)
- **Tests**: 21, 22
- **Endpoints**: `GET /api/balance/:partyId`, `GET /api/bets/:partyId`
- **Issue**: These endpoints return 400 for invalid party IDs but have NO auth middleware. Anyone with a valid Canton party ID can read another user's balance and bet history.
- **Impact**: Data exposure. Party IDs are leaked in public `/api/results/*` responses.
- **Status from CODE_REVIEW.md**: SEC-01 (HIGH) - **NOT FIXED**
- **Recommendation**: Add `requireAuth` middleware or remove these endpoints.

#### BUG-2: CORS Wildcard (MEDIUM)
- **Test**: 23
- **Issue**: `Access-Control-Allow-Origin: *` allows any website to make authenticated API requests.
- **Impact**: Combined with BUG-1, any website can exfiltrate user data.
- **Status from CODE_REVIEW.md**: SEC-04 (MEDIUM) - **NOT FIXED**
- **Recommendation**: Set `CORS_ORIGIN` to `https://predictnow.cc` in Railway env vars.

#### BUG-3: No Admin Rate Limiting (LOW)
- **Test**: 31
- **Issue**: 5 rapid requests with wrong admin secret all return 403 instantly with no throttling.
- **Impact**: Admin secret brute-force possible.
- **Status from CODE_REVIEW.md**: SEC-03 (MEDIUM) - **NOT FIXED**

### STAGING FEATURES Verified Working
| Feature | Status | Notes |
|---------|--------|-------|
| Landing page | Working | HTML loads at / |
| Analytics dashboard | Working | HTML loads at /dashboard.html |
| Invite code system | Working | Admin shows 104 codes (101 retail + 3 institutional) |
| Pool wallet segregation | Working | 4 pools visible in admin (retail + inst-1/2/3) |
| Tier-aware admin | Working | users_by_tier, invite_codes breakdown |
| History limit validation | Working | Returns 400 for invalid limits |
| total/capped fields | Working | Present in history response |
| Auth middleware | Working | All protected endpoints return 401 |
| Admin auth | Working | 403 without secret, 200 with secret |
| BTC price feed | Working | Price=71050.05, updated within minutes |
| 60-second rounds | Working | Round 2442+, window_end - window_start = 60000ms |

### CANNOT TEST Without Auth Token
These features require a valid Firebase auth token and cannot be tested via curl alone:
- Invite code validation during actual signup
- Deposit flow with auto-retry
- Withdrawal within/over deposit limits
- Concurrent withdrawal lock (double-spend prevention)
- Actual bet placement and settlement
- Per-tier pool routing during deposit

**Recommendation**: Update `test-full-e2e.ts` to cover these flows using Firebase Admin SDK tokens.

---

## Environment Snapshot

```
Server: Railway (demo-prep branch)
Round: 2442+ (60-second rounds, 1% fee)
Users: 5 (all retail)
Invite codes: 101 retail available, 3 institutional (0 used each)
Price source: Binance (price=71050.05, updated 2026-03-25T05:09 UTC)
Pool wallets: 4 (retail + inst-1 + inst-2 + inst-3)
```
