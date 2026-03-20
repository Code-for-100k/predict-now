/**
 * Onboard a new test party on the Canton network via the Zoro API.
 *
 * 1. Generates a fresh Ed25519 key pair
 * 2. Calls prepare/external-party with the public key
 * 3. Signs the multiHash with the private key
 * 4. Calls broadcast/external-party to register the party
 * 5. Prints the party ID and keys (copy into .env)
 */

import { loadConfig } from "./lib/config.js";
import { generateKeyPair, signHash } from "./lib/sign.js";
import { prepareExternalParty, broadcastExternalParty } from "./lib/api.js";

async function main() {
  console.log("=== Onboard New Test Party ===\n");

  const config = loadConfig(false); // don't require sender keys yet

  // 1. Generate key pair
  const keys = generateKeyPair();
  console.log("Generated Ed25519 key pair:");
  console.log("  Private key (base64):", keys.privateKey);
  console.log("  Public key  (base64):", keys.publicKey);

  // 2. Prepare external party
  console.log("\n--- Step 1: Prepare External Party ---");
  const prepared = await prepareExternalParty(config, keys.publicKey);

  // 3. Sign the multiHash
  console.log("\n--- Step 2: Sign multiHash ---");
  const signature = signHash(prepared.multiHash, keys.privateKey);
  console.log("Signature (base64):", signature);

  // 4. Broadcast
  console.log("\n--- Step 3: Broadcast External Party ---");
  const result = await broadcastExternalParty(config, signature, {
    partyId: prepared.partyId,
    topologyTransactions: prepared.topologyTransactions,
    multiHash: prepared.multiHash,
    publicKeyFingerprint: prepared.publicKeyFingerprint,
  });

  // 5. Print results
  console.log("\n=== SUCCESS ===");
  console.log("New Party ID:", result.partyId);
  console.log("\n--- Copy these into your .env file: ---");
  console.log(`SENDER_PARTY_ID=${result.partyId}`);
  console.log(`SENDER_PRIVATE_KEY=${keys.privateKey}`);
  console.log(`SENDER_PUBLIC_KEY=${keys.publicKey}`);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
