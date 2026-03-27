# Staging Security Audit

**Date**: 2026-03-25
**Branch**: demo-prep
**Auditor**: Security Engineer Agent (Claude Opus 4.6)

---

## Fixes Applied This Session

| ID | Severity | Status | Description |
|---|---|---|---|
| SEC-01 | HIGH | FIXED | Legacy /api/balance/:partyId and /api/bets/:partyId now require auth |
| SEC-02 | LOW | FIXED | Admin secret uses HMAC comparison (no length leak) |
| SEC-03 | MEDIUM | FIXED | Admin endpoints rate-limited (10 attempts/min per IP) |
| SEC-04 | MEDIUM | FIXED | CORS omits header when CORS_ORIGIN not set (same-origin only) |
| NEW-02 | HIGH | FIXED | Legacy endpoints verify authenticated user owns the partyId (IDOR) |

## Open Issues

| ID | Severity | File:Line | Issue | Demo Risk |
|---|---|---|---|---|
| NEW-01 | HIGH | db/init.ts:275 | Hardcoded master invite code PREDICT-NOW (999 uses) | Acceptable -- intentional for team demo |
| NEW-03 | MEDIUM | api/auth.ts:50 | No rate limit on invite code validation failures | Low -- requires valid Firebase token |
| NEW-04 | MEDIUM | db/init.ts:300, market.ts:250 | Math.random() for invite code generation (weak PRNG) | Low -- codes are admin-distributed |
| NEW-05 | MEDIUM | api/auth.ts:63-81 | Invite code use-count race condition (TOCTOU) | Low -- unlikely during demo |
| NEW-06 | MEDIUM | market.ts:419 | Admin /credit inflates total_deposited (loosens anti-fraud) | Low -- admin-only |
| NEW-07 | LOW | market.ts:127 | Admin rate limiter map never evicts (memory leak) | None for demo |
| NEW-08 | LOW | account.ts:163 | Deposit rate limiter map never evicts (memory leak) | None for demo |
| NEW-09 | LOW | account.ts:322 | Sequential DB IDs predictable | None |

## Notes

- Concurrent withdrawal lock (withdrawLockSet) is adequate for single-process Node.js
- Anti-fraud check (total_withdrawn > total_deposited) only gates manual withdrawals, not settlement auto-payouts -- correct behavior
- All open issues are acceptable risk for the demo. Fix NEW-01, NEW-03, NEW-05 before any public release.
