# PRD: BTC Prediction Market

v1.0 | March 2026 | Canton Network + Zoro Wallet API

---

## What It Is

Binary prediction game. Users bet UP or DOWN on BTC price in 15-min windows using Canton Coin (CC). Winners split the loser pool proportionally. 10% operator fee.

```
payout = original_bet + (bet / winner_pool) × loser_pool × 0.9
```

---

## Architecture

### Internal Ledger (the key decision)

No on-chain transactions for bets or settlement. Canton API only used for deposits (accept pending transfer) and withdrawals (send CC). Everything else is internal balance math.

```
Deposit:  User sends CC → pending queue → server accepts → credits balance
Bet:      balance -= amount (instant, no API call)
Settle:   balance += payout (instant, no API call)
Withdraw: server sends CC → balance -= amount
```

**Why no auto-approval on pool wallet:** Zoro has no completed transaction history API. The ONLY way to match sender party ID is via `/canton/transaction/history/pending`, which only shows unaccepted transfers. Auto-approval would make deposit verification impossible.

### File Structure

```
src/
├── market.ts                  # Express server + startup health check
├── api/
│   ├── prediction.ts          # POST /predict, GET /market/status, GET /results/*
│   └── account.ts             # POST /deposit, POST /withdraw, GET /balance, GET /bets, GET /pool-info
├── settlement/settlement.ts   # Payout math, internal balance credits, idempotency guard
├── scheduler/cron.ts          # 15-min cron → oracle fetch → settle
├── oracle/binance-oracle.ts   # Binance kline fetch with retry
├── db/init.ts                 # JSON DB with atomic writes, getOrCreateBalance()
├── lib/
│   ├── api.ts                 # Canton API client: getPendingTransfers, prepareAccept, prepareSend, broadcast, getBalance
│   ├── types.ts               # Config, PrepareResponse, BroadcastResponse, PendingTransaction, etc.
│   ├── sign.ts                # Ed25519 signing via @noble/ed25519
│   └── config.ts              # Env var loader
public/
└── index.html                 # Single-page UI (no build step)
```

### Data Model

**DB shape:** `{ rounds[], predictions[], balances[], deposits[], withdrawals[] }`

**MarketRound** — `round_number`, `window_start_time`, `window_end_time`, `open_price`, `close_price`, `winning_direction`, `total_up_amount`, `total_down_amount`, `settling` (idempotency lock), `settled`

**Prediction** — `market_round_id`, `party_id`, `direction` (UP|DOWN), `amount`, `settled`

**UserBalance** — `party_id`, `balance`, `total_deposited`, `total_withdrawn`, `total_won`, `total_lost`

**DepositRecord** — `party_id`, `amount`, `contract_id` (idempotency key), `accepted_at`

**WithdrawalRecord** — `party_id`, `amount`, `txn_id`, `created_at`

---

## API Endpoints

| Method | Endpoint | What it does |
|--------|----------|-------------|
| `POST` | `/api/deposit` | Check pool's pending transfers, filter by sender party_id, accept matching ones, credit balance. Rate limit: 1 per 10s per party. |
| `POST` | `/api/predict` | Validate balance >= amount, deduct balance, create prediction, update round totals. Rate limit: 5 per round per party. |
| `POST` | `/api/withdraw` | Validate balance >= amount, execute Canton send (prepare→sign→broadcast), deduct balance, record withdrawal. |
| `GET` | `/api/balance/:partyId` | Return `{ balance, total_deposited, total_withdrawn, total_won, total_lost }` |
| `GET` | `/api/bets/:partyId` | Return bet array with `status: "won" | "lost" | "pending"` per bet |
| `GET` | `/api/market/status` | Current round number, countdown, UP/DOWN pool sizes and counts |
| `GET` | `/api/results/history?limit=20&offset=0` | Paginated settled rounds |
| `GET` | `/api/results/:roundNumber` | Single round detail with per-prediction breakdown |
| `GET` | `/api/pool-info` | `{ pool_party_id, fee_percentage }` |
| `GET` | `/health` | `{ status: "ok" }` |

---

## Canton API Usage

