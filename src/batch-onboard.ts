/**
 * Batch onboard 45 new Canton parties via Zoro API.
 * Rate limit: 5 per minute, so we batch in groups of 5 with 65s pauses.
 */

import { loadConfig } from "./lib/config.js";
import { generateKeyPair, signHash } from "./lib/sign.js";
import { prepareExternalParty, broadcastExternalParty } from "./lib/api.js";
import * as fs from "fs";

const TOTAL = 45;
const BATCH_SIZE = 5;
const PAUSE_BETWEEN_BATCHES_MS = 65_000; // 65 seconds between batches of 5
const PAUSE_BETWEEN_WALLETS_MS = 3_000;  // 3 seconds between individual wallets

interface WalletRecord {
  index: number;
  partyId: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

async function onboardOne(config: any, index: number): Promise<WalletRecord> {
  const keys = generateKeyPair();

  const prepared = await prepareExternalParty(config, keys.publicKey);
  const signature = signHash(prepared.multiHash, keys.privateKey);

  const result = await broadcastExternalParty(config, signature, {
    partyId: prepared.partyId,
    topologyTransactions: prepared.topologyTransactions,
    multiHash: prepared.multiHash,
    publicKeyFingerprint: prepared.publicKeyFingerprint,
  });

  return {
    index,
    partyId: result.partyId,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    createdAt: new Date().toISOString(),
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const config = loadConfig(false);
  const wallets: WalletRecord[] = [];
  const outputFile = "wallets-batch.json";

  // Load existing if resuming
  if (fs.existsSync(outputFile)) {
    const existing = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
    wallets.push(...existing);
    console.log(`Resuming from ${wallets.length} existing wallets`);
  }

  const remaining = TOTAL - wallets.length;
  if (remaining <= 0) {
    console.log(`Already have ${wallets.length} wallets. Done.`);
    return;
  }

  console.log(`Creating ${remaining} wallets in batches of ${BATCH_SIZE}...\n`);

  let created = 0;
  for (let i = wallets.length; i < TOTAL; i++) {
    const batchPosition = created % BATCH_SIZE;

    // Pause between batches
    if (created > 0 && batchPosition === 0) {
      console.log(`\n--- Batch pause (65s to respect rate limit) ---`);
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }

    try {
      console.log(`[${i + 1}/${TOTAL}] Onboarding wallet...`);
      const wallet = await onboardOne(config, i + 1);
      wallets.push(wallet);
      console.log(`  ✓ ${wallet.partyId.substring(0, 20)}...`);

      // Save after each successful creation
      fs.writeFileSync(outputFile, JSON.stringify(wallets, null, 2));
      created++;

      // Small pause between individual wallets
      if (i < TOTAL - 1) {
        await sleep(PAUSE_BETWEEN_WALLETS_MS);
      }
    } catch (err: any) {
      console.error(`  ✗ Failed wallet ${i + 1}: ${err.message}`);
      console.log("  Saving progress and waiting 30s before retry...");
      fs.writeFileSync(outputFile, JSON.stringify(wallets, null, 2));
      await sleep(30_000);
      i--; // retry this index
    }
  }

  console.log(`\n=== COMPLETE: ${wallets.length} wallets created ===`);
  console.log(`Saved to ${outputFile}`);

  // Print summary table
  console.log("\n| # | Party ID | Public Key |");
  console.log("|---|----------|------------|");
  for (const w of wallets) {
    console.log(`| ${w.index} | ${w.partyId.substring(0, 30)}... | ${w.publicKey.substring(0, 20)}... |`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
