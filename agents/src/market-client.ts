/**
 * MarketClient — typed HTTP client for any prediction market instance.
 *
 * Zero dependencies. Uses native fetch.
 * Point it at any base URL and it gives you the full API surface.
 */

// ── Response types (mirrors what the API actually returns) ──

export interface MarketStatus {
  status: "active" | "no_active_round";
  round_number?: number;
  time_remaining_seconds?: number;
  window_start_time?: number;
  window_end_time?: number;
  total_up_amount?: number;
  total_down_amount?: number;
  next_round?: number;
  next_start_time?: number;
}

export interface BTCPrice {
  price: number;
  change24h: number;
  change_24h?: number;  // predict-now uses snake_case
  lastUpdated: number;
  last_updated?: number;
}

export interface PoolInfo {
  pool_party_id: string;
  fee_percentage: number;
}

export interface RoundResult {
  round_number: number;
  open_price: number;
  close_price: number;
  winning_direction: "UP" | "DOWN";
  total_up_amount: number;
  total_down_amount: number;
  fee_collected: number;
  window_start_time: number;
  window_end_time: number;
}

export interface Balance {
  party_id: string;
  balance: number;
  total_deposited: number;
  total_withdrawn: number;
  total_won: number;
  total_lost: number;
  total_fees_paid: number;
}

export interface Bet {
  id: number;
  market_round_id: number;
  party_id: string;
  direction: "UP" | "DOWN";
  amount: number;
  settled: boolean;
}

export interface PredictResponse {
  prediction_id: number;
  direction: "UP" | "DOWN";
  amount: number;
  round_number: number;
}

export interface LeaderboardTrader {
  name: string;
  displayName: string;
  winRate: number;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  roi: number;
  currentStreak: number;
  totalProfit: number;
  active: boolean;
}

// ── Client ──

export interface FirebaseAuth {
  email: string;
  password: string;
  apiKey: string;
}

export class MarketClient {
  private firebaseAuth?: FirebaseAuth;
  private idToken?: string;
  private refreshToken?: string;
  private tokenExpiresAt = 0;

  constructor(
    private baseUrl: string,
    private authToken?: string,
    private timeoutMs = 10_000,
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Configure Firebase auth — tokens auto-refresh before expiry. */
  setFirebaseAuth(auth: FirebaseAuth): void {
    this.firebaseAuth = auth;
  }

  /** Sign in with Firebase and get an ID token. Called automatically. */
  private async ensureFirebaseToken(): Promise<void> {
    if (!this.firebaseAuth) return;
    if (this.idToken && Date.now() < this.tokenExpiresAt - 60_000) return; // 1 min buffer

    try {
      if (this.refreshToken) {
        // Refresh existing token
        const res = await globalThis.fetch(
          `https://securetoken.googleapis.com/v1/token?key=${this.firebaseAuth.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `grant_type=refresh_token&refresh_token=${this.refreshToken}`,
          },
        );
        const data = await res.json() as any;
        if (data.id_token) {
          this.idToken = data.id_token;
          this.authToken = data.id_token;
          this.refreshToken = data.refresh_token;
          this.tokenExpiresAt = Date.now() + parseInt(data.expires_in || "3600") * 1000;
          return;
        }
      }

      // Full sign-in
      const res = await globalThis.fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.firebaseAuth.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: this.firebaseAuth.email,
            password: this.firebaseAuth.password,
            returnSecureToken: true,
          }),
        },
      );
      const data = await res.json() as any;
      if (!data.idToken) throw new Error(`Firebase sign-in failed: ${data.error?.message || "unknown"}`);

      this.idToken = data.idToken;
      this.authToken = data.idToken;
      this.refreshToken = data.refreshToken;
      this.tokenExpiresAt = Date.now() + parseInt(data.expiresIn || "3600") * 1000;
    } catch (err) {
      console.error("[MarketClient] Firebase auth error:", err instanceof Error ? err.message : err);
      throw err;
    }
  }

  // ── Public (no auth) ──

  async getPrice(): Promise<BTCPrice> {
    const raw = await this.get<BTCPrice>("/api/btc-price");
    // Normalize snake_case → camelCase (predict-now uses change_24h)
    if (raw.change_24h !== undefined && raw.change24h === undefined) {
      raw.change24h = raw.change_24h;
    }
    if (raw.last_updated !== undefined && raw.lastUpdated === undefined) {
      (raw as any).lastUpdated = raw.last_updated;
    }
    return raw;
  }

  async getMarketStatus(): Promise<MarketStatus> {
    return this.get<MarketStatus>("/api/market/status");
  }

  async getPoolInfo(): Promise<PoolInfo> {
    return this.get<PoolInfo>("/api/pool-info");
  }

  async getHistory(): Promise<{ rounds: RoundResult[] }> {
    return this.get<{ rounds: RoundResult[] }>("/api/results/history");
  }

  async getRoundResult(roundNumber: number): Promise<RoundResult> {
    return this.get<RoundResult>(`/api/results/${roundNumber}`);
  }

  async getBalance(partyId: string): Promise<Balance> {
    return this.get<Balance>(`/api/balance/${partyId}`);
  }

  async getBets(partyId: string): Promise<{ bets: Bet[] }> {
    return this.get<{ bets: Bet[] }>(`/api/bets/${partyId}`);
  }

  async getLeaderboard(): Promise<{ traders: LeaderboardTrader[] }> {
    return this.get<{ traders: LeaderboardTrader[] }>("/api/leaderboard");
  }

  // ── Trading endpoints ──

  async placeBet(partyId: string, direction: "UP" | "DOWN", amount: number): Promise<PredictResponse> {
    await this.ensureFirebaseToken();
    if (!this.authToken) throw new Error("Auth token required to place bets");
    // Use regular predict endpoint (Firebase auth, party_id looked up from user account)
    return this.post<PredictResponse>("/api/predict", { direction, amount });
  }

  async seedBalance(partyId: string, amount = 1.0): Promise<{ party_id: string; balance: number; seeded: number }> {
    if (!this.authToken) throw new Error("Auth token required to seed balance");
    return this.post("/api/bot/seed", { party_id: partyId, amount });
  }

  async botDeposit(partyId: string, amount: number): Promise<{ party_id: string; balance: number; deposited: number }> {
    if (!this.authToken) throw new Error("Auth token required to deposit");
    return this.post("/api/bot/deposit", { party_id: partyId, amount });
  }

  async triggerDeposit(): Promise<any> {
    await this.ensureFirebaseToken();
    if (!this.authToken) throw new Error("Auth token required for deposit");
    return this.post("/api/deposit", {});
  }

  // ── HTTP internals ──

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetch(path, { method: "GET" });
    return res as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res as T;
  }

  private async fetch(path: string, init: RequestInit, skipAuth = false): Promise<unknown> {
    if (!skipAuth) await this.ensureFirebaseToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string>),
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`API ${init.method} ${path} failed: ${response.status} ${text}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
