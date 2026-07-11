// ChiyaPay shop server.
//
// Milestone M1: serve the shop page (item, price, Pay button). No chain code yet.
// Later milestones add POST /api/order (Solana Pay URL + HTTP 402 for agents) and
// GET /api/order/:id (poll for confirmation).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, ITEM, PRICE_USDC, NETWORK } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());

// Expose the item + price to the page so the HTML has no hardcoded values.
app.get('/api/config', (_req, res) => {
  res.json({ item: ITEM, priceUsdc: PRICE_USDC, network: NETWORK });
});

// Serve the shop page and any static assets from /public.
app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`ChiyaPay shop running: http://localhost:${PORT} (${NETWORK})`);
});
