// Central config for ChiyaPay. Loads .env once and exposes plain constants +
// the Solana devnet chain objects, so no other file has to reach into
// process.env or re-create a Connection.
import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import BigNumber from 'bignumber.js';

// The one product this stall sells.
export const ITEM = {
  name: 'Nepali Milk Chiya',
  emoji: '☕',
};

// Price in whole USDC (e.g. "0.10"). Kept as a Number for display.
export const PRICE_USDC = Number(process.env.PRICE_USDC ?? '0.10');

// USDC has 6 decimal places. Every on-chain amount is an integer of "base units"
// (micro-USDC), so 0.10 USDC = 0.10 * 10^6 = 100000 base units. We compute this
// ONCE here and reuse it everywhere, so an off-by-10^6 bug can only live in one place.
export const USDC_DECIMALS = 6;
export const PRICE_BASE_UNITS = Math.round(PRICE_USDC * 10 ** USDC_DECIMALS);

// Network is always devnet for this project. Never mainnet.
export const NETWORK = 'devnet';

export const PORT = Number(process.env.PORT ?? '3000');

// --- Solana devnet chain objects (added in M2) ---

// One shared RPC connection. 'confirmed' commitment is a good balance for a demo:
// fast enough, but the payment is real (not just 'processed'/in-flight).
export const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
export const connection = new Connection(RPC_URL, 'confirmed');

// The tea stall's wallet — payments must land here. Filled by `npm run setup`.
// We fail loudly if it's missing so a chain call never silently uses a bad key.
if (!process.env.MERCHANT_PUBKEY) {
  throw new Error('MERCHANT_PUBKEY is not set in .env — run `npm run setup` first.');
}
export const MERCHANT = new PublicKey(process.env.MERCHANT_PUBKEY);

// Devnet USDC mint (6 decimals). Same value used to build the Solana Pay request
// and to verify the payment on-chain, so the two can never disagree.
export const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);

// Amount for Solana Pay / validateTransfer. These APIs take the price in WHOLE
// USDC as a BigNumber (they apply the mint's 6 decimals themselves) — so here we
// pass PRICE_USDC directly, NOT PRICE_BASE_UNITS. PRICE_BASE_UNITS stays the
// single source of truth for any raw base-unit math (used in M4's balance check).
export const AMOUNT = new BigNumber(PRICE_USDC);

