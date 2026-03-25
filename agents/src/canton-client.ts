/**
 * CantonClient — typed wrapper around the Zoro Canton API for agent wallets.
 *
 * Handles prepare/sign/broadcast flows for accepting and sending CBTC.
 * Zero external HTTP dependencies — uses native fetch.
 * Ed25519 signing via @noble/ed25519 (same as server sign.ts).
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = sha512;

// ── Zoro API response types (subset needed for agent flows) ──

interface PreparedCommand {
  preparedTransaction: string;
  preparedTransactionHash: string;
  hashingSchemeVersion: string;
  hashingDetails?: Record<string, unknown>;
}

interface PrepareResponse {
  commandId: string;
  command: PreparedCommand;
}

interface BroadcastResponse {
  status: string;
  transactionId: string;
}

interface BalanceResponse {
  balance: string;
  partyId: string;
  instruments: Array<{
    id: string;
    amount: string;
  }>;
}

export interface PendingTransaction {
  contractId: string;
  amount: string;
  sender: string;
  receiver?: string;
  instrumentId?: { id: string; admin: string };
  executeBefore?: string;
  status?: string;
}

interface PendingTransactionsResponse {
  transactions: PendingTransaction[];
}

interface ChoiceContextResponse {
  factoryId: string;
  choiceContext: {
    choiceContextData: Record<string, unknown>;
    disclosedContracts: Array<{
      contractId: string;
      templateId: string;
      createdEventBlob: string;
      synchronizerId: string;
    }>;
  };
}

// ── Helpers ──

function signHash(hashBase64: string, privateKeyBase64: string): string {
  const hashBytes = Buffer.from(hashBase64, "base64");
  const privateKeyBytes = Buffer.from(privateKeyBase64, "base64");
  const signatureBytes = ed.sign(hashBytes, privateKeyBytes);
  return Buffer.from(signatureBytes).toString("base64");
}

// ── Client ──

export class CantonClient {
  private baseUrl: string;
  private apiKey: string;
  private partyId: string;
  private privateKey: string;
  private publicKey: string;
  private instrumentId: string;
  private instrumentAdmin: string;

  constructor(config: {
    baseUrl: string;
    apiKey: string;
    partyId: string;
    privateKey: string;
    publicKey: string;
    instrumentId: string;
    instrumentAdmin: string;
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.partyId = config.partyId;
    this.privateKey = config.privateKey;
    this.publicKey = config.publicKey;
    this.instrumentId = config.instrumentId;
    this.instrumentAdmin = config.instrumentAdmin;
  }

  // ── Public API ──

  /** Get pending inbound transfers for this wallet. */
  async getPendingTransfers(): Promise<PendingTransaction[]> {
    const res = await this.post<PendingTransactionsResponse>(
      "/canton/transaction/history/pending",
      { partyId: this.partyId },
    );
    return res.transactions;
  }

  /** Accept a pending transfer: prepare, sign, broadcast. */
  async acceptTransfer(
    contractId: string,
    instrument?: { id: string; admin: string },
  ): Promise<BroadcastResponse> {
    // 1. Prepare accept — use instrument from the transfer if provided
    const prepared = await this.post<PrepareResponse>(
      "/canton/transaction/prepare/accept",
      {
        partyId: this.partyId,
        transferContractId: contractId,
        instrument: instrument ?? {
          id: this.instrumentId,
          admin: this.instrumentAdmin,
        },
      },
    );

    // 2. Sign the prepared transaction hash
    const signature = signHash(
      prepared.command.preparedTransactionHash,
      this.privateKey,
    );

    // 3. Broadcast
    return this.broadcast(prepared, signature);
  }

  /** Send CBTC to another party: choice-context, prepare, sign, broadcast. */
  async send(
    receiverPartyId: string,
    amount: number,
  ): Promise<BroadcastResponse> {
    const amountStr = amount.toString();
    const expiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

    const instrument = {
      id: this.instrumentId,
      admin: this.instrumentAdmin,
    };

    // 1. Get choice context
    const choiceCtx = await this.post<ChoiceContextResponse>(
      "/canton/transaction/choice-context",
      {
        senderPartyId: this.partyId,
        receiverPartyId,
        amount: amountStr,
        expiryDate: expiry,
        instrument,
      },
    );

    // 2. Prepare send
    const prepared = await this.post<PrepareResponse>(
      "/canton/transaction/prepare/send",
      {
        senderPartyId: this.partyId,
        receiverPartyId,
        amount: amountStr,
        expiryDate: expiry,
        instrument,
        registryChoiceContext: choiceCtx,
      },
    );

    // 3. Sign
    const signature = signHash(
      prepared.command.preparedTransactionHash,
      this.privateKey,
    );

    // 4. Broadcast
    return this.broadcast(prepared, signature);
  }

  /** Get on-chain CBTC balance for this wallet. */
  async getBalance(): Promise<{ balance: number; raw: BalanceResponse }> {
    const res = await this.post<BalanceResponse>(
      "/canton/wallet/balance",
      { partyId: this.partyId },
    );
    return {
      balance: parseFloat(res.balance) || 0,
      raw: res,
    };
  }

  // ── Internal helpers ──

  private async broadcast(
    prepared: PrepareResponse,
    signature: string,
  ): Promise<BroadcastResponse> {
    return this.post<BroadcastResponse>(
      "/canton/transaction/broadcast",
      {
        signature,
        publicKey: this.publicKey,
        preparedTransaction: {
          commandId: prepared.commandId,
          command: prepared.command,
        },
        partyId: this.partyId,
      },
    );
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Canton API ${path} non-JSON response (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `Canton API error ${res.status} on ${path}: ${JSON.stringify(data, null, 2)}`,
      );
    }

    return data;
  }
}
