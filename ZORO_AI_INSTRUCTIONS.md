# Zoro Wallet API — AI Agent Instructions

This document gives a complete working reference for interacting with the Zoro Wallet API to send CC (Canton Coin) and CBTC on the Canton mainnet. All scripts are already built and tested.

---

## Project Location

```
/Users/mayank/Clawed/canton-send/
```

Run all commands from this directory.

---

## Credentials & Known Values

| Key | Value |
|-----|-------|
| **API endpoint** | `https://dev-api.zorowallet.com` (Zoro beta API, connected to Canton mainnet) |
| **API key** | `canton_-KPOgjYXFL_DoI-S3wMhFCIbxaElqbjVJxUc69T7wbI` |
| **Mayank's Zoro wallet party ID** | `237268376e::122034217581211f6d9fca5ef447aba2cb9302608dedb336a1f58339178a4cc36f43` |
| **CC instrument ID** | `Amulet` |
| **CC instrument admin** | `DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc` |
| **CBTC instrument ID** | `CBTC` |
| **CBTC instrument admin** | `cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262` |
| **Rate limit** | 0.5 TPS (wait ≥2s between transactions) |
| **Party onboard limit** | 10 parties max, 5 per minute |

### Test Party (API-controlled)
The test party below has its own Ed25519 keys stored in `.env` and can sign/send transactions directly via the API:

| | Value |
|-|-------|
| **Party ID** | `8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37` |
| **Private/public keys** | Stored in `/Users/mayank/Clawed/canton-send/.env` |

---

## .env File

Located at `/Users/mayank/Clawed/canton-send/.env`. Required fields:

```
ZORO_BASE_URL=https://dev-api.zorowallet.com
ZORO_API_KEY=canton_-KPOgjYXFL_DoI-S3wMhFCIbxaElqbjVJxUc69T7wbI
SENDER_PARTY_ID=<party ID of the API-controlled test party>
SENDER_PRIVATE_KEY=<base64 Ed25519 private key>
SENDER_PUBLIC_KEY=<base64 Ed25519 public key>
INSTRUMENT_ID=Amulet
INSTRUMENT_ADMIN=DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc
```

`INSTRUMENT_ID` and `INSTRUMENT_ADMIN` default to CC (Amulet). Override in the script for CBTC.

---

## Available Scripts

All scripts use `npx tsx src/<script>.ts`. No build step needed.

### `src/balance.ts` — Check balance
```bash
npx tsx src/balance.ts                                      # test party from .env
npx tsx src/balance.ts <partyId>                            # any party
```

### `src/send.ts` — Send CC
```bash
npx tsx src/send.ts                                         # send 10 CC to Mayank's wallet
npx tsx src/send.ts <receiverPartyId>                       # send 10 CC to specific party
npx tsx src/send.ts <receiverPartyId> <amount>              # send custom amount of CC
```
- Logs full API responses at each step (prepare, sign, broadcast)
- Checks balance before and after
- Default receiver: Mayank's Zoro wallet

### `src/send-cbtc.ts` — Send CBTC
```bash
npx tsx src/send-cbtc.ts                                    # sends all CBTC to Mayank's wallet
npx tsx src/send-cbtc.ts <receiverPartyId> <amount>
```
- Uses hardcoded CBTC instrument details
- Costs ~3 CC in network fees per transaction (paid from CC balance)

### `src/onboard.ts` — Create a new party
```bash
npx tsx src/onboard.ts
```
- Generates a fresh Ed25519 key pair
- Registers a new party on Canton mainnet via the Zoro API
- Prints the new party ID and keys — copy them into `.env`

### `src/setup-party.ts` — Set up a party for receiving
```bash
npx tsx src/setup-party.ts
```
- Runs merge delegation + transfer pre-approval for CC in sequence
- Required so the party can auto-accept incoming CC transfers
- Must be run after onboarding before the party can receive

### `src/preapprove.ts` — CC transfer pre-approval only
```bash
npx tsx src/preapprove.ts
```

### `src/preapprove-cbtc.ts` — CBTC transfer pre-approval
```bash
npx tsx src/preapprove-cbtc.ts
```

### `src/pending.ts` — Check pending transfers
```bash
npx tsx src/pending.ts                                      # test party
npx tsx src/pending.ts <partyId>                            # any party
```

---

## Core Library (`src/lib/`)

### `src/lib/api.ts`
All Zoro API calls. Every function logs full request + response JSON.

| Function | Endpoint | Purpose |
|----------|----------|---------|
| `prepareExternalParty(config, publicKey)` | POST `/canton/transaction/prepare/external-party` | Step 1 of onboarding |
| `broadcastExternalParty(config, sig, preparedParty)` | POST `/canton/transaction/broadcast/external-party` | Step 2 of onboarding |
| `prepareSend(config, params)` | POST `/canton/transaction/prepare/send` | Step 1 of sending |
| `broadcast(config, params)` | POST `/canton/transaction/broadcast` | Step 2 of sending |
| `getBalance(config, partyId)` | POST `/canton/wallet/balance` | Check balance |
| `getChoiceContext(config, params)` | POST `/canton/transaction/choice-context` | Optional: pre-fetch contract cache |

