#!/bin/bash

# BTC Market MVP - Manual Testing Script
# This script demonstrates the full prediction → settlement flow

set -e

API_URL="http://localhost:3000/api"

echo "╔════════════════════════════════════════════════════════╗"
echo "║  BTC Market MVP - End-to-End Test                     ║"
echo "╚════════════════════════════════════════════════════════╝"

# Check if server is running
echo -n "Checking server... "
if ! curl -s "${API_URL%/api}/health" > /dev/null 2>&1; then
    echo "✗ Server not running. Start with: npm run market"
    exit 1
fi
echo "✓"

echo ""
echo "Step 1: Check market status"
echo "───────────────────────────"
STATUS=$(curl -s "$API_URL/market/status")
echo "$STATUS" | jq .

ROUND=$(echo "$STATUS" | jq -r '.round_number // .next_round // 1')
echo "Current round: $ROUND"

echo ""
echo "Step 2: Submit 3 predictions"
echo "────────────────────────────"

echo "  → User 1 bets 100 CC on UP"
P1=$(curl -s -X POST "$API_URL/predict" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100,
    "direction": "UP",
    "party_id": "party::test_user_1"
  }')
echo "$P1" | jq .
P1_ID=$(echo "$P1" | jq -r '.prediction_id')

echo ""
echo "  → User 2 bets 150 CC on DOWN"
P2=$(curl -s -X POST "$API_URL/predict" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 150,
    "direction": "DOWN",
    "party_id": "party::test_user_2"
  }')
echo "$P2" | jq .
P2_ID=$(echo "$P2" | jq -r '.prediction_id')

echo ""
echo "  → User 3 bets 50 CC on UP"
P3=$(curl -s -X POST "$API_URL/predict" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 50,
    "direction": "UP",
    "party_id": "party::test_user_3"
  }')
echo "$P3" | jq .
P3_ID=$(echo "$P3" | jq -r '.prediction_id')

echo ""
echo "Step 3: Check updated market status"
echo "────────────────────────────────────"
STATUS=$(curl -s "$API_URL/market/status")
echo "$STATUS" | jq .

UP_AMOUNT=$(echo "$STATUS" | jq '.up_amount')
DOWN_AMOUNT=$(echo "$STATUS" | jq '.down_amount')
echo ""
echo "Pool Status:"
echo "  UP pool:   $UP_AMOUNT CC (users: 1, 3)"
echo "  DOWN pool: $DOWN_AMOUNT CC (user: 2)"

echo ""
echo "Step 4: Wait for automation"
echo "──────────────────────────"
echo "The cron scheduler will:"
echo "  1. Run the oracle (fetch BTC price from Binance)"
echo "  2. Determine winning direction (UP or DOWN)"
echo "  3. Calculate payouts to winners"
echo "  4. Execute transfers to winners + fee to operator"
echo ""
echo "This happens automatically every 15 minutes."
echo "For testing, you can manually trigger settlement in the database:"
echo ""
echo "  sqlite3 market.db \"UPDATE market_rounds SET window_end_time = 0, settled = 0 LIMIT 1\""
echo ""
echo "Then restart the server to trigger immediate settlement."

echo ""
echo "Step 5: Check results (after settlement)"
echo "────────────────────────────────────────"
echo ""
echo "Once settled, check the round results:"
echo "  curl http://localhost:3000/api/results/1"
echo ""
echo "Expected output will show:"
echo "  - winning_direction (UP or DOWN)"
echo "  - Which users won"
echo "  - Payout amounts"
echo "  - Transaction IDs from Canton"

echo ""
echo "✓ Test flow completed!"
