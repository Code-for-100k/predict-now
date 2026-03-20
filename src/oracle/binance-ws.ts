import WebSocket from "ws";
import type { Direction } from "../types/market.js";

/**
 * Multi-Source BTC Price Service
 *
 * Priority chain (handles geo-restrictions gracefully):
 *   1. Binance.US WebSocket (real-time, works from US servers)
 *   2. Binance.US REST API (fallback if WS disconnects)
 *   3. Coinbase REST API (second fallback, no geo-restrictions)
 *   4. CoinGecko REST API (last resort)
 *
 * Provides:
 * - Real-time spot price
 * - 24h change percentage
 * - Lock/close price functions for round settlement
 */

// ── State ──
let currentPrice = 0;
let change24h = 0;
let lastUpdated = 0;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isStarted = false;
let wsConnected = false;
let consecutiveWsFailures = 0;
const MAX_WS_FAILURES = 5; // stop trying WS after this many consecutive failures

// Binance.US endpoints (accessible from US servers)
const BINANCE_US_WS_URL = "wss://stream.binance.us:9443/ws/btcusd@trade";
const BINANCE_US_REST_URL = "https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD";
const BINANCE_US_24HR_URL = "https://api.binance.us/api/v3/ticker/24hr?symbol=BTCUSD";

// Coinbase REST (no geo-restrictions, works everywhere)
const COINBASE_REST_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

// CoinGecko REST (last resort, has rate limits)
const COINGECKO_REST_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";

const RECONNECT_DELAY_MS = 5_000;
const STALE_THRESHOLD_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;

// ── Fetch with timeout ──
async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── REST API Sources ──

async function fetchFromBinanceUS(): Promise<number> {
  const res = await fetchWithTimeout(BINANCE_US_REST_URL);
  if (!res.ok) throw new Error(`Binance.US REST error: ${res.status}`);
  const data = (await res.json()) as { price: string };
  return parseFloat(data.price);
}

async function fetchFromCoinbase(): Promise<number> {
  const res = await fetchWithTimeout(COINBASE_REST_URL);
  if (!res.ok) throw new Error(`Coinbase REST error: ${res.status}`);
  const data = (await res.json()) as { data: { amount: string } };
  return parseFloat(data.data.amount);
}

async function fetchFromCoinGecko(): Promise<number> {
  const res = await fetchWithTimeout(COINGECKO_REST_URL);
  if (!res.ok) throw new Error(`CoinGecko REST error: ${res.status}`);
  const data = (await res.json()) as { bitcoin?: { usd?: number } };
  if (!data.bitcoin?.usd) throw new Error("CoinGecko returned no BTC price");
  return data.bitcoin.usd;
}

async function fetch24hChange(): Promise<number> {
  // Try Binance.US first
  try {
    const res = await fetchWithTimeout(BINANCE_US_24HR_URL);
    if (res.ok) {
      const data = (await res.json()) as { priceChangePercent: string };
      return parseFloat(data.priceChangePercent);
    }
  } catch { /* fall through */ }

  // Try CoinGecko
  try {
    const res = await fetchWithTimeout(COINGECKO_REST_URL);
    if (res.ok) {
      const data = (await res.json()) as { bitcoin?: { usd_24h_change?: number } };
      return data.bitcoin?.usd_24h_change ?? 0;
    }
  } catch { /* fall through */ }

  return 0;
}

/**
 * Fetch BTC price from multiple sources with cascading fallback.
 */