All Canton calls go through `src/lib/api.ts` using a shared `post()` helper with log redaction.

| Canton Endpoint | Used In | Purpose |
|----------------|---------|---------|
| `POST /canton/wallet/balance` | `market.ts` startup | Health check |
| `POST /canton/transaction/history/pending` | `account.ts` deposit | List pending transfers for pool |
| `POST /canton/transaction/prepare/accept` | `account.ts` deposit | Accept a pending transfer |
| `POST /canton/transaction/prepare/send` | `account.ts` withdraw | Send CC to user |
| `POST /canton/transaction/broadcast` | Both deposit + withdraw | Broadcast signed transaction |

**Constraints:** 0.5 TPS (2s sleep between calls), 3-step flow (prepare → sign → broadcast), 30s timeout wrapper on all calls.

---

## Settlement Logic (`settlement.ts`)

```
1. Guard: if round.settled → throw. if round.settling → throw.
2. Set round.settling = true, db.save()  ← idempotency lock
3. Split predictions into winners[] and losers[]
4. feeCollected = loserPool × feePercentage
5. For each winner:
     payout = bet + (bet / winnerPool) × loserPool × (1 - fee%)
     balance[winner] += payout
     winner.total_won += (payout - bet)
6. For each loser:
     loser.total_lost += bet   (balance already deducted at bet time)
7. Credit operator balance += feeCollected
8. If no losers: refund winners their original bet
9. round.settled = true, round.settling = false, db.save()
```

Zero external API calls. Cannot fail.

---

## Hardening (already implemented)

| What | Where | How |
|------|-------|-----|
| Log redaction | `api.ts` | Strip privateKey, signature, publicKey, apiKey from logs |
| Idempotency (settlement) | `settlement.ts` | `settling` flag persisted before work; cleared on completion or crash recovery |
| Idempotency (deposits) | `account.ts` | `contract_id` dedup — same transfer never credited twice |
| Atomic DB writes | `db/init.ts` | Write to `.tmp`, then `fs.renameSync` |
| Input validation | `prediction.ts`, `account.ts` | Party ID format check, amount bounds (0.01–999,999.99) |
| Rate limiting | `prediction.ts`, `account.ts` | 5 bets/round/party, 1 deposit check/10s/party |
| Error sanitization | All routes | 500s return `{ error: "Internal server error" }` only |
| Oracle retry | `binance-oracle.ts` | 3 retries, 2s delay, 10s timeout, uses completed kline |
| Stale lock cleanup | `db/init.ts` | On startup, clear `settling` flags from crash |

---

## Frontend (`public/index.html`)

Single HTML file, no build step. Key sections:

- **Account** — Party ID input (localStorage), balance bar with deposited/won/lost stats
- **Deposit** — Pool ID with copy button + "Verify Deposit" button
- **Withdraw** — Amount input + withdraw button
- **Market** — BTC price, round #, countdown, UP/DOWN pools
- **Bet form** — Direction picker, amount with balance hint, submit
- **My Bets** — WON/LOST/PENDING badges per bet
- **Round History** — Paginated settled rounds

Polling: market status 5s, balance+bets 15s, history on-demand.

---

## Config (`.env`)

```
ZORO_BASE_URL=https://dev-api.zorowallet.com
ZORO_API_KEY=<key>
SENDER_PARTY_ID=<pool wallet>
SENDER_PRIVATE_KEY=<base64>
SENDER_PUBLIC_KEY=<base64>
OPERATOR_PARTY_ID=<fee recipient>
INSTRUMENT_ID=Amulet
INSTRUMENT_ADMIN=DSO::1220b1431ef...
FEE_PERCENTAGE=10
PORT=3000
DB_PATH=./market.db.json
LOG_API_CALLS=true
```

---

## Run

```bash
npm run market              # start server
docker compose up -d        # or via Docker
pm2 start ecosystem.config.cjs  # or via PM2
```

---

## Not building (v1)

No auth, no wallet creation, no notifications, no PostgreSQL, no KYC, no multiple oracles, no multiple pairs, no mobile app. Party ID = identity. JSON DB fine for <100 users.
