# Predict Now — BTC Prediction Market

A real-time BTC price prediction market built on the **Canton Network** using **CBTC** for deposits and payouts.

## Live

- **Production:** [https://predictnow.cc](https://predictnow.cc)
- **Railway:** [https://btc-prediction-market-production.up.railway.app](https://btc-prediction-market-production.up.railway.app)

## Architecture

```
Frontend (SPA)          Backend (Express)           External
─────────────          ─────────────────           ────────
index.html      ──►    market.ts (main)     ──►    Zoro/Canton API
 - Firebase Auth        ├── api/auth.ts             - Wallet mgmt
 - Binance WS           ├── api/account.ts          - CC transfers
   (live price)         ├── api/prediction.ts        - Tx history
 - Tailwind CSS         ├── settlement/
                        ├── scheduler/cron.ts  ──►  CoinGecko API
                        ├── oracle/coingecko.ts      - BTC price
                        └── db/init.ts (JSON DB)     - Settlement
```

## Key Features

- **1-minute prediction rounds** — bet UP or DOWN on BTC price
- **Real-time BTC price** — Binance WebSocket in browser (multiple updates/sec)
- **Canton Coin deposits** — link your Canton wallet, send CC, verify via transaction history
- **Auto-payout** — winners get CC sent directly back to their wallet on settlement
- **Multi-wallet support** — link multiple Canton wallets, set one as active
- **Firebase Auth** — Google sign-in, secure API with ID tokens
- **Per-wallet deposit tracking** — each wallet has its own verified offset (no double-credits)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/JS, Tailwind CSS, Firebase Auth SDK |
| Backend | Node.js, Express, TypeScript (tsx) |
| Database | JSON file (market.db.json) |
| Auth | Firebase Admin SDK |
| Blockchain | Canton Network via Zoro Wallet API |
| Oracle | CoinGecko (settlement), Binance WebSocket (display) |
| Hosting | Railway |

## Setup

### Prerequisites

- Node.js 22+
- Firebase project with Google Auth enabled
- Canton/Zoro wallet (pool wallet) with CC balance

### Environment Variables

```bash
# Canton/Zoro API
CANTON_BASE_URL=https://dev-api.zorowallet.com
CANTON_API_KEY=your_api_key
SENDER_PARTY_ID=your_pool_party_id
SENDER_PUBLIC_KEY=your_pool_public_key
SENDER_PRIVATE_KEY=your_pool_private_key

# Firebase Admin
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=your_service_account_email
FIREBASE_PRIVATE_KEY=your_private_key

# Firebase Web (public)
FIREBASE_WEB_API_KEY=your_web_api_key
FIREBASE_WEB_AUTH_DOMAIN=your_project.firebaseapp.com
FIREBASE_WEB_PROJECT_ID=your_project_id
FIREBASE_WEB_APP_ID=your_app_id

# App config
PORT=3000
DB_PATH=./market.db
ROUND_MINUTES=1
```

### Install & Run

```bash
npm install
npm start
```

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/api/btc-price` | No | Cached BTC price |
| GET | `/api/firebase-config` | No | Firebase web config |
| GET | `/api/market/status` | No | Current round status |
| GET | `/api/results/history` | No | Settled round history |
| GET | `/api/pool-info` | No | Pool wallet address & balance |
| POST | `/api/auth/verify` | Yes | Verify Firebase token |
| POST | `/api/auth/link-party` | Yes | Link Canton wallet |
| POST | `/api/auth/set-active-wallet` | Yes | Switch active wallet |
| GET | `/api/balance` | Yes | User balance & stats |
| POST | `/api/deposit` | Yes | Verify & credit CC deposits |
| POST | `/api/predict` | Yes | Place UP/DOWN prediction |
| GET | `/api/bets` | Yes | User's bet history |

## Settlement Flow

1. Round ends (1-minute timer)
2. CoinGecko oracle fetches BTC close price
3. Compare open vs close → determine UP or DOWN
4. Winners split the loser pool proportionally
5. **Auto-payout:** CC sent from pool wallet to each winner's Canton wallet
6. New round starts automatically

## Data Model

- **Users** — `uid` (Firebase), `party_ids[]`, `active_party_id`
- **Balances** — keyed by `uid`, tracks deposited/won/lost
- **Predictions** — `uid`, `round_id`, `direction`, `amount`, `status`
- **Deposits** — `uid`, `party_id`, `amount`, `update_id` (idempotency)
- **WalletDepositState** — per-wallet `last_verified_offset` (prevents double-credit)
- **Rounds** — `open_price`, `close_price`, `direction`, `status`

## Project Structure

```
├── public/
│   └── index.html          # SPA frontend (Tailwind + Firebase Auth)
├── src/
│   ├── market.ts           # Main server entry point
│   ├── api/
│   │   ├── auth.ts         # Auth routes (verify, link-party, set-wallet)
│   │   ├── account.ts      # Account routes (balance, deposit, withdraw, bets)
│   │   └── prediction.ts   # Market routes (status, predict, history)
│   ├── db/
│   │   └── init.ts         # JSON database with migrations
│   ├── lib/
│   │   ├── api.ts          # Zoro/Canton API client
│   │   ├── config.ts       # Environment config loader
│   │   ├── firebase.ts     # Firebase Admin init
│   │   ├── sign.ts         # Ed25519 transaction signing
│   │   └── types.ts        # API response types
│   ├── middleware/
│   │   └── auth.ts         # Firebase token verification middleware
│   ├── oracle/
│   │   └── coingecko-oracle.ts  # BTC price oracle
│   ├── scheduler/
│   │   └── cron.ts         # Round lifecycle scheduler
│   ├── settlement/
│   │   └── settlement.ts   # Payout calculation + auto-withdrawal
│   └── types/
│       └── market.ts       # Domain types
├── package.json
├── tsconfig.json
├── PRD.md
├── CONTEXT.md
├── CC_INTEGRATION.md
├── ZORO_AI_INSTRUCTIONS.md
└── DEPLOYMENT.md
```
