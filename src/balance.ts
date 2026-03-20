/**
 * Check the balance of a party.
 *
 * Usage:
 *   npx tsx src/balance.ts                    # uses SENDER_PARTY_ID from .env
 *   npx tsx src/balance.ts <partyId>          # checks a specific party
 */

import { loadConfig } from "./lib/config.js";
import { getBalance } from "./lib/api.js";

async function main() {
  const partyId = process.argv[2];

  // If a partyId is provided as arg, we only need base config
  // If not, we need the sender party ID from .env
  const config = loadConfig(!partyId);
  const targetPartyId = partyId || config.senderPartyId;

  console.log(`=== Balance Check ===`);
  console.log(`Party: ${targetPartyId}\n`);

  const balance = await getBalance(config, targetPartyId);

  console.log("\n=== Balance Summary ===");
  console.log(`Total balance: ${balance.balance}`);
  if (balance.instruments && balance.instruments.length > 0) {
    console.log("Instruments:");
    for (const inst of balance.instruments) {
      console.log(`  ${inst.id}: ${inst.amount}`);
    }
  } else {
    console.log("No instruments found.");
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
