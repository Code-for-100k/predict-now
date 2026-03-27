# HANDOFF — Continue Exactly From Here

**Date:** March 24, 2026, ~3:30 PM IST
**You are working on:** Predict Now — BTC prediction market on Canton Network
**Repo:** `/Users/mayank/Clawed/predict-now` on branch `demo-prep`
**GitHub:** `Code-for-100k/predict-now` (private, gh CLI is authenticated)
**Preview:** https://predict-now-preview-production.up.railway.app
**Production:** https://predictnow.cc (STILL RUNNING OLD CODE — do NOT touch until Mayank says to merge)

---

## WHAT YOU MUST DO FIRST

1. Read this entire file
2. Read `/Users/mayank/Clawed/predict-now/.env` to understand credentials
3. Run `cd /Users/mayank/Clawed/predict-now && git log --oneline -10` to see recent commits
4. Run `railway service logs 2>&1 | tail -20` to see if the preview is healthy

---

## EXACTLY WHERE WE LEFT OFF

### Last completed work:
- Fixed deposit bug (getTransactionHistory wasn't paginating — new deposits after the first 88 were invisible). Fix: pass `beginOffset` parameter.
- Added concurrent withdrawal lock (in-memory Set per uid)
- Added anti-fraud guard: withdrawals blocked if `total_withdrawn + amount > total_deposited`. Admin can override via `POST /admin/approve-withdrawal`
- Manually credited Vinay (vinay@warpx.exchange) with 0.00014 CBTC because his deposit hit the pagination bug before the fix was deployed

### Active user issue:
- **Vinay (vinay@warpx.exchange)** is the first external customer. His deposit was manually credited. He should be able to bet now. Monitor his experience.

### What was NOT finished:
1. **Deposit UX is still clunky** — user clicks "Verify Deposit", gets "accepted, wait and try again", then must click again. The 3-second Canton settlement wait may not be enough. Consider increasing to 5s or adding auto-retry on the frontend.
2. **Production deploy** — `main` branch has old code. `demo-prep` has all fixes. Mayank has not approved merging yet.
3. **Reward investigation** — Our CBTC transactions show `total_reward: null` in YAC API. A Notion doc was prepared for Gabi and Ferenc. Meeting is scheduled. The doc is at: https://www.notion.so/bitsafe/32d636dd0ba58131a9dcc0dcd377dbdb
4. **Data tracking dashboard** — Jesse wants real cost/reward data from YAC before scaling. Dashboard not built yet.
5. **UI/UX polish** — Mayank explicitly said AI-generated UI isn't good enough. He wants a design-focused AI (v0.dev or similar) to handle aesthetics. Don't try to redesign the UI yourself.

---

## THE APP — HOW IT WORKS

### Core flow:
```
User signs up with invite code → links Canton wallet → deposits CBTC to pool → bets UP/DOWN → round settles after 1 min → winners get auto-payout on-chain
```

### Internal ledger model:
- Bets deduct from internal balance (no blockchain call)
- Settlement is pure math (no blockchain call)
- Only deposits (accept CBTC) and payouts/withdrawals (send CBTC) touch Canton
- This is intentional — keeps it fast and cheap

### Pool wallets (4 total):
| ID | Type | Party ID | Funded? |
|----|------|----------|---------|
| retail | Retail (default) | `8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37` | Yes (0.0006 CBTC, 811 CC) |
| inst1 | Institutional | `0afed9241a::1220320c5994fd50d10e15a687d336acf65d0ba07f94744d16d68291ac8bb65e2825` | No |
| inst2 | Institutional | `394df865bf::122058ec34c21cd7707c60c31b0ca721944612b2deb5fa59aeda8a62a06d824257a1` | No |
| inst3 | Institutional | `702758b398::12205271e3242c223dcbf092f3012f54265930c2a2eb465dbd45315d64a34bcfba2f` | No |

### Invite codes:
- 100 retail codes: `RET-XXXX` (single-use each)
- 3 institutional codes: `INST-ALPHA`, `INST-BETA`, `INST-GAMMA` (10 uses each, each maps to its own pool wallet)
- 1 master code: `PREDICT-NOW` (unlimited, retail pool)

---

## TECH STACK

- **Frontend:** Single `public/index.html` file (~1900 lines), Tailwind CDN, TradingView Lightweight Charts v4.1.3, vanilla JS, Binance WebSocket for real-time BTC price
- **Backend:** Node.js + Express + TypeScript. No build step — runs with `tsx`. Entry: `src/market.ts`
- **Database:** JSON file `market.db.json`, read into memory, written on every state change via `db.save()`. On Railway, persisted to volume at `/data/market.db.json`
- **Auth:** Firebase (Google sign-in). ID tokens verified by Firebase Admin SDK. Project: `cpredict`
- **Canton/Blockchain:** Zoro Wallet API at `https://dev-api.zorowallet.com`. Bearer token auth. 3-step flow: prepare → sign (Ed25519) → broadcast
- **Price:** Binance WebSocket `wss://stream.binance.com:9443/ws/btcusdt@trade` (frontend). Backend uses REST polling because Binance WS is geo-blocked from Railway US servers. Cascading fallback: Binance Global REST → Binance.US REST → Coinbase → CoinGecko
- **Hosting:** Railway Hobby plan. Volume mounted at `/data`

---

## KEY FILES

```
src/market.ts              — Express server, all admin endpoints, startup logic
src/api/account.ts         — deposit, withdraw, balance, bets, pool-info endpoints
src/api/prediction.ts      — POST /predict, GET /market/status, GET /results/*
src/api/auth.ts            — Firebase auth verify, link-party, set-active-wallet
src/settlement/settlement.ts — Payout math + auto-payout via Canton API
src/scheduler/cron.ts      — 10s interval settlement checks, round creation
src/oracle/binance-ws.ts   — Multi-source BTC price service (WS + REST fallbacks)
src/db/init.ts             — JSON database, migrations, helper functions
src/lib/api.ts             — Canton/Zoro API client (prepare, broadcast, history, etc.)
src/lib/config.ts          — Env loader, pool wallet config, invite code definitions
src/lib/sign.ts            — Ed25519 signing
src/lib/firebase.ts        — Firebase Admin SDK init
src/middleware/auth.ts      — Firebase token verification middleware
public/index.html          — Entire frontend (landing page, login, app, betting UI)
```

---

## ADMIN ENDPOINTS (all require header: `x-admin-secret: $ADMIN_SECRET`)

```bash
# View user account
curl -s "https://predict-now-preview-production.up.railway.app/admin/user?email=vinay@warpx.exchange" \
  -H "x-admin-secret: $ADMIN_SECRET"

# DB overview
curl -s "https://predict-now-preview-production.up.railway.app/admin/db-summary" \
  -H "x-admin-secret: $ADMIN_SECRET"

# Manually credit a user's balance
curl -s -X POST "https://predict-now-preview-production.up.railway.app/admin/credit" \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{"email": "user@example.com", "amount": 0.001, "reason": "manual credit"}'

# Approve a blocked withdrawal (when total_withdrawn would exceed total_deposited)
curl -s -X POST "https://predict-now-preview-production.up.railway.app/admin/approve-withdrawal" \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{"email": "user@example.com", "amount": 0.001}'

# Retry failed auto-payouts
curl -s -X POST "https://predict-now-preview-production.up.railway.app/admin/retry-payout" \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{"email": "user@example.com"}'
```

---

## DEPLOY COMMANDS

```bash
cd /Users/mayank/Clawed/predict-now

# Push code
git add -A && git commit -m "description" && git push origin demo-prep

# Deploy to PREVIEW (safe)
railway up -d

# Check logs
railway service logs 2>&1 | tail -30

# Check health
curl -s https://predict-now-preview-production.up.railway.app/health
```

**DO NOT deploy to production (predictnow.cc) without Mayank's explicit approval.**

---

## CANTON/ZORO API QUICK REFERENCE

```bash
# Check pool wallet balance
curl -s -X POST https://dev-api.zorowallet.com/canton/wallet/balance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer canton_-KPOgjYXFL_DoI-S3wMhFCIbxaElqbjVJxUc69T7wbI" \
  -d '{"partyId": "8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37"}'

# Check pending transfers
curl -s -X POST https://dev-api.zorowallet.com/canton/transaction/history/pending \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer canton_-KPOgjYXFL_DoI-S3wMhFCIbxaElqbjVJxUc69T7wbI" \
  -d '{"partyId": "8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37"}'

# Check transaction history (with offset for pagination!)
curl -s -X POST https://dev-api.zorowallet.com/canton/transaction/history \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer canton_-KPOgjYXFL_DoI-S3wMhFCIbxaElqbjVJxUc69T7wbI" \
  -d '{"partyId": "8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37", "beginOffset": 34680000}'
```

---

## YAC (Activity Tracker) API

Base URL: `https://cbtc-data-api.bitsafe.finance/api/v1/`
Notion docs: https://www.notion.so/bitsafe/Activity-Tracker-API-Reference-Internal-2f8636dd0ba5807a9a25c49f76b41a53

```bash
# Check CBTC transactions from our pool
curl -s -X POST https://cbtc-data-api.bitsafe.finance/api/v1/events/transfer-offers \
  -H "Content-Type: application/json" \
  -d '{"sender": ["8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37"], "instrument_id": "CBTC", "limit": 50}'

# Check reward coupons
curl -s -X POST https://cbtc-data-api.bitsafe.finance/api/v1/events/reward-coupons \
  -H "Content-Type: application/json" \
  -d '{"sender": ["8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37"], "instrument_id": "CBTC", "limit": 50}'
```

**Known issue:** YAC was timing out intermittently during this session. If it fails, try again later.

---

## PEOPLE CONTEXT

| Person | Role | Key context |
|--------|------|-------------|
| **Mayank** | Founder/PM | Drives all decisions. Wants the app working first, pretty second. |
| **Jesse** | Leadership | Wants data/cost tracking before scaling. Meeting to set up data side. |
| **Gabi** | Engineering | Knows YAC/reward system inside out. Key person for reward investigation. |
| **Ferenc** | Engineering | Technical counterpart for reward investigation. |
| **Vinay** | First external user | vinay@warpx.exchange. Had deposit bug. Was manually credited 0.00014 CBTC. |
| **Amit** | Client/partner | Needs API docs for trading integration. API_REFERENCE.md is ready to share. |
| **Nitish** | Potential external dev | Aki's friend, interested in taking over development long-term. |

---

## BUSINESS CONTEXT

- Every CBTC transaction earns BitSafe ~$0.80 in CC rewards (after April 2-3 mainnet upgrade)
- DA network traffic fee is ~$0.50 per transaction (user pays)
- Net margin: ~$0.30 per transaction
- Target: stay under 5% of Canton Network daily activity (~30K txns/day)
- Projected revenue at 5% target: ~$270K/month, ~$3.2M/year
- Canton Network does ~600K txns/day currently

---

## NOTION PAGES

- Demo One-Pager: https://www.notion.so/bitsafe/32c636dd0ba581bca6c0c8def39dafb8
- Reward Investigation: https://www.notion.so/bitsafe/32d636dd0ba58131a9dcc0dcd377dbdb
- YAC API Reference: https://www.notion.so/bitsafe/Activity-Tracker-API-Reference-Internal-2f8636dd0ba5807a9a25c49f76b41a53

---

## WHAT MAYANK WILL LIKELY ASK NEXT

1. "Did Vinay's deposit work?" → Check his account via admin endpoint
2. "Can we go live on predictnow.cc?" → Merge demo-prep to main, deploy via Railway (production project is `btc-prediction-market`, NOT `predict-now-preview`)
3. "What about the rewards?" → Meeting with Gabi/Ferenc is scheduled. Notion doc ready.
4. "Make the UI better" → He wants a design-focused AI to do this, not you. Suggest v0.dev or similar.
5. "Check on the data dashboard" → Not built yet. Uses YAC API. Jesse call needed first.
