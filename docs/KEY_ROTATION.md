# Key Rotation Procedure

> How to rotate credentials for the Predict Now platform. Follow this guide for both emergency (compromised key) and scheduled (preventive) rotations.

**Last reviewed:** 2026-03-27
**Related:** [SECURITY.md](SECURITY.md) | [DEPLOYMENT.md](DEPLOYMENT.md)

---

## Table of Contents

- [Keys Inventory](#keys-inventory)
- [Emergency Rotation Procedure](#emergency-rotation-procedure)
- [Scheduled Rotation](#scheduled-rotation)
- [Per-Key Rotation Instructions](#per-key-rotation-instructions)
- [Verification Checklist](#verification-checklist)
- [Rollback](#rollback)

---

## Keys Inventory

Every credential used by Predict Now is listed below. All keys are stored as Railway environment variables and must never be committed to the repository.

| Key | Env Var(s) | Rotation Cycle | Risk if Compromised |
|-----|-----------|----------------|---------------------|
| **Pool wallet -- retail** | `POOL_RETAIL_PARTY_ID`, `POOL_RETAIL_PRIVATE_KEY`, `POOL_RETAIL_PUBLIC_KEY` | 90 days | Funds drained from retail pool |
| **Pool wallet -- inst1** | `POOL_INST1_PARTY_ID`, `POOL_INST1_PRIVATE_KEY`, `POOL_INST1_PUBLIC_KEY` | 90 days | Funds drained from institutional pool 1 |
| **Pool wallet -- inst2** | `POOL_INST2_PARTY_ID`, `POOL_INST2_PRIVATE_KEY`, `POOL_INST2_PUBLIC_KEY` | 90 days | Funds drained from institutional pool 2 |
| **Pool wallet -- inst3** | `POOL_INST3_PARTY_ID`, `POOL_INST3_PRIVATE_KEY`, `POOL_INST3_PUBLIC_KEY` | 90 days | Funds drained from institutional pool 3 |
| **Agent wallet 1** (momentum) | `PARTY_ID_1`, `PRIVATE_KEY_1`, `PUBLIC_KEY_1` | 90 days | Agent funds drained |
| **Agent wallet 2** (contrarian) | `PARTY_ID_2`, `PRIVATE_KEY_2`, `PUBLIC_KEY_2` | 90 days | Agent funds drained |
| **Agent wallet 3** (hybrid) | `PARTY_ID_3`, `PRIVATE_KEY_3`, `PUBLIC_KEY_3` | 90 days | Agent funds drained |
| **Admin secret** | `ADMIN_SECRET` | 90 days | Unauthorized admin access |
| **Rewards API key** | `REWARDS_API_KEY` | 90 days | Unauthorized reward data access |
| **Zoro API key** | `ZORO_API_KEY` | 90 days | Unauthorized Canton transactions |
| **Firebase service account** | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | 90 days | Auth system compromised |

---

## Emergency Rotation Procedure

Use this procedure when you suspect a key has been compromised. The goal is to generate a new credential, migrate any on-chain balance, swap the env var, and restart the service with zero downtime for users.

### Step 1: Generate a new wallet keypair

Run the onboard script to create a fresh Ed25519 keypair and register it on the Canton network via the Zoro API.

```bash
cd predict-now
npx tsx src/onboard.ts
```

The script calls `POST /canton/transaction/prepare/external-party` followed by `POST /canton/transaction/broadcast/external-party` on the Zoro API. On success it prints:

```
SENDER_PARTY_ID=<new-party-id>
SENDER_PRIVATE_KEY=<new-private-key-base64>
SENDER_PUBLIC_KEY=<new-public-key-base64>
```

Save these values securely. Do not paste them into chat, logs, or shared documents.

### Step 2: Transfer remaining balance from old wallet to new wallet

Before decommissioning the old wallet, move any CBTC balance to the new one.

1. Check the old wallet balance via the admin dashboard at `/dashboard.html` or by calling:
   ```
   POST /canton/wallet/balance
   ```
2. If balance > 0, initiate a transfer from the old wallet to the new party ID using the Zoro transfer API.
3. Wait for the transfer to confirm on-chain before proceeding.

### Step 3: Update Railway environment variables

1. Open the Railway project dashboard.
2. Navigate to **Variables**.
3. Replace the old values with the new `PARTY_ID`, `PRIVATE_KEY`, and `PUBLIC_KEY` from Step 1.
4. Double-check that the variable names match exactly (see the [Keys Inventory](#keys-inventory) table for the correct prefixes).

### Step 4: Restart the service

Trigger a redeploy on Railway. The service reads env vars at startup, so a restart picks up the new keys immediately.

```
Railway Dashboard > Deployments > Redeploy
```

If you use the CLI:

```bash
railway up
```

### Step 5: Verify the new wallet is operational

Run through the [Verification Checklist](#verification-checklist) below. At minimum, confirm:

- The service starts without errors in the Railway logs.
- The new wallet balance is visible on the admin dashboard.
- A test prediction round settles successfully with a payout from the new wallet.

### Step 6: Decommission the old wallet

1. Confirm the old wallet balance is 0.
2. Remove any local copies of the old private key (`.env` files, password managers, shared docs).
3. Record the rotation in the team's incident log with the date, which key was rotated, and why.

---

## Scheduled Rotation

Rotate all keys on a **90-day cycle** to limit the blast radius of an undetected compromise.

### Setting up the schedule

1. Create a recurring calendar reminder titled "Predict Now -- Key Rotation" repeating every 90 days.
2. Assign a primary owner and a backup owner for the rotation task.
3. Each rotation should follow the same steps as the [Emergency Rotation Procedure](#emergency-rotation-procedure), except there is no urgency -- you can schedule a maintenance window.

### Recommended rotation order

Rotate keys in this order to minimize service disruption:

1. **Pool wallets** (retail, inst1, inst2, inst3) -- one at a time, verifying each before moving to the next.
2. **Agent wallets** (momentum, contrarian, hybrid) -- stop the agent process, rotate, restart.
3. **Admin secret** -- generate a new random string (`openssl rand -base64 32`), update Railway, restart.
4. **Rewards API key** -- coordinate with the Activity Tracker (Yak) team to issue a new key, update Railway.
5. **Zoro API key** -- request a new key from the Zoro dashboard, update Railway. The key must start with `canton_`.
6. **Firebase service account** -- generate a new private key from the Firebase Console under *Project Settings > Service Accounts*, update the three `FIREBASE_*` env vars.

### Tracking rotations

Maintain a rotation log (spreadsheet or Notion table) with these columns:

| Key Name | Last Rotated | Next Due | Rotated By | Notes |
|----------|-------------|----------|------------|-------|
| Pool retail | 2026-03-27 | 2026-06-25 | -- | -- |

---

## Per-Key Rotation Instructions

### Canton wallet keys (pool and agent wallets)

All Canton wallets use Ed25519 keypairs registered via the Zoro API. The rotation process is identical for pool wallets and agent wallets -- only the env var prefix differs.

1. Run `npx tsx src/onboard.ts` to generate and register a new keypair.
2. Transfer any remaining CBTC balance from the old wallet to the new wallet.
3. Update the corresponding `*_PARTY_ID`, `*_PRIVATE_KEY`, and `*_PUBLIC_KEY` env vars on Railway.
4. Restart the service (market server for pool wallets, agent process for agent wallets).
5. Verify the new wallet is operational.

### Admin secret

The `ADMIN_SECRET` protects all `/admin/*` endpoints. It is compared using HMAC to prevent timing attacks.

1. Generate a new secret: `openssl rand -base64 32`
2. Update `ADMIN_SECRET` on Railway.
3. Restart the service.
4. Verify admin endpoints respond correctly by making a test request with the new secret.

### Rewards API key

The `REWARDS_API_KEY` is a shared secret between Predict Now and the Activity Tracker (Yak) integration.

1. Coordinate with the Activity Tracker team to issue a new key.
2. Update `REWARDS_API_KEY` on Railway.
3. Update the key on the Activity Tracker side as well.
4. Restart the service and verify the `/api/rewards/*` endpoints work.

### Zoro API key

The `ZORO_API_KEY` authenticates all Canton network operations. It must start with the `canton_` prefix.

1. Generate a new API key from the Zoro developer dashboard.
2. Update `ZORO_API_KEY` on Railway.
3. Restart the service.
4. Verify on-chain operations (balance check, test transfer) succeed.

### Firebase service account

The Firebase service account authenticates the server-side Firebase Admin SDK for token verification.

1. Open the Firebase Console for the project.
2. Go to *Project Settings > Service Accounts > Generate New Private Key*.
3. Update the following env vars on Railway with values from the downloaded JSON:
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY` (replace `\n` literals with actual newlines, or keep escaped -- the server handles both)
4. Restart the service.
5. Verify authentication works by logging in through the app.

---

## Verification Checklist

Run through this checklist after every key rotation. Every item must pass before the rotation is considered complete.

### Service health

- [ ] Service starts without errors in Railway logs
- [ ] No `Missing required env var` errors on startup
- [ ] `ZORO_API_KEY must start with 'canton_' prefix` error does NOT appear

### Wallet operations (for Canton key rotations)

- [ ] New wallet balance is visible on the admin dashboard (`/dashboard.html`)
- [ ] Old wallet balance is 0 (funds transferred)
- [ ] A test CBTC transfer from the new wallet succeeds
- [ ] Settlement payout completes for the next prediction round

### Agent operations (for agent key rotations)

- [ ] All three agents (momentum, contrarian, hybrid) connect and begin polling
- [ ] Agents place predictions on the next round
- [ ] Deposit manager detects and forwards inbound CBTC

### Admin endpoints (for admin secret rotation)

- [ ] `GET /admin/stats` returns 200 with the new secret
- [ ] Old secret returns 403

### Rewards API (for rewards key rotation)

- [ ] `GET /api/rewards/leaderboard` returns 200 with the new key
- [ ] Old key returns 403

### Authentication (for Firebase rotation)

- [ ] Google sign-in works on the frontend
- [ ] Agent Firebase email/password auth succeeds
- [ ] Token verification on protected endpoints works

---

## Rollback

If a rotation fails and the service is down:

1. Revert the Railway env vars to the previous (old) key values.
2. Redeploy the service.
3. Verify the service is healthy.
4. Investigate the failure before attempting the rotation again.

Keep the old key values in a secure, temporary location until you have confirmed the new keys are fully operational. Only delete old key records after the verification checklist passes.
