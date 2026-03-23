# Predict Now — Revenue Projection

## How We Make Money (Simple)

Every time a user wins a bet, we send them CBTC on-chain. That on-chain transaction earns BitSafe a **$0.80 CBTC reward** from the Canton Network. The user pays a **$0.50 network traffic fee** (per DA's fee schedule). We keep the reward, the user pays the fee. That's the model.

**The prediction market is the engine that generates transactions. More bets = more payouts = more rewards.**

---

## Unit Economics (Per Transaction)

| Line Item | Amount | Who Pays | Why |
|-----------|--------|----------|-----|
| CBTC Reward | +$0.80 | Canton → BitSafe | BitSafe earns rewards as a CBTC operator for every on-chain transaction |
| DA Network Traffic Fee | -$0.50 | User (deducted from payout) | Canton Network charges this for every transfer (DA v0.12 pricing) |
| **Net Profit Per Txn** | **$0.30** | | |

Every single payout transaction nets us $0.30. No exceptions, no variability.

---

## Throughput (What Limits Us)

| Constraint | Value | Source |
|-----------|-------|--------|
| Zoro hard limit | 0.5 TPS per API key / wallet | Zoro API allocation |
| Our operating target | 0.25 TPS per wallet | 50% of hard limit (safety margin) |
| Pool wallets | 50 | Each wallet = 1 API key = independent throughput |
| **Total effective TPS** | **12.5** | 50 wallets × 0.25 TPS each |

---

## Monthly Revenue Projection (50 Wallets)

| Step | Math | Result |
|------|------|--------|
| TPS | 50 wallets × 0.25 TPS | 12.5 txns/sec |
| Per minute | 12.5 × 60 | 750 txns/min |
| Per hour | 750 × 60 | 45,000 txns/hr |
| Per day | 45,000 × 24 | 1,080,000 txns/day |
| **Per month** | 1,080,000 × 30 | **32,400,000 txns/month** |
| | | |
| Gross rewards | 32.4M × $0.80 | **$25,920,000/month** |
| User-paid traffic fees | 32.4M × $0.50 | -$16,200,000/month (users pay this, not us) |
| **Net revenue** | 32.4M × $0.30 | **$9,720,000/month** |
| **Annual** | $9.72M × 12 | **$116,640,000/year** |

---

## Where the Numbers Come From

| Number | Source | Notes |
|--------|--------|-------|
| $0.80/txn reward | BitSafe CBTC operator agreement | Earned for every on-chain CBTC transaction |
| $0.50/txn traffic fee | [DA Utilities v0.12 fee schedule](https://docs.digitalasset.com/utilities/releases/0.12.html#id3) | "Direct Transfer" = $0.50. Trending down (was higher in v0.11) |
| 0.5 TPS per wallet | Zoro API rate limit | Hard limit per API key, Canton global cap is 10 TPS |
| 50% utilization | Our policy | Stay at half the hard limit to avoid rate errors and leave headroom |
| 50 wallets | Scaling plan | Each is an independent Canton party with its own keys and API allocation |

---

## Network Activity Share

### Canton Network — Actual Current Activity

| Metric | Value | Source |
|--------|-------|--------|
| Daily transactions | **600,000+** | [Phemex](https://phemex.com/news/article/canton-networks-daily-transactions-exceed-600000-amid-node-expansion-29333) |
| Implied TPS (avg) | **~7 TPS** | 600K / 86,400 seconds |
| Wallets | 28,000+ | Copper Research |
| Connected institutions | 400+ | Canton Network |
| Tokenized assets | $6T+ | Canton Network |
| Validators | 575+ | Copper Research |

**Key context:** Canton processes 600K+ txns/day across Goldman Sachs, HSBC, JPMorgan, Broadridge, Binance.US, Kraken, etc. The network averages ~7 TPS across all participants.

**Zoro's 10 TPS allocation is separate** from the 7 TPS average above — Zoro is one API provider on Canton, not the whole network. Total Canton throughput is much higher than 10 TPS.

### Our Activity as % of Total Network

| Our Target | % of Canton (600K/day) | % of Zoro (10 TPS) | Our TPS | Wallets | Txns/Day | Txns/Month | Net Rev/Month | Annual |
|-----------|----------------------|-------------------|---------|---------|---------|-----------|--------------|--------|
| **Quiet** | 7.2% | 5% | 0.5 | 2 | 43,200 | 1.3M | $389K | $4.7M |
| **Modest** | 14.4% | 10% | 1.0 | 4 | 86,400 | 2.6M | $778K | $9.3M |
| **Visible** | 28.8% | 20% | 2.0 | 8 | 172,800 | 5.2M | $1.56M | $18.7M |
| **Notable** | 43.2% | 30% | 3.0 | 12 | 259,200 | 7.8M | $2.33M | $28.0M |
| **Major** | 72.0% | 50% | 5.0 | 20 | 432,000 | 13.0M | $3.89M | $46.7M |

### How to read this table

- **"% of Canton"** = our daily txns as a share of the network's 600K daily transactions. At 5 TPS we'd be **72% of current Canton activity** — that's very visible.
- **"% of Zoro"** = our share of Zoro's 10 TPS API allocation. This is the real constraint.
- **"Wallets"** = pool wallets running at 0.25 TPS each (50% of the 0.5 TPS per-key hard limit).
- **"Net Revenue"** = txns × $0.30 ($0.80 CBTC reward minus $0.50 traffic fee paid by user).

### The real constraint

| Fact | Value |
|------|-------|
| Canton total daily txns | 600,000+ (~7 TPS average) |
| Zoro's allocation from Canton | 10 TPS (separate from the 7 TPS avg) |
| Max wallets at 0.25 TPS before hitting Zoro cap | 40 |
| At 20 wallets (5 TPS) we'd be | 72% of Canton daily volume, 50% of Zoro |

### Key insight

**We're visible on both Canton and Zoro.** Even the "Quiet" tier (2 wallets, 43K txns/day) would be 7.2% of Canton's current 600K daily activity. At "Modest" (4 wallets) we'd be 14.4%. This means:

1. Canton will notice us — we'd be a top-5 source of transaction volume
2. This is actually a **feature, not a bug** — DA wants network activity and we're paying traffic fees
3. But we should have the conversation with DA proactively, not surprise them

### Recommendation

Start at **Quiet (2 wallets, 7% of Canton)** → proves the model at $4.7M/year, doesn't dominate network. Then align with DA before scaling up — frame it as "we're driving X% of your network activity and paying $Y in traffic fees, we want to grow together."

## Summary

| | Quiet | Modest | Visible |
|---|-------|--------|---------|
| Canton share | 7.2% | 14.4% | 28.8% |
| Zoro share | 5% | 10% | 20% |
| Pool wallets | 2 | 4 | 8 |
| Txns/month | 1.3M | 2.6M | 5.2M |
| Profit/txn | $0.30 | $0.30 | $0.30 |
| **Monthly** | **$389K** | **$778K** | **$1.56M** |
| **Annual** | **$4.7M** | **$9.3M** | **$18.7M** |

One product. One transaction type. $0.30 profit each. Scale in coordination with DA as a mutually beneficial growth story.
