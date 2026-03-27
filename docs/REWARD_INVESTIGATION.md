# CBTC Reward Investigation — Meeting Brief

**Prepared by:** Mayank Sachdev
**Date:** March 24, 2026
**For:** Gabi Tuinaite, Ferenc Fabian
**Subject:** Our pool wallets are not earning CBTC rewards despite active transactions

---

## 1. What We Built

**Predict Now** is a BTC prediction market running live on Canton Network. Here is how it works:

1. Users deposit CBTC into our pool wallet
2. Users bet on whether Bitcoin's price will go up or down in the next round
3. At the end of each round, winners receive automatic CBTC payouts from the pool

Every deposit and payout is a **real CBTC transaction on Canton mainnet**. We have been testing live since March 16, 2026.

---

## 2. Our Pool Wallets

We created 4 pool wallets through the Zoro Wallet API. Only the Retail Pool has been active so far.

| Wallet | Party ID | Type | Invite Codes | Current CBTC Balance |
|--------|----------|------|--------------|---------------------|
| **Retail Pool** | 8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37 | Retail | 100 single-use codes | 0.00058519 CBTC |
| **Institutional 1** | 0afed9241a::1220320c5994fd50d10e15a687d336acf65d0ba07f94744d16d68291ac8bb65e2825 | Institutional | 1 code (10 uses) | 0 |
| **Institutional 2** | 394df865bf::122058ec34c21cd7707c60c31b0ca721944612b2deb5fa59aeda8a62a06d824257a1 | Institutional | 1 code (10 uses) | 0 |
| **Institutional 3** | 702758b398::12205271e3242c223dcbf092f3012f54265930c2a2eb465dbd45315d64a34bcfba2f | Institutional | 1 code (10 uses) | 0 |

---

## 3. Transaction Summary

| Metric | Value |
|--------|-------|
| Testing period | March 16 -- 23, 2026 |
| Outbound CBTC transactions (payouts to users) | 18 |
| Inbound CBTC transactions (deposits from users) | 12 |
| **Total CBTC transactions** | **30** |
| YAC tracks all these transactions? | Yes |
| Reward coupons with a reward value? | **0 out of 25** |

**Bottom line:** YAC sees all 30 of our transactions. But every single reward coupon has a blank reward amount.

---

## 4. Full Transaction Log

### Outbound Transactions (Pool paying out to users)

| # | Date/Time | Amount (CBTC) | Transaction ID | Counterparty |
|---|-----------|--------------|----------------|--------------|
| 1 | Mar 20, 17:39 | 0.00001992 | 1220e5666e6abfa8e1ebf0a6f3...7c57 | User wallet |
| 2 | Mar 21, 00:17 | 0.00001000 | 1220e2025d397f047da6ed6704...e543 | User wallet |
| 3 | Mar 21, 00:19 | 0.00001000 | (on record in YAC) | User wallet |
| 4 | Mar 21, 01:08 | 0.00002400 | (on record in YAC) | User wallet |
| 5 | Mar 21, 01:09 | 0.00002400 | (on record in YAC) | User wallet |
| 6 | Mar 21, 01:20 | 0.00001040 | (on record in YAC) | User wallet |
| 7 | Mar 21, 01:21 | 0.00001040 | (on record in YAC) | User wallet |
| 8 | Mar 21, 01:23 | 0.00001000 | (on record in YAC) | User wallet |
| 9 | Mar 21, 01:26 | 0.00001000 | (on record in YAC) | User wallet |
| 10 | Mar 21, 01:28 | 0.00001040 | (on record in YAC) | User wallet |
| 11 | Mar 21, 01:29 | 0.00001040 | (on record in YAC) | User wallet |
| 12 | Mar 21, 01:30 | 0.00001000 | (on record in YAC) | User wallet |
| 13 | Mar 21, 01:33 | 0.00002029 | (on record in YAC) | User wallet |
| 14 | Mar 21, 01:34 | 0.00001000 | (on record in YAC) | User wallet |
| 15 | Mar 23, 11:39 | 0.00002000 | (on record in YAC) | User wallet |
| 16-18 | Mar 21-23 | Various | (on record in YAC) | User wallets |

### Inbound Transactions (Users depositing into pool)

| # | Date/Time | Amount (CBTC) | Sender (partial ID) |
|---|-----------|--------------|---------------------|
| 1 | Mar 23, 11:20 | 0.00010000 | a34d10491219f838806... |
| 2 | Mar 21, 04:59 | 0.00005000 | 7f973f93024cef2e473... |
| 3 | Mar 21, 04:13 | 0.00001000 | c56dac674727a1c3539... |
| 4-12 | Mar 16-23 | Various | (9 additional deposits on record in YAC) |

