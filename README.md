# ChiyaPay ☕

**One checkout, two doors: humans scan a QR, AI agents pay over HTTP 402 — same chiya, same price.**

ChiyaPay is a tiny USDC checkout for a Nepali tea stall. It sells one thing — a
cup of milk chiya (Nepali tea) — and takes payment through two doors at once. A
human opens a web page and pays by scanning a Solana Pay QR code with their
phone wallet. A software agent (a program buying on its own, no human) hits the
same shop over HTTP, gets back a `402 Payment Required` with a machine-readable
invoice, pays on-chain, and comes back with proof. Both doors accept **USDC**
(a dollar-pegged stablecoin) or native **SOL**, and both settle on **Solana
devnet** (a free test network — no real money).

> ⚠️ **Devnet only.** This project never touches mainnet and never handles real
> funds. Every coin here is free test money.

## The two doors

```
                        ┌─────────────────────────────┐
                        │        ChiyaPay shop        │
                        │   POST /api/order  (Express)│
                        └──────────────┬──────────────┘
                                       │
             ┌─────────────────────────┴─────────────────────────┐
             │                                                     │
   HUMAN DOOR (browser)                              AGENT DOOR (HTTP, no human)
             │                                                     │
   open http://localhost:3000                        send header  X-Agent: 1
             │                                                     │
   server returns Solana Pay URL + QR                 server returns HTTP 402
             │                                          + invoice (recipient,
   tap "Open in wallet" / scan                           reference, accepts[])
             │                                                     │
   wallet pays USDC or SOL                             agent pays USDC or SOL
   (Solflare / Phantom on Devnet)                       on-chain, tags reference
             │                                                     │
   page polls the chain                                agent retries with
             │                                          X-Payment-Signature: <sig>
             │                                                     │
             └──────────────► server verifies on-chain ◄──────────┘
                              (recipient, amount, recent,
                               not reused, correct reference)
                                       │
                              "Order confirmed ☕"
                              + Solana Explorer link
```

## Prerequisites

- **Node.js 18 or newer** (a JavaScript runtime). Check with `node --version`.
- A free Solana **devnet** wallet on your phone for the human demo. **Solflare
  on Devnet worked most reliably in testing** — see the QR tip below.

## Quick start

Run these from a terminal. Steps are in order; do not skip `npm run setup`.

**1. Clone and install**

```bash
git clone <your-repo-url> chiyapay
cd chiyapay
npm install
```

**2. Create your local settings file**

```bash
cp .env.example .env
```

`.env` holds your local settings and is gitignored (never committed). Only
`.env.example` is in the repo.

**3. Create and fund the shop's wallet**

```bash
npm run setup
```

This makes the tea stall's merchant wallet, airdrops a little devnet SOL for
fees, and creates its USDC account so it can receive USDC. It ends by printing a
line to copy:

