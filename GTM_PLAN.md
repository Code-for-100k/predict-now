# Go-to-Market Plan: Predict Now -- 24-Hour Launch

**Launch Date**: March 25, 2026 (T+0 starts when Mayank kicks off execution)
**Launch Tier**: 3 (Controlled Pilot -- NOT a public launch)
**PM Owner**: Mayank
**Target**: 2-3 early customers/partners running live predictions within 24 hours

---

## What We Are Launching

Predict Now is a BTC prediction market running on Canton Network. Users predict whether Bitcoin price moves UP or DOWN in 1-minute rounds, betting with real Canton Coins (CC). Winners split the losing pool. Settlement is fully automated via Canton's Zoro API. The product is live on Railway (preview) and needs to go live on predictnow.cc with the latest code, then onboard Nitish + his developer friend as the first external users.

This is NOT a public launch. This is a controlled pilot with 2-3 hand-picked users to validate the core loop works end-to-end with real money before broader distribution.

---

## Hour-by-Hour Timeline

### PHASE 1: PRODUCTION READY (Hours 0-4)

**Hour 0-1: Code & Infrastructure**
- [ ] Deploy latest code from Railway preview to predictnow.cc production
- [ ] Verify DNS/SSL on predictnow.cc resolves correctly with new deployment
- [ ] Confirm all environment variables match production (Zoro API key, party IDs, instrument config)
- [ ] Verify Binance WebSocket price feed is connected and streaming on production
- [ ] Confirm cron scheduler is running (15-min settlement cycle active)

**Hour 1-2: Pool Wallet & Money**
- [ ] Check pool wallet balance: `npx tsx src/balance.ts <SENDER_PARTY_ID>`
- [ ] Fund pool wallet with minimum 500 CC (enough for ~50 small rounds without needing refill)
- [ ] Verify operator wallet (OPERATOR_PARTY_ID) is configured for fee collection
- [ ] Confirm fee percentage is set to 10% in .env
- [ ] Document current pool wallet balance as baseline

**Hour 2-3: End-to-End Smoke Test**
- [ ] Run a full prediction cycle on predictnow.cc (not localhost):
  - Submit an UP prediction with a test party ID and small amount (10 CC)
  - Submit a DOWN prediction with a different test party ID (10 CC)
  - Wait for the round to settle
  - Confirm winner received payout via Zoro API balance check
  - Confirm operator received fee
  - Confirm losing side got nothing
- [ ] If settlement fails: check pool balance, check Zoro API logs, fix before proceeding
- [ ] Run a second round to confirm consistency
- [ ] Test the "insufficient balance" guard -- does it block settlement cleanly?

**Hour 3-4: Monitoring & Logging**
- [ ] Confirm Railway logs are accessible and show settlement events clearly
- [ ] Set up a simple uptime check (even just a curl in a cron job hitting /api/market/status every 5 min)
- [ ] Document what "healthy" looks like in logs (for quick triage later)
- [ ] Create a shared note/channel for live incident tracking during the pilot

---

### PHASE 2: EARLY CUSTOMER ONBOARDING (Hours 4-10)

**Hour 4-5: Prepare Onboarding Materials**
- [ ] Write a one-page "How to Use Predict Now" guide covering:
  - What it is (30-second explanation)
  - How to get a Canton wallet / Party ID (Zoro wallet setup)
  - How to get CC to bet with (where CC comes from, or Mayank sends them starter CC)
  - How to place a prediction (UP/DOWN, amount, party_id)
  - How to check results
  - What the 15-minute round cadence means
  - Known limitations (must have CC pre-loaded, 1-min rounds, no mobile optimization)
- [ ] Prepare 2 invite codes from the 100 retail codes (one for Nitish, one for his developer friend)
- [ ] Decide on starter CC amount to send each pilot user (recommend: 100 CC each, enough for ~20 small bets)

**Hour 5-6: Reach Out to Nitish**
- [ ] Mayank messages Nitish directly
- [ ] Pitch: "We built a BTC prediction market on Canton. It's live. Want to be one of the first 3 people to use it? Takes 5 minutes to set up."
- [ ] Share predictnow.cc link + the one-pager
- [ ] Offer to do a 10-minute screenshare walkthrough if needed
- [ ] Ask Nitish to loop in his developer friend
- [ ] Goal: both have accounts created and Party IDs shared back to Mayank by end of Hour 8

