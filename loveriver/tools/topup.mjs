#!/usr/bin/env node
/**
 * Keeps the administrator wallets full, in two stages with different gates.
 *
 * THE RULE, AS WRITTEN INTO THIS SCRIPT
 *
 *   The five admin wallets are the pool that distribution spends from. Whatever they hold
 *   is the supply that exists for distribution; the distribution wallets hold only what has
 *   been paid out of it. So the pool is what must never be left empty.
 *
 *   Stage 1, the floor.   Below half of the mark, mint back to exactly half. This stage is
 *                         never gated: it is the rule that a wallet does not stay emptied,
 *                         and a rule with a calendar on it is not a floor.
 *   Stage 2, the full.    Between the floor and the mark, mint back to the mark. This stage
 *                         is the issuance, so `--within-window` puts it on the mint calendar
 *                         and outside a window it waits.
 *
 * An emptied wallet therefore goes to half at once and to full as soon as issuance is
 * allowed. Two mints instead of one when both stages run, which is the cost of being able
 * to say exactly which part of a refill was the safety floor and which was issuance.
 *
 * WHERE THE MARK COMES FROM
 *
 * Not from the balances, because a distribution drains those to nothing:
 *
 *   1. --target <LVR>     explicit, and recorded for later runs
 *   2. the recorded mark  written by fund.mjs just before it empties the admins
 *   3. the highest balance on chain, when nothing is recorded yet
 *
 * With nothing recorded and every admin at zero there is no "full" to refill to, so it
 * refuses and asks for --target rather than inventing a number. The mark is a ceiling until
 * a person moves it: only --target raises or lowers it.
 *
 * Minting is owner-only, so this signs with OWNER_KEY. It never moves tokens between admins
 * and never touches the fee wallet. Dry run is the default; sending needs --broadcast and
 * LOVERIVER_BROADCAST=yes.
 *
 *   node tools/topup.mjs --rpc ... --token ...
 *   node tools/topup.mjs --target 140000000000          set the mark, then plan
 *   node tools/topup.mjs --within-window                gate only the full stage
 *   ... add --broadcast and OWNER_KEY, with LOVERIVER_BROADCAST=yes in the environment
 */
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, HDNodeWallet, Mnemonic } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFullMark, writeFullMark } from './full-mark.mjs';
import { gmt11, nextWindowAfter, openWindowAt, resolveNow } from './mint-window.mjs';
import { appendLedger, purgeLedger, RETENTION_MS } from './mint-ledger.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const ABI = [
  'function mint(address to, uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function isAdmin(address) view returns (bool)',
];

const file = resolve(value('file', 'wallets.json'));
const stateFile = resolve('admin-full-mark.json');
const rpc = value('rpc', process.env.RPC_URL);
const tokenAddress = value('token', process.env.LOVERIVER_TOKEN);
const targetArg = value('target', '');
const ledgerFile = resolve(value('ledger', 'mint-ledger.jsonl'));

// The gate's argument is validated before any chain work: a bad --now is a usage error, not
// a reason to spend six RPC calls and print a balance report before failing.
const withinWindow = flag('within-window');
const gateAt = withinWindow ? resolveNow(value('now', '')) : null;

// Ten minutes and no more: whatever is already older than the retention is destroyed before
// this run reads or records anything, so an expired line is never left on disk for the next
// reader to find — including a run that turns out to have nothing to mint.
const stale = purgeLedger(ledgerFile, Date.now());
if (stale.removed > 0) console.log(`  ledger: destroyed ${stale.removed} expired entries, kept ${stale.kept}`);

const saved = JSON.parse(readFileSync(file, 'utf8'));
if (!saved.mnemonic || !saved.paths?.admins?.path || !Array.isArray(saved.admins)) {
  console.error(`  ${file} has no admin list or no admin derivation path`);
  process.exit(2);
}

// Same rule as the funder: the admin addresses are re-derived from the mnemonic and must
// match the stored list exactly before anything is signed.
const root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(saved.mnemonic), saved.paths.admins.path);
const admins = saved.admins.map((_, index) => root.deriveChild(index).address);
const bad = admins.findIndex(
  (address, index) => address.toLowerCase() !== String(saved.admins[index]).toLowerCase()
);
if (bad !== -1) {
  console.error(`  derived admin ${bad} does not match the stored list; refusing to run`);
  process.exit(2);
}
console.log(`  ${admins.length} admin addresses derived from ${saved.paths.admins.path}, all match the file`);

if (!rpc || !tokenAddress) {
  console.error('  --rpc and --token are required: balances are read, never assumed');
  process.exit(2);
}

const provider = new JsonRpcProvider(rpc);
const reader = new Contract(tokenAddress, ABI, provider);
const balances = await Promise.all(admins.map((address) => reader.balanceOf(address)));
const highest = balances.reduce((max, balance) => (balance > max ? balance : max), 0n);

// Resolve the mark. --target wins because it is the only input that came from a person
// rather than from what happens to be on chain.
const recorded = readFullMark(stateFile);
let target;
let source;
if (targetArg) {
  if (!/^\d+$/.test(targetArg) || BigInt(targetArg) === 0n) {
    console.error(`  --target ${targetArg} is not a whole number of LVR greater than zero`);
    process.exit(2);
  }
  target = parseUnits(targetArg, 18);
  source = '--target';
} else if (recorded) {
  target = recorded.fullMark;
  source = `recorded ${recorded.recordedAt} by ${recorded.source}`;
} else if (highest > 0n) {
  target = highest;
  source = 'the highest admin balance (nothing recorded yet)';
} else {
  console.error(
    '  every admin wallet is empty and no full mark has been recorded, so there is no\n' +
      '  "full" to refill to. Set one explicitly; it is remembered for later runs:\n' +
      '    node tools/topup.mjs --target <LVR per admin> --rpc ... --token ...'
  );
  process.exit(1);
}

