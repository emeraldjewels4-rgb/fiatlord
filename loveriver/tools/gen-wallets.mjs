#!/usr/bin/env node
/**
 * Generates the 1,000 distribution wallets and the 5 administrator wallets from ONE
 * BIP-39 mnemonic, using BIP-32 derivation.
 *
 * The backup is a single mnemonic instead of 1,005 private keys: every address is a
 * derived child, so there is nothing else to store and nothing to keep in sync. No
 * network is used and nothing is sent anywhere.
 *
 * The output file is the ONLY copy of that mnemonic, so back it up (or move it to
 * whatever secret store you use) before you fund anything, and never commit it.
 *
 *   node tools/gen-wallets.mjs --selftest     verify the derivation against known vectors
 *   node tools/gen-wallets.mjs                write wallets.json + the addresses file
 *   node tools/gen-wallets.mjs --force        replace an existing wallets.json
 */
import { HDNodeWallet, Mnemonic, Wallet } from 'ethers';
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DISTRIBUTION_WALLETS = 1000;
const ADMIN_WALLETS = 5;

// BIP-44 for Ethereum: m / purpose' / coin_type' / account' / change' / address_index.
// Distribution and the admins sit in different accounts, so the two sets can never
// overlap no matter how many wallets are generated later.
const WALLET_PATH = "m/44'/60'/0'/0";
const ADMIN_PATH = "m/44'/60'/1'/0";

const argv = process.argv.slice(2);

/** The address at `path`/`index` for a mnemonic. This is the only derivation used here. */
function deriveAddress(phrase, path, index) {
  return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase), path).deriveChild(index).address;
}

// Known vectors. Two separate claims are checked, because the previous version of this
// script only had the first one:
//   1. the address derivation is still secp256k1 + keccak and did not change;
//   2. the BIP-32 derivation is the standard Ethereum one. The test mnemonic below is the
//      one Hardhat and anvil use, so index 0, 1 and 2 MUST come out as their first three
//      accounts. If this passes, any tool that understands the same mnemonic agrees with
//      this file - which is what makes a single mnemonic a usable backup.
if (argv.includes('--selftest')) {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    console.log(`       got      ${actual}`);
    if (!ok) console.log(`       expected ${expected}`);
  };

  console.log('  key -> address');
  check(
    'private key 0x...01',
    new Wallet('0x' + '0'.repeat(63) + '1').address,
    '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'
  );

  console.log("  BIP-32 m/44'/60'/0'/0/<i>, standard test mnemonic (Hardhat/anvil)");
  const testPhrase = 'test test test test test test test test test test test junk';
  check(
    'index 0',
    deriveAddress(testPhrase, WALLET_PATH, 0),
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  );
  check(
    'index 1',
    deriveAddress(testPhrase, WALLET_PATH, 1),
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
  );
  check(
    'index 2',
    deriveAddress(testPhrase, WALLET_PATH, 2),
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
  );

  console.log('  derivation is a function of the path and index, as it must be');
  check(
    'same index twice gives the same address',
    deriveAddress(testPhrase, WALLET_PATH, 7),
    deriveAddress(testPhrase, WALLET_PATH, 7)
  );
  const walletZero = deriveAddress(testPhrase, WALLET_PATH, 0);
  const adminZero = deriveAddress(testPhrase, ADMIN_PATH, 0);
  if (walletZero === adminZero) {
    failures++;
    console.log('  FAIL the wallet and admin paths collide at index 0');
  } else {
    console.log('  ok   the admin path is a different branch (no overlap with wallets)');
  }

  console.log(failures === 0 ? '  selftest PASSED' : `  selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const outPath = resolve('wallets.json');
if (existsSync(outPath) && !argv.includes('--force')) {
  console.error(`  ${outPath} already exists. A seed is never overwritten by accident; pass --force to replace it.`);
  process.exit(2);
}

// 256 bits of entropy = 24 words. This one phrase controls every wallet below it, so it
// gets the stronger option rather than the 12-word default.
const mnemonic = Mnemonic.fromEntropy(randomBytes(32)).phrase;

const wallets = Array.from({ length: DISTRIBUTION_WALLETS }, (_, index) =>
  deriveAddress(mnemonic, WALLET_PATH, index)
);
const admins = Array.from({ length: ADMIN_WALLETS }, (_, index) =>
  deriveAddress(mnemonic, ADMIN_PATH, index)
);

// Distinct indices under one path must give distinct addresses. A duplicate would mean
// the same wallet was counted twice and one of the 1,000 would silently go unfunded.
const all = [...wallets, ...admins];
const seen = new Set(all.map((address) => address.toLowerCase()));
if (seen.size !== all.length) {
  console.error('  derivation produced a duplicate address; refusing to write the file');
  process.exit(2);
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      version: 2,
      warning:
        'This mnemonic controls all 1,005 wallets and any funds in them. It is the only copy. Store it offline, never commit it, never paste it into a chat.',
      createdAt: new Date().toISOString(),
      note: 'One mnemonic replaces 1,005 private keys. Derive any address with its path and index below; tools/fund.mjs derives the distribution wallets for you and checks them against the list here.',
      mnemonic,
      paths: {
        wallets: {
          path: WALLET_PATH,
          count: DISTRIBUTION_WALLETS,
          indexRange: `0..${DISTRIBUTION_WALLETS - 1}`,
        },
        admins: { path: ADMIN_PATH, count: ADMIN_WALLETS, indexRange: `0..${ADMIN_WALLETS - 1}` },
      },
      wallets,
      admins,
    },
    null,
    2
  )
);
chmodSync(outPath, 0o600);

const addressesPath = outPath.replace(/\.json$/, '') + '-addresses.txt';
writeFileSync(
  addressesPath,
  [
    `# ${DISTRIBUTION_WALLETS} distribution wallets from ${WALLET_PATH}/0..${DISTRIBUTION_WALLETS - 1}`,
    ...wallets,
    '',
    `# ${ADMIN_WALLETS} administrator wallets from ${ADMIN_PATH}/0..${ADMIN_WALLETS - 1}`,
    ...admins,
    '',
  ].join('\n')
);

console.log(`  wrote ${DISTRIBUTION_WALLETS} wallets + ${ADMIN_WALLETS} admins to ${outPath}`);
console.log(`  one mnemonic, 24 words, at ${WALLET_PATH} (wallets) and ${ADMIN_PATH} (admins)`);
console.log(`  addresses only: ${addressesPath}`);
console.log(`  first wallet:   ${wallets[0]}`);
console.log(`  admin 0:        ${admins[0]}`);
console.log('  the mnemonic exists only in that file — back it up now, and do not commit it.');
