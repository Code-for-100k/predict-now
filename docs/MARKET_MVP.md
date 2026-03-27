# BTC 15-Minute Prediction Market MVP

## Overview

This is a fully autonomous **BTC binary prediction market** where:
- **Users predict** BTC direction (UP/DOWN) for 15-minute windows
- **Oracle** autonomously fetches prices from Binance every 15 mins
- **Settlement** autonomously distributes payouts to winners every 15 mins
- **Zero manual intervention** - just deploy and it runs

## Quick Start

### 1. Install Dependencies

```bash
cd canton-send
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

You need:
- `ZORO_BASE_URL` & `ZORO_API_KEY` - Canton Zoro API credentials
- `SENDER_PARTY_ID`, `SENDER_PRIVATE_KEY`, `SENDER_PUBLIC_KEY` - Pool wallet (where users send bets)
- `OPERATOR_PARTY_ID` - Your fee collection wallet
- Pool wallet should have some initial balance to send to winners

### 3. Run the Market

```bash
npm run market
```

Output:
```
✓ Database initialized
✓ Config loaded: https://api.testnet.canton.io
✓ Pool wallet: party::xxxxx
✓ API server running on http://localhost:3000
🚀 Market MVP is running autonomously
```

## API Endpoints

### Register a Prediction

```bash
POST /api/predict
Content-Type: application/json

{
  "amount": 100,
  "direction": "UP",
  "party_id": "party::abc123"
}
```

**Requirements:**
- User must pre-send `amount` CC to pool wallet before calling this
- `direction` must be "UP" or "DOWN"
- `party_id` is the user's wallet party ID (where they'll receive payouts)

**Response:**
```json
{
  "prediction_id": 1,
  "market_round": 1,
  "direction": "UP",
  "amount": 100,
  "party_id": "party::abc123",
  "message": "Prediction registered successfully"
}
```

### Get Market Status

```bash
GET /api/market/status
```

**Response:**
```json
{
  "status": "active",
  "round_number": 1,
  "window_start_ms": 1710750000000,
  "window_end_ms": 1710750900000,
  "time_remaining_ms": 450000,
  "up_predictions": 3,
  "down_predictions": 2,
  "up_amount": 350,
  "down_amount": 150
}
```

### Get Round Results

```bash
GET /api/results/1
```

**Response:**
```json
{
  "round_number": 1,
  "open_price": 42000.50,
  "close_price": 42100.75,
  "winning_direction": "UP",
  "total_up_amount": 350,
  "total_down_amount": 150,
  "fee_collected": 15,
  "predictions": [
    {
      "party_id": "party::abc123",
      "direction": "UP",
      "amount": 100,
      "won": true,
      "payout_txn_id": "txn_xxxxx"
    }
  ]
}
```

## How It Works

### User Flow

```
User 1: Sends 100 CC to pool wallet via Canton transfer
            ↓
User 1: Calls POST /api/predict {amount: 100, direction: "UP", party_id: "user1"}
            ↓
Server: Registers prediction in DB for round 1
            ↓
(15 minutes pass)
            ↓
Oracle: Fetches BTC price from Binance, determines UP/DOWN winner
            ↓
Settlement: Calculates payouts, executes transfers to winners + fee
            ↓
User 1: Receives payout in their wallet
```

### Market Rounds

- Each round is **15 minutes**
- Oracle runs every 15 mins to:
  1. Create new round (if none active)
  2. Settle expired rounds (calculate winners + execute transfers)
- Fully automated via cron scheduler

### Fee Structure

- 10% of losing bets go to operator (configurable via `FEE_PERCENTAGE`)
- 90% of losing bets distributed to winners proportionally
- Example:
  - UP: 100 CC, DOWN: 100 CC
  - Direction: UP wins
  - Fee: 100 * 0.10 = 10 CC
  - Winner gets: 100 + (100 - 10) = 190 CC

## Database Schema

```sql
market_rounds {
  id, round_number, window_start_time, window_end_time,
  open_price, close_price, winning_direction,
  total_up_amount, total_down_amount, your_fee_collected,
  settled
}

predictions {
  id, market_round_id, party_id, direction, amount,
  settled, payout_txn_id
}

price_snapshots {
  id, market_round_id, open_price, close_price, timestamp
}
```

## Testing the MVP

### Manual Test Flow

1. **Pre-fund the pool wallet** (send some CC to it via Canton)

2. **Make 3 predictions:**

```bash
# Prediction 1: User bets 100 UP
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "direction": "UP", "party_id": "party::user1"}'

# Prediction 2: User bets 150 DOWN
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 150, "direction": "DOWN", "party_id": "party::user2"}'

# Prediction 3: User bets 50 UP
curl -X POST http://localhost:3000/api/predict \
  -H "Content-Type: application/json" \
  -d '{"amount": 50, "direction": "UP", "party_id": "party::user3"}'
```

3. **Check market status:**

```bash
curl http://localhost:3000/api/market/status
```

4. **Wait for cron to settle** (or manually trigger via database)

5. **Check results:**

```bash
curl http://localhost:3000/api/results/1
```

## Logs

Check console output for:
- ✓ Market cycle runs
- 🏁 Settling round X
- ✓ Transfer executed (transaction IDs)

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZORO_BASE_URL` | Yes | - | Canton Zoro API endpoint |
| `ZORO_API_KEY` | Yes | - | API key (must start with `canton_`) |
| `SENDER_PARTY_ID` | Yes | - | Pool wallet party ID |
| `SENDER_PRIVATE_KEY` | Yes | - | Pool wallet private key (base64) |
| `SENDER_PUBLIC_KEY` | Yes | - | Pool wallet public key (base64) |
| `OPERATOR_PARTY_ID` | No | - | Fee recipient party ID (optional) |
| `FEE_PERCENTAGE` | No | 10 | Fee % from losing bets |
| `PORT` | No | 3000 | Server port |
| `DB_PATH` | No | ./market.db | SQLite database path |
| `INSTRUMENT_ID` | No | Amulet | Canton instrument (asset) ID |
| `INSTRUMENT_ADMIN` | No | (default) | Instrument admin party |

## Architecture

```
src/
├── market.ts              # Main server
├── api/
│   └── prediction.ts      # Express routes: /api/predict, /api/market/status, /api/results/:round
├── oracle/
│   └── binance-oracle.ts  # Fetch BTC prices from Binance API
├── settlement/
│   └── settlement.ts      # Calculate payouts & execute transfers
├── scheduler/
│   └── cron.ts            # Autonomous scheduler (runs every 15 mins)
├── db/
│   └── init.ts            # SQLite initialization
├── types/
│   └── market.ts          # TypeScript types
└── lib/
    ├── api.ts             # Canton API client (reused)
    ├── sign.ts            # Ed25519 signing (reused)
    ├── config.ts          # Config loading (reused)
    └── types.ts           # Canton types (reused)
```

## Limitations (MVP)

- Single oracle source (Binance only) - good enough for MVP
- No user authentication - party_id passed in request
- No minimum bet size
- No maximum pool size
- Simple price calculation (close >= open = UP)
- Basic error handling (continues on failures)

## Next Steps After MVP

- Add user authentication + wallet linking
- Add historical data & statistics
- Add minimum/maximum bet limits
- Add tie handling (price doesn't move)
- Add multiple pairs (ETH, SOL, etc.)
- Add UI dashboard
- Move to mainnet with real money
