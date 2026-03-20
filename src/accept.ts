/**
 * Accept a pending transfer.
 *
 * Usage:
 *   npx tsx src/accept.ts                    # accepts the first pending transfer
 *   npx tsx src/accept.ts <contractId>       # accepts a specific transfer
 */
import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import { broadcast } from "./lib/api.js";
import type { PrepareResponse } from "./lib/types.js";

async function main() {
  const config = loadConfig(true);
  const contractId = process.argv[2];

  // If no contractId provided, fetch pending and use the first one
  let transferContractId = contractId;
  if (!transferContractId) {
    console.log("No contractId provided, fetching pending transactions...\n");
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
      transactions: Array<{ contractId: string; amount: string; sender: string }>;
    };

    if (!pending.transactions || pending.transactions.length === 0) {
      console.log("No pending transactions to accept.");
      return;
    }

    const tx = pending.transactions[0];
    transferContractId = tx.contractId;
    console.log(`Found pending transfer: ${tx.amount} CC from ${tx.sender}`);
  }

  console.log(`\nAccepting transfer: ${transferContractId}\n`);

  // Step 1: Prepare accept
  console.log("--- Step 1: Prepare Accept ---");
  const prepareUrl = `${config.baseUrl}/canton/transaction/prepare/accept`;
  const prepareRes = await fetch(prepareUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      partyId: config.senderPartyId,
      transferContractId,
      instrument: {
        id: config.instrumentId,
        admin: config.instrumentAdmin,
      },
    }),
  });

  const prepared = (await prepareRes.json()) as PrepareResponse;
  console.log("Prepare response:", JSON.stringify(prepared, null, 2));

  if (!prepareRes.ok) {
    throw new Error(`Prepare failed (${prepareRes.status}): ${JSON.stringify(prepared)}`);
  }

  // Step 2: Sign
  console.log("\n--- Step 2: Sign ---");
  const signature = signHash(
    prepared.command.preparedTransactionHash,
    config.senderPrivateKey
  );
  console.log("Signed.");

  // Step 3: Broadcast
  console.log("\n--- Step 3: Broadcast ---");
  const result = await broadcast(config, {
    signature,
    publicKey: config.senderPublicKey,
    commandId: prepared.commandId,
    command: prepared.command,
    partyId: config.senderPartyId,
  });

  console.log("\n=== RESULT ===");
  console.log("Status:", result.status);
  console.log("Transaction ID:", result.transactionId);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
