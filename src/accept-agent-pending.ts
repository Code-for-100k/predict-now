/**
 * Accept all pending CBTC transfers on agent wallets.
 */

import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";
import * as fs from "fs";

const CBTC_INSTRUMENT = {
  id: "CBTC",
  admin: "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262",
};

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
    throw new Error(`${path} (${res.status}): ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function acceptTransfer(config: any, wallet: BatchWallet, contractId: string): Promise<void> {
  // Prepare accept
  const prepared = await post(config, "/canton/transaction/prepare/accept", {
    partyId: wallet.partyId,
    transferContractId: contractId,
    instrument: CBTC_INSTRUMENT,
  });

  // Sign
  const signature = signHash(prepared.command.preparedTransactionHash, wallet.privateKey);

  // Broadcast
  await post(config, "/canton/transaction/broadcast", {
    signature,
    publicKey: wallet.publicKey,
    preparedTransaction: {
      commandId: prepared.commandId,
      command: prepared.command,
    },
    partyId: wallet.partyId,
  });
}

async function main() {
  const config = loadConfig(false);
  const wallets: BatchWallet[] = JSON.parse(fs.readFileSync("./wallets-batch.json", "utf-8"));
  const agents = wallets.slice(0, 3);

  let accepted = 0;
  let failed = 0;

  for (const agent of agents) {
    console.log(`\n[Agent ${agent.index}] ${agent.partyId.substring(0, 30)}...`);

    // Get pending transfers
    const pending = await post(config, "/canton/transaction/history/pending", {
      partyId: agent.partyId,
    });

    const txns = pending.transactions || [];
    console.log(`  Pending: ${txns.length}`);

    for (const txn of txns) {
      try {
        console.log(`  Accepting ${txn.amount} CBTC (${txn.contractId.substring(0, 20)}...)...`);
        await acceptTransfer(config, agent, txn.contractId);
        accepted++;
        console.log(`  ✓ Accepted`);
      } catch (err: any) {
        failed++;
        console.error(`  ✗ Failed: ${err.message.substring(0, 100)}`);
      }
      // Rate limit
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  console.log(`\nDone. Accepted: ${accepted}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
