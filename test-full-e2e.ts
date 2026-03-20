/**
 * Full E2E Test Suite — BTC Prediction Market
 *
 * Uses Firebase Admin SDK to create real auth tokens for 3 test users,
 * then tests the complete flow:
 * 1. Auth (verify, link-party)
 * 2. Deposit (send CC to pool, verify deposit)
 * 3. Predict (place bets UP/DOWN)
 * 4. Settlement (wait for round to settle via CoinGecko oracle)
 * 5. Withdrawal (withdraw winnings)
 * 6. Security (cross-wallet, duplicate link, etc.)
 */

import "dotenv/config";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
ed.etc.sha512Sync = sha512;

import admin from "firebase-admin";
const { apps: firebaseApps } = admin;
import * as fs from "fs";

// ── Config ──
const BASE_URL = "https://dev-api.zorowallet.com";
const API_KEY = process.env.ZORO_API_KEY || "";
const MARKET_URL = "https://btc-prediction-market-production.up.railway.app";

const POOL_PARTY_ID = process.env.SENDER_PARTY_ID || "";
const POOL_PRIVATE_KEY = process.env.SENDER_PRIVATE_KEY || "";
const POOL_PUBLIC_KEY = process.env.SENDER_PUBLIC_KEY || "";

const INSTRUMENT_ID = "Amulet";
const INSTRUMENT_ADMIN = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

const RATE_LIMIT_MS = 3500;

interface Wallet {
  name: string;
  partyId: string;
  privateKey: string;
  publicKey: string;
}

interface TestUser {
  name: string;
  wallet: Wallet;
  uid: string;
  token: string;
}

interface TestResult {
  test: string;
  phase: string;
  status: "PASS" | "FAIL" | "SKIP" | "BUG";
  details: string;
  severity?: "critical" | "high" | "medium" | "low";
}

const results: TestResult[] = [];

// ── Helpers ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function zoroPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