**Hour 7-8: Fund Pilot Users & First Predictions**
- [ ] Once Nitish and friend share their Party IDs:
  - Send each 100 CC from pool/main wallet
  - Confirm they received it (balance check or they confirm)
- [ ] Walk them through placing their first prediction (live, on a call or async via chat)
- [ ] Stay available for the first 2-3 rounds to answer questions and catch issues
- [ ] Document any friction points they hit (this is gold for v2)

**Hour 8-10: Monitor First External Rounds**
- [ ] Watch the first 3-4 rounds with external users participating
- [ ] Verify settlements complete correctly with their party IDs
- [ ] Check for any edge cases: same direction bets (no losers), very small amounts, rapid re-betting
- [ ] If anything breaks: fix it, re-deploy, communicate to users immediately ("Hey, we saw X, fixed it, try again")

---

### PHASE 3: DATA & TRACKING (Hours 10-16)

**Hour 10-12: YAC API Reward Tracking Setup**
- [ ] Confirm the YAC API endpoints needed for CBTC reward tracking:
  - Transaction history endpoint
  - Reward accrual endpoint
  - Volume tracking endpoint
- [ ] Build or configure a simple script that polls:
  - Total transactions processed (count)
  - Total CC volume through the pool wallet
  - Total fees collected by operator
  - Individual user prediction counts
- [ ] Store results in a simple log file or lightweight DB table
- [ ] Calculate actual unit economics from real data:
  - Actual CC fee per transaction (should be ~$0.47 for CBTC sends)
  - Net margin per round (revenue from 10% fee - Canton network fee)
  - Verify the $0.80 CBTC reward vs $0.50 traffic fee math with real numbers

**Hour 12-14: Activity Monitoring**
- [ ] Check current Canton Network total activity level
- [ ] Calculate Predict Now's transactions as % of total network activity
- [ ] HARD CONSTRAINT: Must stay under 5% of Canton Network activity
- [ ] If approaching 3%, slow down round cadence or cap concurrent users
- [ ] Set up an alert (even a manual check every 2 hours) for network activity ratio

**Hour 14-16: Dashboard / Reporting**
- [ ] Create a simple tracking spreadsheet or doc with:
  - Round number | Timestamp | UP pool | DOWN pool | Winner direction | Payout amount | Fees collected | Settlement status
- [ ] Record all rounds from the first 24 hours
- [ ] This becomes the data package for leadership update

---

### PHASE 4: COMMUNICATION & REPORTING (Hours 16-24)

**Hour 16-18: Pilot User Check-in**
- [ ] Message Nitish and friend: "How's it going? Any bugs? What's confusing?"
- [ ] Collect specific feedback:
  - Was onboarding smooth?
  - Did they understand the round timing?
  - Did settlements feel reliable?
  - Would they use it again tomorrow?
  - Would they invite someone else?
- [ ] Document verbatim quotes (useful for internal advocacy)

**Hour 18-20: Internal Status Update**
- [ ] Draft a brief update for leadership (Aki, Jesse, Kadeem, Gabi, Robert):

```
Subject: Predict Now Pilot -- 24-Hour Status

Summary: Predict Now is live on predictnow.cc with 2-3 external pilot users.

What shipped:
- Production deployment on predictnow.cc
- Real CC settlement (automated, every 15 min)
- 2 external users onboarded (Nitish + friend)

Key numbers (first 24 hours):
- Rounds completed: [X]
- Total predictions placed: [X]
- Total CC volume: [X]
- Settlement success rate: [X]%
- Canton Network activity share: [X]% (target: <5%)

What worked:
- [specifics]

What we need to fix:
- [specifics]

Next step: [recommendation -- expand to 5-10 users, or fix issues first]

Rewards note: CBTC rewards resume ~April 2-3 after mainnet upgrade.
We have 100 retail + 3 institutional invite codes ready for next phase.
```

