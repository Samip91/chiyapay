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
import {
  PORT, ITEM, PRICE_USDC, PRICE_SOL, USDC_DECIMALS, SOL_DECIMALS,
  NETWORK, MERCHANT, USDC_MINT,
} from './config.js';
import { buildPaymentUrl, findPayment, explorerTx } from './solana.js';
import { verifyPayment } from './verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

// In-memory order store — no database, per the plan. Each order remembers its
// unique Solana Pay `reference` (a Keypair) and current status.
const orders = new Map();

const app = express();
app.use(express.json());

// Expose the item + both prices so the page has no hardcoded values.
app.get('/api/config', (_req, res) => {
  res.json({ item: ITEM, priceUsdc: PRICE_USDC, priceSol: PRICE_SOL, network: NETWORK });
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
  orders.set(orderId, { reference, status: 'pending', signature: null, currency: null });

  // Agent door: 402 with the payment "invoice", advertising BOTH accepted
  // currencies. `recipient` + `reference` are shared; the agent picks one entry
  // in `accepts`, pays it (including the reference), then retries with the tx
  // signature in `retryHeader`. The server verifies whichever currency landed.
  if (req.get('X-Agent')) {
    return res.status(402).json({
      orderId,
      recipient: MERCHANT.toBase58(),
      network: NETWORK, // always 'devnet'
      reference: reference.toBase58(),
      retryHeader: 'X-Payment-Signature',
      retryUrl: `/api/order/${orderId}/pay`,
      accepts: [
        // decimals let the agent compute base units unambiguously (avoids the 10^N trap).
        { currency: 'USDC', amount: PRICE_USDC, decimals: USDC_DECIMALS, mint: USDC_MINT.toBase58() },
        { currency: 'SOL', amount: PRICE_SOL, decimals: SOL_DECIMALS }, // native SOL, no mint
      ],
      message:
        `Pay EITHER ${PRICE_USDC} USDC or ${PRICE_SOL} SOL to recipient, including the ` +
        `reference, then retry POST /api/order/${orderId}/pay with header X-Payment-Signature: <sig>.`,
    });
  }

  // Human door: the customer picked a currency (?currency=usdc|sol). Build that
  // Solana Pay URL and render it as a QR. The reference's private key is
  // irrelevant — only its public key matters as a marker.
  const currency = req.query.currency === 'sol' ? 'sol' : 'usdc';
  const url = buildPaymentUrl(reference, currency);
  const qr = await QRCode.toDataURL(url.toString()); // data:image/png;base64,...
  res.json({
    orderId,
    url: url.toString(),
    qr,
    currency: currency.toUpperCase(),
    amount: currency === 'sol' ? PRICE_SOL : PRICE_USDC,
  });
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
      currency: order.currency,
      explorer: explorerTx(order.signature),
    });
  }

  try {
    const signature = await findPayment(order.reference);
    if (!signature) return res.json({ status: 'pending' });

    // Found a candidate — verify on-chain before trusting it (never trust find
    // alone). verifyPayment accepts either USDC or SOL and reports which landed.
    const result = await verifyPayment(signature, order.reference);
    if (!result.ok) return res.json({ status: 'pending', reason: result.reason });
    order.status = 'confirmed';
    order.signature = signature;
    order.currency = result.currency;
    return res.json({
      status: 'confirmed',
      signature,
      currency: result.currency,
      explorer: explorerTx(signature),
    });
  } catch (err) {
    // A found-but-invalid payment (wrong amount/mint) keeps the order pending,
    // with a reason for debugging. Real confirmations simply arrive on a later poll.
    // Log server-side too, so a sustained RPC failure is distinguishable from a
    // customer who simply hasn't paid yet (both look like "pending" to the client).
    console.warn(`order ${req.params.id} still pending: ${err.message}`);
    return res.json({ status: 'pending', reason: err.message });
  }
});

// Agent door — retry endpoint (M4). The agent paid off-chain and now submits its
// transaction signature in the X-Payment-Signature header. We verify it on-chain
// (server-side, never trusting the client) and confirm the order, or answer 402
// again with the reason so the agent can react.
app.post('/api/order/:orderId/pay', async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'unknown order' });

  // Idempotent: if this order is already settled, just return the result.
  if (order.status === 'confirmed') {
    return res.json({
      status: 'confirmed',
      signature: order.signature,
      currency: order.currency,
      explorer: explorerTx(order.signature),
    });
  }

  const signature = req.get('X-Payment-Signature');
  if (!signature) {
    return res.status(402).json({ status: 'unpaid', reason: 'missing X-Payment-Signature header' });
  }

  const result = await verifyPayment(signature, order.reference);
  if (!result.ok) {
    // Verification failed — stay unpaid and tell the agent why (402 Payment Required).
    return res.status(402).json({ status: 'unpaid', reason: result.reason });
  }

  order.status = 'confirmed';
  order.signature = signature;
  order.currency = result.currency;
  return res.json({
    status: 'confirmed',
    signature,
    currency: result.currency,
    explorer: explorerTx(signature),
  });
});

// Serve the shop page and static assets from /public.
app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`ChiyaPay shop running: http://localhost:${PORT} (${NETWORK})`);
});
