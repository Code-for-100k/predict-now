# HANDOFF — Session 3 Continuation

**Date:** March 25, 2026, ~5:00 PM IST
**Repo:** `/Users/mayank/Clawed/predict-now` on branch `main` (demo-prep is synced)
**Production:** https://predictnow.cc (= https://btc-prediction-market-production.up.railway.app)
**Preview:** https://predict-now-preview-production.up.railway.app
**Dashboard:** append `/dashboard.html` to any URL above, secret: `$ADMIN_SECRET`

Read HANDOFF_SESSION2.md first for full project context. This file covers only what changed in Session 2.

---

## CRITICAL DISCOVERY: Pre-Approval Kills Rewards

**Finding:** CBTC transfers that are auto-accepted via pre-approval do NOT generate rewards in YAC. Only transfers accepted via explicit `TransferInstruction_Accept` earn rewards (~3.45 CC per transaction).

**Proof:**
- Retail pool (no pre-approval on receivers): 16 accepted transfers → **55.18 CC earned**
- Inst-1 + agent wallets (have pre-approval): 20+ transfers → **0 CC earned**

**Pre-approval cannot be revoked.** Once set via `prepare/transfer-preapproval`, it's permanent. No revoke API exists.

**Wallets with pre-approval (DO NOT earn rewards as receivers):**
- Agent 1: `df0c3fdb58::12200a976df35fa70038966d8fc1fdd86a3c1310e30d7e3d1d3d43dbe5f372c3ea94`
- Agent 2: `689e91029e::12202e732753e42faa1577be9f9efb22daaa1f85e8a3874695e2ed292e2883f0d0bc`
- Agent 3: `1ca79f9918::12206e3ad664f644c87a3dc169d5d4cf442fd897a32f2daaf1b165df975ce7a2f16d`
- Inst-1: `0afed9241a::1220320c5994fd50d10e15a687d336acf65d0ba07f94744d16d68291ac8bb65e2825`

**Wallets WITHOUT pre-approval (batch wallets 4-45):** These CAN earn rewards. Use these going forward.

---

## IMMEDIATE NEXT STEPS (in priority order)

### 1. Switch agent wallets to batch 4-6 (no pre-approval)
- Retire agent wallets 1-3 (they have pre-approval, can't earn rewards)
- Use batch wallets 4-6 from `wallets-batch.json` as new agent wallets
- Update `src/ai/engine.ts` and `.env` to point to wallets 4-6
- DO NOT run `preapprove-cbtc.ts` on them

### 2. Inline acceptance (not periodic polling)
- When pool sends payout to agent: immediately check agent's pending transfers and accept
- When agent sends deposit to pool: immediately accept on pool side
- This happens in the same code flow — no cron, no polling, no delay
- Add this to `settlement.ts` after each `sendPayout()` call

### 3. Dashboard: tag pre-approved wallets
- In the admin dashboard pool/agent wallet tables, show a badge: "Pre-Approved (no rewards)" vs "Manual Accept (earns rewards)"
- So Mayank can see at a glance which wallets are earning

### 4. Confirm with Gabi/Ferenc
- The reward investigation meeting is scheduled
- Key question: is the pre-approval → no rewards behavior intentional or a bug?
- If it's a bug, they fix it and all wallets earn rewards
- If intentional, we continue with manual accept flow

---

## WHAT WAS DONE IN SESSION 2

### Gas Tracking
- Added `canton_transactions` table to DB
- Round-level gas measurement: CC balance before/after all payouts (2 API calls per round)
- Dashboard shows estimated gas (historical) + DB-recorded gas (new transactions)
- Gas formula: CBTC sends × 2.49 CC avg (from Zoro skill diagnostic)

### Dashboard Restructure
- Two tabs: Revenue & Rewards / Product Analytics
- Pool wallets with CC/CBTC balances, rewards, gas per wallet
- Agent wallets summary (total, active, rewards, gas)
- Daily reward breakdown table
- Product stats from app DB (users, rounds, bets, tier breakdown)
- Date range filter (7/14/30/90 days)
- Pool filter (all/retail/institutional)

### Agent Wallet Operations
- Created 45 batch wallets (`wallets-batch.json`)
- Set CBTC pre-approval on agents 1-3 (mistake — kills rewards)
- Accepted 20 pending transfers on inst-1 (cost ~80 CC in gas)
- Sent 80 CC from retail to inst-1 for gas

### Production Deploy
- Merged demo-prep → main
- Deployed to production (predictnow.cc)
- Set all env vars on production (ADMIN_SECRET, pool wallet keys, CORS)
- Both preview and production are in sync

---

## CURRENT BALANCES (as of deploy)

| Wallet | CC | CBTC |
|--------|-----|------|
| Retail pool | ~83 CC | 0.000693 |
| Inst-1 | ~3 CC | 0.00021 |
| Inst-2 | 100 CC | 0 |
| Inst-3 | 100 CC | 0 |

---

## KEY COMMANDS

```bash
cd /Users/mayank/Clawed/predict-now

# Deploy to production
railway link -p 78a6927b-e945-4573-becf-db90c2be42f3 -s 57d2716e-4273-460d-992b-44564cb8a773
railway up -d

# Deploy to preview
railway link -p b64a4fa0-e547-4608-bf12-497881fafd6e -s 633e9656-487b-40b8-83fe-33c55aea8831
railway up -d

# Check rewards
curl -s "https://btc-prediction-market-production.up.railway.app/admin/rewards" -H "x-admin-secret: $ADMIN_SECRET"

# Check wallet balance
curl -s -X POST https://dev-api.zorowallet.com/canton/wallet/balance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer canton_-KPOgjYXFL_DoI-S3wMhFCIbxaElqbjVJxUc69T7wbI" \
  -d '{"partyId": "PARTY_ID_HERE"}'

# Send CC
INSTRUMENT_ID=Amulet INSTRUMENT_ADMIN="DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc" npx tsx src/send.ts "RECEIVER_PARTY_ID" AMOUNT
```

---

## WHAT MAYANK WILL LIKELY ASK NEXT

1. "Switch agents to new wallets" → Use batch wallets 4-6, update engine.ts
2. "Add inline acceptance" → After sendPayout, check pending on receiver, accept immediately
3. "Tag pre-approved wallets in dashboard" → Add badge to pool/agent wallet tables
4. "Did the rewards come through?" → Check YAC daily-rewards for the new wallets after they run some transactions
5. "Auto-payout toggle" → Add `AUTO_PAYOUT=true|false` env var, check before payout loop
