import WebSocket from "ws";
import type { Direction } from "../types/market.js";

/**
 * Binance WebSocket BTC Price Service
 *
 * Maintains a persistent WebSocket connection to Binance for real-time
 * BTC/USDT price. Replaces CoinGecko entirely — no rate limits, no polling.
 *
 * Provides:
 * - Real-time spot price (updated every ~100ms from Binance trade stream)
 * - 24h change percentage (from Binance 24hr mini-ticker)
 * - Lock/close price functions for round settlement
 */

// ── State ──
let currentPrice = 0;
let change24h = 0;
let lastUpdated = 0;
let ws: WebSocket | null = null;
let tickerWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let tickerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isStarted = false;

const BINANCE_TRADE_URL = "wss://stream.binance.com:9443/ws/btcusdt@trade";
const BINANCE_TICKER_URL = "wss://stream.binance.com:9443/ws/btcusdt@miniTicker";
const RECONNECT_DELAY_MS = 3_000;
const STALE_THRESHOLD_MS = 30_000; // consider price stale after 30s

// ── Fallback: Binance REST API ──
async function fetchPriceREST(): Promise<number> {
  const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
  if (!res.ok) throw new Error(`Binance REST error: ${res.status}`);
  const data = (await res.json()) as { price: string };
  return parseFloat(data.price);
}

async function fetch24hChangeREST(): Promise<number> {
  const res = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT");
  if (!res.ok) throw new Error(`Binance 24hr REST error: ${res.status}`);
  const data = (await res.json()) as { priceChangePercent: string };
  return parseFloat(data.priceChangePercent);
}

// ── WebSocket: Trade stream (real-time price) ──
function connectTradeStream(): void {
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
  }

  ws = new WebSocket(BINANCE_TRADE_URL);

  ws.on("open", () => {
    console.log("[Binance WS] Trade stream connected");
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const trade = JSON.parse(data.toString()) as { p: string };
      const price = parseFloat(trade.p);
      if (price > 0) {
        currentPrice = price;
        lastUpdated = Date.now();
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on("close", () => {
    console.warn("[Binance WS] Trade stream disconnected, reconnecting...");
    scheduleReconnect("trade");
  });

  ws.on("error", (err: Error) => {
    console.warn("[Binance WS] Trade stream error:", err.message);
    // close event will trigger reconnect
  });
}

// ── WebSocket: 24hr Mini Ticker (24h change) ──
function connectTickerStream(): void {
  if (tickerWs) {
    try { tickerWs.close(); } catch { /* ignore */ }
  }

  tickerWs = new WebSocket(BINANCE_TICKER_URL);

  tickerWs.on("open", () => {
    console.log("[Binance WS] Ticker stream connected");
  });

  tickerWs.on("message", (data: WebSocket.Data) => {
    try {
      // miniTicker: { o: open price, c: close price }
      const ticker = JSON.parse(data.toString()) as { o: string; c: string };
      const openPrice = parseFloat(ticker.o);
      const closePrice = parseFloat(ticker.c);
      if (openPrice > 0) {
        change24h = ((closePrice - openPrice) / openPrice) * 100;
      }
    } catch { /* ignore */ }
  });

  tickerWs.on("close", () => {
    console.warn("[Binance WS] Ticker stream disconnected, reconnecting...");
    scheduleReconnect("ticker");
  });

  tickerWs.on("error", (err: Error) => {
    console.warn("[Binance WS] Ticker stream error:", err.message);
  });
}

function scheduleReconnect(stream: "trade" | "ticker"): void {
  if (stream === "trade") {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectTradeStream(), RECONNECT_DELAY_MS);
  } else {
    if (tickerReconnectTimer) clearTimeout(tickerReconnectTimer);
    tickerReconnectTimer = setTimeout(() => connectTickerStream(), RECONNECT_DELAY_MS);
  }
}

// ── Public API ──

/**
 * Start the Binance WebSocket price service.
 * Call once at server startup. Handles reconnection automatically.
 */
export async function startBinancePriceService(): Promise<void> {
  if (isStarted) return;
  isStarted = true;

  console.log("[Binance WS] Starting price service...");

  // Fetch initial price via REST so we have a value immediately
  try {
    currentPrice = await fetchPriceREST();
    lastUpdated = Date.now();
    console.log(`[Binance WS] Initial price from REST: $${currentPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  } catch (e) {
    console.warn("[Binance WS] Initial REST fetch failed:", e instanceof Error ? e.message : e);
  }

  // Fetch initial 24h change
  try {
    change24h = await fetch24hChangeREST();
    console.log(`[Binance WS] Initial 24h change: ${change24h.toFixed(2)}%`);
  } catch (e) {
    console.warn("[Binance WS] Initial 24h change fetch failed:", e instanceof Error ? e.message : e);
  }

  // Connect WebSocket streams
  connectTradeStream();
  connectTickerStream();
}

/**
 * Get the current BTC/USD price.
 * Falls back to REST API if WebSocket data is stale.
 */
export async function getBTCPrice(): Promise<number> {
  // If we have a recent WS price, return it
  if (currentPrice > 0 && Date.now() - lastUpdated < STALE_THRESHOLD_MS) {
    return currentPrice;
  }

  // Fallback to REST
  console.warn("[Binance WS] Price stale, fetching from REST...");
  try {
    currentPrice = await fetchPriceREST();
    lastUpdated = Date.now();
    return currentPrice;
  } catch (e) {
    console.error("[Binance WS] REST fallback failed:", e instanceof Error ? e.message : e);
    if (currentPrice > 0) return currentPrice; // return last known price
    throw new Error("No BTC price available from any source");
  }
}

/**
 * Get the cached price synchronously (for the /api/btc-price endpoint).
 * Returns whatever we have — no async fallback.
 */
export function getCachedPrice(): { price: number; change24h: number; lastUpdated: number } {
  return {
    price: currentPrice,
    change24h: change24h,
    lastUpdated,
  };
}

/**
 * Fetch BTC price — drop-in replacement for CoinGecko's fetchBTCPrice().
 * Used by the scheduler for lock/close prices.
 */
export async function fetchBTCPrice(): Promise<number> {
  return getBTCPrice();
}

/**
 * Get current window prices for settlement.
 * Uses the round's stored open_price and current live price as close.
 */
export async function getCurrentWindowPrices(): Promise<{
  open_price: number;
  close_price: number;
}> {
  const closePrice = await getBTCPrice();
  // open_price is now stored on the round at creation time,
  // but we still provide it here as a fallback
  return {
    open_price: closePrice, // caller should use round.open_price instead
    close_price: closePrice,
  };
}

/**
 * Determine winning direction based on prices.
 */
export function determineDirection(
  open_price: number,
  close_price: number
): Direction {
  return close_price >= open_price ? "UP" : "DOWN";
}
