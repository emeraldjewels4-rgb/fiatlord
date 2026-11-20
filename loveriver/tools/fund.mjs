#!/usr/bin/env node
/**
 * Fills the first interval of the distribution wallets from the pooled admin supply.
 *
 * The amount is not typed in. The five admin addresses are re-derived from the mnemonic and
 * their on-chain balances summed into a pool; that pool is divided by the number of wallets
 * in the interval, and each admin sends its own balance divided by that same number in one
 * distributeRange() call covering all of them. Five equal admins are one pass of five
 * calls, and every wallet in the interval ends up holding the same share of the whole pool.
 *
 * `--first 1000` is the same operation over every wallet: there is no separate sweep mode
 * because the interval already is one.
 *
 * The full mark is recorded here, before the admins are emptied, because this is the last
 * moment it is visible on chain (see tools/full-mark.mjs).
 *
 * Safe to re-run: only empty wallets are filled. A wallet holding less than the share stops
 * the run instead of being skipped, because that is the shape of an interrupted fill and
 * finishing around it silently would leave the interval uneven.
 *
 * Keys are never stored: the admin signing keys are derived at run time from the same
 * mnemonic the addresses come from, which is also the only file this script needs.
 *
 *   node tools/fund.mjs --rpc ...                        plan only
 *   ... add --broadcast and LOVERIVER_BROADCAST=yes to send
 *
 * The token address comes from the committed deployments.json, looked up by the chain id the
 * RPC reports - the same file the audit and the top-up read, so a fill cannot be aimed at the
 * wrong token by a typo in a shell history. --token still overrides it for a one-off.
 */
import { JsonRpcProvider, Wallet, Contract, formatUnits, HDNodeWallet, Mnemonic } from 'ethers';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFullMark, writeFullMark } from './full-mark.mjs';
import { DEFAULT_DEPLOYMENTS, deploymentFor } from './deployments.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const ABI = [
  'function distributeRange(address[] to, uint256 perWallet, uint256 start, uint256 end)',
  'function balanceOf(address) view returns (uint256)',
  'function isAdmin(address) view returns (bool)',
];

// Balance reads go out in small groups: 1,000 individual calls at once is what rate limits
// are for, and a failed read must not be mistaken for an empty wallet.
const READ_CONCURRENCY = 25;

const file = resolve(value('file', 'wallets.json'));
const stateFile = resolve('admin-full-mark.json');
const rpc = value('rpc', process.env.RPC_URL);
const first = value('first', '100');

// The same rule in the same place as mint-audit.mjs: a malformed --token is refused before
// wallets.json is parsed or a provider is built, so a typo costs a second rather than a file read
// and a connection. Empty means "look it up in deployments.json by the chain id the RPC reports".
const givenToken = value('token', process.env.LOVERIVER_TOKEN);
if (givenToken && !/^0x[0-9a-fA-F]{40}$/.test(givenToken)) {
  console.error(`  --token ${givenToken} is not an address`);
  process.exit(2);
}
let tokenAddress = givenToken;

