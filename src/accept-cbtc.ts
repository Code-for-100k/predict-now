/**
 * Accept a pending CBTC transfer.
 */
import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import { broadcast } from "./lib/api.js";
import type { PrepareResponse } from "./lib/types.js";

const CBTC_INSTRUMENT = {
  id: "CBTC",
  admin: "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262",
};

async function main() {
  const config = loadConfig(true);

  // Fetch pending transactions
  console.log("Fetching pending transactions...\n");
  const pendingRes = await fetch(
    `${config.baseUrl}/canton/transaction/history/pending`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ partyId: config.senderPartyId }),
    }
  );
  const pending = (await pendingRes.json()) as {
    transactions: Array<{ contractId: string; amount: string; sender: string; instrumentId?: any }>;
  };
  console.log("Pending:", JSON.stringify(pending, null, 2));

  if (!pending.transactions || pending.transactions.length === 0) {
    console.log("No pending transactions.");
    return;
  }

  // Find CBTC transfer
  const cbtcTx = pending.transactions.find(
    (tx) => tx.instrumentId?.id === "CBTC"
  ) || pending.transactions[0];

  console.log(`\nAccepting: ${cbtcTx.amount} from ${cbtcTx.sender}`);
  console.log(`Contract: ${cbtcTx.contractId}\n`);

  // Prepare accept with CBTC instrument
  console.log("--- Prepare Accept ---");
  const prepRes = await fetch(
    `${config.baseUrl}/canton/transaction/prepare/accept`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        partyId: config.senderPartyId,
        transferContractId: cbtcTx.contractId,
        instrument: CBTC_INSTRUMENT,
      }),
    }
  );

  const prepared = (await prepRes.json()) as PrepareResponse & { error?: string; cysyncError?: string };
  console.log("Response:", JSON.stringify(prepared, null, 2));

  if (!prepRes.ok || prepared.error || prepared.cysyncError) {
    throw new Error(`Prepare failed: ${JSON.stringify(prepared)}`);
  }

  // Sign
  console.log("\n--- Sign ---");
  const signature = signHash(prepared.command.preparedTransactionHash, config.senderPrivateKey);

  // Broadcast
  console.log("--- Broadcast ---");
  const result = await broadcast(config, {
    signature,
    publicKey: config.senderPublicKey,
    commandId: prepared.commandId,
    command: prepared.command,
    partyId: config.senderPartyId,
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));

  // Check balance
  console.log("\n--- Balance After ---");
  const balRes = await fetch(`${config.baseUrl}/canton/wallet/balance`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ partyId: config.senderPartyId }),
  });
  console.log("Balance:", JSON.stringify(await balRes.json(), null, 2));
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
