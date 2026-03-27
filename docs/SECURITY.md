# Security Overview

> Security posture summary for the Predict Now BTC prediction market platform.

**Last reviewed:** 2026-03-27
**Related:** [KEY_ROTATION.md](KEY_ROTATION.md) | [STAGING_SECURITY_AUDIT.md](STAGING_SECURITY_AUDIT.md) | [DEPLOYMENT.md](DEPLOYMENT.md)

---

## Architecture Security Summary

Predict Now is a real-time BTC prediction market built on the Canton Network. The backend is a Node.js/Express service deployed on Railway with Firebase authentication and Canton blockchain settlement via the Zoro Wallet API.

### Authentication

- **Users:** Firebase Auth (Google sign-in and email/password) with server-side token verification via Firebase Admin SDK.
- **Agents:** Firebase email/password auth per agent, with tokens refreshed automatically.
- **Admin endpoints:** Protected by `ADMIN_SECRET` env var, compared using HMAC to prevent timing-based side-channel attacks (SEC-02).
- **Rewards API:** Protected by a shared `REWARDS_API_KEY` for partner integrations.

### Authorization

- Legacy API endpoints (`/api/balance/:partyId`, `/api/bets/:partyId`) require authentication and verify the authenticated user owns the requested `partyId` to prevent IDOR attacks (SEC-01, NEW-02).
- Admin endpoints are rate-limited to 10 requests per minute per IP (SEC-03).

### Network security

- CORS is restricted: when `CORS_ORIGIN` is not set, the server omits CORS headers entirely, enforcing same-origin only (SEC-04).
- The service runs on Railway with HTTPS enforced at the platform level.

### On-chain security

- All Canton transactions (deposits, payouts, transfers) go through the Zoro Wallet API with `Bearer` token authentication.
- Pool wallets hold user funds and are the highest-value targets. See [KEY_ROTATION.md](KEY_ROTATION.md) for the rotation procedure.
- Withdrawal locking (`withdrawLockSet`) prevents concurrent withdrawal race conditions in the single-process Node.js runtime.
- Anti-fraud checks gate manual withdrawals: `total_withdrawn` must not exceed `total_deposited`.

### Secrets management

- All secrets are stored as Railway environment variables. No secrets are committed to the repository.
- The `ZORO_API_KEY` is validated at startup to ensure it has the `canton_` prefix.
- Firebase service account credentials (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) are loaded from env vars with a startup warning if missing.
- See [KEY_ROTATION.md](KEY_ROTATION.md) for the full inventory of credentials and the rotation schedule.

---

## Key Rotation

All credentials are rotated on a 90-day cycle. Emergency rotation procedures are documented for compromised keys.

Full details: **[KEY_ROTATION.md](KEY_ROTATION.md)**

Summary of keys managed:

| Category | Count | Details |
|----------|-------|---------|
| Pool wallets | 4 | retail, inst1, inst2, inst3 (Ed25519 keypairs) |
| Agent wallets | 3 | momentum, contrarian, hybrid (Ed25519 keypairs) |
| API keys | 2 | `ZORO_API_KEY`, `REWARDS_API_KEY` |
| Admin secret | 1 | `ADMIN_SECRET` (HMAC-compared) |
| Firebase | 1 | Service account (project ID, client email, private key) |

---

## Known Issues and Accepted Risks

The following items were identified during the staging security audit (see [STAGING_SECURITY_AUDIT.md](STAGING_SECURITY_AUDIT.md) for full details). Items marked "fix before public release" must be resolved before any production launch beyond the team demo.

| ID | Severity | Status | Summary | Action Required |
|----|----------|--------|---------|-----------------|
| NEW-01 | HIGH | Open | Hardcoded master invite code with 999 uses | Fix before public release |
| NEW-03 | MEDIUM | Open | No rate limit on invite code validation | Fix before public release |
| NEW-05 | MEDIUM | Open | Invite code TOCTOU race condition | Fix before public release |
| NEW-04 | MEDIUM | Open | `Math.random()` for invite code generation (weak PRNG) | Fix before public release |
| NEW-06 | MEDIUM | Open | Admin `/credit` inflates `total_deposited` | Review anti-fraud implications |
| NEW-07 | LOW | Open | Admin rate limiter map never evicts (memory leak) | Fix before public release |
| NEW-08 | LOW | Open | Deposit rate limiter map never evicts (memory leak) | Fix before public release |
| NEW-09 | LOW | Open | Sequential DB IDs are predictable | Low priority |
| SEC-10 | MEDIUM | Resolved | No key rotation strategy | Resolved by [KEY_ROTATION.md](KEY_ROTATION.md) |

---

## Security Practices

### For developers

- Never commit secrets to the repository. Use `.env` files locally and Railway env vars in production.
- Run `npx tsx src/onboard.ts` to generate new wallet keypairs. Do not generate keys manually.
- Use `openssl rand -base64 32` for generating new admin secrets and API keys.
- Review the [STAGING_SECURITY_AUDIT.md](STAGING_SECURITY_AUDIT.md) before making changes to auth or payment flows.

### For operators

- Monitor Railway logs for authentication failures and rate-limit hits.
- Set a 90-day calendar reminder for key rotation (see [KEY_ROTATION.md -- Scheduled Rotation](KEY_ROTATION.md#scheduled-rotation)).
- Keep the rotation log up to date after every credential change.
- Respond to any suspected compromise by following the [Emergency Rotation Procedure](KEY_ROTATION.md#emergency-rotation-procedure) immediately.

### Incident response

1. **Detect:** Monitor for unauthorized transactions, unexpected balance changes, or authentication anomalies.
2. **Contain:** Immediately rotate the compromised key using the [Emergency Rotation Procedure](KEY_ROTATION.md#emergency-rotation-procedure).
3. **Assess:** Determine the scope of the breach -- which wallets were affected, what transactions occurred.
4. **Recover:** Transfer any remaining funds to new wallets, restore service.
5. **Review:** Document the incident and update security procedures as needed.
