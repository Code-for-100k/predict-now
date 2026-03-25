import type {
  Config,
  PrepareExternalPartyResponse,
  BroadcastExternalPartyResponse,
  PrepareResponse,
  BroadcastResponse,
  BalanceResponse,
  ChoiceContextResponse,
  PrepareSendRequest,
  PendingTransactionsResponse,
  TransactionHistoryResponse,
} from "./types.js";

// ── Helpers ──

/** Redact sensitive fields from objects before logging */
function redactForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitive = ["privateKey", "signature", "publicKey", "apiKey"];
  const redacted = { ...obj };
  for (const key of Object.keys(redacted)) {
    if (sensitive.some((s) => key.toLowerCase().includes(s.toLowerCase()))) {
      redacted[key] = "[REDACTED]";
    }
    if (typeof redacted[key] === "object" && redacted[key] !== null) {
      redacted[key] = redactForLog(redacted[key] as Record<string, unknown>);
    }
  }
  return redacted;
}

const LOG_API = process.env.LOG_API_CALLS === "true"; // default: no logging (set LOG_API_CALLS=true to enable)

async function post<T>(
  config: Config,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const url = `${config.baseUrl}${path}`;

  if (LOG_API) {
    console.log(`\n── POST ${path} ──`);
    console.log("Request:", JSON.stringify(redactForLog(body), null, 2));
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    console.error(`API ${path} non-JSON response (${res.status}):`, text.slice(0, 200));
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (LOG_API) {
    console.log(`Response (${res.status}):`, JSON.stringify(data, null, 2));
  }

  if (!res.ok) {
    throw new Error(
      `API error ${res.status} on ${path}: ${JSON.stringify(data, null, 2)}`
    );
  }

  return data;
}

// ── External Party Onboarding ──

export async function prepareExternalParty(
  config: Config,
  publicKey: string
): Promise<PrepareExternalPartyResponse> {
  return post<PrepareExternalPartyResponse>(
    config,
    "/canton/transaction/prepare/external-party",
    { publicKey }
  );
}

export async function broadcastExternalParty(
  config: Config,
  signature: string,
  preparedParty: {
    partyId: string;
    topologyTransactions: string[];
    multiHash: string;
    publicKeyFingerprint: string;
  }
): Promise<BroadcastExternalPartyResponse> {
  return post<BroadcastExternalPartyResponse>(
    config,
    "/canton/transaction/broadcast/external-party",
    { signature, preparedParty }
  );
}

// ── Send ──

export async function prepareSend(
  config: Config,
  params: PrepareSendRequest
): Promise<PrepareResponse> {
  return post<PrepareResponse>(
    config,
    "/canton/transaction/prepare/send",
    params as unknown as Record<string, unknown>
  );
}

export async function broadcast(
  config: Config,
  params: {
    signature: string;
    publicKey: string;
    commandId: string;
    command: {
      preparedTransaction: string;
      preparedTransactionHash: string;
      hashingSchemeVersion: string;
    };
    partyId: string;
  }
): Promise<BroadcastResponse> {
  return post<BroadcastResponse>(config, "/canton/transaction/broadcast", {
    signature: params.signature,
    publicKey: params.publicKey,
    preparedTransaction: {
      commandId: params.commandId,
      command: params.command,
    },
    partyId: params.partyId,
  });
}

// ── Gas Measurement ──

/** Get the CC (Amulet) balance for a party — used to measure gas before/after operations */
export async function getCCBalance(config: Config, partyId: string): Promise<number> {
  try {
    const bal = await getBalance(config, partyId);
    // Handle both response formats
    const balances = (bal as any).balances || {};
    return parseFloat(balances.Amulet || balances.amulet || "0");
  } catch {
    return 0;
  }
}

// ── Balance ──

export async function getBalance(
  config: Config,
  partyId: string,
  node?: "openvector" | "cypherock"
): Promise<BalanceResponse> {
  const body: Record<string, unknown> = { partyId };
  if (node) body.node = node;
  return post<BalanceResponse>(config, "/canton/wallet/balance", body);
}

// ── Pending Transfers ──

export async function getPendingTransfers(
  config: Config,
  partyId: string
): Promise<PendingTransactionsResponse> {
  return post<PendingTransactionsResponse>(
    config,
    "/canton/transaction/history/pending",
    { partyId }
  );
}

// ── Accept Transfer ──

export async function prepareAccept(
  config: Config,
  params: {
    partyId: string;
    transferContractId: string;
    instrument: { id: string; admin: string };
  }
): Promise<PrepareResponse> {
  return post<PrepareResponse>(
    config,
    "/canton/transaction/prepare/accept",
    params as unknown as Record<string, unknown>
  );
}

// ── Transaction History ──

export async function getTransactionHistory(
  config: Config,
  partyId: string,
  beginOffset?: number
): Promise<TransactionHistoryResponse> {
  const params: Record<string, unknown> = { partyId };
  if (beginOffset !== undefined && beginOffset > 0) {
    params.beginOffset = beginOffset;
  }
  return post<TransactionHistoryResponse>(
    config,
    "/canton/transaction/history",
    params
  );
}

// ── Choice Context ──

export async function getChoiceContext(
  config: Config,
  params: {
    senderPartyId: string;
    receiverPartyId: string;
    amount: string;
    expiryDate: string;
    instrument: { id: string; admin: string };
  }
): Promise<ChoiceContextResponse> {
  return post<ChoiceContextResponse>(
    config,
    "/canton/transaction/choice-context",
    params as unknown as Record<string, unknown>
  );
}
