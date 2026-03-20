import { loadConfig } from "./lib/config.js";

async function main() {
  const config = loadConfig(true);

  const res = await fetch(
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
  console.log("Pre-approval status:", JSON.stringify(await res.json(), null, 2));
}

main().catch(console.error);