**Hour 20-24: Prep for Day 2**
- [ ] Fix any bugs discovered during the pilot
- [ ] Re-deploy if needed
- [ ] Identify the next 2-3 users to onboard (from the remaining invite codes)
- [ ] Write up a brief "Day 1 Retrospective" -- what broke, what surprised us, what users actually did vs. what we expected
- [ ] If pilot went well: draft a plan for scaling to 10 users next week

---

## Risk Mitigation Checklist

### P0 -- Will Kill the Pilot

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|-----------|--------|------------|-------|
| Pool wallet runs out of CC mid-round | Medium | Critical | Fund with 500+ CC upfront. Check balance before each settlement (already built). Set alert at 100 CC remaining. | Mayank |
| Settlement fails silently | Medium | Critical | Check logs after every round for first 24 hours. The insufficient-balance guard already prevents bad settlements. Add logging for all settlement outcomes. | Mayank |
| Zoro API goes down | Low | Critical | No mitigation available -- single dependency. If down, pause the market and communicate to users. Rounds will queue and settle when API returns. | Mayank |
| Canton mainnet issues | Low | Critical | Nothing we can control. Monitor Canton status. Pause if network is degraded. | Mayank |

### P1 -- Will Degrade the Experience

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|-----------|--------|------------|-------|
| Exceed 5% of Canton Network activity | Low (with 2-3 users) | High | Monitor activity ratio every 2 hours. At 3%, throttle. At 4%, pause new onboarding. | Mayank |
| Binance price feed drops | Medium | Medium | App already handles reconnection. If sustained outage, rounds cannot settle -- communicate delay to users. | Mayank |
| User sends wrong party ID | Medium | Medium | Funds go to wrong address. Include clear copy-paste instructions. No recovery mechanism exists -- document this risk for users. | Mayank |
| Rate limit hit (0.5 TPS) | Low (at current scale) | Medium | With 2-3 users, nowhere near 43K tx/day limit. Will become relevant at 50+ concurrent users. | Mayank |

### P2 -- Annoyances

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|-----------|--------|------------|-------|
| Users confused by 15-min settlement delay | High | Low | Set expectations upfront in onboarding doc. "Results come every 15 minutes." | Mayank |
| UI not optimized for mobile | High | Low | Tell pilot users to use desktop. Not fixing for v1. | Mayank |
| Users bet when no one is on the other side | High | Low | If all bets are UP and no DOWN, winners get their money back (no losers to take from). Document this. | Mayank |

---

## Communication Plan

### Who Tells Who What, When

| When | Who Communicates | To Whom | What | Channel |
|------|-----------------|---------|------|---------|
| Hour 0 | Mayank | Nitish | "Hey, want to test something cool?" -- casual intro, no pressure | iMessage / WhatsApp |
| Hour 3 | Mayank | Nitish | Share predictnow.cc + onboarding guide once smoke test passes | iMessage / WhatsApp |
| Hour 5 | Nitish | His developer friend | "My friend built this, check it out" -- peer referral | Their channel |
| Hour 8 | Mayank | Nitish + friend | "Your accounts are funded, try placing a prediction" | Group chat |
| Hour 12 | Mayank | Nitish + friend | Quick check-in: "How's it going? Any issues?" | Group chat |
| Hour 20 | Mayank | Leadership (Aki, Jesse, Kadeem, Gabi, Robert) | 24-hour status email (template above) | Email / Slack |
| Hour 24 | Mayank | Engineering (if separate) | Bug list + priority order for Day 2 fixes | Internal |

### Communication Rules for Pilot
- DO NOT announce on social media, Discord, or any public channel
- DO NOT share predictnow.cc publicly -- invite-only for now
- If a pilot user asks "can I share this?" -- answer: "Not yet, we're in closed testing. Soon."
- If leadership asks for a demo -- point them to predictnow.cc and offer a 5-min walkthrough
- If something breaks -- tell pilot users immediately, don't hide it. "Hey, settlement hiccupped on round X, we're fixing it. Your CC is safe."

---

## Success Metrics -- First 48 Hours