### `src/lib/sign.ts`
Ed25519 signing using `@noble/ed25519` v2.

| Function | Description |
|----------|-------------|
| `generateKeyPair()` | Returns `{ privateKey, publicKey }` as base64 strings |
| `signHash(hashBase64, privateKeyBase64)` | Signs base64 hash, returns base64 signature |
| `getPublicKey(privateKeyBase64)` | Derives public key from private key |

### `src/lib/config.ts`
Loads `.env` and returns a typed `Config` object. Call `loadConfig(true)` when you need sender keys; `loadConfig(false)` for read-only operations.

### `src/lib/types.ts`
TypeScript interfaces for all API request/response shapes.

---

## Transaction Flow

Every send follows a 3-step prepare → sign → broadcast pattern:

```
1. POST /canton/transaction/prepare/send
   → returns: commandId, preparedTransaction (base64), preparedTransactionHash (base64), hashingSchemeVersion

2. Ed25519 sign the preparedTransactionHash with sender's private key
   → returns: signature (base64)

3. POST /canton/transaction/broadcast
   body: { signature, publicKey, preparedTransaction: { commandId, command }, partyId }
   → returns: { status, transactionId }
```

Same pattern applies to onboarding (but uses `multiHash` instead of `preparedTransactionHash`).

---

## Fee Findings (Measured on Mainnet)

| Operation | Traffic units | CC fee | USD fee (at $0.155/CC) |
|-----------|--------------|--------|------------------------|
| **CC send** | ~9,253 | ~0 CC | ~$0 |
| **CBTC send** | ~27,302 | ~3.02 CC | ~$0.47 |
| **Transfer pre-approval** | ~3,583 | ~0 CC | ~$0 |
| **Onboarding** | ~N/A | 0 CC | $0 |

Key observations:
- **CC-to-CC transfers have no effective fee** at current mainnet pricing
- **CBTC sends cost ~3 CC** (~$0.47) in network traffic fees — deducted from CC balance, not CBTC
- **Fee is charged at send time**, not at acceptance — rejecting a transfer does NOT refund the fee
- **Pre-approval must be set up per instrument** (CC and CBTC require separate pre-approvals)
- **Without pre-approval**, receivers get a pending offer they must manually accept

---

## New Party Setup Checklist

When you create a new test party and need it to receive tokens:

1. `npx tsx src/onboard.ts` → copy output into `.env`
2. `npx tsx src/setup-party.ts` → merge delegation + CC pre-approval
3. `npx tsx src/preapprove-cbtc.ts` → CBTC pre-approval (if needed)
4. Send CC to the party from Mayank's Zoro app to fund it
5. `npx tsx src/balance.ts` → confirm funds arrived
6. Party is now ready to send

---

## Important Gotchas

1. **Rate limit**: 0.5 TPS — always wait ≥2s between transactions. `setup-party.ts` handles this automatically with a 3s delay.
2. **CBTC fees come from CC balance** — the test party needs CC to send CBTC. If CC balance is too low, CBTC send will fail.
3. **Pre-approval is per-instrument** — setting up CC pre-approval does not cover CBTC. Run `preapprove-cbtc.ts` separately.
4. **Party IDs are 71–245 chars** — validate length before passing to any API call.
5. **`dev-api.zorowallet.com` is Canton mainnet** — these are real transactions with real CC/CBTC. The "dev" refers to Zoro's API being in beta.
6. **Never re-use commandId** — each prepare call returns a unique commandId; always sign and broadcast the most recent one.
7. **Expiry date** — set 24h from now. If you try to broadcast an expired prepared transaction, it will fail.
8. **Keys format**: Ed25519 keys are base64-encoded 32-byte values. Private key must be exactly 32 bytes when decoded.

---

## Dependencies

```json
{
  "@noble/ed25519": "^2.1.0",
  "@noble/hashes": "^1.7.0",
  "dotenv": "^16.4.7"
}
```

Run `npm install` if node_modules is missing.

---

## Quick Reference

```bash
cd /Users/mayank/Clawed/canton-send

# Check balances
npx tsx src/balance.ts                          # test party
npx tsx src/balance.ts 237268376e::1220...      # Mayank's wallet

# Send CC
npx tsx src/send.ts                             # 10 CC → Mayank's wallet
npx tsx src/send.ts <partyId> <amount>          # custom

# Send CBTC
npx tsx src/send-cbtc.ts                        # all CBTC → Mayank's wallet

# New party from scratch
npx tsx src/onboard.ts
npx tsx src/setup-party.ts
npx tsx src/preapprove-cbtc.ts

# Debug
npx tsx src/pending.ts                          # pending transfers
```
