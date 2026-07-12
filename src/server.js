// ChiyaPay shop server.
//
// M1: serve the shop page (item, price, Pay button).
// M2: the human door — POST /api/order mints a Solana Pay QR; GET /api/order/:id
//     polls the chain and flips to "confirmed" once the customer pays.
// Later: HTTP 402 agent door (M3) + on-chain signature verification (M4).
import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Keypair } from '@solana/web3.js';
import { PORT, ITEM, PRICE_USDC, NETWORK, MERCHANT, USDC_MINT } from './config.js';
import { buildPaymentUrl, findPayment, confirmPayment, explorerTx } from './solana.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

// In-memory order store — no database, per the plan. Each order remembers its
// unique Solana Pay `reference` (a Keypair) and current status.
const orders = new Map();

const app = express();
app.use(express.json());

// Expose the item + price so the page has no hardcoded values.
app.get('/api/config', (_req, res) => {
  res.json({ item: ITEM, priceUsdc: PRICE_USDC, network: NETWORK });
});

// Create an order. Every order gets a fresh reference (a throwaway public key
// used only as a marker). Two doors share this endpoint:
//   - Human door (browser): returns a Solana Pay URL + QR to scan.
//   - Agent door (sends the `X-Agent` header): returns HTTP 402 Payment Required
//     with machine-readable payment details, so a script knows exactly what to
//     pay and how to come back with proof.
app.post('/api/order', async (req, res) => {
  const orderId = randomUUID();
  const reference = Keypair.generate().publicKey;
  orders.set(orderId, { reference, status: 'pending', signature: null });

  // Agent door: 402 with the payment "invoice". Amount is in whole USDC; the
  // mint + recipient tell the agent exactly where and in what token to pay, and
  // `reference` is the marker to include so the payment can be tied to THIS order.
  // The agent pays, then retries with the tx signature in `retryHeader` (M4 will
  // verify it on-chain).
  if (req.get('X-Agent')) {
    return res.status(402).json({
      orderId,
      recipient: MERCHANT.toBase58(),
      amount: PRICE_USDC, // whole USDC…
      decimals: 6, // …and its decimals, so the agent computes base units unambiguously (0.1 → 100000)
      mint: USDC_MINT.toBase58(),
      network: NETWORK, // always 'devnet'
      reference: reference.toBase58(),
      retryHeader: 'X-Payment-Signature',
      retryUrl: `/api/order/${orderId}/pay`, // machine-readable retry path (implemented in M4)
      message:
        `Pay ${PRICE_USDC} USDC (mint above) to recipient, including the reference, ` +
        `then retry POST /api/order/${orderId}/pay with header X-Payment-Signature: <signature>.`,
    });
  }

  // Human door: build the Solana Pay URL and render it as a QR the browser shows.
  // The private key of the reference is irrelevant — only its public key matters.
  const url = buildPaymentUrl(reference);
  const qr = await QRCode.toDataURL(url.toString()); // data:image/png;base64,...
  res.json({ orderId, url: url.toString(), qr, amountUsdc: PRICE_USDC });
});

// Poll an order. While unpaid we return "pending". Once a transaction carrying
// this order's reference appears AND passes server-side validation, we mark it
// confirmed and hand back the signature + explorer link.
app.get('/api/order/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'unknown order' });

  // Already confirmed — return the settled result without re-hitting the chain.
  if (order.status === 'confirmed') {
    return res.json({
      status: 'confirmed',
      signature: order.signature,
      explorer: explorerTx(order.signature),
    });
  }

  try {
    const signature = await findPayment(order.reference);
    if (!signature) return res.json({ status: 'pending' });

    // Found a candidate — verify on-chain before trusting it (never trust find alone).
    await confirmPayment(signature, order.reference);
    order.status = 'confirmed';
    order.signature = signature;
    return res.json({ status: 'confirmed', signature, explorer: explorerTx(signature) });
  } catch (err) {
    // A found-but-invalid payment (wrong amount/mint) keeps the order pending,
    // with a reason for debugging. Real confirmations simply arrive on a later poll.
    // Log server-side too, so a sustained RPC failure is distinguishable from a
    // customer who simply hasn't paid yet (both look like "pending" to the client).
    console.warn(`order ${req.params.id} still pending: ${err.message}`);
    return res.json({ status: 'pending', reason: err.message });
  }
});

// Serve the shop page and static assets from /public.
app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`ChiyaPay shop running: http://localhost:${PORT} (${NETWORK})`);
});