// Offline by construction: the lookup reads the committed file, the refusal reads argv, and the
// command-line case is a child process - no RPC, no mnemonic, no signing key, and it works on a
// checkout with no wallets.json at all. This is the tool that moves the admins' whole supply, so
// the two things it must not get wrong are which token it aims at and which addresses it refuses.
if (flag('selftest')) {
  let failures = 0;
  const check = (label, ok) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  };
  const committed = JSON.parse(readFileSync(DEFAULT_DEPLOYMENTS, 'utf8'));

  check(
    'the token for a recorded chain is the one in deployments.json',
    deploymentFor(31337).token === committed['31337'].token && /^0x[0-9a-fA-F]{40}$/.test(committed['31337'].token)
  );
  let unknown = '';
  try { deploymentFor(424242); } catch (error) { unknown = error.message; }
  check('an unrecorded chain is refused, named, and points at --token', unknown.includes('424242') && unknown.includes('--token'));

  // The command line itself, because a refusal that only exists inside a helper is not the one an
  // operator hits. Neither run reaches an RPC: the first stops at argv, the second at wallets.json.
  const child = spawnSync(process.execPath, [process.argv[1], '--token', '0xnot-an-address'], { encoding: 'utf8' });
  check(
    '--token that is not an address exits 2 and names it',
    child.status === 2 && /is not an address/.test(`${child.stderr}`) && child.stderr.includes('0xnot-an-address')
  );
  const without = spawnSync(process.execPath, [process.argv[1]], { encoding: 'utf8' });
  check(
    'with no --token it goes on to wallets.json instead of refusing an address',
    without.status !== 0 && !/is not an address/.test(`${without.stderr}`)
  );

  console.log(failures === 0 ? '  fund selftest PASSED' : `  fund selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const saved = JSON.parse(readFileSync(file, 'utf8'));
if (!saved.mnemonic || !saved.paths?.wallets?.path || !saved.paths?.admins?.path) {
  console.error(
    `  ${file} has no mnemonic, wallet path or admin path. Regenerate it with tools/gen-wallets.mjs:\n` +
      '  this funder derives addresses and signing keys instead of reading stored ones.'
  );
  process.exit(2);
}

// Derive, then compare every address with the stored list. This is the check that keeps one
// mnemonic as trustworthy as 1,005 saved keys: the two must agree exactly.
function derive(path, count, stored, label) {
  const node = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(saved.mnemonic), path);
  const nodes = Array.from({ length: count }, (_, index) => node.deriveChild(index));
  const addresses = nodes.map((child) => child.address);
  const bad = addresses.findIndex(
    (address, index) => address.toLowerCase() !== String(stored[index]).toLowerCase()
  );
  if (bad !== -1) {
    console.error(
      `  derived ${label} ${bad} does not match the stored list:\n` +
        `    derived ${addresses[bad]}\n    stored  ${stored[bad]}`
    );
    process.exit(2);
  }
  console.log(`  ${count} ${label} addresses derived from ${path}, all match the file`);
  return nodes;
}

if (!Array.isArray(saved.wallets) || !Array.isArray(saved.admins) || saved.admins.length === 0) {
  console.error(`  ${file} lists no wallets or no admins`);
  process.exit(2);
}
const walletNodes = derive(saved.paths.wallets.path, saved.paths.wallets.count ?? saved.wallets.length, saved.wallets, 'wallet');
const adminNodes = derive(saved.paths.admins.path, saved.admins.length, saved.admins, 'admin');
const admins = adminNodes.map((node) => node.address);
const wallets = walletNodes.map((node) => node.address);

if (!/^\d+$/.test(first) || Number(first) < 1 || Number(first) > wallets.length) {
  console.error(`  --first ${first} is not a wallet count between 1 and ${wallets.length}`);
  process.exit(2);
}
const count = Number(first);
const targets = wallets.slice(0, count);

if (!rpc) {
  console.error('  --rpc is required: the pool is read, never assumed');
  process.exit(2);
}

// The address comes from deployments.json unless one was passed, looked up by the chain id the
// RPC reports. A fill aimed at a token that is not LVR would empty the admins into nothing,
// which is the failure this lookup exists to make impossible by not needing to be typed.
const provider = new JsonRpcProvider(rpc);
if (!tokenAddress) {
  let network;
  try {
    network = await provider.getNetwork();
  } catch (error) {
    console.error(`  cannot read the chain at ${rpc}: ${error.message}`);
    process.exit(2);
  }
  try {
    const deployment = deploymentFor(network.chainId, value('deployments', DEFAULT_DEPLOYMENTS));
    tokenAddress = deployment.token;
    console.log(`  token ${tokenAddress} from deployments.json (chain ${network.chainId})`);
  } catch (error) {
    console.error(`  ${error.message}`);
    process.exit(2);
  }
}

async function readBalances(reader, list) {
  const balances = new Array(list.length);
  for (let i = 0; i < list.length; i += READ_CONCURRENCY) {
    const group = list.slice(i, i + READ_CONCURRENCY);
    const values = await Promise.all(group.map((address) => reader.balanceOf(address)));
    values.forEach((value, offset) => {
      balances[i + offset] = value;
    });
  }
  return balances;
}

const reader = new Contract(tokenAddress, ABI, provider);
console.log(`  reading ${count} wallet balances and ${admins.length} admin balances ...`);
const balances = await readBalances(reader, targets);
const vaults = await readBalances(reader, admins);

const pool = vaults.reduce((sum, balance) => sum + balance, 0n);

// This is the last moment the admin wallets are full: the fill below spends them down to
// nothing. Record the mark now, or no later run can know what "full" was.
const observed = vaults.reduce((max, balance) => (balance > max ? balance : max), 0n);
const previousMark = readFullMark(stateFile);
if (observed > 0n && (previousMark === null || observed > previousMark.fullMark)) {
  writeFullMark(stateFile, observed, 'fund.mjs interval fill');
  console.log(
    `  full mark recorded: ${formatUnits(observed, 18)} LVR per admin -> ${stateFile}` +
      (previousMark ? ` (was ${formatUnits(previousMark.fullMark, 18)})` : '')
  );
}

if (pool === 0n) {
  const holding = balances.filter((balance) => balance > 0n).length;
  if (holding === count) {
    console.log(`  all ${count} wallets already hold tokens and the admins are empty: nothing to send`);
    process.exit(0);
  }
  console.error(
    `  every admin wallet is empty and ${count - holding} wallet(s) in the interval hold nothing: there is no supply to split`
  );
  process.exit(1);
}

// Integer division, deliberately: a share is a whole number of wei and the remainder stays
// with the admins rather than being invented.
const perWallet = pool / BigInt(count);
if (perWallet === 0n) {
  console.error(`  pooled supply ${formatUnits(pool, 18)} LVR is smaller than the ${count} wallets in the interval`);
  process.exit(1);
}

const empty = [];
const partial = [];
balances.forEach((balance, index) => {
  if (balance >= perWallet) return;
  if (balance > 0n) partial.push({ address: targets[index], balance });
  else empty.push(targets[index]);
});

// An interrupted fill leaves every wallet holding a fraction of the share. Finishing around
// those would send different amounts to identical wallets, so this stops instead.
if (partial.length > 0) {
  console.error(
    `  ${partial.length} of ${count} wallets hold less than the ${formatUnits(perWallet, 18)} LVR share, ` +
      'which is the shape of an interrupted fill:'
  );
  for (const { address, balance } of partial.slice(0, 3)) {
    console.error(`    ${address} holds ${formatUnits(balance, 18)} LVR`);
  }
  if (partial.length > 3) console.error(`    ... and ${partial.length - 3} more`);
  console.error('  nothing sent. Top those wallets up to the share, or reset, before filling again.');
  process.exit(1);
}

// Each admin sends the same amount per wallet, so the interval holds one share of the pool
// no matter how many of its wallets still need filling.
const contributions = vaults.map((balance) => balance / BigInt(count));
const share = contributions.reduce((sum, amount) => sum + amount, 0n);
const sent = share * BigInt(empty.length);
const dust = pool - sent;

console.log(`  pooled admin supply ${formatUnits(pool, 18)} LVR across ${admins.length} admin wallets`);
console.log(`  interval 0..${count}: ${count} wallets, ${formatUnits(share, 18)} LVR each (pool / ${count})`);
for (let i = 0; i < admins.length; i++) {
  if (contributions[i] === 0n) continue;
  console.log(
    `    ${admins[i]} sends ${formatUnits(contributions[i], 18)} LVR each ` +
      `from ${formatUnits(vaults[i], 18)} LVR`
  );
}
console.log(
  `  plan: ${empty.length} empty wallet(s), ${formatUnits(sent, 18)} LVR sent, ` +
    `${formatUnits(dust, 18)} LVR left in the admins`
);
if (empty.length > 0) console.log(`  first ${empty[0]}   last ${empty[empty.length - 1]}`);
else {
  console.log('  every wallet in the interval already holds the share: nothing to send');
  process.exit(0);
}

if (!flag('broadcast')) {
  console.log('  DRY RUN — nothing sent. Add --broadcast and LOVERIVER_BROADCAST=yes to send.');
  process.exit(0);
}
if (process.env.LOVERIVER_BROADCAST !== 'yes') {
  console.error('  refusing to broadcast without LOVERIVER_BROADCAST=yes in the environment');
  process.exit(2);
}

const token = new Contract(tokenAddress, ABI, provider);
const signers = adminNodes
  .map((node, index) => ({ address: admins[index], amount: contributions[index], vault: vaults[index], wallet: new Wallet(node.privateKey, provider) }))
  .filter((signer) => signer.amount > 0n);

// distributeRange is admin-only and needs gas, and finding out halfway through means a
// half-filled interval: both are checked for every sender before the first call.
const nonces = new Map();
for (const signer of signers) {
  if (!(await token.isAdmin(signer.address))) {
    console.error(`  ${signer.address} is not an admin on this token; distributeRange is admin-only`);
    process.exit(1);
  }
  if ((await provider.getBalance(signer.address)) === 0n) {
    console.error(`  ${signer.address} holds LVR but no native coin for gas; fund it before broadcasting`);
    process.exit(1);
  }
  nonces.set(signer.address, await provider.getTransactionCount(signer.address, 'pending'));
}

for (const signer of signers) {
  const nonce = nonces.get(signer.address);
  nonces.set(signer.address, nonce + 1);
  const tx = await new Contract(tokenAddress, ABI, signer.wallet).distributeRange(
    empty,
    signer.amount,
    0,
    empty.length,
    { nonce }
  );
  await tx.wait();
  console.log(`    ${signer.address} filled all ${empty.length} empty wallets in one call (${tx.hash})`);
}
console.log(`  done: interval 0..${count} filled in ${signers.length} call(s), no fee charged`);
console.log('  the admin pool is now empty: tools/topup.mjs restores the half floor at once and the full mark inside a window');
