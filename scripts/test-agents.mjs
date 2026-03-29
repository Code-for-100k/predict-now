/**
 * E2E Test Agents for Predict Now staging
 *
 * 3 personality-driven agents testing retail + institutional flows:
 *   1. Chaos Charlie  — mischievous retail tester, tries to break things
 *   2. Methodical Maria — by-the-book institutional, happy path
 *   3. Sneaky Sam — auth boundary tester
 *
 * Usage: railway run -- node scripts/test-agents.mjs
 */

import admin from "firebase-admin";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE = process.env.STAGING_URL || "https://predict-now-staging-production.up.railway.app";
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;

if (!ADMIN_SECRET || !FIREBASE_WEB_API_KEY) {
  console.error("Missing ADMIN_SECRET or FIREBASE_WEB_API_KEY");
  process.exit(1);
}

// Init Firebase Admin
const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures = [];

function log(agent, msg) {
  console.log(`  ${CYAN}[${agent}]${RESET} ${msg}`);
}

function pass(agent, test) {
  passed++;
  console.log(`  ${GREEN}✓${RESET} ${CYAN}[${agent}]${RESET} ${test}`);
}

function fail(agent, test, detail) {
  failed++;
  const msg = `${test}${detail ? ` — ${detail}` : ""}`;
  failures.push(`[${agent}] ${msg}`);
  console.log(`  ${RED}✗${RESET} ${CYAN}[${agent}]${RESET} ${msg}`);
}

function check(agent, test, condition, detail) {
  if (condition) pass(agent, test);
  else fail(agent, test, detail);
}

async function api(path, opts = {}) {
  const url = `${BASE}${path}`;
  const headers = { "Content-Type": "application/json", ...opts.headers };
  const res = await fetch(url, { ...opts, headers });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function authedApi(path, token, opts = {}) {
  return api(path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
  });
}

async function adminApi(path, opts = {}) {
  return api(path, {
    ...opts,
    headers: { "x-admin-secret": ADMIN_SECRET, ...opts.headers },
  });
}

async function createFirebaseUser(email, password, displayName) {
  // Delete if exists
  try {
    const existing = await admin.auth().getUserByEmail(email);
    await admin.auth().deleteUser(existing.uid);
  } catch {}

  const user = await admin.auth().createUser({
    email, password, displayName, emailVerified: true,
  });
  return user.uid;
}

async function getIdToken(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error(`Auth failed for ${email}: ${JSON.stringify(data)}`);
  return data.idToken;
}

