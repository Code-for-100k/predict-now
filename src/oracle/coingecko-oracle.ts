import type { Direction } from "../types/market.js";

// CoinGecko free API — no auth needed, no geo-restrictions
const COINGECKO_API = "https://api.coingecko.com/api/v3";
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
 * Fetch BTC/USD price from CoinGecko with retry and timeout.
 * Returns the current spot price.
 */
export async function fetchBTCPrice(): Promise<number> {
  const url = `${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json() as { bitcoin?: { usd?: number } };

      if (!data.bitcoin?.usd) {
        throw new Error("CoinGecko returned no BTC price data");
      }

      return data.bitcoin.usd;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `CoinGecko fetch attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(
    `CoinGecko oracle failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

/**
 * Fetch BTC OHLC data from CoinGecko for the last 24h (gives ~15min candles).
 * Returns the most recent completed candle.
 */
export async function fetchBTCOHLC(): Promise<{
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}> {
  // CoinGecko OHLC: 1 day = 30-min candles, 7 days = 4-hour candles
  // For ~15 min resolution, we use /market_chart with 1-day range
  const url = `${COINGECKO_API}/coins/bitcoin/ohlc?vs_currency=usd&days=1`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(`CoinGecko OHLC API error: ${response.status}`);
      }

      // Response: [[timestamp, open, high, low, close], ...]
      const data = await response.json() as number[][];

      if (!Array.isArray(data) || data.length < 2) {
        throw new Error(`CoinGecko returned insufficient OHLC data: ${data.length} candles`);
      }

      // Use the second-to-last candle (last completed one)
      const completed = data[data.length - 2];
      return {
        timestamp: completed[0],
        open: completed[1],
        high: completed[2],
        low: completed[3],
        close: completed[4],
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `CoinGecko OHLC fetch attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(
    `CoinGecko OHLC oracle failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

/**
 * Get current window prices (open from start, close from latest).
 * Uses CoinGecko OHLC for the completed candle, with spot price fallback.
 */
export async function getCurrentWindowPrices(): Promise<{
  open_price: number;
  close_price: number;
}> {
  try {
    // Try OHLC first for proper open/close
    const ohlc = await fetchBTCOHLC();
    return {
      open_price: ohlc.open,
      close_price: ohlc.close,
    };
  } catch (ohlcError) {
    // Fallback: use spot price for both (settlement will be "no change" = UP wins)
    console.warn("OHLC fetch failed, falling back to spot price:", ohlcError);
    const price = await fetchBTCPrice();
    return {
      open_price: price,
      close_price: price,
    };
  }
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
