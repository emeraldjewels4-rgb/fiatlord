#!/usr/bin/env node
/**
 * Rebuilds the wallet file from a backup, and proves the backup is good rather than assumed.
 *
 * The backup is one 24-word mnemonic; the 1,000 distribution and 5 admin addresses are derived
 * children of it, so a backup is only usable if the seed in it reproduces exactly the addresses
 * that were funded. This re-derives every one of them from the seed in the backup and compares
 * against the lists stored in that same file (and, with --check, against a live wallets.json).
 * A backup that cannot do that is worthless even though it is a valid JSON file.
 *
 *   node tools/restore-wallets.mjs --from D:\loveriver-backup\wallets-20261120.json
 *   node tools/restore-wallets.mjs --from <backup> --check wallets.json
 *   node tools/restore-wallets.mjs --from <backup> --write
 *   node tools/restore-wallets.mjs --selftest
 *
 * Exit codes: 0 the backup re-derives every address, 1 a check failed, 2 it could not run.
 *
 * Nothing here prints the mnemonic, and nothing needs a network: the seed never leaves this
 * process except into the file it writes with --write.
 */
import { HDNodeWallet, Mnemonic } from 'ethers';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WALLET_PATH = "m/44'/60'/0'/0";
const ADMIN_PATH = "m/44'/60'/1'/0";
const DISTRIBUTION_WALLETS = 1000;
const ADMIN_WALLETS = 5;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 || at === argv.length - 1 ? fallback : argv[at + 1];
};

function cannotRun(message) {
  console.error(`  ${message}`);
  process.exit(2);
}

/** The same derivation gen-wallets.mjs and fund.mjs use. */
function derive(phrase, path, count) {
  const node = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase), path);
  return Array.from({ length: count }, (_, index) => node.deriveChild(index).address);
}

/** Case-insensitive comparison, so a lower-cased backup list is not a false alarm. */
function differences(derived, stored) {
  const bad = [];
  const longest = Math.max(derived.length, stored.length);
  for (let index = 0; index < longest; index++) {
    if (String(derived[index] ?? '').toLowerCase() !== String(stored[index] ?? '').toLowerCase()) {
      bad.push(index);
    }
  }
  return bad;
}

const fingerprint = (addresses) =>
  createHash('sha256').update(addresses.map((address) => address.toLowerCase()).join('\n')).digest('hex');