```
✅ Setup complete. Put this in your .env:

MERCHANT_PUBKEY=5S7L8CGHwgHETwquYYkjNqhu3SpwxDjyGKNgkgJYMwDe
USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

If the airdrop is rate-limited, `setup` prints the wallet address to fund by
hand at <https://faucet.solana.com>, then re-run `npm run setup`.

**4. Paste the merchant key into `.env`**

Open `.env` and set the `MERCHANT_PUBKEY` line to the value `setup` printed. The
shop server will not start until this is filled in (it fails loudly on purpose).

You are ready. Now run either demo below.

## Demo 1 — Human door (the QR)

**1. Start the shop:**

```bash
npm run dev
```

You should see:

```
ChiyaPay shop running: http://localhost:3000 (devnet)
```

**2. Open <http://localhost:3000>** in a browser. You will see the chiya, the
price, and two buttons: **Pay 0.1 USDC** and **Pay 0.001 SOL**. Pick one. A QR
code appears and the status reads `Waiting for USDC payment…`.

**3. Pay from your phone.** This step has one trap — please read it:

> ### ⚠️ QR tip that bit a real user
> On your phone, do **NOT** scan the QR into your wallet's plain "Send /
> send-to-address" box. That flow drops the amount, the token, and the payment
> **reference** (a hidden marker that ties the payment to your order), so the
> shop can never match it and the page stays "pending" forever.
>
> Do one of these instead:
> - **Best:** open the shop page **on your phone** and tap the
>   **"On this phone? Tap to open in your wallet →"** link under the QR. This
>   uses the wallet's Solana Pay handler, which keeps the reference.
> - Or use your wallet's **dedicated Solana Pay scanner** (not the plain Send
>   scanner).
>
> **Phantom's devnet Solana Pay support was flaky in testing — use Solflare on
> Devnet** for the smoothest run. Make sure the wallet is switched to Devnet and
> holds devnet USDC (from <https://faucet.circle.com>, select Solana Devnet) or
> a little devnet SOL.

**4. Watch it confirm.** Once your wallet sends the payment, the page verifies
it on-chain and flips to:

```
Order confirmed ☕ (USDC)
View on Solana Explorer
```

## Demo 2 — Agent door (HTTP 402)

This shows a program buying a chiya with no human and no wallet screen.

**1. Keep the shop running** (`npm run dev` in one terminal).

**2. In a second terminal, run the agent:**

```bash
npm run agent
```

On the first run the agent creates its own wallet (`agent.keypair.json`,
gitignored) and, if it has no funds, prints the address to fund:

```
Fund the agent wallet on DEVNET, then re-run `npm run agent`:
  wallet: 9x...abc
  SOL  (fees + SOL price):  https://faucet.solana.com  (paste the address above)
  USDC (USDC price):        https://faucet.circle.com  (select Solana Devnet)
```

Fund it, then run `npm run agent` again. A full, successful run prints:

```
Agent wallet: 9x...abc
→ POST /api/order (X-Agent) …
← 402 Payment Required: pay 0.1 USDC to 5S7L8CGHwgHETwquYYkjNqhu3SpwxDjyGKNgkgJYMwDe
→ paying invoice in devnet USDC …
← paid, signature 4nK...xyz
→ POST /api/order/<id>/pay with X-Payment-Signature …

✅ Order confirmed ☕ (paid in USDC)
   https://explorer.solana.com/tx/4nK...xyz?cluster=devnet
