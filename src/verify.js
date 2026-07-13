// Server-side, on-chain verification for the AGENT door (M4).
//
// The agent claims "I paid — here's my transaction signature." We must NEVER
// trust that claim. This module re-reads the transaction from the chain and
// checks, in order:
//   1. the signature hasn't been used before (replay protection),
//   2. the transaction exists and didn't fail,
//   3. it's recent (not an old payment being replayed),
//   4. it actually transferred >= the price to the merchant — in EITHER USDC
//      (SPL token balance delta) OR SOL (native lamport balance delta),
//   5. it carries this order's reference (so a payment can't confirm a
//      different order).
// Any failure returns { ok:false, reason } — the caller answers HTTP 402 again.
import {
  connection,
  MERCHANT,
  USDC_MINT,
  PRICE_BASE_UNITS,
  PRICE_SOL_LAMPORTS,
} from './config.js';

// Signatures we've already accepted. In-memory Set — fine for a demo (no DB).
const usedSignatures = new Set();

const MAX_AGE_SECONDS = 10 * 60; // reject payments older than ~10 minutes

// Every account key of a transaction, in the order the pre/postBalances arrays
// use: static message keys first, then any v0 Address-Lookup-Table addresses
// (writable then readonly). Returns PublicKeys; used both to check the reference
// is present and to index the merchant's native SOL balance.
function orderedAccountKeys(tx) {
  const msg = tx.transaction.message;
  const staticKeys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses;
  return [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

// How many USDC base units (micro-USDC) the merchant received in this tx.
// Token balances carry owner + mint, so we match on both and diff pre/post.
function merchantUsdcDelta(tx) {
  const mintStr = USDC_MINT.toBase58();
  const ownerStr = MERCHANT.toBase58();
  const matches = (b) => b.mint === mintStr && b.owner === ownerStr;
  const post = (tx.meta?.postTokenBalances ?? []).find(matches);
  if (!post) return 0n;
  const pre = (tx.meta?.preTokenBalances ?? []).find(matches);
  return BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0');
}

// How many lamports the merchant's native account gained in this tx. preBalances
// / postBalances are lamport arrays indexed by orderedAccountKeys.
function merchantSolDelta(tx) {
  const idx = orderedAccountKeys(tx).findIndex((k) => k.equals(MERCHANT));
  if (idx < 0) return 0n;
  const pre = BigInt(tx.meta?.preBalances?.[idx] ?? 0);
  const post = BigInt(tx.meta?.postBalances?.[idx] ?? 0);
  return post - pre;
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

  // 4. Amount: the merchant must have received at least the price in EITHER
  // currency. We compare raw base units (micro-USDC / lamports) — no float math,
  // no decimals guesswork. This intentionally honors whichever accepted currency
  // actually landed (at full price, with the correct reference) — the shop takes
  // USDC or SOL, so we don't force it to match the currency the QR suggested.
  const usdcDelta = merchantUsdcDelta(tx);
  const solDelta = merchantSolDelta(tx);
  const paidUsdc = usdcDelta >= BigInt(PRICE_BASE_UNITS);
  const paidSol = solDelta >= BigInt(PRICE_SOL_LAMPORTS);
  if (!paidUsdc && !paidSol) {
    return {
      ok: false,
      reason:
        `underpaid: merchant received ${usdcDelta} USDC base units / ${solDelta} lamports, ` +
        `need ${PRICE_BASE_UNITS} USDC base units or ${PRICE_SOL_LAMPORTS} lamports`,
    };
  }
  const currency = paidUsdc ? 'USDC' : 'SOL';

  // 5. Bind the payment to THIS order — the reference must appear in the tx.
  const referenced = orderedAccountKeys(tx).some((k) => k.equals(reference));
  if (!referenced) {
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
  return { ok: true, currency };
}
