// One-time devnet setup: `npm run setup`.
//
// Creates (or reuses) the tea stall's merchant wallet, funds it with a little
// devnet SOL (needed only to pay rent/fees), and makes sure the merchant has a
// USDC token account so it can RECEIVE payments. Then it prints the exact line
// to paste into .env.
//
// This file is intentionally standalone — it does NOT import ./config.js,
// because config throws when MERCHANT_PUBKEY is empty and setup is what fills it.
import 'dotenv/config';
import fs from 'node:fs';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount } from '@solana/spl-token';

const WALLET_PATH = './wallet.json';
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
// Devnet USDC (6 decimals). Merchant only needs an account for it to receive.
const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load the merchant keypair from wallet.json, or create + save a fresh one.
// wallet.json is gitignored — a devnet key still never belongs in git.
function loadOrCreateWallet() {
  if (fs.existsSync(WALLET_PATH)) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8')));
    return { kp: Keypair.fromSecretKey(secret), created: false };
  }
  const kp = Keypair.generate();
  // Same format the Solana CLI uses: a JSON array of the 64 secret-key bytes.
  fs.writeFileSync(WALLET_PATH, JSON.stringify(Array.from(kp.secretKey)));
  return { kp, created: true };
}

// Make sure the merchant has enough SOL for the ATA rent + fees. Airdrop is
// rate-limited on devnet, so retry a few times before giving up gracefully.
async function ensureSol(connection, pubkey) {
  const min = 0.5 * LAMPORTS_PER_SOL;
  let balance = await connection.getBalance(pubkey);
  for (let attempt = 1; attempt <= 3 && balance < min; attempt++) {
    console.log(`Airdropping 1 devnet SOL (attempt ${attempt}/3)…`);
    try {
      const sig = await connection.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    } catch (err) {
      console.log(`  airdrop failed: ${err.message}`);
      await sleep(30_000); // wait out the rate limit
    }
    balance = await connection.getBalance(pubkey);
  }
  return balance;
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const { kp: merchant, created } = loadOrCreateWallet();
  console.log(`Merchant wallet ${created ? 'created' : 'loaded'}: ${merchant.publicKey.toBase58()}`);

  const balance = await ensureSol(connection, merchant.publicKey);
  console.log(`Merchant SOL balance: ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    console.log(
      '\n⚠️  Not enough SOL and airdrop is rate-limited. Fund the address above at\n' +
        '    https://faucet.solana.com  then re-run `npm run setup`.',
    );
    process.exit(1);
  }

  // Create the merchant's USDC associated token account (idempotent — returns the
  // existing one if it's already there). Without this, a USDC transfer to the
  // merchant would have nowhere to land.
  console.log('Ensuring merchant USDC token account exists…');
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    merchant, // payer for the account-creation fee
    USDC_MINT,
    merchant.publicKey, // owner
  );
  console.log(`Merchant USDC account: ${ata.address.toBase58()}`);

  console.log('\n✅ Setup complete. Put this in your .env:\n');
  console.log(`MERCHANT_PUBKEY=${merchant.publicKey.toBase58()}`);
  console.log(`USDC_MINT=${USDC_MINT.toBase58()}`);
  console.log(
    '\nTo pay from your own Phantom (human door): switch Phantom to Devnet and\n' +
      'fund it with devnet USDC from https://faucet.circle.com (select Solana Devnet).',
  );
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