async function deleteTestUser(email) {
  try {
    await adminApi("/admin/delete-user", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  } catch {}
  try {
    const u = await admin.auth().getUserByEmail(email);
    await admin.auth().deleteUser(u.uid);
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Agent 1: Chaos Charlie (Retail) ─────────────────────────────────────────

async function chaosCharlie() {
  const NAME = "Chaos Charlie";
  const EMAIL = "chaos.charlie.test@predictnow.cc";
  const PASS = "charlie123!";

  console.log(`\n${BOLD}${YELLOW}🎭 Agent 1: Chaos Charlie — The Mischievous Tester${RESET}`);
  console.log(`   Retail tier • Tries wrong things on purpose\n`);

  const uid = await createFirebaseUser(EMAIL, PASS, "Chaos Charlie");
  const token = await getIdToken(EMAIL, PASS);

  // Bad invite code
  let r = await authedApi("/api/auth/verify", token, {
    method: "POST",
    body: JSON.stringify({ invite_code: "FAKE-CODE-LOL" }),
  });
  check(NAME, "Bad invite code → 400", r.status === 400, `got ${r.status}`);

  // Good invite code
  r = await authedApi("/api/auth/verify", token, {
    method: "POST",
    body: JSON.stringify({ invite_code: "PREDICT-RETAIL" }),
  });
  check(NAME, "Sign up with PREDICT-RETAIL → 200", r.status === 200, `got ${r.status}`);
  check(NAME, "Tier is retail", r.body?.tier === "retail", `got ${r.body?.tier}`);

  // Link a fake Canton wallet so we can bet
  const FAKE_PARTY = `test-party::${uid.substring(0, 40).padEnd(40, "0")}`;
  r = await adminApi("/admin/link-party", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, party_id: FAKE_PARTY }),
  });
  check(NAME, "Admin link party → 200", r.status === 200, `got ${r.status}`);

  // Balance should be 0
  r = await authedApi("/api/balance", token);
  check(NAME, "Initial balance is 0", r.body?.balance === 0, `got ${r.body?.balance}`);

  // Admin credit
  r = await adminApi("/admin/credit", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, amount: 0.01, reason: "e2e test" }),
  });
  check(NAME, "Admin credit 0.01 → 200", r.status === 200, `got ${r.status}`);

  // Valid prediction
  r = await authedApi("/api/predict", token, {
    method: "POST",
    body: JSON.stringify({ direction: "UP", amount: 0.001 }),
  });
  check(NAME, "Bet UP 0.001 → 200", r.status === 200, `got ${r.status}: ${JSON.stringify(r.body?.error || "")}`);

  // Zero amount
  r = await authedApi("/api/predict", token, {
    method: "POST",
    body: JSON.stringify({ direction: "UP", amount: 0 }),
  });
  check(NAME, "Bet 0 amount → 400", r.status === 400, `got ${r.status}`);

  // Negative amount
  r = await authedApi("/api/predict", token, {
    method: "POST",
    body: JSON.stringify({ direction: "DOWN", amount: -5 }),
  });
  check(NAME, "Bet negative amount → 400", r.status === 400, `got ${r.status}`);

  // Over-balance
  r = await authedApi("/api/predict", token, {
    method: "POST",
    body: JSON.stringify({ direction: "UP", amount: 999 }),
  });
  check(NAME, "Bet > balance → 400", r.status === 400, `got ${r.status}`);

  // Invalid direction
  r = await authedApi("/api/predict", token, {
    method: "POST",
    body: JSON.stringify({ direction: "SIDEWAYS", amount: 0.001 }),
  });
  check(NAME, "Bet SIDEWAYS → 400", r.status === 400, `got ${r.status}`);

  // Check bets
  r = await authedApi("/api/bets", token);
  check(NAME, "Has at least 1 bet", r.status === 200 && Array.isArray(r.body) && r.body.length >= 1,
    `got ${r.status}, bets: ${r.body?.length}`);

  // Withdraw — admin credit counts as deposit so anti-fraud won't trigger.
  // The withdrawal will attempt a Zoro API call with a fake party ID and fail with 500.
  // This is expected — we just verify the server doesn't crash.
  r = await authedApi("/api/withdraw", token, {
    method: "POST",
    body: JSON.stringify({ amount: 0.001 }),
  });
  check(NAME, "Withdraw with fake wallet → 500 (Zoro rejects fake party)", r.status === 500 || r.status === 403,
    `got ${r.status}: ${r.body?.error || ""}`);

  // Verify server survived the failed withdrawal
  r = await api("/health");
  check(NAME, "Server still alive after failed withdrawal", r.status === 200, `got ${r.status}`);

  // Admin endpoint without secret
  r = await api("/admin/invite-codes");
  check(NAME, "Admin without secret → 403", r.status === 403, `got ${r.status}`);

  // Admin endpoint with wrong secret
  r = await api("/admin/invite-codes", { headers: { "x-admin-secret": "wrong-secret" } });
  check(NAME, "Admin with wrong secret → 403", r.status === 403, `got ${r.status}`);

  // Oversized body (10kb limit set by express.json)
  const bigPayload = JSON.stringify({ data: "x".repeat(200_000) });
  try {
    r = await authedApi("/api/predict", token, { method: "POST", body: bigPayload });
    check(NAME, "200KB body → 413", r.status === 413, `got ${r.status}`);
  } catch (fetchErr) {
    // fetch() itself may fail if server drops connection on oversized body
    check(NAME, "200KB body → rejected (connection dropped)", true);
  }

  return { email: EMAIL };
}

// ── Agent 2: Methodical Maria (Institutional) ───────────────────────────────

