/**
 * AgentFactory — creates and manages a fleet of trading agents.
 *
 * Usage:
 *   const factory = new AgentFactory("https://your-market.up.railway.app");
 *   factory.create({ name: "my-bot", partyId: "...", strategy: momentum });
 *   factory.startAll();
 */

import { MarketClient, type FirebaseAuth } from "./market-client.js";
import { Agent, type AgentConfig, type Strategy } from "./agent.js";

export interface FactoryConfig {
  baseUrl: string;
  authToken?: string;
  pollIntervalMs?: number;
}

export class AgentFactory {
  private client: MarketClient;
  private baseUrl: string;
  private agents = new Map<string, Agent>();
  private pollIntervalMs: number;

  constructor(config: FactoryConfig) {
    this.baseUrl = config.baseUrl;
    this.client = new MarketClient(config.baseUrl, config.authToken);
    this.pollIntervalMs = config.pollIntervalMs ?? 15_000;
  }

  /** Create an agent with optional per-agent Firebase auth. */
  create(cfg: AgentConfig & { firebaseAuth?: FirebaseAuth }): Agent {
    if (this.agents.has(cfg.name)) {
      throw new Error(`Agent "${cfg.name}" already exists`);
    }
    // If Firebase auth provided, create a per-agent client
    let client = this.client;
    if (cfg.firebaseAuth) {
      client = new MarketClient(this.baseUrl);
      client.setFirebaseAuth(cfg.firebaseAuth);
    }
    const agent = new Agent(client, cfg);
    this.agents.set(cfg.name, agent);
    return agent;
  }

  /** Create multiple agents from configs. */
  createMany(configs: AgentConfig[]): Agent[] {
    return configs.map((cfg) => this.create(cfg));
  }

  /** Start a single agent by name. */
  async start(name: string): Promise<void> {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`Agent "${name}" not found`);
    agent.start(this.pollIntervalMs); // fire and forget — runs in background
  }

  /** Start all registered agents. */
  async startAll(): Promise<void> {
    console.log(`\nStarting ${this.agents.size} agents against ${this.getBaseUrl()}...\n`);
    for (const [name, agent] of this.agents) {
      agent.start(this.pollIntervalMs);
    }
  }

  /** Stop a single agent. */
  stop(name: string): void {
    this.agents.get(name)?.stop();
  }

  /** Stop all agents. */
  stopAll(): void {
    for (const agent of this.agents.values()) {
      agent.stop();
    }
  }

  /** Get an agent by name. */
  get(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  /** List all agent names. */
  list(): string[] {
    return [...this.agents.keys()];
  }

  /** Print a stats table for all agents. */
  printStats(): void {
    console.log("\n--- Agent Stats ---");
    for (const [name, agent] of this.agents) {
      const s = agent.getStats();
      console.log(
        `${name.padEnd(20)} | ${s.totalTrades} trades | WR: ${(s.winRate * 100).toFixed(1)}% | PnL: ${s.totalPnl >= 0 ? "+" : ""}${s.totalPnl.toFixed(4)} | Streak: ${s.currentStreak}`,
      );
    }
    console.log();
  }

  /** Expose the client for direct API calls. */
  getClient(): MarketClient {
    return this.client;
  }

  private getBaseUrl(): string {
    return (this.client as any).baseUrl;
  }
}
