# ChiyaPay — Build Plan

## Context

ChiyaPay is a hackathon submission for a beginner Solana mini-hack (Kathmandu): a
USDC checkout for a Nepali tea stall with **two payment doors**:
1. **Human door** — Solana Pay QR code, scanned with a wallet (Phantom).
2. **Agent door** — API returns HTTP 402 with payment details; an agent script pays
   devnet USDC programmatically, retries with the tx signature, order confirmed.

Constraints (from CLAUDE.md, non-negotiable): devnet only, never mainnet/real funds;
no secrets in repo (`.env` local + `.env.example` committed); server-side on-chain
verification mandatory for the agent door; small/readable code a beginner can explain
to a judge; working demo beats extra features.

Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals), verified
via Circle docs (https://developers.circle.com/stablecoins/docs/usdc-on-testing-networks).
Fallback if faucet is dry: self-mint a 6-decimal SPL token and note it in the README.

## File tree (as few files as possible)

```
chiyapay/
├── package.json      # deps + scripts: dev, agent, setup
├── .env.example      # RPC_URL, MERCHANT_PUBKEY, USDC_MINT, PRICE_USDC, PORT (committed)
├── .env              # real values, gitignored (never committed)
├── .gitignore        # .env, wallet*.json, node_modules
├── README.md         # run both demos in <5 min (M6)
├── PLAN.md           # this plan
├── src/
│   ├── config.js     # loads .env, exports connection + constants; USDC decimals math
│   ├── solana.js     # shared helpers: encodeURL, findReference, transfer, replay set
│   ├── server.js     # Express: GET / (shop), POST /api/order (402), GET /api/order/:id (poll)
│   ├── verify.js     # server-side on-chain tx verification (all checks) — no client trust
│   ├── agent.js      # `npm run agent`: 402 → pay → retry w/ sig → print explorer link
│   └── setup.js      # `npm run setup`: keygen/airdrop guidance + create merchant ATA
└── public/
    └── index.html    # shop page + QR render + poll loop → "Order confirmed ☕"
```

Orders + used-signatures kept **in-memory** (Map/Set) — no database.

## Build order (each milestone independently testable)

**M1 — Shop page renders** ✅ DONE
- Done when: `npm run dev` serves index.html showing item, price, Pay button (no chain yet).
- Prove: `npm run dev`; `curl -s localhost:$PORT | grep -i chiya` returns the page.
- Proof: server logs `ChiyaPay shop running: http://localhost:3000 (devnet)`;
  `curl localhost:3000/api/config` → `{"item":{"name":"Nepali Milk Chiya","emoji":"☕"},"priceUsdc":0.1,"network":"devnet"}`;
  `curl localhost:3000/ | grep -i chiya` returns the page. Review: PASS (no blockers).

**M2 — Solana Pay QR end-to-end (human door)** ⏳ CODE COMPLETE + REVIEW: PASS — confirmed-payment step PENDING devnet funding
- Done when: Pay → POST /api/order → fresh reference Keypair + Solana Pay URL → QR renders;
  real Phantom (devnet) payment flips page to "Order confirmed ☕".
- Prove: `npm run dev`, scan with Phantom-on-devnet, pay; page text becomes confirmed.
- Built: src/solana.js (buildPaymentUrl/findPayment/confirmPayment), src/setup.js,
  POST /api/order + GET /api/order/:id, QR + poll UI, qrcode dep. solana-reviewer: PASS
  (applied fix: maxSupportedTransactionVersion:0 on validateTransfer).
- Proven headlessly: POST /api/order → valid URL
  `solana:<merchant>?amount=0.1&spl-token=4zMMC9…DncDU&reference=<key>&label=ChiyaPay&message=…`
  + data:image/png QR; poll → `{"status":"pending"}` (real findReference call); unknown → 404.
- NOT yet proven: the "confirmed" flip + validateTransfer reject-path — BLOCKED because
  devnet airdrop faucets (public + Helius) are rate-limited/dry and real devnet USDC needs
  Circle's web faucet. Finish by: (a) user pays via Phantom-on-devnet after `npm run setup`
  (needs SOL+USDC funded), or (b) re-run the scripted-payment proof when faucets recover.
  DO NOT mark ✅ until a real devnet tx confirms an order.

**M3 — /api/order returns a correct 402 (agent contract)** ✅ DONE
- Done when: agent request returns HTTP 402 JSON `{recipient, amount, mint,
  network:"devnet", reference, retryHeader:"X-Payment-Signature"}`.
- Prove: `curl -i -X POST localhost:$PORT/api/order -H 'X-Agent: 1'` → first line HTTP 402.
- Proof: `HTTP/1.1 402 Payment Required` with all fields present —
  `orderId✓ recipient✓ amount=0.1 decimals=6 mint✓ network=devnet reference✓
  retryHeader=X-Payment-Signature retryUrl=/api/order/<id>/pay`. Human door (no
  header) still returns 200 + Solana Pay URL + QR. solana-reviewer: PASS (added
  decimals + retryUrl per its suggestions). No on-chain payment needed for M3.
- Note: M4 must implement `POST /api/order/:orderId/pay` (verify X-Payment-Signature on-chain).

**M4 — Server-side tx verification** ⏳ CODE COMPLETE + REVIEW: PASS — confirm/underpay/replay paths PENDING devnet funding
- Done when: verify.js checks (1) tx exists / no `meta.err`; (2) recipient token-balance
  delta ≥ price AND mint matches; (3) blockTime within ~10 min; (4) signature not reused.
  Fail → 402 + reason.
- Prove: known-good sig → confirmed; reused/wrong-amount sig → 402 with reason.
- Built: src/verify.js (verifyPayment — 5 checks incl. reference binding + atomic replay
  claim); POST /api/order/:orderId/pay (verifies X-Payment-Signature on-chain, 402+reason
  on fail, idempotent confirm, 404 unknown). solana-reviewer: PASS (fixed a concurrent-replay
  TOCTOU blocker; added v0 ALT loadedAddresses handling).
- Proven headlessly against REAL devnet reads: no-sig → 402 "missing header"; garbage sig →
  402 "transaction not found"; a real recent (1–8s old) unrelated devnet tx → 402 "no USDC
  transfer to the merchant" (this exercises checks 1–4 on real chain data); unknown order → 404.
- NOT yet proven: known-good → confirmed, underpay → 402, on-chain replay → 402 — all need a
  real ≥0.1 USDC payment TO the merchant, BLOCKED (devnet airdrop faucets dry, Circle USDC
  faucet is web-only). Finish when faucets recover / a wallet is funded. DO NOT mark ✅ until
  a real payment confirms an order and a reused/underpaid sig is rejected on-chain.

**M5 — Agent script full flow** ⏳ CODE COMPLETE + REVIEW: PASS — full pay→confirm PENDING devnet funding
- Done when: `npm run agent` does 402 → send USDC transfer (create ATA if needed) →
  resubmit with X-Payment-Signature → confirmed → prints
  `explorer.solana.com/tx/<sig>?cluster=devnet`.
- Prove: `npm run agent` exits 0 and prints a resolving devnet explorer link.
- Built: src/agent.js — loads/creates a gitignored payer keypair, POSTs /api/order
  (X-Agent) → parses the 402 invoice → builds a transferChecked of 0.1 USDC to the
  merchant with the order `reference` appended (creates merchant ATA if missing) →
  retries the /pay endpoint with the signature (bounded retry on devnet "not found"
  lag) → prints the devnet explorer link. solana-reviewer: PASS (added the retry loop).
- Proven headlessly: `npm run agent` boots, receives HTTP 402, correctly parses
  "pay 0.1 USDC to <merchant>", detects 0 SOL, prints funding instructions, exits 1.
- NOT yet proven: the actual pay → confirmed → explorer link — BLOCKED, needs the
  agent wallet funded with devnet SOL (faucet.solana.com) + devnet USDC
  (faucet.circle.com). Once funded, `npm run agent` completes and this SAME real
  payment also closes M2 (QR flip) and M4 (confirm/underpay/replay) on-chain proofs.
  DO NOT mark ✅ until it prints a resolving explorer link.

**M6 — README + polish**
- Done when: stranger can run setup → dev (scan QR) → agent in <5 min; `.env.example`
  complete; faucet fallback documented; every file commented with its purpose.
- Prove: follow README on a clean checkout; both demos pass.

**Gate:** run `/review` then `/qa` after each milestone before marking it done.

## Risks & mitigations

1. Devnet faucet dry/rate-limited → retry 30s / faucet.solana.com; else self-mint 6-dec SPL token.
2. USDC decimals bug (off by 10^6) → single source in config.js: `baseUnits = price * 10**6`, commented.
3. Tx confirmation lag ("not found" right after pay) → poll with `confirmed`, retry ~30s.
4. Recipient missing ATA → setup.js pre-creates merchant ATA; agent creates ATA idempotently.
5. QR never confirms → reference reuse/mismatch: one fresh Keypair reference per order.

**Biggest technical risk:** server-side tx verification correctness (M4) — the USDC
6-decimal amount math combined with reading `pre/postTokenBalances` for the correct
recipient token account. A decimals or wrong-account slip silently accepts underpayment.
Mitigation: one commented amount constant in `config.js` + delta-based checks in `verify.js`.

## Out of scope

Mainnet/real funds/fiat ramp; real database/auth/login; cart/multi-product/inventory;
deployment/Docker/CI; React/Next SPA or CSS frameworks; webhooks/receipts/refunds;
multi-currency/dynamic pricing.

## Verification (end-to-end)

- Human door: `npm run setup` (keygen + airdrop + merchant ATA) → `npm run dev` → open
  shop → scan QR with Phantom on devnet → pay → page flips to "Order confirmed ☕".
- Agent door: with server running, `npm run agent` → observe 402 → programmatic USDC
  pay → retry with signature → "confirmed" + a resolving devnet explorer link.
- Negative check: replay the same signature or an underpaying tx → server returns 402
  with a reason, order stays unconfirmed.