async function fetchPriceFromAnySource(): Promise<number> {
  const sources = [
    { name: "Binance.US", fn: fetchFromBinanceUS },
    { name: "Coinbase", fn: fetchFromCoinbase },
    { name: "CoinGecko", fn: fetchFromCoinGecko },
  ];

  for (const source of sources) {
    try {
      const price = await source.fn();
      if (price > 0) {
        return price;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[Price] ${source.name} failed: ${msg}`);
    }
  }

  throw new Error("All price sources failed");
}

// ── WebSocket: Binance.US Trade stream ──
function connectTradeStream(): void {
  if (consecutiveWsFailures >= MAX_WS_FAILURES) {
    console.warn(`[Price WS] Stopped WebSocket attempts after ${MAX_WS_FAILURES} consecutive failures. Using REST polling.`);
    startRESTPolling();
    return;
  }

  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
  }

  console.log("[Price WS] Connecting to Binance.US trade stream...");
  ws = new WebSocket(BINANCE_US_WS_URL);

  ws.on("open", () => {
    console.log("[Price WS] Connected to Binance.US trade stream");
    wsConnected = true;
    consecutiveWsFailures = 0;
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
    wsConnected = false;
    consecutiveWsFailures++;
    console.warn(`[Price WS] Disconnected (failure #${consecutiveWsFailures}), reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    scheduleReconnect();
  });

  ws.on("error", (err: Error) => {
    console.warn("[Price WS] Error:", err.message);
    // close event will trigger reconnect
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectTradeStream(), RECONNECT_DELAY_MS);
}

// ── REST Polling fallback (when WS is unavailable) ──
let restPollingInterval: ReturnType<typeof setInterval> | null = null;

function startRESTPolling(): void {
  if (restPollingInterval) return;
  console.log("[Price REST] Starting REST polling every 10s as WebSocket fallback");

  const poll = async () => {
    try {
      const price = await fetchPriceFromAnySource();
      currentPrice = price;
      lastUpdated = Date.now();
    } catch (e) {
      console.warn("[Price REST] Poll failed:", e instanceof Error ? e.message : e);
    }
  };

  // Poll immediately then every 10 seconds
  poll();
  restPollingInterval = setInterval(poll, 10_000);
}

// ── Public API ──

/**
 * Start the price service.
 * Call once at server startup. Handles reconnection and fallbacks automatically.
 */
export async function startBinancePriceService(): Promise<void> {
  if (isStarted) return;
  isStarted = true;

  console.log("[Price] Starting multi-source BTC price service...");

  // Fetch initial price via REST (cascading sources)
  try {
    currentPrice = await fetchPriceFromAnySource();
    lastUpdated = Date.now();
    console.log(`[Price] Initial price: $${currentPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  } catch (e) {
    console.warn("[Price] Initial price fetch failed:", e instanceof Error ? e.message : e);
  }

  // Fetch initial 24h change
  try {
    change24h = await fetch24hChange();
    console.log(`[Price] Initial 24h change: ${change24h.toFixed(2)}%`);
  } catch (e) {
    console.warn("[Price] Initial 24h change fetch failed:", e instanceof Error ? e.message : e);
  }

  // Try WebSocket first (best latency)
  connectTradeStream();

  // Also refresh 24h change periodically via REST (every 60s)
  setInterval(async () => {
    try {
      change24h = await fetch24hChange();
    } catch { /* ignore */ }
  }, 60_000);
}

/**
 * Get the current BTC/USD price.
 * Falls back to REST API if WebSocket data is stale.
 */
export async function getBTCPrice(): Promise<number> {
  // If we have a recent price (from WS or REST polling), return it
  if (currentPrice > 0 && Date.now() - lastUpdated < STALE_THRESHOLD_MS) {
    return currentPrice;
  }

  // Fallback: fetch from any REST source
  console.warn("[Price] Price stale, fetching from REST...");
  try {
    currentPrice = await fetchPriceFromAnySource();
    lastUpdated = Date.now();
    return currentPrice;
  } catch (e) {
    console.error("[Price] All REST sources failed:", e instanceof Error ? e.message : e);
    if (currentPrice > 0) return currentPrice; // return last known price
    throw new Error("No BTC price available from any source");
  }
}

/**
 * Get the cached price synchronously (for the /api/btc-price endpoint).
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
 * Determine winning direction based on prices.
 */
export function determineDirection(
  open_price: number,
  close_price: number
): Direction {
  return close_price >= open_price ? "UP" : "DOWN";
}
