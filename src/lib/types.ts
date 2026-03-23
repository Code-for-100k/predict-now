// ── Shared types matching Zoro API doc shapes ──

import type { UserTier } from "../types/market.js";

export interface PoolWalletConfig {
  partyId: string;
  privateKey: string;
  publicKey: string;
}

export interface Config {
  baseUrl: string;
  apiKey: string;
  // Legacy single-pool fields (kept for CLI scripts + backward compat)
  senderPartyId: string;
  senderPrivateKey: string;
  senderPublicKey: string;
  instrumentId: string;
  instrumentAdmin: string;
  // Tier-based pool wallets
  poolWallets: Record<UserTier, PoolWalletConfig>;
}

// ── External Party Onboarding ──

export interface PrepareExternalPartyResponse {
  partyId: string;
  topologyTransactions: string[];
  multiHash: string;
  publicKeyFingerprint: string;
  publicKey: string;
}

export interface BroadcastExternalPartyRequest {
  signature: string;
  preparedParty: {
    partyId: string;
    topologyTransactions: string[];
    multiHash: string;
    publicKeyFingerprint: string;
  };
}

export interface BroadcastExternalPartyResponse {
  partyId: string;
  status: string;
}

// ── Prepare / Broadcast Transactions ──

export interface PreparedCommand {
  preparedTransaction: string;
  preparedTransactionHash: string;
  hashingSchemeVersion: string;
  hashingDetails?: Record<string, unknown>;
}

export interface PrepareResponse {
  commandId: string;
  command: PreparedCommand;
}

export interface BroadcastRequest {
  signature: string;
  publicKey: string;
  preparedTransaction: {
    commandId: string;
    activityMarkerIdentifier?: string;
    command: PreparedCommand;
  };
  partyId: string;
}

export interface BroadcastResponse {
  status: string;
  transactionId: string;
  updateId?: string;
  offset?: number;
}

// ── Send ──

export interface PrepareSendRequest {
  senderPartyId: string;
  receiverPartyId: string;
  amount: string;
  expiryDate: string;
  memo?: string;
  instrument: {
    id: string;
    admin: string;
  };
  registryChoiceContext?: ChoiceContextResponse;
}

// ── Balance ──

export interface BalanceResponse {
  balance: string;
  partyId: string;
  instruments: Array<{
    id: string;
    amount: string;
  }>;
}

// ── Pending Transfers ──

export interface PendingTransaction {
  contractId: string;
  amount: string;
  sender: string;
  instrumentId?: { id: string; admin: string };
}

export interface PendingTransactionsResponse {
  transactions: PendingTransaction[];
}

// ── Accept Transfer ──

export interface PrepareAcceptRequest {
  partyId: string;
  transferContractId: string;
  instrument: { id: string; admin: string };
}

// ── Transaction History ──

export interface TransactionHistoryEntry {
  updateId: string;
  offset: number;
  recordTime: string;
  type: "TransferIn" | "TransferOut" | "MergeSplit";
  choice: string;
  status: string;
  sender: string;
  receiver: string;
  amount: string;
  fees: string;
  instrumentId: { id: string; admin: string };
  requestedAt?: string;
  executeBefore?: string;
  memo?: string | null;
}

export interface TransactionHistoryResponse {
  count: number;
  transactions: TransactionHistoryEntry[];
}

// ── Choice Context ──

export interface ChoiceContextResponse {
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
