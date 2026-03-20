# BTC Market MVP - Deployment & Troubleshooting

## Prerequisites

- Node.js 18+
- Canton Zoro testnet account with API key
- Pool wallet (with some initial CC balance)
- Operator wallet (for fee collection)

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your values
```

Required values:
- `ZORO_BASE_URL`: Canton testnet endpoint
- `ZORO_API_KEY`: Your API key (starts with `canton_`)
- `SENDER_PARTY_ID`: Pool wallet party ID
- `SENDER_PRIVATE_KEY`: Pool wallet private key (base64)
- `SENDER_PUBLIC_KEY`: Pool wallet public key (base64)
- `OPERATOR_PARTY_ID`: Your wallet for receiving fees

### 3. Ensure Pool Wallet Has Funds
The pool wallet needs CC balance to pay winners. Check its balance:

```bash
npm run balance  # Shows balance of SENDER_PARTY_ID
```

### 4. Start the Market
```bash
npm run market
```

Expected output:
```
╔════════════════════════════════════════════════════════╗
║  BTC 15-Minute Prediction Market - MVP                 ║
╚════════════════════════════════════════════════════════╝
✓ Database initialized at ./market.db
✓ Config loaded: https://api.testnet.canton.io
✓ Pool wallet: party::xxxxx
✓ API server running on http://localhost:3000
  POST /api/predict - Register a prediction
  GET /api/market/status - Get current round status
  GET /api/results/:roundNumber - Get round results

✓ Market scheduler started (runs every 15 mins)

🚀 Market MVP is running autonomously
   - Oracle: Fetches BTC price from Binance every 15 mins
   - Settlement: Distributes payouts to winners automatically
   - No manual intervention needed!
```

## Testing

### Manual Test (with curl)

```bash
# 1. Check market status
curl http://localhost:3000/api/market/status | jq

# 2. Submit predictions (requires users to pre-send funds to pool)
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100,
    "direction": "UP",
    "party_id": "party::user1"
  }' | jq

# 3. Wait 15 mins for cron to settle...

# 4. Check results
curl http://localhost:3000/api/results/1 | jq
```

### Automated Test Script

```bash
bash test-market.sh
```

This script will:
1. Check server is running
2. Submit 3 test predictions
3. Show market status
4. Explain how to trigger settlement

## Troubleshooting

### Server won't start

**Error: Missing required env var**
```
Check .env has all required values. Run:
  cat .env
```

**Error: ZORO_API_KEY must start with 'canton_'**
```
Your API key format is wrong. Verify in Canton dashboard.
```

### Predictions rejected

**"No active market round"**
```
The cron scheduler hasn't created a round yet.
Wait a moment and try again, or restart the server.
```

**"Caller's party exists and sent funds"**
```
The pool wallet needs to have received a transfer from the user's party.
Verify the user pre-sent CC to pool wallet via Canton transfer.
```

### Settlement not executing

**"Failed to payout"**
```
Pool wallet might be out of funds. Check balance:
  npm run balance
```

**"Transfer times out"**
```
Canton network might be slow. Check logs for details.
Transfers are retried automatically on next cycle.
```

### Database issues

**Reset database**
```bash
# Backup current
cp market.db market.db.backup

# Delete and recreate
rm market.db
npm run market
```

**Check database contents**
```bash
sqlite3 market.db
  SELECT * FROM market_rounds;
  SELECT * FROM predictions;
  .quit
```

## Monitoring

### Logs

The server logs everything to console:
- Market cycle runs
- Oracle price fetches
- Settlement execution
- Transfer results

### Database Queries

Check pending predictions:
```bash
sqlite3 market.db "SELECT * FROM predictions WHERE settled = 0;"
```

Check settled rounds:
```bash
sqlite3 market.db "SELECT * FROM market_rounds WHERE settled = 1;"
```

Check fee collection:
```bash
sqlite3 market.db "SELECT SUM(your_fee_collected) FROM market_rounds WHERE settled = 1;"
```

## Production Considerations

For real deployment:

1. **Move to Canton mainnet**
   - Change ZORO_BASE_URL to mainnet
   - Use real money (not testnet CC)

2. **Add authentication**
   - API key protection
   - User wallet linking
   - Session management

3. **Add monitoring**
   - Prometheus metrics
   - Error alerts
   - Transfer failure notifications

4. **Add compliance**
   - KYC for users
   - Transaction logging
   - Regulatory reporting

5. **Scaling**
   - Use PostgreSQL instead of SQLite
   - Add load balancer
   - Cache market data

6. **Risk management**
   - Minimum/maximum bet limits
   - Pool size limits
   - Liquidity reserves
   - Circuit breakers

## Support

For issues with:
- **Canton API**: Check Canton docs at https://docs.canton.io
- **Binance API**: Check Binance docs at https://binance-docs.github.io/apidocs/
- **This MVP**: Check MARKET_MVP.md for architecture
