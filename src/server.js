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
import { PORT, ITEM, PRICE_USDC, NETWORK } from './config.js';
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

// Create an order: generate a fresh reference, build the Solana Pay URL, and
// render it as a QR the browser can show. The private key of the reference is
// irrelevant — only its public key matters as a marker, so we don't store it.
app.post('/api/order', async (_req, res) => {
  const orderId = randomUUID();
  const reference = Keypair.generate().publicKey;
  orders.set(orderId, { reference, status: 'pending', signature: null });

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
    return res.json({ status: 'pending', reason: err.message });
  }
});

// Serve the shop page and static assets from /public.
app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`ChiyaPay shop running: http://localhost:${PORT} (${NETWORK})`);
});