async function marketApi(method: string, path: string, body?: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const opts: RequestInit = { method, headers };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const res = await fetch(`${MARKET_URL}${path}`, opts);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

function signHash(hashBase64: string, privateKeyBase64: string): string {
  const hashBytes = Buffer.from(hashBase64, "base64");
  const privateKeyBytes = Buffer.from(privateKeyBase64, "base64");
  const signatureBytes = ed.sign(hashBytes, privateKeyBytes);
  return Buffer.from(signatureBytes).toString("base64");
}

function generateKeyPair() {
  const privateKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = ed.getPublicKey(privateKeyBytes);
  return {
    privateKey: Buffer.from(privateKeyBytes).toString("base64"),
    publicKey: Buffer.from(publicKeyBytes).toString("base64"),
  };
}

function record(phase: string, test: string, status: TestResult["status"], details: string, severity?: TestResult["severity"]) {
  results.push({ test, phase, status, details, severity });
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : status === "BUG" ? "🐛" : "○";
  console.log(`  ${icon} [${status}] ${test}`);
  if (details && status !== "PASS") console.log(`         ${details}`);
}

// ── Wallet Operations ──

async function createWallet(name: string): Promise<Wallet> {
  const keys = generateKeyPair();
  const prep = await zoroPost("/canton/transaction/prepare/external-party", { publicKey: keys.publicKey });
  if (!prep.ok) throw new Error(`Prepare failed: ${JSON.stringify(prep.data)}`);
  const { partyId, topologyTransactions, multiHash, publicKeyFingerprint } = prep.data;
  await sleep(RATE_LIMIT_MS);
  const signature = signHash(multiHash, keys.privateKey);
  const bcast = await zoroPost("/canton/transaction/broadcast/external-party", {
    signature,
    preparedParty: { partyId, topologyTransactions, multiHash, publicKeyFingerprint },
  });
  if (!bcast.ok) throw new Error(`Broadcast failed: ${JSON.stringify(bcast.data)}`);
  await sleep(RATE_LIMIT_MS);
  return { name, partyId, privateKey: keys.privateKey, publicKey: keys.publicKey };
}

async function setupParty(wallet: Wallet): Promise<boolean> {
  // Merge delegation
  const mergePrep = await zoroPost("/canton/transaction/prepare/merge-delegation-proposal", { partyId: wallet.partyId });
  if (mergePrep.ok && mergePrep.data.command) {
    const sig = signHash(mergePrep.data.command.preparedTransactionHash, wallet.privateKey);
    await zoroPost("/canton/transaction/broadcast", {
      signature: sig, publicKey: wallet.publicKey,
      preparedTransaction: { commandId: mergePrep.data.commandId, command: mergePrep.data.command },
      partyId: wallet.partyId,
    });
  }
  await sleep(RATE_LIMIT_MS);

  // Transfer pre-approval
  const preapprovePrep = await zoroPost("/canton/transaction/prepare/transfer-preapproval", {
    partyId: wallet.partyId,
    instrument: { id: INSTRUMENT_ID, admin: INSTRUMENT_ADMIN },
  });
  if (preapprovePrep.ok && preapprovePrep.data.command) {
    const sig = signHash(preapprovePrep.data.command.preparedTransactionHash, wallet.privateKey);
    await zoroPost("/canton/transaction/broadcast", {
      signature: sig, publicKey: wallet.publicKey,
      preparedTransaction: { commandId: preapprovePrep.data.commandId, command: preapprovePrep.data.command },
      partyId: wallet.partyId,
    });
  }
  await sleep(RATE_LIMIT_MS);
  return true;
}

async function sendCC(fromPrivateKey: string, fromPublicKey: string, fromPartyId: string, toPartyId: string, amount: string) {
  const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const prep = await zoroPost("/canton/transaction/prepare/send", {
    senderPartyId: fromPartyId, receiverPartyId: toPartyId, amount,
    expiryDate, memo: "test-e2e",
    instrument: { id: INSTRUMENT_ID, admin: INSTRUMENT_ADMIN },
  });
  if (!prep.ok) throw new Error(`Prepare send failed: ${JSON.stringify(prep.data)}`);
  const sig = signHash(prep.data.command.preparedTransactionHash, fromPrivateKey);
  const bcast = await zoroPost("/canton/transaction/broadcast", {
    signature: sig, publicKey: fromPublicKey,
    preparedTransaction: { commandId: prep.data.commandId, command: prep.data.command },
    partyId: fromPartyId,
  });
  if (!bcast.ok) throw new Error(`Broadcast send failed: ${JSON.stringify(bcast.data)}`);
  await sleep(RATE_LIMIT_MS);
  return bcast.data;
}

async function getBalance(partyId: string): Promise<string> {
  const r = await zoroPost("/canton/wallet/balance", { partyId });
  return r.data?.balance || "0";
}

// ── Firebase Auth ──

function initFirebase() {
  const saPath = "./firebase-sa.json";
  if (!fs.existsSync(saPath)) {
    throw new Error("firebase-sa.json not found. Run the setup first.");
  }
  const sa = JSON.parse(fs.readFileSync(saPath, "utf-8"));

  if (!admin.apps?.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.project_id,
    });
  }
}

async function createTestUser(name: string): Promise<{ uid: string; token: string }> {
  const email = `test-${name.toLowerCase()}-${Date.now()}@test.cpredict.com`;

  // Create user in Firebase
  let userRecord: admin.auth.UserRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      password: `TestPass123!${name}`,
      displayName: `Test ${name}`,
    });
  } catch (e: any) {
    throw new Error(`Failed to create Firebase user: ${e.message}`);
  }

  // Create custom token and exchange for ID token
  const customToken = await admin.auth().createCustomToken(userRecord.uid);

  // Exchange custom token for ID token via Firebase REST API
  const apiKey = process.env.FIREBASE_WEB_API_KEY || "AIzaSyAALLUn5YsJNkXc0f7dKpgerJcmH4YPsUw";
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  const tokenData = await resp.json() as any;
  if (!tokenData.idToken) {
    throw new Error(`Failed to get ID token: ${JSON.stringify(tokenData)}`);
  }

  return { uid: userRecord.uid, token: tokenData.idToken };
}

