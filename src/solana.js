// Solana Pay helpers for the human door (and reused by the agent door later).
//
// The flow: build a Solana Pay URL that encodes a fresh `reference` per order →
// the customer's wallet pays → we FIND the payment by that reference on-chain →
// we VALIDATE it actually paid the right merchant, mint, and amount. The
// reference is the thread that ties an anonymous on-chain transfer back to our
// specific order.
import {
  encodeURL,
  findReference,
  validateTransfer,
  FindReferenceError,
} from '@solana/pay';
import { connection, MERCHANT, USDC_MINT, AMOUNT, ITEM } from './config.js';

// Build the Solana Pay request URL a wallet (Phantom) can open/scan.
// `reference` is a throwaway public key unique to this order — it carries no
// funds, it's just a searchable marker the wallet includes in the transaction.
export function buildPaymentUrl(reference) {
  return encodeURL({
    recipient: MERCHANT,
    amount: AMOUNT, // whole USDC; @solana/pay applies the mint's 6 decimals
    splToken: USDC_MINT, // pay in USDC, not SOL
    reference, // lets us find this exact payment later
    label: 'ChiyaPay',
    message: `One ${ITEM.name} ${ITEM.emoji}`,
  });
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

// Server-side verification — NEVER trust that a found signature actually paid us.
// validateTransfer re-checks on-chain that this signature transferred exactly
// AMOUNT of USDC_MINT to MERCHANT and carries our reference. Throws on any
// mismatch (wrong amount, wrong mint, wrong recipient); the caller treats a
// throw as "not confirmed".
export async function confirmPayment(signature, reference) {
  // maxSupportedTransactionVersion: 0 is required — validateTransfer forwards
  // these opts to getTransaction, which throws on a versioned (v0) tx otherwise.
  // Without it a v0 payment would silently never confirm.
  await validateTransfer(
    connection,
    signature,
    { recipient: MERCHANT, amount: AMOUNT, splToken: USDC_MINT, reference },
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  );
  return signature;
}

// A clickable devnet explorer link for any signature.
export function explorerTx(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
