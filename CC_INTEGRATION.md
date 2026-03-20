# Canton Coin (CC) Integration - BTC Prediction Market

## Overview

The BTC 15-minute prediction market **uses real Canton Coins (CC) for both betting and settlement**. All bets and payouts are executed via the Canton Zoro wallet API on the Canton mainnet.

---

## System Architecture

```
User's Wallet                Pool Wallet              Winners' Wallets
    │                            │                           │
    │──(send CC)──────────────→  │                           │
    │   (pre-funding)            │                           │
    │                            │                           │
    │                            │──(auto-transfer)──────────→ │
    │                            │   (settlement payouts)     │
    │                            │                           │
```

---

## User Flow for Placing a Bet

### Step 1: Pre-Send CC to Pool Wallet

Before you can place a prediction, you must send your bet amount in CC to the **prediction pool wallet**.

**Using Canton Zoro send.ts script:**
```bash
cd /Users/mayank/Clawed/canton-send

# Send 100 CC to pool wallet
npx tsx src/send.ts <POOL_WALLET_PARTY_ID> 100
```

**Or use Canton Zoro wallet app manually:**
- Open Canton Zoro app
- Send your bet amount (e.g., 100 CC) to the pool wallet party ID
- Wait for confirmation

**Pool Wallet Party ID:**
```
Specified in environment variable: SENDER_PARTY_ID
```

### Step 2: Submit Prediction via API

Once you've sent CC to the pool wallet, call the prediction API:

```bash
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100,
    "direction": "UP",
    "party_id": "your_wallet_party_id"
  }'
```

**Parameters:**
- `amount`: Your bet amount in CC (must match or be less than what you sent to pool)
- `direction`: "UP" or "DOWN" (case-sensitive)
- `party_id`: Your Canton wallet party ID (where you want payouts sent)

### Step 3: Market Processes (Autonomous)

After you submit your prediction:

1. **15-minute window closes** - No more bets accepted
2. **Oracle fetches BTC price** from Binance:
   - Opening price (when window started)
   - Closing price (when window ended)
3. **Settlement engine runs automatically**:
   - Determines winning direction
   - Calculates your payout
   - Executes CC transfer to your wallet

---

## Settlement & Payouts

### How Winners Are Determined

The winning direction is determined by comparing BTC closing vs opening price:

```
IF close_price >= open_price:
  Winner = UP predictions
  Loser = DOWN predictions

ELSE:
  Winner = DOWN predictions
  Loser = UP predictions
```

### Payout Formula

Each winner receives:

```
payout = original_bet + (your_share_of_loser_pool × (1 - fee_percentage))

Example:
- You bet: 100 CC on UP (winner)
- Total UP bets: 150 CC
- Total DOWN bets: 200 CC
- Fee: 10%

Your share of loser pool: (100 / 150) × (200 - 20) = 120 CC
Your payout: 100 + 120 = 220 CC
```

### Automatic CC Transfer

Once settlement is triggered:

1. **Balance Check** - System verifies pool wallet has sufficient CC
2. **For Each Winner** - System executes Canton transfer:
   - Prepares transaction via `prepareSend()`
   - Signs with pool wallet private key
   - Broadcasts transaction to Canton blockchain
   - Records transaction ID
3. **Operator Fee** - Fee is transferred to operator wallet

All transfers use real Canton Zoro wallet API calls - **not test/mock transfers**.

---

## Environment Configuration for CC

Required `.env` variables for CC integration:

```bash
# Pool Wallet (receives bets, pays out winners)
SENDER_PARTY_ID=<your_pool_wallet_party_id>
SENDER_PRIVATE_KEY=<pool_private_key_base64>
SENDER_PUBLIC_KEY=<pool_public_key_base64>

# Fee Recipient (receives 10% of losing bets)
OPERATOR_PARTY_ID=<operator_wallet_party_id>

# CC Configuration
INSTRUMENT_ID=Amulet  # CC identifier on Canton
INSTRUMENT_ADMIN=DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc

# Canton Zoro API
ZORO_BASE_URL=https://dev-api.zorowallet.com
ZORO_API_KEY=<your_api_key>

# Settlement Fee (10% default)
FEE_PERCENTAGE=10
```

---

## Verifying Pool Wallet Balance

Before settlement, the system checks if the pool wallet has enough CC:

```bash
# Check pool wallet balance
npx tsx src/balance.ts <SENDER_PARTY_ID>
```

**Expected output:**
```
Balance: XXX.XX CC
Instruments:
  - Amulet (CC): XXX.XX CC
```

### Insufficient Balance Handling

If pool wallet doesn't have enough CC to cover all payouts:

1. System logs warning: `⚠️ Insufficient pool balance`
2. Settlement is **skipped** (not executed)
3. Market continues normally - next round starts
4. Failed payouts can be retried in next cycle

**Action Required:** Fund pool wallet with more CC before next settlement:

```bash
# Send 1000 CC to pool wallet from your main wallet
npx tsx src/send.ts <POOL_WALLET_PARTY_ID> 1000
```

---

## Real CC Transfers - Transaction Details

### Bet Submission (User → Pool)

**Executed manually by user:**
```
From: User's Canton wallet
To: Pool wallet (SENDER_PARTY_ID)
Amount: Bet amount (e.g., 100 CC)
Fee: 0 CC (CC transfers have no network fee)
```

### Settlement Payouts (Pool → Winners)