if (!recorded || target !== recorded.fullMark) {
  writeFullMark(stateFile, target, source === '--target' ? '--target' : 'topup.mjs');
  console.log(`  full mark recorded -> ${stateFile}`);
}
const floor = target / 2n;
console.log(
  `  full mark ${formatUnits(target, 18)} LVR per admin, half floor ${formatUnits(floor, 18)} (${source})`
);

// Two lists, because the two stages are different promises: below the floor is a wallet that
// may not stay empty, below the mark is issuance that the calendar may refuse.
const floorTopUps = [];
const fullTopUps = [];
balances.forEach((balance, index) => {
  const percent = (Number((balance * 10_000n) / target) / 100).toFixed(1);
  const state =
    balance === 0n ? 'EMPTY' : balance < floor ? 'below floor' : balance < target ? 'floor to full' : 'full';
  console.log(`    ${admins[index]}  ${formatUnits(balance, 18)} LVR (${percent}%)  ${state}`);
  if (balance < floor) floorTopUps.push({ address: admins[index], amount: floor - balance });
  const afterFloor = balance < floor ? floor : balance;
  if (afterFloor < target) fullTopUps.push({ address: admins[index], amount: target - afterFloor });
});

// The floor is not gated. Only stage 2 asks the calendar.
const gateOpen = withinWindow ? openWindowAt(gateAt) : null;
const canIssue = !withinWindow || gateOpen !== null;
if (withinWindow) {
  if (gateOpen) {
    console.log(`  mint window open: ${gateOpen.label} until ${gmt11(gateOpen.close)}`);
  } else {
    const next = nextWindowAfter(gateAt);
    console.log(`  no mint window open at ${gmt11(gateAt)}: the floor is restored, the full stage waits`);
    console.log(`    next window: ${next.label} of ${next.year}, opening ${gmt11(next.open)}`);
  }
}
// What the ledger's window field says: the window that was open, 'none' when the floor ran
// outside one, 'ungated' when this run never consulted the calendar. Recording a window the
// run did not enforce would be a worse record than recording none.
const windowLabel = !withinWindow ? 'ungated' : gateOpen ? `${gateOpen.label} of ${gateOpen.year}` : 'none';

const phases = [];
if (floorTopUps.length > 0) phases.push({ rule: 'floor', name: 'floor: back to half, never empty', items: floorTopUps });
if (canIssue && fullTopUps.length > 0) phases.push({ rule: 'full', name: 'full: back to the mark', items: fullTopUps });

const total = phases.reduce(
  (sum, phase) => sum + phase.items.reduce((phaseSum, item) => phaseSum + item.amount, 0n),
  0n
);

if (phases.length === 0) {
  if (fullTopUps.length > 0) {
    console.log('  nothing to mint until the window opens: every wallet is above the floor');
  } else {
    console.log(`  nothing to do: every admin holds the full ${formatUnits(target, 18)} LVR`);
  }
  process.exit(0);
}

console.log(`  plan: mint ${formatUnits(total, 18)} LVR across ${phases.length} stage(s)`);
for (const phase of phases) {
  console.log(`    ${phase.name}`);
  for (const item of phase.items) console.log(`      +${formatUnits(item.amount, 18)} -> ${item.address}`);
}
console.log(`  totalSupply now ${formatUnits(await reader.totalSupply(), 18)} LVR; this plan is inflation, by design`);

if (!flag('broadcast')) {
  console.log('  DRY RUN — nothing minted. Add --broadcast and LOVERIVER_BROADCAST=yes to send.');
  process.exit(0);
}
if (process.env.LOVERIVER_BROADCAST !== 'yes') {
  console.error('  refusing to broadcast without LOVERIVER_BROADCAST=yes in the environment');
  process.exit(2);
}

const key = process.env.OWNER_KEY;
if (!key) {
  console.error('  OWNER_KEY (the mint authority) is not set; mint() is owner-only');
  process.exit(2);
}

const owner = new Wallet(key, provider);
const tokenOwner = await reader.owner();
if (tokenOwner.toLowerCase() !== owner.address.toLowerCase()) {
  console.error(`  ${owner.address} is not the owner of this token (owner is ${tokenOwner}); mint would revert`);
  process.exit(1);
}

// A refilled wallet that cannot distribute is useless, so say it now rather than after the
// first mint.
for (const admin of admins) {
  if (!(await reader.isAdmin(admin))) {
    console.error(`  ${admin} is not an admin on this token; refilling it would not help distribution`);
    process.exit(1);
  }
}

const writer = new Contract(tokenAddress, ABI, owner);
let nonce = await provider.getTransactionCount(owner.address, 'pending');
for (const phase of phases) {
  console.log(`  ${phase.name}`);
  for (const item of phase.items) {
    const tx = await writer.mint(item.address, item.amount, { nonce: nonce++ });
    await tx.wait();
    // One line per mint that actually happened, written only after it is mined.
    appendLedger(ledgerFile, {
      at: new Date().toISOString(),
      rule: phase.rule,
      window: windowLabel,
      admin: item.address,
      amount: formatUnits(item.amount, 18),
      txHash: tx.hash,
    });
    console.log(`    ${item.address} +${formatUnits(item.amount, 18)} LVR (${tx.hash})`);
  }
}
const held = purgeLedger(ledgerFile, Date.now());
console.log(`  done: floor restored everywhere it was needed, ${phases.length} stage(s) minted`);
console.log(
  `  ledger: ${held.kept} entr${held.kept === 1 ? 'y' : 'ies'} kept ${RETENTION_MS / 60000} minutes then destroyed; ` +
    'the chain keeps the permanent record'
);
