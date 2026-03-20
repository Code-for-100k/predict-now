# Context: Programmatic CC & CBTC Transfers via Zoro API

## Who & What

BitSafe is an institutional-grade Bitcoin tokenization company on the Canton Network. It issues **CBTC** — a 1:1 wrapped Bitcoin token powered by Canton's decentralized party (DecParty) architecture. The Canton Network uses **CC (Canton Coin / Amulet)** as its native utility and gas token. BitSafe earns CC as profit-sharing rewards through its CBTC operations.

The business now needs to **move CC and CBTC programmatically** — not just through the Zoro consumer wallet app — to support automated workflows, settlements, and potential product builds on top of the Canton rails.

---

## The Problem Being Solved

Mayank (BitSafe) is exploring whether CC and CBTC can be sent and received entirely via API, without manual wallet interaction. The specific questions are:

1. **Can we control a Canton wallet purely through code?** (no passkey, no UI)
2. **What does it actually cost to send CC and CBTC on mainnet?** (fee structure)
3. **How does the full transaction lifecycle work?** (prepare → sign → broadcast)
4. **What are the operational constraints?** (rate limits, pre-approvals, instrument setup)

This is foundational work for any automated CC distribution, settlement engine, or product that transacts on Canton at scale.

---

## What Was Built

A TypeScript test harness at `/Users/mayank/Clawed/canton-send/` using the **Zoro Wallet API** (`https://dev-api.zorowallet.com`) — Zoro is OpenVector's API layer for the Canton Network, currently in beta but live on Canton mainnet.

The key insight enabling this: **you can't export the Ed25519 private key from a passkey-based wallet** (Mayank's Zoro wallet uses 1Password passkeys). So the solution was to **onboard a fresh API-controlled party** with its own generated Ed25519 keys, fund it from the main Zoro wallet, and use it as the programmatic sender.

The harness does the full lifecycle:
- **Onboard** a new Canton party via API (generates keys, registers on-chain)
- **Set up** the party for receiving (merge delegation + transfer pre-approval per instrument)
- **Send CC** with prepare → sign → broadcast
- **Send CBTC** with prepare → sign → broadcast
- **Check balances and pending transfers**
- **Log every API request and response** for fee inspection

---

## What Was Learned (Mainnet Findings)

| Operation | Network traffic | CC fee | USD cost (@$0.155/CC) |
|-----------|----------------|--------|----------------------|
| Send CC | ~9,253 units | ~0 CC | ~$0 |
| Send CBTC | ~27,302 units | ~3.02 CC | ~$0.47 |
| Transfer pre-approval | ~3,583 units | ~0 CC | ~$0 |
| Party onboarding | — | 0 CC | $0 |

Key findings:
- **CC-to-CC transfers are effectively free** at current mainnet pricing
- **CBTC sends cost ~$0.47 each** in CC network fees — deducted from CC balance, not CBTC
- **Fees are charged at send time** — rejecting an incoming transfer does NOT refund the fee to the sender
- **Pre-approval is per-instrument** — CC and CBTC require separate pre-approvals; without it, receivers get a pending offer requiring manual acceptance
- **Rate limit is 0.5 TPS** (Canton network caps total at 10 TPS; Zoro allocates 0.5 to this API key)
- The "dev" in `dev-api.zorowallet.com` refers to Zoro's API being in beta — these are **real mainnet Canton transactions**

---

## Technical Architecture (for reference)

The transaction signing model Canton uses:
1. **Prepare** — send intent to the API, receive a serialized transaction + hash
2. **Sign** — Ed25519 sign the hash client-side with the party's private key
3. **Broadcast** — submit signature + public key + prepared transaction back to the API

This means whoever controls the private key controls the wallet. The harness holds the private key in `.env` and signs locally using `@noble/ed25519`.

Both CC (instrument: `Amulet`) and CBTC have their own instrument identifiers on Canton. The DSO (Decentralized Synchronizer Operator — effectively Canton governance) controls the CC instrument. CBTC is administered by the `cbtc-network` party (BitSafe's decentralized party).

---

## What This Enables

With this harness working, BitSafe can:
- **Automate CC distributions** — e.g., programmatically send CC rewards to partners or customers
- **Build settlement infrastructure** — net CBTC/CC flows between parties without UI involvement
- **Model unit economics** — now has real fee data to price any product that transacts on Canton
- **Extend to other instruments** — any Canton asset following the same instrument model (USDxlr, uniBTC, etc.) can be sent with the same code, just swapping instrument details

The rate limit (0.5 TPS) is the main throughput constraint. At 0.5 TPS that's ~43,000 transactions/day — sufficient for most settlement and distribution use cases, not sufficient for high-frequency trading infrastructure.
