/**
 * DepositManager — polls agent wallets for inbound CBTC transfers,
 * accepts them, forwards to the institutional pool, and credits
 * the agent's internal market balance via the bot deposit endpoint.
 */

import { CantonClient, type PendingTransaction } from "./canton-client.js";
import { MarketClient } from "./market-client.js";

// ── Types ──

export interface AgentWallet {
  partyId: string;
  privateKey: string;
  publicKey: string;
}

export interface DepositManagerConfig {
  agents: AgentWallet[];
  poolPartyId: string;
  marketClient: MarketClient;
  cantonBaseUrl: string;
  cantonApiKey: string;
  instrumentId: string;
  instrumentAdmin: string;
  /** Polling interval in ms (default: 60_000). */
  pollIntervalMs?: number;
}

// ── Manager ──

export class DepositManager {
  private agents: AgentWallet[];
  private poolPartyId: string;
  private marketClient: MarketClient;
  private clients: Map<string, CantonClient> = new Map();
  private pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: DepositManagerConfig) {
    this.agents = config.agents;
    this.poolPartyId = config.poolPartyId;
    this.marketClient = config.marketClient;
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;

    // Create a CantonClient per agent wallet
    for (const agent of this.agents) {
      this.clients.set(
        agent.partyId,
        new CantonClient({
          baseUrl: config.cantonBaseUrl,
          apiKey: config.cantonApiKey,
          partyId: agent.partyId,
          privateKey: agent.privateKey,
          publicKey: agent.publicKey,
          instrumentId: config.instrumentId,
          instrumentAdmin: config.instrumentAdmin,
        }),
      );
    }
  }

  /** Start the polling loop. */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log(
      `[DepositManager] Started — polling ${this.agents.length} agent wallets every ${this.pollIntervalMs / 1000}s`,
    );

    // Run immediately, then on interval
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log("[DepositManager] Stopped");
  }

  // ── Core loop ──

  private async tick(): Promise<void> {
    for (const agent of this.agents) {
      try {
        await this.processAgent(agent);
      } catch (err) {
        console.error(
          `[DepositManager] Error processing agent ${agent.partyId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private async processAgent(agent: AgentWallet): Promise<void> {
    const client = this.clients.get(agent.partyId)!;

    // 1. Check for pending transfers
    let pending: PendingTransaction[];
    try {
      pending = await client.getPendingTransfers();
    } catch (err) {
      console.error(
        `[DepositManager] Failed to get pending transfers for ${agent.partyId}:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }

    // Filter for inbound transfers only (agent is the receiver, not sender)
    // The pending API returns both incoming and outgoing transfers
    // Also filter out expired transfers (past executeBefore date)
    const now = Date.now();
    const inbound = pending.filter((tx) => {
      if (tx.sender === agent.partyId) return false;
      if (tx.executeBefore && new Date(tx.executeBefore).getTime() < now) return false;
      return true;
    });

    if (inbound.length === 0) return;

    console.log(
      `[DepositManager] ${agent.partyId}: found ${inbound.length} inbound transfer(s) (${pending.length} total pending)`,
    );

    // 2. Accept each inbound transfer, forward to pool, credit internal balance
    for (const tx of inbound) {
      try {
        await this.processTransfer(agent, client, tx);
      } catch (err) {
        console.error(
          `[DepositManager] Failed to process transfer ${tx.contractId} for ${agent.partyId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private async processTransfer(
    agent: AgentWallet,
    client: CantonClient,
    tx: PendingTransaction,
  ): Promise<void> {
    const amount = parseFloat(tx.amount);
    const tag = `[DepositManager] ${agent.partyId}`;

    // Step 1: Accept the inbound transfer (use instrument from the transfer itself)
    const instrument = tx.instrumentId ?? { id: "CBTC", admin: "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262" };
    console.log(`${tag}: accepting transfer ${tx.contractId} (${tx.amount} CBTC from ${tx.sender}, instrument: ${instrument.id})`);
    const acceptResult = await client.acceptTransfer(tx.contractId, instrument);
    console.log(`${tag}: accepted — tx ${acceptResult.transactionId}`);

    // Step 2: Forward to institutional pool
    console.log(`${tag}: forwarding ${tx.amount} CBTC to pool ${this.poolPartyId}`);
    const sendResult = await client.send(this.poolPartyId, amount);
    console.log(`${tag}: forwarded — tx ${sendResult.transactionId}`);

    // Step 3: Credit the agent's internal market balance
    console.log(`${tag}: crediting ${amount} to internal balance via bot/deposit`);
    const depositResult = await this.marketClient.botDeposit(agent.partyId, amount);
    console.log(
      `${tag}: deposited — new balance: ${depositResult.balance}`,
    );
  }
}