### Must-Hit (Pilot fails without these)

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Production deployment live on predictnow.cc | Yes/No | Visit the URL, confirm latest code |
| At least 1 external user places a real prediction | Yes/No | Check predictions table in DB |
| At least 1 settlement completes successfully with external user | Yes/No | Check settlement logs + user confirms receipt |
| Zero loss of user funds | 0 incidents | Reconcile pool wallet balance vs. expected |
| Canton Network activity share | Under 5% | Manual calculation from network stats |

### Want-to-Hit (Signs the product has legs)

| Metric | Target | How to Measure |
|--------|--------|----------------|
| External users onboarded | 2-3 | Count of unique external party IDs |
| Total predictions placed by external users | 10+ | DB query |
| Rounds with 2+ participants | 3+ | DB query (rounds with both UP and DOWN) |
| Settlement success rate | 100% | Settlements attempted vs. completed |
| User returns for second session (without prompting) | 1+ user | Observe prediction timestamps -- gap of 2+ hours |
| Positive qualitative signal | "This is cool" or equivalent | Direct feedback from Nitish / friend |

### Unit Economics Validation (48 hours)

| Metric | Expected | Actual (fill in) |
|--------|----------|-------------------|
| Average CC wagered per round | TBD | _____ |
| Average fee collected per round (10%) | TBD | _____ |
| Canton network fee per settlement tx | ~$0.47 | _____ |
| Net margin per round (fee collected - network fee) | Positive | _____ |
| CBTC reward per transaction | $0.80 (after Apr 2-3) | N/A until rewards resume |
| Projected net per tx after rewards | ~$0.30 | _____ |

---

## What Must Happen Before predictnow.cc Goes Live

This is the hard prerequisite list. Do not onboard external users until all items are green.

1. **Latest code deployed to predictnow.cc** -- the Railway preview build, not the older code currently on production
2. **Pool wallet funded with 500+ CC** -- verified via balance check API call
3. **Operator wallet configured** -- fees have somewhere to go
4. **Full settlement cycle tested on production** -- not staging, not localhost, the actual predictnow.cc URL
5. **Binance price feed confirmed working** -- WebSocket connected, prices updating
6. **Cron scheduler confirmed running** -- 15-minute cycle active, visible in logs
7. **Rollback plan documented** -- if predictnow.cc breaks, can we revert to previous deploy? How?
8. **No P0 bugs from smoke test** -- any settlement failure or fund loss issue blocks launch

---

## Rollback Plan

If predictnow.cc breaks after going live with pilot users:

1. **Immediate**: Message pilot users: "We're pausing the market for a fix. Your CC in the pool is safe. Will update you in [X] minutes."
2. **Assess**: Is this a code bug (fixable) or infrastructure issue (Railway/Canton/Zoro)?
3. **If code bug**: Fix, redeploy to Railway, verify on predictnow.cc, resume
4. **If infrastructure**: Wait for upstream fix. Keep users informed with ETAs if available.
5. **If fund-related**: Halt all activity. Manually reconcile pool wallet. Do not restart until balances are verified.
6. **Rollback deploy**: If the new code is the problem, redeploy the previous Railway build. Note: this means predictnow.cc goes back to the "older code" -- acceptable for stability while debugging.

---

## Appendix: Key Technical Reference

**Production URL**: https://predictnow.cc
**Preview URL**: https://predict-now-preview-production.up.railway.app
**Pool Wallet Party ID**: 8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37
**Zoro API**: https://dev-api.zorowallet.com
**Settlement Cadence**: Every 15 minutes (cron)
**Fee**: 10% of winning pool
**Rate Limit**: 0.5 TPS (Zoro allocation)
**Max Daily Transactions**: ~43,000 (well above pilot needs)
**Network Activity Cap**: Stay under 5% of total Canton Network activity
**Invite Codes Available**: 100 retail, 3 institutional
**CBTC Rewards**: Resume ~April 2-3 after mainnet upgrade

**Key API Endpoints**:
- `POST /api/predict` -- place a prediction
- `GET /api/market/status` -- current round status
- `GET /api/results/latest` -- last round results
- `POST /canton/wallet/balance` -- check wallet balance
- `POST /canton/transaction/prepare/send` -- prepare CC transfer
- `POST /canton/transaction/broadcast` -- broadcast signed transaction
