/**
 * Set up transfer pre-approval for the sender party.
 * This may be needed before the party can accept transfers.
 */
import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import { broadcast } from "./lib/api.js";
import type { PrepareResponse } from "./lib/types.js";

async function main() {
  const config = loadConfig(true);

  console.log("=== Transfer Pre-Approval ===");
  console.log(`Party: ${config.senderPartyId}\n`);

  // Step 1: Prepare transfer pre-approval
  console.log("--- Step 1: Prepare Transfer Pre-Approval ---");
  const url = `${config.baseUrl}/canton/transaction/prepare/transfer-preapproval`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      partyId: config.senderPartyId,
      instrument: {
        id: config.instrumentId,
        admin: config.instrumentAdmin,
      },
    }),
  });

  const prepared = (await res.json()) as PrepareResponse;
  console.log("Response:", JSON.stringify(prepared, null, 2));

  if (!res.ok) {
    throw new Error(`Prepare failed (${res.status}): ${JSON.stringify(prepared)}`);
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

  // Check pre-approval status
  console.log("\n--- Checking Pre-Approval Status ---");
  const statusRes = await fetch(
    `${config.baseUrl}/canton/wallet/transfer-preapproval-status`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        partyId: config.senderPartyId,
        instrument: {
          id: config.instrumentId,
          admin: config.instrumentAdmin,
        },
      }),
    }
  );
  const status = await statusRes.json();
  console.log("Pre-approval status:", JSON.stringify(status, null, 2));
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