---

## 5. Reward Coupon Log

Every reward coupon from YAC for our retail pool shows **no reward value**. Here are the records:

| # | Date/Time | Amount (CBTC) | Our Role | Total Reward | Client Reward |
|---|-----------|--------------|----------|-------------|--------------|
| 1 | Mar 20, 17:39 | 0.00001992 | Sender | **none** | **none** |
| 2 | Mar 21, 00:17 | 0.00001000 | Sender | **none** | **none** |
| 3 | Mar 21, 00:19 | 0.00001000 | Sender | **none** | **none** |
| 4 | Mar 21, 01:08 | 0.00002400 | Sender | **none** | **none** |
| 5 | Mar 21, 01:09 | 0.00002400 | Sender | **none** | **none** |
| 6 | Mar 21, 01:20 | 0.00001040 | Sender | **none** | **none** |
| 7 | Mar 21, 01:21 | 0.00001040 | Sender | **none** | **none** |
| 8 | Mar 21, 01:23 | 0.00001000 | Sender | **none** | **none** |
| 9 | Mar 21, 01:26 | 0.00001000 | Sender | **none** | **none** |
| 10 | Mar 21, 01:28 | 0.00001040 | Sender | **none** | **none** |
| 11 | Mar 21, 01:29 | 0.00001040 | Sender | **none** | **none** |
| 12 | Mar 21, 01:30 | 0.00001000 | Sender | **none** | **none** |
| 13 | Mar 21, 01:33 | 0.00002029 | Sender | **none** | **none** |
| 14 | Mar 21, 01:34 | 0.00001000 | Sender | **none** | **none** |
| 15 | Mar 23, 11:39 | 0.00002000 | Sender | **none** | **none** |

Plus 10 additional reward coupon records where our pool was the receiver -- all also show **no reward value**.

**25 reward coupons total. Zero rewards earned.**

---

## 6. Comparison: Why Others Get Rewards But We Don't

We looked at CBTC reward coupons across the entire Canton network to understand whether this is just our problem or a network-wide pattern. Here is what we found:

### Transactions from March 1--15 DO have rewards

| Date | Amount (CBTC) | Wallet | Reward Earned | Client Share |
|------|--------------|--------|--------------|-------------|
| Mar 1 | 0.00000100 | consolewallet-jiaqian | **4.61 CC** | 0.82 CC |
| Mar 1 | 0.00000100 | consolewallet-kailun | **5.47 CC** | 1.94 CC |
| Mar 4 | 0.00000100 | consolewallet-helloworld | **10.99 CC** | 1.94 CC |
| Mar 7 | 0.00000100 | consolewallet-yusnehw | **8.81 CC** | 1.58 CC |
| Mar 15 | 0.00000100 | bron | **3.49 CC** | 1.92 CC |

These wallets earned between **3 and 11 CC per transaction** during early March.

### Transactions from March 16 onward show NO rewards

After March 15, **every CBTC transaction across the entire network** shows no reward value -- not just ours. Our testing started March 16, which falls entirely in this blank period.

**This is not unique to Predict Now. It affects all CBTC users network-wide.**

---

## 7. The Question for Gabi and Ferenc

Our retail pool wallet has completed **30 real CBTC transactions** on Canton mainnet during March 16--23. YAC tracks every one of them correctly. But all 25 associated reward coupons show **no reward earned**.

Meanwhile, other wallets' CBTC transactions from early March (before the 15th) earned **3 to 11 CC in rewards per transaction**. After March 15, rewards disappeared for everyone.

**We need clarity on four things:**

1. **Did reward distribution stop or pause after March 15?** Is this an intentional change, or is something broken?

2. **Is there a processing delay?** Will rewards for March 16+ transactions show up later once a reward round is processed?

3. **Is there a recording issue?** Are rewards being distributed on-chain but not captured by the YAC API?

4. **Is there a setup step we are missing?** Do our wallets need any additional registration or configuration to be eligible for CBTC rewards?

This matters for our business model. Predict Now's revenue depends on earning CBTC rewards from transaction volume. Until we understand why rewards are blank, we cannot finalize our revenue projections or scale up.

---

## How to Verify This Yourself

Query the YAC data API for our retail pool wallet's reward coupons:

- **Endpoint:** POST to the YAC reward-coupons API
- **Filter by:** Our retail pool Party ID (listed in Section 2 above)
- **Instrument:** CBTC

All 15 sender records will show no reward. Then run the same query without a sender filter, starting from March 1, and you will see that early March transactions DO have rewards but anything after March 15 does not.

---

*Document prepared March 24, 2026. API data pulled from the YAC CBTC Data API and Zoro Wallet API.*
