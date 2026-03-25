/**
 * Accept all pending CBTC transfers on inst-1 pool wallet.
 */
import { loadConfig } from "./lib/config.js";
import { signHash } from "./lib/sign.js";

const CBTC_INSTRUMENT = {
  id: "CBTC",
  admin: "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262",
};

async function post(config: any, path: string, body: any) {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} (${res.status}): ${(await res.text()).substring(0, 200)}`);
  return res.json();
}

async function main() {
  const config = loadConfig(false);
  const pool = config.poolWallets["inst-1"];
  if (!pool) throw new Error("inst-1 pool not configured");

  console.log(`Accepting pending transfers on inst-1: ${pool.partyId.substring(0, 30)}...`);

  const pending = await post(config, "/canton/transaction/history/pending", { partyId: pool.partyId });
  const txns = pending.transactions || [];
  console.log(`Pending: ${txns.length}`);

  let accepted = 0, failed = 0;
  for (const txn of txns) {
    try {
      const prepared = await post(config, "/canton/transaction/prepare/accept", {
        partyId: pool.partyId,
        transferContractId: txn.contractId,
        instrument: CBTC_INSTRUMENT,
      });
      const signature = signHash(prepared.command.preparedTransactionHash, pool.privateKey);
      await post(config, "/canton/transaction/broadcast", {
        signature,
        publicKey: pool.publicKey,
        preparedTransaction: { commandId: prepared.commandId, command: prepared.command },
        partyId: pool.partyId,
      });
      accepted++;
      console.log(`  ✓ Accepted ${txn.amount} CBTC from ${txn.sender.substring(0, 20)}...`);
    } catch (err: any) {
      failed++;
      console.error(`  ✗ Failed: ${err.message.substring(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  console.log(`\nDone. Accepted: ${accepted}, Failed: ${failed}`);
}

main().catch((err) => { console.error("FATAL:", err.message); process.exit(1); });
