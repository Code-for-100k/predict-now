/**
 * Full party setup: merge delegation + transfer pre-approval.
 * Run this after onboarding to make the party ready to transact.
 */
import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import { broadcast } from "./lib/api.js";
import type { PrepareResponse } from "./lib/types.js";

async function prepareAndBroadcast(config: ReturnType<typeof loadConfig>, path: string, body: Record<string, unknown>, label: string) {
  console.log(`\n=== ${label} ===`);

  // Prepare
  console.log("--- Prepare ---");
  const prepRes = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const prepared = (await prepRes.json()) as PrepareResponse & { error?: string; cysyncError?: string };
  console.log("Response:", JSON.stringify(prepared, null, 2));

  if (!prepRes.ok || prepared.error || prepared.cysyncError) {
    console.log(`SKIPPED ${label}: ${prepared.error || prepared.cysyncError || `HTTP ${prepRes.status}`}`);
    return null;
  }

  // Sign
  console.log("--- Sign ---");
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

  console.log("Result:", JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const config = loadConfig(true);
  console.log(`Setting up party: ${config.senderPartyId}`);

  // 1. Merge delegation proposal
  await prepareAndBroadcast(
    config,
    "/canton/transaction/prepare/merge-delegation-proposal",
    { partyId: config.senderPartyId },
    "Merge Delegation Proposal"
  );

  // Small delay between transactions (0.5 TPS limit)
  console.log("\nWaiting 3s for rate limit...");
  await new Promise((r) => setTimeout(r, 3000));

  // 2. Transfer pre-approval
  await prepareAndBroadcast(
    config,
    "/canton/transaction/prepare/transfer-preapproval",
    {
      partyId: config.senderPartyId,
      instrument: { id: config.instrumentId, admin: config.instrumentAdmin },
    },
    "Transfer Pre-Approval"
  );

  // Wait and check status
  console.log("\nWaiting 5s then checking status...");
  await new Promise((r) => setTimeout(r, 5000));

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
        instrument: { id: config.instrumentId, admin: config.instrumentAdmin },
      }),
    }
  );
  console.log("\nPre-approval status:", JSON.stringify(await statusRes.json(), null, 2));

  // Check balance
  console.log("\nChecking balance...");
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