// The teeth: the comparison has to be able to fail. Checked against a public, worthless test
// mnemonic, so the real seed is never involved.
if (has('--selftest')) {
  const testPhrase = 'test test test test test test test test test test test junk';
  let failures = 0;
  const check = (label, ok) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  };

  check(
    'the derivation is the standard one (anvil account 0)',
    derive(testPhrase, WALLET_PATH, 1)[0] === '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  );
  const five = derive(testPhrase, ADMIN_PATH, 5);
  check('deriving twice gives the same list', fingerprint(five) === fingerprint(derive(testPhrase, ADMIN_PATH, 5)));
  check('an untouched list reports no difference', differences(five, five).length === 0);
  check('a lower-cased list reports no difference', differences(five, five.map((a) => a.toLowerCase())).length === 0);

  const swapped = [...five];
  swapped[2] = '0x0000000000000000000000000000000000000001';
  check('one wrong address is caught and named by index', differences(five, swapped).join(',') === '2');
  const short = five.slice(0, 4);
  check('a missing address is caught', differences(five, short).join(',') === '4');
  const long = [...five, '0x0000000000000000000000000000000000000002'];
  check('an extra address is caught', differences(five, long).join(',') === '5');

  check('a phrase that is not a mnemonic is rejected', Mnemonic.isValidMnemonic('not a real phrase at all') === false);
  check('the test phrase itself is valid', Mnemonic.isValidMnemonic(testPhrase) === true);

  console.log(failures === 0 ? '  restore selftest PASSED' : `  restore selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const fromPath = value('from');
if (!fromPath) cannotRun('  --from <backup.json> is required');

let backup;
try {
  backup = JSON.parse(readFileSync(fromPath, 'utf8'));
} catch (error) {
  cannotRun(`  cannot read ${fromPath}: ${error.message}`);
}

const phrase = String(backup.mnemonic ?? '').trim();
if (!phrase) cannotRun(`  ${fromPath} holds no mnemonic, so it cannot rebuild anything`);
if (!Mnemonic.isValidMnemonic(phrase)) {
  cannotRun(`  the phrase in ${fromPath} is not a valid BIP-39 mnemonic (${phrase.split(/\s+/).length} words, bad word or checksum)`);
}

const walletPath = backup.paths?.wallets?.path ?? WALLET_PATH;
const adminPath = backup.paths?.admins?.path ?? ADMIN_PATH;
const walletCount = Number(backup.paths?.wallets?.count ?? DISTRIBUTION_WALLETS);
const adminCount = Number(backup.paths?.admins?.count ?? ADMIN_WALLETS);

console.log(`  backup   ${fromPath}`);
console.log(`  seed     ${phrase.split(/\s+/).length} words, valid BIP-39 (not printed)`);
console.log(`  deriving ${walletCount} at ${walletPath} and ${adminCount} at ${adminPath}`);

const wallets = derive(phrase, walletPath, walletCount);
const admins = derive(phrase, adminPath, adminCount);

let failures = 0;
const compare = (label, derived, stored) => {
  if (!Array.isArray(stored) || stored.length === 0) {
    failures++;
    console.log(`  FAIL ${label}: the backup stores no address list to check against`);
    return;
  }
  const bad = differences(derived, stored);
  if (bad.length) {
    failures++;
    console.log(`  FAIL ${label}: ${bad.length} of ${derived.length} disagree, first at index ${bad[0]}`);
    if (derived[bad[0]]) console.log(`       derived ${derived[bad[0]]}`);
    if (stored[bad[0]]) console.log(`       stored  ${stored[bad[0]]}`);
    return;
  }
  console.log(`  ok   ${label}: all ${derived.length} addresses re-derived and match the backup`);
};

compare('wallets', wallets, backup.wallets);
compare('admins', admins, backup.admins);

const everything = [...wallets, ...admins];
const distinct = new Set(everything.map((address) => address.toLowerCase()));
if (distinct.size !== everything.length) {
  failures++;
  console.log(`  FAIL ${everything.length - distinct.size} address(es) are duplicated`);
} else {
  console.log(`  ok   ${everything.length} distinct addresses, no overlap between the two paths`);
}

const addressFingerprint = fingerprint(everything);
console.log(`  ok   derived set fingerprint ${addressFingerprint}`);
console.log('       (sha256 of the 1,005 lower-cased addresses this seed produces, independent of the stored lists)');

const checkPath = value('check');
if (checkPath) {
  let live;
  try {
    live = JSON.parse(readFileSync(checkPath, 'utf8'));
  } catch (error) {
    cannotRun(`  cannot read ${checkPath}: ${error.message}`);
  }
  const sameSeed = String(live.mnemonic ?? '').trim() === phrase;
  if (sameSeed) {
    console.log(`  ok   ${checkPath} holds the same seed`);
  } else {
    failures++;
    console.log(`  FAIL ${checkPath} was made from a different seed`);
  }
  const liveWallets = Array.isArray(live.wallets) ? live.wallets : [];
  const liveAdmins = Array.isArray(live.admins) ? live.admins : [];
  const liveFingerprint = fingerprint([...liveWallets, ...liveAdmins]);
  if (liveFingerprint === addressFingerprint) {
    console.log(`  ok   and the same ${liveWallets.length} + ${liveAdmins.length} addresses`);
  } else {
    failures++;
    console.log(`  FAIL ${checkPath} lists different addresses (${liveFingerprint.slice(0, 12)}…)`);
  }
}

if (has('--write')) {
  const outPath = resolve(value('out', 'wallets.json'));
  if (existsSync(outPath) && !has('--force')) {
    cannotRun(`  ${outPath} already exists; pass --force to replace it deliberately`);
  }
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        version: 2,
        warning:
          'This mnemonic controls all 1,005 wallets and any funds in them. It is the only copy. Store it offline, never commit it, never paste it into a chat.',
        createdAt: backup.createdAt ?? new Date().toISOString(),
        note: 'One mnemonic replaces 1,005 private keys. Derive any address with its path and index below; tools/fund.mjs derives the distribution wallets for you and checks them against the list here.',
        mnemonic: phrase,
        paths: {
          wallets: { path: walletPath, count: walletCount, indexRange: `0..${walletCount - 1}` },
          admins: { path: adminPath, count: adminCount, indexRange: `0..${adminCount - 1}` },
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
      `# ${walletCount} distribution wallets from ${walletPath}/0..${walletCount - 1}`,
      ...wallets,
      '',
      `# ${adminCount} administrator wallets from ${adminPath}/0..${adminCount - 1}`,
      ...admins,
      '',
    ].join('\n')
  );
  console.log(`  wrote  ${outPath} and ${addressesPath}`);
}

if (failures) {
  console.log(`  restore FAILED (${failures}) — this backup does NOT reproduce its own addresses`);
  process.exit(1);
}
console.log('  restore PASSED: this backup re-derives every address it lists');