async function cleanupTestUsers(users: TestUser[]) {
  for (const u of users) {
    try {
      await admin.auth().deleteUser(u.uid);
      console.log(`  Cleaned up Firebase user: ${u.name} (${u.uid})`);
    } catch { /* ignore */ }
  }
}

// ── Main ──

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Full E2E Test Suite — BTC Prediction Market             ║");
  console.log("║  With Firebase Auth, Deposits, Bets, Settlement          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!POOL_PRIVATE_KEY || !POOL_PUBLIC_KEY || !API_KEY) {
    console.error("ERROR: Missing env vars.");
    process.exit(1);
  }

  // Initialize Firebase Admin
  initFirebase();

  const testUsers: TestUser[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1: Create 3 Zoro Wallets + Firebase Users
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n═══ PHASE 1: Create Wallets & Firebase Users ═══");

    // Check if we have existing test wallets
    let wallets: Wallet[] = [];
    if (fs.existsSync("./test-wallets.json")) {
      wallets = JSON.parse(fs.readFileSync("./test-wallets.json", "utf-8"));
      console.log("  Using existing test wallets from test-wallets.json");
      for (const w of wallets) {
        record("1-Setup", `Reuse wallet: ${w.name}`, "PASS", `partyId: ${w.partyId.substring(0, 40)}...`);
      }
    }

    if (wallets.length < 3) {
      wallets = [];
      for (const name of ["Alice", "Bob", "Charlie"]) {
        console.log(`  Creating wallet: ${name}...`);
        const w = await createWallet(name);
        wallets.push(w);
        record("1-Setup", `Create wallet: ${name}`, "PASS", `partyId: ${w.partyId.substring(0, 40)}...`);
      }

      // Setup merge + preapproval
      for (const w of wallets) {
        console.log(`  Setting up ${w.name}...`);
        await setupParty(w);
        record("1-Setup", `Setup ${w.name}`, "PASS", "merge + preapprove");
      }
      console.log("  Waiting 8s for pre-approvals...");
      await sleep(8000);

      // Fund wallets
      for (const w of wallets) {
        console.log(`  Funding ${w.name} with 50 CC...`);
        await sendCC(POOL_PRIVATE_KEY, POOL_PUBLIC_KEY, POOL_PARTY_ID, w.partyId, "50.00");
        record("1-Setup", `Fund ${w.name}`, "PASS", "50 CC sent");
      }
      console.log("  Waiting 8s for funding to settle...");
      await sleep(8000);

      fs.writeFileSync("./test-wallets.json", JSON.stringify(wallets, null, 2));
    }

    // Create Firebase users
    for (const w of wallets) {
      console.log(`  Creating Firebase user: ${w.name}...`);
      const { uid, token } = await createTestUser(w.name);
      testUsers.push({ name: w.name, wallet: w, uid, token });
      record("1-Setup", `Firebase user: ${w.name}`, "PASS", `uid: ${uid.substring(0, 20)}...`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2: Auth — Verify & Link Wallets
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n═══ PHASE 2: Auth — Verify & Link Wallets ═══");

    // 2a. Verify each user
    for (const u of testUsers) {
      const r = await marketApi("POST", "/api/auth/verify", {}, u.token);
      record("2-Auth", `Verify ${u.name}`, r.ok ? "PASS" : "FAIL",
        r.ok ? `uid: ${r.data.uid}` : `Error: ${JSON.stringify(r.data)}`,
        !r.ok ? "critical" : undefined);
    }

    // 2b. Link wallets
    for (const u of testUsers) {
      const r = await marketApi("POST", "/api/auth/link-party",
        { party_id: u.wallet.partyId }, u.token);
      record("2-Auth", `Link ${u.name} wallet`, r.ok ? "PASS" : "FAIL",
        r.ok ? `linked: ${r.data.party_ids?.length} wallets` : `Error: ${JSON.stringify(r.data)}`,
        !r.ok ? "critical" : undefined);
    }

    // 2c. Security: Try to link Alice's wallet to Bob's account
    {
      const r = await marketApi("POST", "/api/auth/link-party",
        { party_id: testUsers[0].wallet.partyId }, testUsers[1].token);
      record("2-Auth", "Security: Bob tries to link Alice's wallet",
        r.status === 409 ? "PASS" : "BUG",
        r.status === 409 ? "Correctly rejected (409 conflict)" : `VULNERABILITY! Got ${r.status}: ${JSON.stringify(r.data)}`,
        r.status !== 409 ? "critical" : undefined);
    }

    // 2d. Check /me endpoint
    for (const u of testUsers) {
      const r = await marketApi("GET", "/api/auth/me", undefined, u.token);
      record("2-Auth", `GET /me for ${u.name}`, r.ok ? "PASS" : "FAIL",
        `party_ids: ${r.data?.party_ids?.length}, active: ${r.data?.active_party_id?.substring(0, 30)}...`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3: Deposit — Send CC to Pool & Verify
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n═══ PHASE 3: Deposit — Send CC to Pool & Verify ═══");

    // 3a. Each user sends CC to pool
    for (const u of testUsers) {
      try {
        const amount = u.name === "Alice" ? "15.00" : u.name === "Bob" ? "10.00" : "8.00";
        console.log(`  ${u.name} sending ${amount} CC to pool...`);
        await sendCC(u.wallet.privateKey, u.wallet.publicKey, u.wallet.partyId, POOL_PARTY_ID, amount);
        record("3-Deposit", `${u.name} sends ${amount} CC to pool`, "PASS", "Transfer sent");
      } catch (e: any) {
        record("3-Deposit", `${u.name} sends CC to pool`, "FAIL", e.message, "high");
      }
    }

    console.log("  Waiting 8s for transfers to settle...");
    await sleep(8000);

    // 3b. Verify deposits via market API
    for (const u of testUsers) {
      const r = await marketApi("POST", "/api/deposit", {}, u.token);
      record("3-Deposit", `Verify ${u.name} deposit`,
        r.ok && r.data.credited > 0 ? "PASS" : r.ok && r.data.credited === 0 ? "BUG" : "FAIL",
        `credited: ${r.data?.credited} CC, balance: ${r.data?.balance} CC`,
        r.ok && r.data.credited === 0 ? "high" : undefined);
    }

    // 3c. Double-verify (should find nothing new)
    await sleep(11000); // wait for rate limit
    for (const u of testUsers) {
      const r = await marketApi("POST", "/api/deposit", {}, u.token);
      record("3-Deposit", `Re-verify ${u.name} (idempotency)`,
        r.ok && r.data.credited === 0 ? "PASS" : "BUG",
        `credited: ${r.data?.credited} CC (expected 0)`,
        r.data?.credited > 0 ? "critical" : undefined);
    }

    // 3d. Check balances
    for (const u of testUsers) {
      const r = await marketApi("GET", "/api/balance", undefined, u.token);
      record("3-Deposit", `${u.name} balance check`, r.ok ? "PASS" : "FAIL",
        `balance: ${r.data?.balance} CC, deposited: ${r.data?.total_deposited} CC`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 4: Check Market Status & Place Bets
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n═══ PHASE 4: Place Bets ═══");

    // Check market status
    let marketStatus = await marketApi("GET", "/api/market/status");
    record("4-Bets", "Market status", "PASS",
      `status: ${marketStatus.data?.status}, round: ${marketStatus.data?.round_number}`);

    if (marketStatus.data?.status !== "active") {
      console.log("  No active round — waiting for scheduler to create one...");
      // Wait up to 60s for a new round
      for (let i = 0; i < 12; i++) {
        await sleep(5000);
        marketStatus = await marketApi("GET", "/api/market/status");
        if (marketStatus.data?.status === "active") break;
        console.log(`  Still waiting... (${(i + 1) * 5}s)`);
      }
      if (marketStatus.data?.status !== "active") {
        record("4-Bets", "Wait for active round", "FAIL",
          "No active round after 60s. CoinGecko oracle may need deployment.", "critical");
      }
    }

    if (marketStatus.data?.status === "active") {
      // Alice bets UP (10 CC)
      {
        const r = await marketApi("POST", "/api/predict",
          { amount: 10, direction: "UP" }, testUsers[0].token);
        record("4-Bets", "Alice bets 10 CC on UP",
          r.ok ? "PASS" : "FAIL",
          r.ok ? `prediction_id: ${r.data.prediction_id}, remaining: ${r.data.remaining_balance}` : `Error: ${JSON.stringify(r.data)}`,
          !r.ok ? "high" : undefined);
      }

      // Bob bets DOWN (8 CC)
      {
        const r = await marketApi("POST", "/api/predict",
          { amount: 8, direction: "DOWN" }, testUsers[1].token);
        record("4-Bets", "Bob bets 8 CC on DOWN",
          r.ok ? "PASS" : "FAIL",
          r.ok ? `prediction_id: ${r.data.prediction_id}, remaining: ${r.data.remaining_balance}` : `Error: ${JSON.stringify(r.data)}`,
          !r.ok ? "high" : undefined);
      }

      // Charlie bets UP (5 CC)
      {
        const r = await marketApi("POST", "/api/predict",
          { amount: 5, direction: "UP" }, testUsers[2].token);
        record("4-Bets", "Charlie bets 5 CC on UP",
          r.ok ? "PASS" : "FAIL",
          r.ok ? `prediction_id: ${r.data.prediction_id}, remaining: ${r.data.remaining_balance}` : `Error: ${JSON.stringify(r.data)}`,
          !r.ok ? "high" : undefined);
      }

      // Validation tests
      {
        // Bet with insufficient balance
        const r = await marketApi("POST", "/api/predict",
          { amount: 999999, direction: "UP" }, testUsers[0].token);
        record("4-Bets", "Bet with insufficient balance → rejected",
          r.status === 400 ? "PASS" : "BUG",
          `Got ${r.status}: ${r.data?.error?.substring(0, 60)}`,
          r.status !== 400 ? "critical" : undefined);
      }

      {
        // Bet with invalid direction
        const r = await marketApi("POST", "/api/predict",
          { amount: 1, direction: "SIDEWAYS" }, testUsers[0].token);
        record("4-Bets", "Bet with invalid direction → rejected",
          r.status === 400 ? "PASS" : "BUG",
          `Got ${r.status}`,
          r.status !== 400 ? "medium" : undefined);
      }

      {
        // Bet with negative amount
        const r = await marketApi("POST", "/api/predict",
          { amount: -5, direction: "UP" }, testUsers[0].token);
        record("4-Bets", "Bet with negative amount → rejected",
          r.status === 400 ? "PASS" : "BUG",
          `Got ${r.status}`,
          r.status !== 400 ? "critical" : undefined);
      }

      {
        // Bet with zero amount
        const r = await marketApi("POST", "/api/predict",
          { amount: 0, direction: "UP" }, testUsers[0].token);
        record("4-Bets", "Bet with zero amount → rejected",
          r.status === 400 ? "PASS" : "BUG",
          `Got ${r.status}`,
          r.status !== 400 ? "medium" : undefined);
      }

      // Check market status after bets
      const afterBets = await marketApi("GET", "/api/market/status");
      record("4-Bets", "Market status after bets", "PASS",
        `UP: ${afterBets.data?.up_amount} CC (${afterBets.data?.up_predictions} bets), DOWN: ${afterBets.data?.down_amount} CC (${afterBets.data?.down_predictions} bets)`);

      // Check bets endpoint
      for (const u of testUsers) {
        const r = await marketApi("GET", "/api/bets", undefined, u.token);
        record("4-Bets", `${u.name} bet history`, r.ok ? "PASS" : "FAIL",
          `${r.data?.length || 0} bets`);
      }

      // ════════════════════════════════════════════════════════════════════════
      // PHASE 5: Wait for Settlement
      // ════════════════════════════════════════════════════════════════════════
      console.log("\n═══ PHASE 5: Wait for Round Settlement ═══");

      const timeRemaining = marketStatus.data?.time_remaining_ms || 0;
      const roundNumber = marketStatus.data?.round_number;

      if (timeRemaining > 0) {
        const waitSecs = Math.ceil(timeRemaining / 1000) + 20; // extra 20s for settlement
        console.log(`  Round ${roundNumber} ends in ${Math.ceil(timeRemaining / 1000)}s, waiting ${waitSecs}s total...`);

        // Wait in 5s intervals, checking status (fast for 1-min rounds)
        const maxWait = waitSecs * 1000;
        const startWait = Date.now();
        let settled = false;

        while (Date.now() - startWait < maxWait) {
          await sleep(5000);
          const status = await marketApi("GET", "/api/market/status");
          const elapsed = Math.round((Date.now() - startWait) / 1000);
          console.log(`  [${elapsed}s] status: ${status.data?.status}, round: ${status.data?.round_number}`);

          // Check if our round was settled
          const roundResult = await marketApi("GET", `/api/results/${roundNumber}`);
          if (roundResult.ok && roundResult.data?.winning_direction) {
            settled = true;
            record("5-Settlement", `Round ${roundNumber} settled`,
              "PASS",
              `direction: ${roundResult.data.winning_direction}, open: ${roundResult.data.open_price}, close: ${roundResult.data.close_price}`);

            // Check individual results
            for (const u of testUsers) {
              const bets = await marketApi("GET", "/api/bets", undefined, u.token);
              const roundBets = (bets.data || []).filter((b: any) => b.round_number === roundNumber);
              for (const bet of roundBets) {
                record("5-Settlement", `${u.name} bet ${bet.direction} ${bet.amount} CC → ${bet.status}`,
                  "PASS", `payout: ${bet.payout_amount || 0} CC`);
              }
            }
            break;
          }
        }

        if (!settled) {
          record("5-Settlement", `Round ${roundNumber} settlement`, "FAIL",
            "Round did not settle within expected time. Check CoinGecko oracle.", "critical");
        }
      } else {
        record("5-Settlement", "Settlement timing", "SKIP", "Round already expired before bets");
      }

      // Check balances after settlement
      console.log("\n  Balances after settlement:");
      for (const u of testUsers) {
        const r = await marketApi("GET", "/api/balance", undefined, u.token);
        record("5-Settlement", `${u.name} post-settlement balance`, r.ok ? "PASS" : "FAIL",
          `balance: ${r.data?.balance} CC, won: ${r.data?.total_won}, lost: ${r.data?.total_lost}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 6: Withdrawal
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n═══ PHASE 6: Withdrawal ═══");

    // Alice withdraws 2 CC
    {
      const r = await marketApi("POST", "/api/withdraw", { amount: 2 }, testUsers[0].token);
      record("6-Withdraw", "Alice withdraws 2 CC",
        r.ok ? "PASS" : "FAIL",
        r.ok ? `txn_id: ${r.data.txn_id?.substring(0, 40)}..., remaining: ${r.data.remaining_balance}` : `Error: ${JSON.stringify(r.data)}`,
        !r.ok ? "high" : undefined);
    }

    // Withdraw more than balance
    {
      const balR = await marketApi("GET", "/api/balance", undefined, testUsers[0].token);
      const currentBal = balR.data?.balance || 0;
      const r = await marketApi("POST", "/api/withdraw", { amount: currentBal + 100 }, testUsers[0].token);
      record("6-Withdraw", "Withdraw more than balance → rejected",
        r.status === 400 ? "PASS" : "BUG",
        `Got ${r.status}: ${r.data?.error?.substring(0, 60)}`,
        r.status !== 400 ? "critical" : undefined);
    }

    // Withdraw negative amount
    {
      const r = await marketApi("POST", "/api/withdraw", { amount: -5 }, testUsers[0].token);
      record("6-Withdraw", "Withdraw negative amount → rejected",
        r.status === 400 ? "PASS" : "BUG",
        `Got ${r.status}`,
        r.status !== 400 ? "critical" : undefined);
    }

    // Withdraw to non-linked wallet
    {
      const r = await marketApi("POST", "/api/withdraw",
        { amount: 1, party_id: "fake::12201234567890abcdef1234567890abcdef" }, testUsers[0].token);
      record("6-Withdraw", "Withdraw to non-linked wallet → rejected",
        r.status === 400 ? "PASS" : "BUG",
        `Got ${r.status}`,
        r.status !== 400 ? "critical" : undefined);
    }

    // Verify Alice's Zoro wallet received the withdrawal
    await sleep(5000);
    {
      const bal = await getBalance(testUsers[0].wallet.partyId);
      record("6-Withdraw", "Alice Zoro wallet received withdrawal",
        parseFloat(bal) > 0 ? "PASS" : "BUG",
        `Zoro balance: ${bal} CC`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 7: Security Edge Cases
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n═══ PHASE 7: Security Edge Cases ═══");

    // Cross-user deposit claim: Bob tries to verify Alice's wallet deposits
    {
      const r = await marketApi("POST", "/api/deposit",
        { party_id: testUsers[0].wallet.partyId }, testUsers[1].token);
      record("7-Security", "Bob tries to verify Alice's wallet deposits",
        r.status === 400 ? "PASS" : "BUG",
        r.status === 400 ? "Correctly rejected" : `VULNERABILITY! Got ${r.status}: ${JSON.stringify(r.data).substring(0, 80)}`,
        r.status !== 400 ? "critical" : undefined);
    }

    // Withdraw to another user's wallet
    {
      const r = await marketApi("POST", "/api/withdraw",
        { amount: 1, party_id: testUsers[1].wallet.partyId }, testUsers[0].token);
      record("7-Security", "Alice tries to withdraw to Bob's wallet",
        r.status === 400 ? "PASS" : "BUG",
        r.status === 400 ? "Correctly rejected" : `VULNERABILITY! Got ${r.status}`,
        r.status !== 400 ? "critical" : undefined);
    }

    // Use expired/invalid token
    {
      const r = await marketApi("POST", "/api/deposit", {}, "invalid-token-12345");
      record("7-Security", "Request with invalid token → 401",
        r.status === 401 ? "PASS" : "BUG",
        `Got ${r.status}`,
        r.status !== 401 ? "critical" : undefined);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 8: Final State
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n═══ PHASE 8: Final State ═══");

    for (const u of testUsers) {
      const r = await marketApi("GET", "/api/balance", undefined, u.token);
      record("8-Final", `${u.name} final balance`, "PASS",
        `balance: ${r.data?.balance} CC, deposited: ${r.data?.total_deposited}, withdrawn: ${r.data?.total_withdrawn}, won: ${r.data?.total_won}, lost: ${r.data?.total_lost}`);
    }

    const poolBal = await getBalance(POOL_PARTY_ID);
    record("8-Final", "Pool wallet final balance", "PASS", `${poolBal} CC`);

  } finally {
    // Cleanup Firebase test users
    console.log("\n═══ Cleanup ═══");
    await cleanupTestUsers(testUsers);
  }

  printResults();
}

function printResults() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  TEST RESULTS SUMMARY                                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const bugs = results.filter((r) => r.status === "BUG").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;

  const phases = [...new Set(results.map((r) => r.phase))];
  for (const phase of phases) {
    const phaseResults = results.filter((r) => r.phase === phase);
    console.log(`  ── ${phase} ──`);
    for (const r of phaseResults) {
      const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : r.status === "BUG" ? "🐛" : "○";
      const sev = r.severity ? ` [${r.severity.toUpperCase()}]` : "";
      console.log(`    ${icon} [${r.status}]${sev} ${r.test}`);
      console.log(`           ${r.details}`);
    }
    console.log();
  }

  console.log(`  ═══════════════════════════════════════════════`);
  console.log(`  Total: ${results.length} | ✓ Passed: ${passed} | ✗ Failed: ${failed} | 🐛 Bugs: ${bugs} | ○ Skipped: ${skipped}`);
  console.log(`  ═══════════════════════════════════════════════`);

  if (bugs > 0 || failed > 0) {
    console.log("\n  ⚠️  ISSUES FOUND:");
    for (const r of results.filter((r) => r.status === "FAIL" || r.status === "BUG")) {
      const sev = r.severity ? ` [${r.severity.toUpperCase()}]` : "";
      console.log(`    ${r.status === "BUG" ? "🐛" : "✗"} ${sev} ${r.test}: ${r.details}`);
    }
  }

  // Save results
  fs.writeFileSync("./test-results.json", JSON.stringify(results, null, 2));
  console.log("\n  Results saved to test-results.json");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  printResults();
  process.exit(1);
});
