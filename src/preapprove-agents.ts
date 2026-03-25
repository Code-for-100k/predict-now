/**
 * Set up CBTC transfer pre-approval for agent wallets.
 * This ensures inbound CBTC transfers auto-accept (required for YAC rewards).
 */

import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import * as fs from "fs";

const CBTC_INSTRUMENT = {
  id: "CBTC",
  admin: "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262",
};

const BATCH_PATH = "./wallets-batch.json";

interface BatchWallet {
  index: number;
  partyId: string;
  publicKey: string;
  privateKey: string;
}

async function post(config: any, path: string, body: any) {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function preapproveCBTC(config: any, wallet: BatchWallet): Promise<void> {
  console.log(`\n[Agent ${wallet.index}] ${wallet.partyId.substring(0, 30)}...`);

  // Step 1: Prepare transfer pre-approval
  console.log("  1. Preparing CBTC pre-approval...");
  const prepared = await post(config, "/canton/transaction/prepare/transfer-preapproval", {
    partyId: wallet.partyId,
    instrument: CBTC_INSTRUMENT,
  });

  // Step 2: Sign
  console.log("  2. Signing...");
  const signature = signHash(prepared.command.preparedTransactionHash, wallet.privateKey);

  // Step 3: Broadcast
  console.log("  3. Broadcasting...");
  const result = await post(config, "/canton/transaction/broadcast", {
    signature,
    publicKey: wallet.publicKey,
    preparedTransaction: {
      commandId: prepared.commandId,
      command: prepared.command,
    },
    partyId: wallet.partyId,
  });

  console.log(`  ✓ CBTC pre-approval done: ${result.status || "success"}`);
}

async function main() {
  const config = loadConfig(false);

  // Load agent wallets (first 3 from batch)
  const wallets: BatchWallet[] = JSON.parse(fs.readFileSync(BATCH_PATH, "utf-8"));
  const agents = wallets.slice(0, 3);

  console.log(`Setting up CBTC pre-approval for ${agents.length} agent wallets...`);

  for (const agent of agents) {
    try {
      await preapproveCBTC(config, agent);
    } catch (err: any) {
      console.error(`  ✗ Failed for agent ${agent.index}: ${err.message}`);
    }
    // Rate limit: wait 3s between wallets
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
