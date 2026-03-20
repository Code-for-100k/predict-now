/**
 * Send CBTC to a receiver party. Default: 10 CBTC.
 *
 * Usage:
 *   npx tsx src/send.ts <receiverPartyId>
 *   npx tsx src/send.ts                       # defaults to your existing Zoro wallet party
 *
 * Logs full API responses at every step so you can inspect fees.
 */

import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import { prepareSend, broadcast, getBalance } from "./lib/api.js";

const DEFAULT_RECEIVER =
  "237268376e::122034217581211f6d9fca5ef447aba2cb9302608dedb336a1f58339178a4cc36f43";

async function main() {
  const receiverPartyId = process.argv[2] || DEFAULT_RECEIVER;
  const amount = process.argv[3] || "10";

  const config = loadConfig(true); // requires sender keys

  console.log("=== Send CBTC via Zoro API ===");
  console.log(`From:   ${config.senderPartyId}`);
  console.log(`To:     ${receiverPartyId}`);
  console.log(`Amount: ${amount} CBTC`);
  console.log(`Instrument: ${config.instrumentId} (${config.instrumentAdmin})`);

  // Check balance before
  console.log("\n--- Balance BEFORE send ---");
  try {
    await getBalance(config, config.senderPartyId);
  } catch (e) {
    console.log("(Could not fetch balance:", (e as Error).message, ")");
  }

  // Step 1: Prepare send
  console.log("\n--- Step 1: Prepare Send ---");
  const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const prepared = await prepareSend(config, {
    senderPartyId: config.senderPartyId,
    receiverPartyId,
    amount,
    expiryDate,
    instrument: {
      id: config.instrumentId,
      admin: config.instrumentAdmin,
    },
  });

  console.log("\nCommand ID:", prepared.commandId);
  console.log(
    "Hashing scheme:",
    prepared.command.hashingSchemeVersion
  );

  // Step 2: Sign
  console.log("\n--- Step 2: Sign Transaction ---");
  const signature = signHash(
    prepared.command.preparedTransactionHash,
    config.senderPrivateKey
  );
  console.log("Signature (base64):", signature.slice(0, 40) + "...");

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

  // Check balance after
  console.log("\n--- Balance AFTER send ---");
  try {
    await getBalance(config, config.senderPartyId);
  } catch (e) {
    console.log("(Could not fetch balance:", (e as Error).message, ")");
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
