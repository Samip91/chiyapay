// Central config for ChiyaPay. Loads .env once and exposes plain constants so no
// other file has to reach into process.env. Chain objects (Connection, PublicKeys)
// get added here in a later milestone — for now this is just the shop's settings.
import 'dotenv/config';

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
