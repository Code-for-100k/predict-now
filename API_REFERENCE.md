# Predict Now -- API Reference

> BTC Prediction Market API for programmatic trading integration.

**Base URL**: `https://predict-now-preview-production.up.railway.app`

**Version**: Preview (v1)

**Prepared for**: Amit

---

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [CBTC Deposit Flow](#cbtc-deposit-flow)
- [Public Endpoints](#public-endpoints)
  - [GET /health](#get-health)
  - [GET /api/btc-price](#get-apibtc-price)
  - [GET /api/market/status](#get-apimarketstatus)
  - [GET /api/results/latest](#get-apiresultslatest)
  - [GET /api/results/:roundNumber](#get-apiresultsroundnumber)
  - [GET /api/results/history](#get-apiresultshistory)
  - [GET /api/pool-info](#get-apipool-info)
  - [GET /api/firebase-config](#get-apifirebase-config)
- [Authenticated Endpoints](#authenticated-endpoints)
  - [POST /api/auth/verify](#post-apiauthverify)
  - [POST /api/auth/link-party](#post-apiauthlink-party)
  - [POST /api/auth/set-active-wallet](#post-apiauthset-active-wallet)
  - [POST /api/deposit](#post-apideposit)
  - [POST /api/withdraw](#post-apiwithdraw)
  - [POST /api/predict](#post-apipredict)
  - [GET /api/balance](#get-apibalance)
  - [GET /api/bets](#get-apibets)
- [Error Handling](#error-handling)
- [Rate Limits](#rate-limits)

---

## Overview

Predict Now is a BTC prediction market built on Canton Network. Each round, you predict whether the BTC price will go **UP** or **DOWN** within a timed window. Winners split the losing pool (minus a platform fee) proportional to their bet size.

**How rounds work:**

1. A new round opens with a recorded BTC open price.
2. You place a prediction (UP or DOWN) with a CBTC wager.
3. When the round timer expires, the close price is captured.
4. If `close_price > open_price`, UP wins. If `close_price < open_price`, DOWN wins.
5. Winnings are credited to your internal balance automatically.

**Currency**: All amounts are denominated in **CBTC** (Canton BTC), with satoshi precision (8 decimal places). Minimum bet is `0.00001` CBTC (1,000 satoshis).

---

## Authentication

All authenticated endpoints require a **Firebase ID token** sent as a Bearer token in the `Authorization` header.

### Getting Your Token

1. **Sign up** at the Predict Now web UI using an invite code.
2. **Sign in** with Google to obtain a Firebase ID token.
3. **Include the token** in all authenticated API requests.

### Header Format

```
Authorization: Bearer <FIREBASE_ID_TOKEN>
```

### Obtaining a Token Programmatically

Use the Firebase Web SDK to sign in and retrieve an ID token:

```javascript
import { getAuth, signInWithPopup, GoogleAuthProvider } from "firebase/auth";

const auth = getAuth();
const result = await signInWithPopup(auth, new GoogleAuthProvider());
const token = await result.user.getIdToken();
```

You can retrieve the Firebase configuration from the public endpoint `GET /api/firebase-config`.

---

## CBTC Deposit Flow

Before you can place predictions, you need CBTC in your account. The deposit process works as follows:

1. **Get the pool wallet address** -- call `GET /api/pool-info` to get the `pool_party_id`.
2. **Send CBTC** from your Canton wallet to the `pool_party_id`.
3. **Verify and credit** -- call `POST /api/deposit` to scan for your transfer and credit your balance.

The deposit endpoint automatically accepts pending transfer offers from your linked wallets and credits any completed transfers. If Canton settlement is still processing, wait 30 seconds and call the endpoint again.

---

## Public Endpoints

These endpoints require no authentication.

---

### GET /health

Returns server status. Use this to verify the API is online.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/health
```

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2026-03-24T12:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | Always `"ok"` when the server is running |
| `timestamp` | `string` | ISO 8601 server timestamp |

---

### GET /api/btc-price

Returns the current BTC/USD price sourced from the Binance WebSocket feed, along with the 24-hour price change.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/api/btc-price
```

**Response:**

```json
{
  "price": 67542.31,
  "change_24h": 2.45,
  "last_updated": "2026-03-24T12:00:01.234Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `price` | `number` | Current BTC/USD price |
| `change_24h` | `number` | 24-hour percentage change |
| `last_updated` | `string` | ISO 8601 timestamp of last price update |

---

### GET /api/market/status

Returns the current prediction round status, including pool sizes and time remaining.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/api/market/status
```

**Response (active round):**

```json
{
  "status": "active",
  "round_number": 42,
  "open_price": 67500.00,
  "window_start_ms": 1711281600000,
  "window_end_ms": 1711281660000,
  "time_remaining_ms": 45000,
  "up_predictions": 3,
  "down_predictions": 2,
  "up_amount": 0.15,
  "down_amount": 0.08,
  "fee_percentage": 10
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | `"active"` or `"no_active_round"` |
| `round_number` | `number` | Current round sequence number |
| `open_price` | `number \| null` | BTC price when the round opened |
| `window_start_ms` | `number` | Round start time (Unix ms) |
| `window_end_ms` | `number` | Round end time (Unix ms) |
| `time_remaining_ms` | `number` | Milliseconds until the round closes |
| `up_predictions` | `number` | Count of UP bets this round |
| `down_predictions` | `number` | Count of DOWN bets this round |
| `up_amount` | `number` | Total CBTC in the UP pool |
| `down_amount` | `number` | Total CBTC in the DOWN pool |
| `fee_percentage` | `number` | Platform fee percentage (applied to loser pool) |

**Response (no active round):**

```json
{
  "status": "no_active_round",
  "next_round": 43,
  "next_start_time": 1711281660000
}
```

---

### GET /api/results/latest

Returns the most recently settled round with full prediction details.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/api/results/latest
```

**Response:**

```json
{
  "round_number": 41,
  "open_price": 67400.00,
  "close_price": 67550.25,
  "winning_direction": "UP",
  "total_up_amount": 0.25,
  "total_down_amount": 0.10,
  "fee_collected": 0.01,
  "predictions": [
    {
      "party_id": "participant::1234abcd...",
      "direction": "UP",
      "amount": 0.05,
      "won": true,
      "payout_txn_id": "txn_abc123"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `round_number` | `number` | Round sequence number |
| `open_price` | `number` | BTC price at round open |
| `close_price` | `number` | BTC price at round close |
| `winning_direction` | `string` | `"UP"` or `"DOWN"` |
| `total_up_amount` | `number` | Total CBTC bet on UP |
| `total_down_amount` | `number` | Total CBTC bet on DOWN |
| `fee_collected` | `number` | Platform fee collected this round |
| `predictions` | `array` | All predictions placed in this round |

**Prediction object:**

| Field | Type | Description |
|-------|------|-------------|
| `party_id` | `string` | Canton party ID of the bettor |
| `direction` | `string` | `"UP"` or `"DOWN"` |
| `amount` | `number` | CBTC wagered |
| `won` | `boolean` | Whether this prediction won |
| `payout_txn_id` | `string \| null` | Canton transaction ID for the payout |

**Error (no settled rounds yet):**

```
HTTP 404
{"error": "No settled rounds yet"}
```

---

### GET /api/results/:roundNumber

Returns results for a specific settled round.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/api/results/41
```

**Response:** Same schema as `GET /api/results/latest`.

**Errors:**

| Status | Body | Condition |
|--------|------|-----------|
| `400` | `{"error": "Invalid round number"}` | Non-numeric or negative round number |
| `404` | `{"error": "Round not found or not settled"}` | Round does not exist or has not settled yet |

---

### GET /api/results/history

Returns a paginated list of settled rounds, ordered newest first.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | `number` | `20` | Number of rounds to return (max 100) |

**Request:**

```bash
curl "https://predict-now-preview-production.up.railway.app/api/results/history?limit=5"
```

**Response:**

```json
{
  "rounds": [
    {
      "round_number": 41,
      "open_price": 67400.00,
      "close_price": 67550.25,
      "winning_direction": "UP",
      "total_up_amount": 0.25,
      "total_down_amount": 0.10,
      "fee_collected": 0.01
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `rounds` | `array` | Array of settled round summaries (no individual predictions) |

---

### GET /api/pool-info

Returns the Canton party ID of the pool wallet where you send CBTC deposits, plus the CBTC instrument identifiers.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/api/pool-info
```

**Response:**

```json
{
  "pool_party_id": "participant::1220abcdef...",
  "instrument_id": "CBTC",
  "instrument_admin": "participant::1220admin..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pool_party_id` | `string` | Canton party ID to send CBTC deposits to |
| `instrument_id` | `string` | CBTC instrument identifier on Canton |
| `instrument_admin` | `string` | CBTC instrument admin party ID |

---

### GET /api/firebase-config

Returns the Firebase configuration needed to initialize the Firebase SDK for authentication.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/api/firebase-config
```

**Response:**

```json
{
  "apiKey": "AIza...",
  "authDomain": "your-project.firebaseapp.com",
  "projectId": "your-project",
  "storageBucket": "your-project.appspot.com",
  "messagingSenderId": "123456789",
  "appId": "1:123456789:web:abcdef"
}
```

---

## Authenticated Endpoints

All endpoints below require the `Authorization: Bearer <token>` header.

---

### POST /api/auth/verify

Verifies your Firebase token and returns your user profile. For new users, an `invite_code` is required in the request body. For returning users, no body is needed.

**Request (new user):**

```bash
curl -X POST https://predict-now-preview-production.up.railway.app/api/auth/verify \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "RET-ABC123"}'
```

**Request (returning user):**

```bash
curl -X POST https://predict-now-preview-production.up.railway.app/api/auth/verify \
  -H "Authorization: Bearer <TOKEN>"
```

**Response:**

```json
{
  "uid": "firebase_uid_abc123",
  "email": "amit@example.com",
  "display_name": "Amit",
  "party_ids": ["participant::1220abcd..."],
  "active_party_id": "participant::1220abcd...",
  "has_party_id": true,
  "party_id": "participant::1220abcd...",
  "tier": "retail",
  "pool_wallet_id": "retail"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `uid` | `string` | Firebase user ID |
| `email` | `string` | User email address |
| `display_name` | `string \| null` | Display name from Google account |
| `party_ids` | `string[]` | All linked Canton wallet party IDs |
| `active_party_id` | `string \| null` | Currently active wallet for bets and withdrawals |
| `has_party_id` | `boolean` | Whether at least one wallet is linked |
| `party_id` | `string \| null` | Alias for `active_party_id` |
| `tier` | `string` | Account tier (`"retail"` or `"institutional"`) |
| `pool_wallet_id` | `string` | Pool wallet identifier for this tier |

**Errors:**

| Status | Body | Condition |
|--------|------|-----------|
| `403` | `{"error": "Invite code required for new accounts", "code": "INVITE_CODE_REQUIRED"}` | New user without invite code |
| `400` | `{"error": "Invalid invite code", "code": "INVALID_INVITE_CODE"}` | Invite code not recognized |
| `400` | `{"error": "Invite code has reached its usage limit", "code": "INVITE_CODE_EXHAUSTED"}` | Code already fully used |

---

### POST /api/auth/link-party

Links a Canton wallet (party ID) to your account. You can link multiple wallets. The first linked wallet becomes the active wallet automatically.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `party_id` | `string` | Yes | Canton party ID (must contain `::` separator, 20-300 chars) |

**Request:**

```bash
curl -X POST https://predict-now-preview-production.up.railway.app/api/auth/link-party \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"party_id": "participant::1220abcdef1234567890..."}'
```

**Response:**

```json
{
  "uid": "firebase_uid_abc123",
  "email": "amit@example.com",
  "display_name": "Amit",
  "party_ids": ["participant::1220abcdef1234567890..."],
  "active_party_id": "participant::1220abcdef1234567890...",
  "has_party_id": true,
  "party_id": "participant::1220abcdef1234567890...",
  "tier": "retail",
  "pool_wallet_id": "retail"
}
```

**Errors:**

| Status | Body | Condition |
|--------|------|-----------|
| `400` | `{"error": "Missing or invalid party_id"}` | Empty or non-string party ID |
| `400` | `{"error": "Invalid party_id format..."}` | Does not match Canton format |
| `404` | `{"error": "User not found. Call /api/auth/verify first."}` | Token valid but user not registered |
| `409` | `{"error": "..."}` | Party ID already linked to another account |

---

### POST /api/auth/set-active-wallet

Switches which linked wallet is used for placing bets and receiving withdrawals.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `party_id` | `string` | Yes | A party ID already linked to your account |

**Request:**

```bash
curl -X POST https://predict-now-preview-production.up.railway.app/api/auth/set-active-wallet \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"party_id": "participant::1220abcdef1234567890..."}'
```

**Response:**

```json
{
  "active_party_id": "participant::1220abcdef1234567890...",
  "party_ids": [
    "participant::1220abcdef1234567890...",
    "participant::1220second7890..."
  ]
}
```

**Errors:**

| Status | Body | Condition |
|--------|------|-----------|
| `400` | `{"error": "Wallet not linked to your account.", "linked_wallets": [...]}` | Party ID not in your linked wallets |
| `404` | `{"error": "User not found."}` | User does not exist |

---

### POST /api/deposit

Scans for CBTC transfers from your linked wallets to the pool wallet, accepts any pending transfer offers, and credits completed transfers to your balance.

**Request Body (optional):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `party_id` | `string` | No | Check deposits from a specific linked wallet only. If omitted, checks all linked wallets. |

**Request (check all wallets):**

```bash
curl -X POST https://predict-now-preview-production.up.railway.app/api/deposit \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Request (check specific wallet):**

```bash
curl -X POST https://predict-now-preview-production.up.railway.app/api/deposit \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"party_id": "participant::1220abcdef..."}'
```

**Response:**

```json
{
  "credited": 0.05,
  "balance": 0.15,
  "transfers_found": 1,
  "wallets_checked": 1,
  "offers_accepted": 1,
  "per_wallet": [
    {
      "party_id": "participant::1220abcdef...",
      "credited": 0.05,
      "found": 1
    }
  ],
  "message": "Credited 0.05 CBTC from 1 transfer(s)"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `credited` | `number` | Total CBTC credited this call |
| `balance` | `number` | Updated account balance |
| `transfers_found` | `number` | Number of new transfers processed |
| `wallets_checked` | `number` | Number of wallets scanned |
| `offers_accepted` | `number` | Number of pending transfer offers accepted on-chain |
| `per_wallet` | `array` | Breakdown of credits per wallet |
| `message` | `string` | Human-readable status message |

**Errors:**

| Status | Body | Condition |
|--------|------|-----------|
| `400` | `{"error": "No Canton wallet linked..."}` | No wallet linked to account |
| `400` | `{"error": "This wallet is not linked to your account."}` | Specified party ID not linked |
| `429` | `{"error": "Please wait before checking deposits again"}` | Rate limited (1 call per 10 seconds) |

---

### POST /api/withdraw

Withdraws CBTC from your account balance to your active Canton wallet (or a specified linked wallet).

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `amount` | `number` | Yes | Amount to withdraw in CBTC (min `0.00001`) |
| `party_id` | `string` | No | Withdraw to a specific linked wallet. Defaults to your active wallet. |

**Request:**

```bash
curl -X POST https://predict-now-preview-production.up.railway.app/api/withdraw \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"amount": 0.05}'
```

**Response:**

```json
{
  "txn_id": "update_id_abc123...",
  "amount": 0.05,
  "remaining_balance": 0.10
}
```

| Field | Type | Description |
|-------|------|-------------|
| `txn_id` | `string` | Canton transaction/update ID for the withdrawal |
| `amount` | `number` | Amount withdrawn (satoshi-precision) |
| `remaining_balance` | `number` | Account balance after withdrawal |

**Errors:**

| Status | Body | Condition |
|--------|------|-----------|
| `400` | `{"error": "No Canton wallet linked..."}` | No wallet linked |
| `400` | `{"error": "Specified wallet is not linked to your account."}` | Party ID not linked |
| `400` | `{"error": "Invalid amount (min 0.00001 CBTC / 1000 sats)"}` | Amount too small or invalid |
| `400` | `{"error": "Insufficient balance: have X CBTC, requested Y CBTC"}` | Not enough balance |

---

### POST /api/predict

Places a prediction on the current active round. Your bet amount is deducted from your internal balance immediately.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `direction` | `string` | Yes | `"UP"` or `"DOWN"` |
| `amount` | `number` | Yes | Wager amount in CBTC (`0.00001` to `21000000`) |

**Request:**

```bash
curl -X POST https://predict-now-preview-production.up.railway.app/api/predict \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"direction": "UP", "amount": 0.01}'
```

**Response:**

```json
{
  "prediction_id": 15,
  "market_round": 42,
  "direction": "UP",
  "amount": 0.01,
  "party_id": "participant::1220abcdef...",
  "remaining_balance": 0.04,
  "message": "Prediction registered successfully"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `prediction_id` | `number` | Unique prediction identifier |
| `market_round` | `number` | Round number this prediction was placed in |
| `direction` | `string` | `"UP"` or `"DOWN"` |
| `amount` | `number` | CBTC wagered (rounded to satoshi precision) |
| `party_id` | `string` | Canton party ID used for this prediction |
| `remaining_balance` | `number` | Account balance after the bet |
| `message` | `string` | Confirmation message |

**Errors:**

| Status | Body | Condition |
|--------|------|-----------|
| `400` | `{"error": "No Canton wallet linked..."}` | No wallet linked |
| `400` | `{"error": "Invalid amount..."}` | Amount out of valid range |
| `400` | `{"error": "Invalid direction (must be UP or DOWN)"}` | Bad direction value |
| `400` | `{"error": "Insufficient balance..."}` | Not enough CBTC |
| `400` | `{"error": "No active market round"}` | Between rounds |
| `400` | `{"error": "Market round already settled"}` | Round already closed |
| `400` | `{"error": "Market round has expired -- settlement pending"}` | Timer expired, awaiting settlement |
| `429` | `{"error": "Rate limit exceeded (max 5 predictions per round)"}` | Too many bets this round |

---

### GET /api/balance

Returns your account balance and lifetime statistics.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/api/balance \
  -H "Authorization: Bearer <TOKEN>"
```

**Response:**

```json
{
  "uid": "firebase_uid_abc123",
  "active_party_id": "participant::1220abcdef...",
  "linked_wallets": 1,
  "balance": 0.15,
  "total_deposited": 0.20,
  "total_withdrawn": 0.05,
  "total_won": 0.03,
  "total_lost": 0.03
}
```

| Field | Type | Description |
|-------|------|-------------|
| `uid` | `string` | Firebase user ID |
| `active_party_id` | `string` | Currently active Canton wallet |
| `linked_wallets` | `number` | Number of linked wallets |
| `balance` | `number` | Current available CBTC balance |
| `total_deposited` | `number` | Lifetime CBTC deposited |
| `total_withdrawn` | `number` | Lifetime CBTC withdrawn |
| `total_won` | `number` | Lifetime CBTC won from predictions |
| `total_lost` | `number` | Lifetime CBTC lost from predictions |

**Errors:**

| Status | Body | Condition |
|--------|------|-----------|
| `400` | `{"error": "No Canton wallet linked..."}` | No wallet linked to account |

---

### GET /api/bets

Returns your complete prediction history across all rounds.

**Request:**

```bash
curl https://predict-now-preview-production.up.railway.app/api/bets \
  -H "Authorization: Bearer <TOKEN>"
```

**Response:**

```json
[
  {
    "round_number": 42,
    "direction": "UP",
    "amount": 0.01,
    "status": "pending",
    "payout_amount": 0,
    "payout_txn_id": null,
    "settled": false
  },
  {
    "round_number": 41,
    "direction": "UP",
    "amount": 0.05,
    "status": "won",
    "payout_amount": 0.068,
    "payout_txn_id": "txn_abc123",
    "settled": true
  },
  {
    "round_number": 40,
    "direction": "DOWN",
    "amount": 0.03,
    "status": "lost",
    "payout_amount": 0,
    "payout_txn_id": null,
    "settled": true
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `round_number` | `number` | Round this bet was placed in |
| `direction` | `string` | `"UP"` or `"DOWN"` |
| `amount` | `number` | CBTC wagered |
| `status` | `string` | `"pending"`, `"won"`, or `"lost"` |
| `payout_amount` | `number` | CBTC payout (0 if lost or pending) |
| `payout_txn_id` | `string \| null` | Canton transaction ID for payout |
| `settled` | `boolean` | Whether the round has been settled |

---

## Error Handling

All error responses follow a consistent format:

```json
{
  "error": "Human-readable error message"
}
```

Some errors include an additional `code` field for programmatic handling:

```json
{
  "error": "Invite code required for new accounts",
  "code": "INVITE_CODE_REQUIRED"
}
```

### Common HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Success |
| `400` | Bad request (invalid parameters, insufficient balance, no active round) |
| `401` | Unauthorized (missing or invalid Firebase token) |
| `404` | Resource not found (round, user) |
| `409` | Conflict (party ID already linked to another account) |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `POST /api/deposit` | 1 request per 10 seconds per user |
| `POST /api/predict` | 5 predictions per round per user |

All other endpoints do not have explicit rate limits, but excessive use may be throttled at the infrastructure level.
