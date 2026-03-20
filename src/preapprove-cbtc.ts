/**
 * Set up transfer pre-approval for CBTC on the test party.
 */
import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import { broadcast } from "./lib/api.js";
import type { PrepareResponse } from "./lib/types.js";

// Mainnet CBTC instrument
const CBTC_INSTRUMENT = {
  id: "CBTC",
  admin: "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262",
};

async function main() {
  const config = loadConfig(true);

  console.log("=== CBTC Transfer Pre-Approval ===");
  console.log(`Party: ${config.senderPartyId}`);
  console.log(`Instrument: ${CBTC_INSTRUMENT.id} (${CBTC_INSTRUMENT.admin})\n`);

  // Prepare
  console.log("--- Prepare ---");
  const res = await fetch(
    `${config.baseUrl}/canton/transaction/prepare/transfer-preapproval`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        partyId: config.senderPartyId,
        instrument: CBTC_INSTRUMENT,
      }),
    }
  );

  const prepared = (await res.json()) as PrepareResponse & { error?: string; cysyncError?: string };
  console.log("Response:", JSON.stringify(prepared, null, 2));

  if (!res.ok || prepared.error || prepared.cysyncError) {
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
  console.log("\nStatus code:", (result as any).status?.code ?? result.status);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
