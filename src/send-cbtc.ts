/**
 * Send CBTC back to your Zoro wallet. Logs full responses for fee inspection.
 */
import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import { broadcast } from "./lib/api.js";
import type { PrepareResponse } from "./lib/types.js";

const CBTC_INSTRUMENT = {
  id: "CBTC",
  admin: "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262",
};

const DEFAULT_RECEIVER =
  "237268376e::122034217581211f6d9fca5ef447aba2cb9302608dedb336a1f58339178a4cc36f43";

async function main() {
  const config = loadConfig(true);
  const receiverPartyId = process.argv[2] || DEFAULT_RECEIVER;
  const amount = process.argv[3] || "0.0001074721"; // send back what we received

  console.log("=== Send CBTC via Zoro API ===");
  console.log(`From:   ${config.senderPartyId}`);
  console.log(`To:     ${receiverPartyId}`);
  console.log(`Amount: ${amount} CBTC\n`);

  // Balance before
  console.log("--- Balance BEFORE ---");
  const balBefore = await fetch(`${config.baseUrl}/canton/wallet/balance`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ partyId: config.senderPartyId }),
  });
  const balBeforeData = await balBefore.json();
  console.log(JSON.stringify(balBeforeData, null, 2));

  // Prepare send
  console.log("\n--- Step 1: Prepare Send ---");
  const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const prepRes = await fetch(`${config.baseUrl}/canton/transaction/prepare/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      senderPartyId: config.senderPartyId,
      receiverPartyId,
      amount,
      expiryDate,
      instrument: CBTC_INSTRUMENT,
    }),
  });

  const prepared = (await prepRes.json()) as PrepareResponse & { error?: string; cysyncError?: string };
  console.log("Response:", JSON.stringify(prepared, null, 2));

  if (!prepRes.ok || prepared.error || prepared.cysyncError) {
    throw new Error(`Prepare failed: ${JSON.stringify(prepared)}`);
  }

  // Sign
  console.log("\n--- Step 2: Sign ---");
  const signature = signHash(prepared.command.preparedTransactionHash, config.senderPrivateKey);
  console.log("Signed.");

  // Broadcast
  console.log("\n--- Step 3: Broadcast ---");
  const result = await broadcast(config, {
    signature,
    publicKey: config.senderPublicKey,
    commandId: prepared.commandId,
    command: prepared.command,
    partyId: config.senderPartyId,
  });

  console.log("\n=== RESULT ===");
  console.log("Status code:", (result as any).status?.code ?? result.status);

  // Balance after
  console.log("\n--- Balance AFTER ---");
  const balAfter = await fetch(`${config.baseUrl}/canton/wallet/balance`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ partyId: config.senderPartyId }),
  });
  const balAfterData = await balAfter.json();
  console.log(JSON.stringify(balAfterData, null, 2));
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