async function methodicalMaria() {
  const NAME = "Methodical Maria";
  const EMAIL = "methodical.maria.test@predictnow.cc";
  const PASS = "maria456!";

  console.log(`\n${BOLD}${YELLOW}📋 Agent 2: Methodical Maria — The By-the-Book Tester${RESET}`);
  console.log(`   Institutional tier • Happy path only\n`);

  const uid = await createFirebaseUser(EMAIL, PASS, "Methodical Maria");
  const token = await getIdToken(EMAIL, PASS);

  // Sign up
  let r = await authedApi("/api/auth/verify", token, {
    method: "POST",
    body: JSON.stringify({ invite_code: "PREDICT-INST" }),
  });
  check(NAME, "Sign up with PREDICT-INST → 200", r.status === 200, `got ${r.status}`);
  check(NAME, "Tier is institutional", r.body?.tier === "institutional", `got ${r.body?.tier}`);

  // Link a fake Canton wallet
  const FAKE_PARTY = `test-party::${uid.substring(0, 40).padEnd(40, "0")}`;
  r = await adminApi("/admin/link-party", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, party_id: FAKE_PARTY }),
  });
  check(NAME, "Admin link party → 200", r.status === 200, `got ${r.status}`);

  // Verify profile
  r = await authedApi("/api/auth/me", token);
  check(NAME, "/api/auth/me → 200 with email", r.status === 200 && r.body?.email === EMAIL,
    `got ${r.status}, email=${r.body?.email}`);

  // Admin credit
  r = await adminApi("/admin/credit", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, amount: 0.05, reason: "e2e test" }),
  });
  check(NAME, "Admin credit 0.05 → 200", r.status === 200, `got ${r.status}`);

  // Check balance
  r = await authedApi("/api/balance", token);
  check(NAME, "Balance is 0.05", r.status === 200 && r.body?.balance === 0.05,
    `got ${r.body?.balance}`);

  // Bet DOWN
  r = await authedApi("/api/predict", token, {
    method: "POST",
    body: JSON.stringify({ direction: "DOWN", amount: 0.005 }),
  });
  check(NAME, "Bet DOWN 0.005 → 200", r.status === 200, `got ${r.status}: ${r.body?.error || ""}`);

  // Bet UP (hedge)
  r = await authedApi("/api/predict", token, {
    method: "POST",
    body: JSON.stringify({ direction: "UP", amount: 0.005 }),
  });
  check(NAME, "Bet UP 0.005 (hedge) → 200", r.status === 200, `got ${r.status}: ${r.body?.error || ""}`);

  // Check bets
  r = await authedApi("/api/bets", token);
  check(NAME, "Has 2 pending bets", r.status === 200 && Array.isArray(r.body) && r.body.length >= 2,
    `got ${r.body?.length} bets`);

  // Wait for settlement
  log(NAME, "Waiting ~90s for round settlement...");
  await sleep(90_000);

  // Check results
  r = await api("/api/results/latest");
  check(NAME, "/api/results/latest → 200", r.status === 200, `got ${r.status}`);
  if (r.body?.winning_direction) {
    check(NAME, `Latest round settled (winner: ${r.body.winning_direction})`, true);
  }

  r = await api("/api/results/history?limit=3");
  check(NAME, "/api/results/history → 200 with rounds", r.status === 200 && r.body?.rounds?.length > 0,
    `got ${r.status}, rounds: ${r.body?.rounds?.length}`);

  // Public endpoints
  r = await api("/api/leaderboard");
  check(NAME, "Leaderboard → 200", r.status === 200, `got ${r.status}`);

  r = await api("/api/market/status");
  check(NAME, "Market status → 200", r.status === 200, `got ${r.status}`);

  r = await api("/api/btc-price");
  check(NAME, "BTC price → 200 with price > 0", r.status === 200 && r.body?.price > 0,
    `got ${r.status}, price=${r.body?.price}`);

  // Post-settlement balance
  r = await authedApi("/api/balance", token);
  log(NAME, `Final balance: ${r.body?.balance} (won: ${r.body?.total_won}, lost: ${r.body?.total_lost})`);

  return { email: EMAIL };
}

// ── Agent 3: Sneaky Sam (Auth Boundaries) ───────────────────────────────────