**Executed automatically by settlement engine:**
```
From: Pool wallet (config.senderPartyId)
To: Winner's Canton wallet (prediction.party_id)
Amount: Calculated payout
Fee: 0 CC (CC transfers have no network fee)
Network: Canton mainnet (not testnet)
```

### Fee Transfer (Pool → Operator)

**Executed automatically by settlement engine:**
```
From: Pool wallet (config.senderPartyId)
To: Operator wallet (OPERATOR_PARTY_ID)
Amount: 10% of losing bets
Fee: 0 CC
```

---

## Monitoring CC Transfers

### Check Recent Transactions

```bash
# Get latest round results with transaction IDs
curl -s http://localhost:3000/api/results/latest | jq '.payoutDetails'

# Output example:
# [
#   {
#     "partyId": "user::wallet1",
#     "amount": 220.50,
#     "txnId": "txn_abc123def456..."
#   },
#   {
#     "partyId": "operator::wallet",
#     "amount": 20.50,
#     "txnId": "txn_xyz789uvw123..."
#   }
# ]
```

### Server Logs

Settlement logs show all CC transfers:

```
═══ Settling Round 5 (UP) ═══
Total UP: 150, Total DOWN: 200
Fee collected: 20.00 (10%)
Num winners: 2

Payingout 220.50 CC to party::user1 (bet: 100)
  ✓ Transfer executed: txn_abc123def456...

Payingout 110.25 CC to party::user2 (bet: 50)
  ✓ Transfer executed: txn_xyz789uvw321...

Payingout fee 20.00 to operator
  ✓ Transfer executed: txn_fee_123456789...
```

---

## Common Issues & Fixes

### "Insufficient pool balance" Warning

**Problem:** Settlement skipped because pool doesn't have enough CC.

**Fix:**
```bash
# Check current pool balance
npx tsx src/balance.ts <SENDER_PARTY_ID>

# Send more CC to pool from your main wallet
npx tsx src/send.ts <POOL_WALLET_PARTY_ID> 1000
```

### "Invalid party ID" Error

**Problem:** User submitted invalid Canton wallet party ID.

**Fix:** Ensure party ID follows Canton format: `party::xxxxx` or similar. Check with:
```bash
npx tsx src/balance.ts <party_id>
```

### "No transaction ID returned" Error

**Problem:** Settlement failed for a winner because Canton API didn't return transaction ID.

**Fix:**
1. Check Canton Zoro API status
2. Check network connectivity
3. Verify pool wallet has CC (balance check above)
4. Next settlement cycle will retry

### Settlement Not Happening

**Problem:** 15 minutes passed but settlement didn't run.

**Fix:**
1. Check server logs for errors
2. Verify OPERATOR_PARTY_ID is set in `.env`
3. Restart server: `npm run market`

---

## Fee Structure

### CC Transfer Fees

According to Canton Zoro measurements:

| Operation | Traffic Units | CC Fee | USD Fee |
|-----------|---------------|--------|---------|
| **CC send (winner payout)** | ~9,253 | ~0 CC | ~$0 |
| **Fee transfer (to operator)** | ~9,253 | ~0 CC | ~$0 |
| **Overall per settlement** | Varies | ~0 CC | ~$0 |

**Key insight:** CC-to-CC transfers have **no effective network fee** at current Canton pricing. The 10% settlement fee you collect comes from the **losing bets**, not from transfer costs.

---

## Production Checklist

Before running the prediction market with real CC:

- [ ] Pool wallet created and backed up
- [ ] Pool wallet initial balance verified
- [ ] Operator wallet configured (OPERATOR_PARTY_ID)
- [ ] Test settlement with small amounts (e.g., 10 CC total bets)
- [ ] Verify winners received correct payouts
- [ ] Verify operator received fee
- [ ] Monitor first 2-3 rounds for any issues
- [ ] Set up alerts if settlement fails
- [ ] Document pool wallet recovery procedure

---

## Architecture: How CC Flows Through System

```
Round 1 (15 mins):
  - User1 sends 100 CC to pool → /api/predict(100, UP, user1_id)
  - User2 sends 200 CC to pool → /api/predict(200, DOWN, user2_id)
  - Pool has: 300 CC
  - BTC: open=$70k, close=$71k → UP wins

Settlement:
  1. Check pool balance: 300 CC ✓
  2. Calculate: 100 UP, 200 DOWN, fee=20, distribute=180
  3. User1 payout: 100 + 180 = 280 CC
  4. Operator fee: 20 CC
  5. Transfers:
     - Pool → User1: 280 CC ✓ (txn_123)
     - Pool → Operator: 20 CC ✓ (txn_456)
  6. Pool remaining: 0 CC (all distributed)

Round 2 (15 mins):
  - User1 can send more CC to pool and bet again
  - Pool starts fresh: 0 CC
  - New cycle...
```

---

## Summary

✅ **Real CC Integration Complete:**
- Users pre-send real CC to pool wallet
- Predictions register their bet amounts
- Settlement automatically executes CC transfers to winners
- Fee is automatically transferred to operator
- All transfers via Canton Zoro blockchain API
- Zero network fees for CC transfers
- Fully autonomous (no manual intervention)

**Key Points:**
1. Pool wallet must be funded before settlement
2. Users must pre-send CC before predicting
3. Settlement handles all payouts automatically
4. Fee comes from losing bets, not transfer costs
5. All transactions on Canton mainnet (real, not test)
