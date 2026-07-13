// The agent door demo: `npm run agent`.
//
// A software agent buys a chiya with no human and no wallet UI:
//   1. POST /api/order with the X-Agent header → server replies HTTP 402 with a
//      machine-readable invoice: recipient, reference, retryUrl, and an `accepts`
//      list of currencies (USDC and SOL).
//   2. The agent pays one of them (USDC or SOL — pick with AGENT_CURRENCY),
//      tagging the transfer with the order's `reference` so it's tied to this order.
//   3. It re-submits the transaction signature to the retry URL; the server
//      verifies it on-chain and confirms the order.
//   4. It prints a Solana Explorer (devnet) link.
//
// Standalone by design — it talks to the shop only over HTTP, so it does NOT
// import ./config.js (no merchant key needed on the client side).
import 'dotenv/config';
import fs from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TokenAccountNotFoundError,
} from '@solana/spl-token';

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const SHOP_URL = process.env.SHOP_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`;
const KEYPAIR_PATH = process.env.AGENT_KEYPAIR ?? './agent.keypair.json';
// Which currency the agent pays in: 'usdc' (default) or 'sol'.
const CURRENCY = (process.env.AGENT_CURRENCY ?? 'usdc').toLowerCase();

// Load the agent's payer wallet, or create + save one (gitignored) on first run.
function loadOrCreatePayer() {
  if (fs.existsSync(KEYPAIR_PATH)) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8')));
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const fundingHelp = (pubkey) =>
  `\nFund the agent wallet on DEVNET, then re-run \`npm run agent\`:\n` +
  `  wallet: ${pubkey}\n` +
  `  SOL  (fees + SOL price):  https://faucet.solana.com  (paste the address above)\n` +
  `  USDC (USDC price):        https://faucet.circle.com  (select Solana Devnet)\n`;

// Build the payment transaction for the chosen invoice entry. USDC is an SPL
// transferChecked (creating the merchant's token account if missing); SOL is a
// native SystemProgram transfer. Either way we append the order `reference` as a
// read-only key so the payment binds to THIS order (the Solana Pay convention).
async function buildPaymentTx(connection, payer, entry, recipient, reference) {
  const tx = new Transaction();

  if (entry.currency === 'SOL') {
    // Native SOL: amount → lamports using the invoice's own decimals (0.001 × 10^9).
    const lamports = Math.round(entry.amount * 10 ** entry.decimals);
    const ix = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports,
    });
    ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
    return tx.add(ix);
  }

  // USDC (SPL token). Base units from the invoice's decimals (0.1 × 10^6 = 100000).
  const mint = new PublicKey(entry.mint);
  const baseUnits = Math.round(entry.amount * 10 ** entry.decimals);
  const payerAta = await getAssociatedTokenAddress(mint, payer.publicKey);
  const merchantAta = await getAssociatedTokenAddress(mint, recipient);

  try {
    await getAccount(connection, merchantAta);
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) {
      // Merchant has no USDC account yet — the agent pays to create it (idempotent).
      tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, merchantAta, recipient, mint));
    } else {
      throw err;
    }
  }

  // transferChecked re-checks the mint + decimals on-chain — safer than a bare transfer.
  const ix = createTransferCheckedInstruction(
    payerAta, mint, merchantAta, payer.publicKey, baseUnits, entry.decimals,
  );
  ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  return tx.add(ix);
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = loadOrCreatePayer();
  console.log(`Agent wallet: ${payer.publicKey.toBase58()}`);

  // Step 1 — ask for an order as an agent; expect HTTP 402 with the invoice.
  console.log('→ POST /api/order (X-Agent) …');
  const orderRes = await fetch(`${SHOP_URL}/api/order`, {
    method: 'POST',
    headers: { 'X-Agent': '1' },
  });
  if (orderRes.status !== 402) {
    throw new Error(`expected HTTP 402, got ${orderRes.status}`);
  }
  const invoice = await orderRes.json();

  // Pick the currency to pay in from the invoice's accepted list.
  const entry = (invoice.accepts ?? []).find((a) => a.currency.toLowerCase() === CURRENCY);
  if (!entry) {
    throw new Error(
      `AGENT_CURRENCY='${CURRENCY}' not offered; accepts: ` +
        (invoice.accepts ?? []).map((a) => a.currency).join(', '),
    );
  }
  console.log(`← 402 Payment Required: pay ${entry.amount} ${entry.currency} to ${invoice.recipient}`);

  const recipient = new PublicKey(invoice.recipient);
  const reference = new PublicKey(invoice.reference);

  // The agent needs SOL for the transaction fee (and for the price itself if
  // paying in SOL). Bail with a clear message instead of a cryptic RPC error.
  const sol = await connection.getBalance(payer.publicKey);
  if (sol === 0) {
    console.error('\nAgent wallet has 0 SOL — cannot pay transaction fees.');
    console.error(fundingHelp(payer.publicKey.toBase58()));
    process.exit(1);
  }

  // Step 2 — build the payment transaction for the chosen currency.
  const tx = await buildPaymentTx(connection, payer, entry, recipient, reference);

  console.log(`→ paying invoice in devnet ${entry.currency} …`);
  let signature;
  try {
    signature = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
    });
  } catch (err) {
    console.error(`Payment failed: ${err.message}`);
    console.error(`(Most often: the agent wallet lacks devnet ${entry.currency}.)`);
    console.error(fundingHelp(payer.publicKey.toBase58()));
    process.exit(1);
  }
  console.log(`← paid, signature ${signature}`);

  // Step 3 — hand the signature back; the server verifies it on-chain. Right
  // after sendAndConfirmTransaction resolves, the server's getTransaction can
  // still briefly return null (devnet propagation lag), so retry a "not found"
  // response a few times before giving up (PLAN risk #3). A real rejection
  // (underpaid, wrong mint) won't fix itself, so we don't retry those.
  console.log(`→ POST ${invoice.retryUrl} with X-Payment-Signature …`);
  let result;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const payRes = await fetch(`${SHOP_URL}${invoice.retryUrl}`, {
      method: 'POST',
      headers: { 'X-Payment-Signature': signature },
    });
    result = await payRes.json();
    if (payRes.status === 200 && result.status === 'confirmed') break;

    const retryable = /not found/i.test(result.reason ?? '');
    if (!retryable || attempt === 6) {
      throw new Error(`server did not confirm: ${payRes.status} ${JSON.stringify(result)}`);
    }
    console.log(`   not settled yet (attempt ${attempt}/6) — retrying in 5s…`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Step 4 — done.
  console.log(`\n✅ Order confirmed ☕ (paid in ${result.currency})`);
  console.log(`   ${result.explorer}`);
}

main().catch((err) => {
  console.error('Agent failed:', err.message);
  process.exit(1);
});
