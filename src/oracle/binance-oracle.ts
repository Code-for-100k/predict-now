import type { BinanceKline, Direction } from "../types/market.js";

// Binance API endpoint (free, no auth needed)
const BINANCE_API = "https://api.binance.com/api/v3";
const SYMBOL = "BTCUSDT";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

/** Fetch with timeout */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch BTC price kline data from Binance with retry and timeout
 */
export async function fetchBinanceKline(
  interval: string = "15m",
  limit: number = 1
): Promise<BinanceKline[]> {
  const url = `${BINANCE_API}/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(`Binance API error: ${response.status}`);
      }

      const data = (await response.json()) as any[];

      if (!Array.isArray(data) || data.length === 0) {
        throw new Error("Binance returned empty kline data");
      }

      // Transform to typed format
      return data.map((k) => ({
        openTime: k[0],
        open: k[1],
        high: k[2],
        low: k[3],
        close: k[4],
        volume: k[5],
        closeTime: k[6],
        quoteAssetVolume: k[7],
        numberOfTrades: k[8],
        takerBuyBaseAssetVolume: k[9],
        takerBuyQuoteAssetVolume: k[10],
        unused: k[11],
      }));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `Oracle fetch attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(
    `Binance oracle failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

/**
 * Get current window prices (open from start, close from latest)
 */
export async function getCurrentWindowPrices(): Promise<{
  open_price: number;
  close_price: number;
}> {
  // Fetch 2 klines: current and previous
  const klines = await fetchBinanceKline("15m", 2);

  if (klines.length < 2) {
    throw new Error(`Expected 2 klines from Binance, got ${klines.length}`);
  }

  // Use the PREVIOUS (completed) kline for settlement — not the current (still open) one
  // klines[0] = previous completed window, klines[1] = current open window
  const completed = klines[0];

  const open_price = parseFloat(completed.open);
  const close_price = parseFloat(completed.close);

  if (isNaN(open_price) || isNaN(close_price)) {
    throw new Error(`Invalid prices from Binance: open=${completed.open}, close=${completed.close}`);
  }

  return { open_price, close_price };
}

/**
 * Determine winning direction based on prices
 */
export function determineDirection(
  open_price: number,
  close_price: number
): Direction {
  return close_price >= open_price ? "UP" : "DOWN";
}
