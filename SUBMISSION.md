# ChiyaPay — Superteam Earn submission

ChiyaPay is a USDC checkout for a Nepali tea stall on Solana devnet, with two
payment doors. The human door serves a Solana Pay QR; a phone wallet
(Solflare on Devnet) pays and the page flips to "Order confirmed ☕". The agent
door lets a program pay: `POST /api/order` returns HTTP 402 with an invoice, the
agent pays USDC or SOL on-chain, retries with the signature, and the server
verifies it on-chain (recipient, amount, recency, no replay, correct reference)
before confirming with an Explorer link. Both doors take USDC (0.10) or SOL
(0.001). Server code lives in `src/`, the page in `public/index.html`. Run:
install, copy `.env.example` to `.env`, `npm run setup`, `npm run dev`,
`npm run agent`. Devnet only.
