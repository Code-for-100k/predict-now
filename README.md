# Predict Now — BTC Prediction Market on Canton Network

A real-time BTC price prediction market built on the **Canton Network** using **CBTC** for deposits and payouts, with autonomous trading agents and copy-trading.

## Live

- **App:** [https://predictnow.cc](https://predictnow.cc)
- **Admin Dashboard:** [https://predictnow.cc/dashboard.html](https://btc-prediction-market-production.up.railway.app/dashboard.html)
- **Agent Monitor:** [https://predictnow.cc/agents.html](https://btc-prediction-market-production.up.railway.app/agents.html)
- **Rewards Dashboard:** [https://predictnow.cc/rewards-dashboard.html](https://btc-prediction-market-production.up.railway.app/rewards-dashboard.html)
- **Railway:** [https://btc-prediction-market-production.up.railway.app](https://btc-prediction-market-production.up.railway.app)

## Architecture

```
Frontend (SPA)            Backend (Express)              External Services
─────────────            ─────────────────              ─────────────────
index.html        ──►    market.ts (entry point)  ──►   Zoro Wallet API
 - Firebase Auth          ├── api/auth.ts                - Canton transfers
 - Binance WS             ├── api/account.ts             - Balance queries
 - Tailwind CSS           ├── api/prediction.ts          - Tx history
                          ├── api/leaderboard.ts
dashboard.html            ├── settlement/          ──►   Binance WebSocket
agents.html               │   └── settlement.ts          - Real-time BTC price
rewards-dashboard.html    ├── scheduler/cron.ts
leaderboard.html          ├── oracle/binance-ws.ts ──►   CoinGecko API
                          ├── lib/circuit-breaker.ts      - Settlement price
                          ├── lib/slack.ts           ──► Slack Webhooks
                          └── db/init.ts (JSON DB)

agents/ (child process)
 ├── cli.ts               Agent factory + launcher
 ├── agent.ts             Individual agent lifecycle
 ├── strategies/
 │   ├── momentum.ts      Trend-following
 │   ├── contrarian.ts    Trend-reversal
 │   └── hybrid-ev.ts     EV-based hybrid
 └── market-client.ts     HTTP client to market API
```

## Key Features

- **1-minute prediction rounds** — bet UP or DOWN on BTC price
- **Real-time BTC price** — Binance WebSocket (multiple updates/sec)
- **Canton CBTC deposits** — link your Canton wallet, deposit, verify via tx history
- **Auto-payout** — winners receive CBTC directly to their Canton wallet
- **Multi-pool wallets** — retail + 3 institutional pools, auto-routed by user tier
- **Autonomous agents** — 3 trading bots (momentum, contrarian, hybrid-ev) bet every round
- **Circuit breaker** — monitors gas cost vs reward margin, auto-pauses if unprofitable
- **Copy-trading** — users can follow agent strategies from the leaderboard
- **Rewards tracking** — integrates with CBTC Activity Tracker (Yak) for CC reward analytics
- **Firebase Auth** — Google sign-in + email/password for agents

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/JS, Tailwind CSS, Firebase Auth SDK, Chart.js |
| Backend | Node.js 22+, Express, TypeScript (tsx) |
| Database | JSON file (`market.db.json`) — no external DB required |
| Auth | Firebase Admin SDK (server) + Firebase Web SDK (client) |
| Blockchain | Canton Network via [Zoro Wallet API](https://dev-api.zorowallet.com) |
| Price Oracle | Binance WebSocket (display), CoinGecko (settlement) |
| Hosting | Railway |
| Monitoring | Slack alerts, admin dashboard, circuit breaker |

## Quick Start

### Prerequisites

- Node.js 22+
- Firebase project with Google Auth enabled
- Canton/Zoro wallet with CBTC balance (pool wallet)
- Zoro API key

### Install & Run

```bash
git clone https://github.com/Code-for-100k/predict-now.git
cd predict-now
cp .env.example .env   # Edit with your credentials
npm install
npm start              # Server at http://localhost:3000
```

### Environment Variables

See `.env.example` for the complete list with descriptions. Key groups:

| Group | Variables | Required |
|-------|-----------|----------|
| **Zoro/Canton API** | `ZORO_BASE_URL`, `ZORO_API_KEY` | Yes |
| **Pool Wallet (legacy)** | `SENDER_PARTY_ID`, `SENDER_PRIVATE_KEY`, `SENDER_PUBLIC_KEY` | Yes |
| **Multi-Pool** | `POOL_RETAIL_*`, `POOL_INST1/2/3_*` | For multi-tier |
| **Firebase Admin** | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Yes |
| **Firebase Web** | `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN` | Yes |
| **Market Config** | `PORT`, `DB_PATH`, `ROUND_MINUTES`, `FEE_PERCENTAGE` | Defaults provided |
| **Agents** | `AGENT_ENABLED`, `AGENT_PARTY_ID_1/2/3`, `AGENT_POLL_MS` | Optional |
| **Circuit Breaker** | `CB_MIN_MARGIN`, `CB_LOOKBACK`, `CB_AUTO_RECOVER` | Defaults provided |
| **Admin/Monitoring** | `ADMIN_SECRET`, `SLACK_WEBHOOK_URL`, `CCVIEW_API_KEY` | Optional |

## API Endpoints

### Public (No Auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/btc-price` | Cached BTC price from Binance |
| GET | `/api/firebase-config` | Firebase web SDK config |
| GET | `/api/market/status` | Current round (prices, bets, time remaining) |
| GET | `/api/results/latest` | Most recent settled round |
| GET | `/api/results/history?limit=N` | Settled round history |
| GET | `/api/pool-info` | Pool wallet party ID |

### Authenticated (Firebase ID Token)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/verify` | Verify token + register user (accepts `invite_code`) |
| POST | `/api/auth/link-party` | Link Canton wallet to account |
| POST | `/api/auth/set-active-wallet` | Switch active wallet |
| GET | `/api/balance` | User balance + stats |
| POST | `/api/deposit` | Verify & credit CBTC deposit |
| POST | `/api/predict` | Place UP/DOWN bet (`direction`, `amount`) |
| GET | `/api/bets` | User's prediction history |
| POST | `/api/withdraw` | Withdraw CBTC to Canton wallet |
| GET | `/api/leaderboard` | Top players + agent performance |
| POST | `/api/copy-trade/follow` | Follow an agent's strategy |

### Admin (x-admin-secret header)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/activity-summary` | System-wide stats |
| GET | `/admin/agents/status` | Agent process + coverage + per-agent W/L |
| GET | `/admin/circuit-breaker/status` | Circuit breaker state |
| POST | `/admin/circuit-breaker/reset` | Manually reset circuit breaker |
| GET | `/admin/rewards` | Reward metrics from Activity Tracker |

### Partner (x-rewards-key header)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/rewards` | CC reward aggregation + daily breakdown |
| POST | `/api/rewards` | Same, with custom wallet filter |

## Settlement Flow

1. Round timer expires (default: 1 minute)
2. Binance WebSocket provides close price (CoinGecko fallback)
3. Compare open vs close price → determine UP or DOWN
4. Winners split the loser pool proportionally:
   ```
   payout = your_bet + (your_bet / winner_pool) * loser_pool
   ```
5. Auto-payout: CBTC sent from pool wallet to each winner's Canton wallet
6. Inline accept on receiver side (for two-step transfers that earn CC rewards)
7. Circuit breaker checks gas cost vs reward margin
8. New round starts automatically

## Agent System

Three autonomous trading agents run as a child process spawned by `market.ts`:

| Agent | Strategy | Description |
|-------|----------|-------------|
| `agent-momentum` | Trend-following | Bets with recent price direction |
| `agent-contrarian` | Counter-trend | Bets against the crowd when pool is lopsided |
| `agent-hybrid` | EV-based | Combines momentum + pool ratio for expected value |

- Each agent bets **minimum size** (10 satoshi / 0.0000001 CBTC) every round
- Agents use **two-step transfers** to earn CC rewards
- Circuit breaker pauses agents if gas cost exceeds reward margin
- Auto-restart on crash (5s delay)

Enable with: `AGENT_ENABLED=true`

## Circuit Breaker

Monitors per-transaction profitability:

- **Trips** when `avg_reward - avg_gas < CB_MIN_MARGIN` (default: 0.5 CC/txn)
- **Auto-recovers** when margin exceeds 150% of threshold
- When tripped: kills agent process, pauses auto-payouts, sends Slack alert
- Admin can manually reset via `POST /admin/circuit-breaker/reset`

## Data Model

| Entity | Key Fields |
|--------|-----------|
| **User** | `uid` (Firebase), `email`, `party_ids[]`, `active_party_id`, `tier`, `invite_code` |
| **Balance** | `uid`, `balance`, `total_deposited`, `total_won`, `total_lost` |
| **Prediction** | `uid`, `round`, `direction`, `amount`, `settled`, `won`, `payout` |
| **MarketRound** | `round_number`, `open_price`, `close_price`, `direction`, `status` |
| **Deposit** | `uid`, `party_id`, `amount`, `update_id` (idempotent) |
| **WalletDepositState** | `party_id`, `last_verified_offset` (prevents double-credit) |

All data stored in `market.db.json` — a single JSON file loaded at startup, written after each mutation.

## Project Structure

```
predict-now/
├── src/                              # Server (TypeScript)
│   ├── market.ts                     # Entry point — Express server + all routes
│   ├── api/
│   │   ├── auth.ts                   # Firebase auth, wallet linking
│   │   ├── account.ts                # Balance, deposit, withdrawal
│   │   ├── prediction.ts             # Bet placement + market status
│   │   └── leaderboard.ts            # Leaderboard + copy-trading
│   ├── db/
│   │   └── init.ts                   # JSON database, schema, migrations
│   ├── lib/
│   │   ├── api.ts                    # Zoro/Canton API client
│   │   ├── config.ts                 # Multi-pool config loader
│   │   ├── circuit-breaker.ts        # Gas margin monitoring
│   │   ├── firebase.ts               # Firebase Admin init
│   │   ├── sign.ts                   # Ed25519 signing
│   │   ├── slack.ts                  # Slack alert formatting
│   │   └── types.ts                  # Shared types
│   ├── middleware/
│   │   └── auth.ts                   # Firebase token verification
│   ├── oracle/
│   │   └── binance-ws.ts             # BTC price (WebSocket + REST fallback)
│   ├── scheduler/
│   │   └── cron.ts                   # Round lifecycle (10s interval)
│   ├── settlement/
│   │   └── settlement.ts             # Payout calc, auto-withdraw, inline accept
│   └── types/
│       └── market.ts                 # Domain types (Prediction, Round, etc.)
│
├── agents/                           # Autonomous trading agents (separate package)
│   ├── src/
│   │   ├── cli.ts                    # Agent factory launcher
│   │   ├── agent.ts                  # Agent lifecycle
│   │   ├── market-client.ts          # HTTP client
│   │   ├── canton-client.ts          # Zoro API client
│   │   ├── deposit-manager.ts        # Auto-deposit
│   │   ├── factory.ts                # Agent creation/management
│   │   └── strategies/               # Trading strategies
│   ├── package.json
│   └── tsconfig.json
│
├── public/                           # Frontend (static HTML)
│   ├── index.html                    # Main prediction UI
│   ├── dashboard.html                # Admin dashboard (rewards, gas, agents)
│   ├── agents.html                   # Agent monitoring
│   ├── leaderboard.html              # Leaderboard + copy-trading
│   ├── rewards-dashboard.html        # Partner rewards view
│   └── rewards.html                  # Reward info page
│
├── docs/                             # Documentation
│   ├── API_REFERENCE.md              # Full endpoint docs with curl examples
│   ├── CODE_REVIEW.md                # Audit findings
│   ├── CC_INTEGRATION.md             # Canton Coin integration
│   ├── COMPREHENSIVE_OVERVIEW.md     # Deep technical overview
│   ├── DEPLOYMENT.md                 # Railway/Docker deploy guide
│   ├── EDGE_CASES.md                 # Edge case handling
│   ├── PRD.md                        # Product requirements
│   ├── SETTLEMENT_TESTS.md           # Settlement test results
│   ├── STAGING_E2E_FLOW.md           # End-to-end user flow
│   ├── STAGING_SECURITY_AUDIT.md     # Security audit summary
│   └── STAGING_TEST_CASES.md         # QA test matrix
│
├── .env.example                      # Template for all environment variables
├── package.json                      # Dependencies (7 production)
├── tsconfig.json                     # TypeScript config (ES2022, strict)
├── Dockerfile                        # Production image
├── docker-compose.yml                # Local Docker setup
└── market.db.json                    # Runtime database (gitignored)
```

## Testing & Auditing

| Document | What It Covers |
|----------|---------------|
| `API_REFERENCE.md` | Every endpoint with curl examples and response schemas |
| `CODE_REVIEW.md` | Code review findings with file:line references |
| `STAGING_SECURITY_AUDIT.md` | Security vulnerability assessment |
| `STAGING_TEST_CASES.md` | QA test matrix (50+ cases) |
| `STAGING_E2E_FLOW.md` | Full user journey walkthrough |
| `SETTLEMENT_TESTS.md` | Payout calculation verification |
| `EDGE_CASES.md` | Edge case documentation |

### For Auditors

1. **Entry point:** `src/market.ts` — all routes registered here
2. **Money flow:** `src/settlement/settlement.ts` — payout logic
3. **Database:** `src/db/init.ts` — schema, migrations, data access
4. **Auth:** `src/middleware/auth.ts` + `src/api/auth.ts`
5. **Canton integration:** `src/lib/api.ts` — all blockchain calls
6. **Agent system:** `agents/src/` — separate package, spawned as child process
7. **Config:** `src/lib/config.ts` — multi-pool wallet loading

## Deployment

See `DEPLOYMENT.md` for full guide. Quick Railway deploy:

```bash
railway login
railway link
railway up
```

Required Railway env vars: all items marked "Yes" in the environment variables table above.