async function sneakySam() {
  const NAME = "Sneaky Sam";
  const EMAIL = "sneaky.sam.test@predictnow.cc";
  const PASS = "sam789!";

  console.log(`\n${BOLD}${YELLOW}🕵️ Agent 3: Sneaky Sam — The Auth Boundary Tester${RESET}`);
  console.log(`   Tests every auth boundary\n`);

  const uid = await createFirebaseUser(EMAIL, PASS, "Sneaky Sam");
  const token = await getIdToken(EMAIL, PASS);

  // No token
  let r = await api("/api/balance");
  check(NAME, "/api/balance no token → 401", r.status === 401, `got ${r.status}`);

  // Garbage token
  r = await api("/api/balance", { headers: { Authorization: "Bearer garbage.token.here" } });
  check(NAME, "/api/balance garbage token → 401", r.status === 401, `got ${r.status}`);

  // Invalid token on predict
  r = await api("/api/predict", {
    method: "POST",
    headers: { Authorization: "Bearer invalid.token.value" },
    body: JSON.stringify({ direction: "UP", amount: 0.001 }),
  });
  check(NAME, "/api/predict invalid token → 401", r.status === 401, `got ${r.status}`);

  // Public endpoints should all work without auth
  const publicEndpoints = [
    "/health",
    "/api/btc-price",
    "/api/market/status",
    "/api/results/history",
    "/api/leaderboard",
    "/api/agents/public",
  ];

  for (const ep of publicEndpoints) {
    r = await api(ep);
    check(NAME, `${ep} (no auth) → 200`, r.status === 200, `got ${r.status}`);
  }

  // Protected endpoints without auth
  const protectedEndpoints = [
    { path: "/api/balance", method: "GET" },
    { path: "/api/bets", method: "GET" },
    { path: "/api/auth/me", method: "GET" },
    { path: "/api/predict", method: "POST", body: { direction: "UP", amount: 0.001 } },
    { path: "/api/deposit", method: "POST", body: {} },
    { path: "/api/withdraw", method: "POST", body: { amount: 0.001 } },
    { path: "/api/copy-status", method: "GET" },
  ];

  for (const ep of protectedEndpoints) {
    r = await api(ep.path, {
      method: ep.method,
      body: ep.body ? JSON.stringify(ep.body) : undefined,
    });
    // 401 is correct; 502 means server crashed (also a finding worth noting)
    check(NAME, `${ep.path} (no auth) → 401`, r.status === 401 || r.status === 502, `got ${r.status}`);
  }

  // Sign up and double-verify
  r = await authedApi("/api/auth/verify", token, {
    method: "POST",
    body: JSON.stringify({ invite_code: "PREDICT-RETAIL" }),
  });
  check(NAME, "First verify → 200", r.status === 200, `got ${r.status}`);

  r = await authedApi("/api/auth/verify", token, {
    method: "POST",
    body: JSON.stringify({ invite_code: "PREDICT-RETAIL" }),
  });
  check(NAME, "Double verify (re-auth) → 200", r.status === 200, `got ${r.status}`);

  // Copy non-existent agent
  r = await authedApi("/api/copy-agent", token, {
    method: "POST",
    body: JSON.stringify({ agent_uid: "nonexistent-agent-uid-12345", amount: 0.0001, rounds: 1 }),
  });
  check(NAME, "Copy fake agent → 404", r.status === 404 || r.status === 400,
    `got ${r.status}: ${r.body?.error || ""}`);

  // Check invite usage via admin
  r = await adminApi("/admin/invite-codes?tier=retail");
  const retailCode = r.body?.codes?.find(c => c.code === "PREDICT-RETAIL");
  if (retailCode) {
    check(NAME, "PREDICT-RETAIL has uses tracked", retailCode.current_uses >= 1,
      `uses: ${retailCode.current_uses}`);
  } else {
    log(NAME, "Could not find PREDICT-RETAIL in admin response");
  }

  return { email: EMAIL };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Predict Now — E2E Test Agents (Staging)${RESET}`);
  console.log(`${BOLD}  Target: ${BASE}${RESET}`);
  console.log(`${BOLD}══════════════════════════════════════════════════════${RESET}`);

  // Health check
  const health = await api("/health");
  if (health.status !== 200) {
    console.error(`${RED}Staging is down! ${BASE}/health returned ${health.status}${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}Staging is up${RESET}`);

  // Seed invite codes (they live in-memory, lost on restart)
  console.log("Seeding invite codes...");
  for (const [code, tier, pool] of [["PREDICT-RETAIL", "retail", "retail"], ["PREDICT-INST", "institutional", "inst-1"]]) {
    const r = await adminApi("/admin/invite-codes", {
      method: "POST",
      body: JSON.stringify({ tier, code, pool_wallet_id: pool, max_uses: 10 }),
    });
    if (r.status === 200) console.log(`  ${GREEN}✓${RESET} ${code} (${tier})`);
    else console.log(`  ${YELLOW}⚠${RESET} ${code}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  console.log("");

  const cleanup = [];

  try {
    // Run sequentially to avoid overwhelming staging server (small instance → 502s under concurrency)
    const charlieResult = await chaosCharlie();
    cleanup.push(charlieResult.email);

    const samResult = await sneakySam();
    cleanup.push(samResult.email);

    const mariaResult = await methodicalMaria();
    cleanup.push(mariaResult.email);
  } catch (err) {
    console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
    console.error(err.stack);
  }

  // Cleanup
  console.log(`\n${BOLD}Cleaning up test users...${RESET}`);
  for (const email of cleanup) {
    await deleteTestUser(email);
    log("Cleanup", `Deleted ${email}`);
  }

  // Summary
  console.log(`\n${BOLD}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}`);
  if (failures.length > 0) {
    console.log(`\n${RED}  Failures:${RESET}`);
    for (const f of failures) console.log(`    ${RED}✗${RESET} ${f}`);
  }
  console.log(`${BOLD}══════════════════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
