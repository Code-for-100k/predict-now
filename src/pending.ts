/**
 * Check pending transactions for a party.
 */
import { loadConfig } from "./lib/config.js";

async function main() {
  const config = loadConfig(true);
  const partyId = process.argv[2] || config.senderPartyId;

  console.log(`=== Pending Transactions ===`);
  console.log(`Party: ${partyId}\n`);

  const url = `${config.baseUrl}/canton/transaction/history/pending`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ partyId }),
  });

  const data = await res.json();
  console.log("Response:", JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