```

**Pay in SOL instead of USDC** (only needs devnet SOL, no USDC):

```bash
AGENT_CURRENCY=sol npm run agent
```

**Peek at the raw 402 invoice** the agent receives (server must be running):

```bash
curl -s -X POST -H "X-Agent: 1" http://localhost:3000/api/order
```

```json
{
  "orderId": "076f42e5-...",
  "recipient": "5S7L8CGHwgHETwquYYkjNqhu3SpwxDjyGKNgkgJYMwDe",
  "network": "devnet",
  "reference": "5MpYdiHwZCmA9uFY285HD2LB49aCxGfaTAnFv3vZ2EWG",
  "retryHeader": "X-Payment-Signature",
  "retryUrl": "/api/order/076f42e5-.../pay",
  "accepts": [
    { "currency": "USDC", "amount": 0.1, "decimals": 6, "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    { "currency": "SOL", "amount": 0.001, "decimals": 9 }
  ],
  "message": "Pay EITHER 0.1 USDC or 0.001 SOL to recipient, including the reference, then retry POST /api/order/.../pay with header X-Payment-Signature: <sig>."
}
```

## How verification works

The agent door **never trusts the client**. When the agent sends a payment
signature, the server re-reads that transaction from the chain and checks four
things before it confirms the order (see `src/verify.js`):

- **Recipient** — the tea stall's wallet actually received the money (we diff
  its balance before and after the transaction).
- **Amount** — it received at least the full price, in raw base units (integer
  smallest units — no float rounding): 100,000 micro-USDC **or** 1,000,000
  lamports (smallest SOL units).
- **Replay protection** — each signature can be used only once. A used signature
  is remembered and rejected (so one payment can't confirm two orders).
- **Recency** — the transaction must be recent (under ~10 minutes old), so an
  old payment can't be replayed.

Plus one binding check: the transaction must carry **this order's reference**, so
a payment made for one order can never confirm a different order.

## How the 402 handshake works

1. Agent sends `POST /api/order` with the header `X-Agent: 1`.
2. Server replies **HTTP 402 Payment Required** with an invoice: `recipient`,
   `reference`, `retryUrl`, and an `accepts` list (USDC and SOL, each with its
   decimals).
3. Agent pays one currency on-chain, tagging the transfer with the `reference`.
4. Agent calls the `retryUrl` with header `X-Payment-Signature: <sig>`.
5. Server verifies on-chain (the four checks above) and returns `confirmed`
   with a Solana Explorer link — or `402` again with a plain reason if anything
   fails.

## Project layout

```
chiyapay/
├── src/
│   ├── config.js   # loads .env, holds prices + the shared devnet connection
│   ├── solana.js   # Solana Pay helpers: build the QR URL, find a payment
│   ├── verify.js   # server-side on-chain checks (recipient, amount, replay, recency)
│   ├── server.js   # Express shop: the human door + the agent 402 door
│   ├── setup.js    # `npm run setup`: make + fund the merchant wallet
│   └── agent.js    # `npm run agent`: the 402 → pay → retry → confirmed client
├── public/
│   └── index.html  # the shop page: buttons, QR, and the poll-to-confirm loop
├── .env.example    # settings template (committed); copy to .env (gitignored)
└── package.json    # scripts: dev, agent, setup
```

Orders and used signatures are kept **in memory** (no database) — small and easy
to explain, which is the point.

## Why this matters

Small shops today take cash or cards, and cards can't do tiny payments — a bank
fee eats a ten-cent sale. Tomorrow, software agents (programs that shop on their
own) will need to pay for things too, and they can't scan a QR or tap a phone.
ChiyaPay puts both customers at the **same counter with the same price**: a human
scans a QR, an agent talks HTTP 402. Stablecoins on Solana make a real
10-cent chiya sale profitable, so the tea stall and the agent economy share one
simple checkout.

## Tech stack

- **Node.js + Express** — the shop server (a small web server).
- **@solana/pay** — builds the Solana Pay QR and finds a payment by reference.
- **@solana/web3.js + @solana/spl-token** — read the chain and move USDC / SOL.
- **qrcode** — renders the QR image.
- **Solana devnet** — the free test network everything runs on.

Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals).

> **Reminder: devnet only.** No mainnet, no real funds, no secrets in the repo.
> Only `.env.example` is committed; your `.env`, `wallet.json`, and
> `agent.keypair.json` stay local and gitignored.

## Troubleshooting

- **Server won't start, says `MERCHANT_PUBKEY is not set`** — you skipped step 4.
  Run `npm run setup` and paste the `MERCHANT_PUBKEY` line into `.env`.
- **Faucet says "rate limited"** — devnet faucets limit how often you can ask.
  Wait a minute and try again, or use the other faucet link. `setup` also retries
  a few times on its own.
- **QR scanned but the page stays "pending" forever** — you probably scanned into
  the wallet's plain Send box, which drops the reference. Use the **"Tap to open
  in your wallet"** link, or your wallet's dedicated Solana Pay scanner. See the
  QR tip in Demo 1.
- **Phantom on devnet acts weird / nothing happens** — Phantom's devnet Solana
  Pay was flaky in testing. Use **Solflare on Devnet** instead.
- **Agent says "transaction not found"** — devnet can lag right after paying. The
  agent already retries this a few times; if it still fails, run `npm run agent`
  again (the payment is safe, only confirmation was late).
- **Agent says it has 0 SOL / payment failed** — the agent wallet needs devnet
  funds. Copy the address it prints and fund it: SOL from
  <https://faucet.solana.com>, USDC from <https://faucet.circle.com> (select
  Solana Devnet).
