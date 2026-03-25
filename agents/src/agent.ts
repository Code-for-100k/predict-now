/**
 * Agent — base class for all trading agents.
 *
 * An agent:
 * 1. Observes the market via MarketClient (public APIs)
 * 2. Maintains its own state and memory
 * 3. Makes decisions through a Strategy
 * 4. Can learn by updating its config between rounds
 *
 * The agent owns its loop. The factory just creates and starts agents.
 */

import type { MarketClient, MarketStatus, BTCPrice, RoundResult, Balance } from "./market-client.js";

// ── Types ──

export type Direction = "UP" | "DOWN";

/** Everything an agent can see when making a decision. */
export interface TradeContext {
  // Live market
  price: BTCPrice;
  round: MarketStatus;

  // Historical
  history: RoundResult[];        // last N settled rounds
  myBets: MyBetOutcome[];        // my trades with outcomes

  // My state
  balance: number;
  stats: AgentStats;

  // Tunable config (strategy can read and modify)
  config: Record<string, number>;
}

export interface MyBetOutcome {
  roundNumber: number;
  direction: Direction;
  amount: number;
  won: boolean;
  pnl: number;
}

export interface AgentStats {
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  totalSkipped: number;
  winRate: number;
  currentStreak: number;   // positive = wins, negative = losses
  totalPnl: number;
  roi: number;
}

/** A strategy is a single function. No class, no inheritance. */
export type Strategy = (ctx: TradeContext) => TradeDecision | null;

export interface TradeDecision {
  direction: Direction;
  amount: number;
  reason?: string;
}

export interface AgentConfig {
  name: string;
  partyId: string;
  strategy: Strategy;
  initialBalance?: number;
  historyDepth?: number;       // how many past rounds to fetch (default 50)
  params?: Record<string, number>;  // tunable strategy params
}

// ── Agent ──

export class Agent {
  readonly name: string;
  readonly partyId: string;

  private client: MarketClient;
  private strategy: Strategy;
  private config: Record<string, number>;
  private historyDepth: number;

  private stats: AgentStats = {
    totalTrades: 0,
    totalWins: 0,
    totalLosses: 0,
    totalSkipped: 0,
    winRate: 0,
    currentStreak: 0,
    totalPnl: 0,
    roi: 0,
  };

  private betHistory: MyBetOutcome[] = [];
  private lastBetRound = 0;
  private initialBalance: number;
  private running = false;

  constructor(client: MarketClient, cfg: AgentConfig) {
    this.name = cfg.name;
    this.partyId = cfg.partyId;
    this.client = client;
    this.strategy = cfg.strategy;
    this.config = { ...cfg.params };
    this.historyDepth = cfg.historyDepth ?? 50;
    this.initialBalance = cfg.initialBalance ?? 1.0;
  }

  /** Run the agent loop. Polls market status and trades when a round is active. */
  async start(pollIntervalMs = 15_000): Promise<void> {
    this.running = true;
    console.log(`[${this.name}] Started (polling every ${pollIntervalMs / 1000}s)`);

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${this.name}] Tick error: ${msg}`);
      }
      await sleep(pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
    console.log(`[${this.name}] Stopped`);
  }

  getStats(): AgentStats {
    return { ...this.stats };
  }

  getBetHistory(): MyBetOutcome[] {
    return [...this.betHistory];
  }

  /** Single tick: observe → decide → act */
  private async tick(): Promise<void> {
    // 1. Observe
    const [price, round, historyRes, balRes] = await Promise.all([
      this.client.getPrice(),
      this.client.getMarketStatus(),
      this.client.getHistory(),
      this.client.getBalance(this.partyId).catch(() => null),
    ]);

    // No active round — check if any of our pending bets settled
    if (round.status !== "active" || !round.round_number) {
      return;
    }

    // Already bet this round
    if (round.round_number === this.lastBetRound) {
      return;
    }

    // Update bet outcomes from history
    this.reconcileBets(historyRes.rounds);

    const balance = balRes?.balance ?? this.initialBalance;
    const history = historyRes.rounds.slice(0, this.historyDepth);

    // 2. Decide
    const ctx: TradeContext = {
      price,
      round,
      history,
      myBets: this.betHistory,
      balance,
      stats: { ...this.stats },
      config: this.config,
    };

    const decision = this.strategy(ctx);

    if (!decision) {
      this.stats.totalSkipped++;
      return;
    }

    // 3. Act
    try {
      const result = await this.client.placeBet(this.partyId, decision.direction, decision.amount);
      this.lastBetRound = round.round_number;
      this.stats.totalTrades++;

      // Track pending bet (outcome resolved on next tick)
      this.betHistory.unshift({
        roundNumber: round.round_number,
        direction: decision.direction,
        amount: decision.amount,
        won: false,   // pending
        pnl: -decision.amount, // assume loss until settled
      });

      const reason = decision.reason ? ` (${decision.reason})` : "";
      console.log(
        `[${this.name}] ${decision.direction} ${decision.amount.toFixed(8)} CBTC on round ${round.round_number}${reason}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.name}] Bet failed: ${msg}`);
    }
  }

  /** Match settled rounds against our pending bets and update stats. */
  private reconcileBets(settledRounds: RoundResult[]): void {
    const roundMap = new Map(settledRounds.map((r) => [r.round_number, r]));

    for (const bet of this.betHistory) {
      if (bet.pnl !== -bet.amount) continue; // already reconciled

      const round = roundMap.get(bet.roundNumber);
      if (!round) continue; // not settled yet

      const won = bet.direction === round.winning_direction;
      bet.won = won;

      if (won) {
        // Estimate payout: winner gets losing pool minus fees, proportional to bet
        const winPool = bet.direction === "UP" ? round.total_up_amount : round.total_down_amount;
        const losePool = bet.direction === "UP" ? round.total_down_amount : round.total_up_amount;
        const share = winPool > 0 ? bet.amount / winPool : 0;
        const gross = bet.amount + (losePool - round.fee_collected) * share;
        bet.pnl = gross - bet.amount;

        this.stats.totalWins++;
        this.stats.currentStreak = this.stats.currentStreak >= 0 ? this.stats.currentStreak + 1 : 1;
      } else {
        bet.pnl = -bet.amount;
        this.stats.totalLosses++;
        this.stats.currentStreak = this.stats.currentStreak <= 0 ? this.stats.currentStreak - 1 : -1;
      }

      this.stats.totalPnl += bet.pnl;
    }

    // Recalc derived stats
    const decided = this.stats.totalWins + this.stats.totalLosses;
    this.stats.winRate = decided > 0 ? this.stats.totalWins / decided : 0;
    this.stats.roi = this.initialBalance > 0 ? this.stats.totalPnl / this.initialBalance : 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
