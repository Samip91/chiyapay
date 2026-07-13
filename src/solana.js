// Solana Pay helpers for the human door (and reused by the agent door later).
//
// The flow: build a Solana Pay URL that encodes a fresh `reference` per order →
// the customer's wallet pays → we FIND the payment by that reference on-chain →
// we VALIDATE it actually paid the right merchant, mint, and amount. The
// reference is the thread that ties an anonymous on-chain transfer back to our
// specific order.
import { encodeURL, findReference, FindReferenceError } from '@solana/pay';
import { connection, MERCHANT, USDC_MINT, AMOUNT, AMOUNT_SOL, ITEM } from './config.js';

// Build the Solana Pay request URL a wallet (Phantom) can open/scan.
// `reference` is a throwaway public key unique to this order — it carries no
// funds, it's just a searchable marker the wallet includes in the transaction.
// `currency` picks the token: 'usdc' sets splToken (an SPL transfer), 'sol'
// omits it (a native SOL transfer). The amount is the whole-token price for that
// currency; @solana/pay applies the right decimals.
export function buildPaymentUrl(reference, currency = 'usdc') {
  const common = {
    recipient: MERCHANT,
    reference, // lets us find this exact payment later
    label: 'ChiyaPay',
    message: `One ${ITEM.name} ${ITEM.emoji}`,
  };
  if (currency === 'sol') {
    return encodeURL({ ...common, amount: AMOUNT_SOL }); // no splToken → native SOL
  }
  return encodeURL({ ...common, amount: AMOUNT, splToken: USDC_MINT }); // USDC
}

// Look for a settled transaction that carries this order's reference.
// Returns the signature string if found, or null while still unpaid.
// `finality: 'confirmed'` matches our connection commitment and tolerates
// devnet lag better than waiting for 'finalized'.
export async function findPayment(reference) {
  try {
    const info = await findReference(connection, reference, { finality: 'confirmed' });
    return info.signature;
  } catch (err) {
    // No transaction references this order yet — that's the normal "pending" case.
    if (err instanceof FindReferenceError) return null;
    throw err;
  }
}

// NOTE: server-side verification of a found/submitted signature lives in
// verify.js (verifyPayment), shared by both doors. It accepts payment in EITHER
// USDC or SOL, so we don't need a currency-specific validateTransfer here.

// A clickable devnet explorer link for any signature.
export function explorerTx(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
