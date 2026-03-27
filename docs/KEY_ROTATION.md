# Key Rotation Procedures

This document describes how to rotate each secret used by Predict Now.

---

## 1. ADMIN_SECRET

**What it protects:** All `/admin/*` endpoints (user management, invite codes, payouts, circuit breaker).

**Rotation steps:**

1. Generate a new secret: `openssl rand -base64 32`
2. Update the `ADMIN_SECRET` env var in Railway (or your deployment platform).
3. Update your local `.env` file.
4. Restart the server. The new secret takes effect immediately.
5. Update any saved admin secret in browser `localStorage` (dashboard, agents page).
6. Notify all team members who use admin endpoints.

**Frequency:** Rotate immediately if compromised. Otherwise, rotate quarterly.

---

## 2. Firebase Service Account (firebase-sa.json)

**What it protects:** Firebase Auth token verification, user identity.

**Rotation steps:**

1. Go to Firebase Console > Project Settings > Service Accounts.
2. Click "Generate new private key" to create a new SA JSON file.
3. Replace `firebase-sa.json` on the deployment platform (Railway file mount or env var `FIREBASE_SA_B64`).
4. The old key is automatically revoked by Firebase when you generate a new one.
5. Restart the server.

**Frequency:** Rotate annually or immediately if the key file is exposed.

---

## 3. ZORO_API_KEY (Canton Wallet API)

**What it protects:** All Canton ledger operations (deposits, withdrawals, balance checks, transaction history).

**Rotation steps:**

1. Contact the Zoro / Canton wallet provider to issue a new API key.
2. Update `ZORO_API_KEY` in Railway env vars.
3. Update your local `.env`.
4. Restart the server.
5. Verify with a health check: `GET /health` and attempt a test deposit flow.

**Frequency:** Rotate if compromised. Otherwise, follow the provider's recommended schedule.

---

## 4. Canton Wallet Private Keys (Pool Wallets)

**What they protect:** Signing transactions for pool wallets (payouts, withdrawals, seeding).

**Rotation steps:**

1. Generate a new Ed25519 keypair for the affected pool wallet.
2. Register the new public key with the Canton network / Zoro wallet provider.
3. Update the corresponding env vars:
   - `SENDER_PRIVATE_KEY` / `SENDER_PUBLIC_KEY` (retail pool)
   - `INST1_PRIVATE_KEY` / `INST1_PUBLIC_KEY` (institutional pool 1)
   - Additional pools as configured.
4. Update `wallets-batch.json` locally (never commit this file).
5. Restart the server.
6. Send a small test transaction to verify the new key works.

**Frequency:** Rotate immediately if any private key is exposed. Otherwise, rotate annually.

---

## 5. REWARDS_API_KEY

**What it protects:** Partner-facing `/api/rewards` endpoint.

**Rotation steps:**

1. Generate a new key: `openssl rand -base64 32`
2. Update `REWARDS_API_KEY` in Railway env vars.
3. Notify all partners who use the rewards API to update their integration.
4. Restart the server.

**Frequency:** Rotate when a partner's access should be revoked, or quarterly.

---

## General Guidelines

- Never hardcode secrets in source code. Always use environment variables.
- Never commit secrets to git. The `.gitignore` excludes `.env`, `firebase-sa.json`, and `wallets-batch.json`.
- Use `$ADMIN_SECRET` as a placeholder in documentation instead of the actual value.
- After any rotation, verify the service is healthy before marking rotation complete.
