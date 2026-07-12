// Server-side, on-chain verification for the AGENT door (M4).
//
// The agent claims "I paid — here's my transaction signature." We must NEVER
// trust that claim. This module re-reads the transaction from the chain and
// checks, in order:
//   1. the signature hasn't been used before (replay protection),
//   2. the transaction exists and didn't fail,
//   3. it's recent (not an old payment being replayed),
//   4. it actually transferred >= the price in USDC to the merchant,
//   5. it carries this order's reference (so a payment can't confirm a
//      different order).
// Any failure returns { ok:false, reason } — the caller answers HTTP 402 again.
import { connection, MERCHANT, USDC_MINT, PRICE_BASE_UNITS } from './config.js';

// Signatures we've already accepted. In-memory Set — fine for a demo (no DB).
const usedSignatures = new Set();

const MAX_AGE_SECONDS = 10 * 60; // reject payments older than ~10 minutes

// Collect every account key referenced by a transaction (works for both legacy
// and v0 messages). Used to confirm the order's `reference` is present.
function accountKeyStrings(tx) {
  const msg = tx.transaction.message;
  const staticKeys = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k) => k.toBase58());
  // A v0 transaction can pull extra accounts from an Address Lookup Table; those
  // live in meta.loadedAddresses, not in the message. Include them so a valid
  // payment whose reference arrives via an ALT isn't wrongly rejected.
  const loaded = tx.meta?.loadedAddresses;
  const loadedKeys = [...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map((k) =>
    k.toBase58(),
  );
  return [...staticKeys, ...loadedKeys];
}

export async function verifyPayment(signature, reference) {
  // 1. Replay protection — cheapest check, do it first.
  if (usedSignatures.has(signature)) {
    return { ok: false, reason: 'signature already used' };
  }

  // 2. Fetch the transaction. maxSupportedTransactionVersion:0 so a versioned
  // (v0) transaction doesn't make getTransaction throw.
  // NOTE: 'confirmed' (not 'finalized') keeps the demo snappy; a confirmed tx
  // could in theory be dropped on a minority fork — an acceptable devnet risk.
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    return { ok: false, reason: 'transaction not found (devnet lag or wrong signature)' };
  }
  if (tx.meta?.err) {
    return { ok: false, reason: 'transaction failed on-chain' };
  }

  // 3. Recency — blockTime is unix seconds; reject anything too old.
  const now = Math.floor(Date.now() / 1000);
  if (!tx.blockTime || now - tx.blockTime > MAX_AGE_SECONDS) {
    return { ok: false, reason: 'transaction too old' };
  }

  // 4. Amount + mint: look at how the MERCHANT's USDC balance changed in THIS
  // transaction. Token balances are reported in base units (micro-USDC) with the
  // owner + mint attached, so we match on both and compare the delta against the
  // price in base units — no float math, no decimals guesswork.
  const mintStr = USDC_MINT.toBase58();
  const ownerStr = MERCHANT.toBase58();
  const matches = (b) => b.mint === mintStr && b.owner === ownerStr;
  const post = (tx.meta?.postTokenBalances ?? []).find(matches);
  if (!post) {
    return { ok: false, reason: 'no USDC transfer to the merchant in this transaction' };
  }
  const pre = (tx.meta?.preTokenBalances ?? []).find(matches);
  const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0');
  if (delta < BigInt(PRICE_BASE_UNITS)) {
    return {
      ok: false,
      reason: `underpaid: merchant received ${delta} base units, need ${PRICE_BASE_UNITS}`,
    };
  }

  // 5. Bind the payment to THIS order — the reference must appear in the tx.
  if (!accountKeyStrings(tx).includes(reference.toBase58())) {
    return { ok: false, reason: 'payment does not reference this order' };
  }

  // Passed every check — now CLAIM the signature so it can't be replayed. This
  // has()+add() pair runs in one synchronous tick (no await between them), so two
  // concurrent requests submitting the SAME signature can't both slip through:
  // the first claims it here, the second is rejected. (The check at the top of the
  // function is just a fast path for the common sequential-replay case.)
  if (usedSignatures.has(signature)) {
    return { ok: false, reason: 'signature already used' };
  }
  usedSignatures.add(signature);
  return { ok: true };
}
