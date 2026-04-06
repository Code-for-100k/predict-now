# predict-now Project Planning & Backlog

This is the central backlog for predict-now development. Add new features and improvements here, then work through them systematically.

---

## 📋 Backlog (To Do)

### Features to Explore
- [Add new feature ideas here]

### High Priority
- [Add high priority features here]

### Medium Priority
- [Add medium priority improvements here]

### Low Priority
- [Add low priority/nice-to-have features here]

---

## 🚀 In Progress

### Current Work
- [What are we building right now?]
- Started: [Date]
- Expected completion: [Date]

---

## ✅ Completed

### Market Core Features
- ✅ 15-minute BTC prediction market (MVP)
- ✅ Oracle integration for BTC price feeds
- ✅ Automated settlement and payouts
- ✅ Pool wallet architecture with multiple wallets

### Dashboard & Monitoring
- ✅ Revenue dashboard with Projected Earn / Cost / Net Profit tiles
- ✅ Transaction tracking and verification via Zoro API
- ✅ Real-time gas cost calculations (verified at 2.47 CC/txn)
- ✅ Agent activity page with win/loss tracking

### Agent Features
- ✅ AI agent betting system
- ✅ Copy trading feature (users can mirror AI agent bets)
- ✅ Profit & Loss (% P&L) calculations on agent cards
- ✅ Agent coverage tracking

### Technical & Integration
- ✅ Zoro wallet integration for transactions
- ✅ Canton Network integration
- ✅ CORS workaround (proxy CC View API calls through server)
- ✅ Database initialization and management
- ✅ Documentation overhaul with README, .env.example, organized docs/

### Bug Fixes & Optimization
- ✅ Fixed agent win/loss determination logic
- ✅ Fixed transaction count accuracy (eliminated double-counting)
- ✅ Corrected gas calculation using Zoro timestamp-pairing method
- ✅ Fixed pre-approved wallet handling in rewards query
- ✅ Dashboard redesigned with 3-row layout

---

## 📝 Notes

- All active development tracked in git
- Last major update: Mar 25, 2026
- Key files: src/market.ts (main), .env (configuration)
- Dependencies: Zoro API, Canton Network, Binance price feed
- Document any API rate limits or integration challenges
