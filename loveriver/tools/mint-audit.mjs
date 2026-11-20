#!/usr/bin/env node
/**
 * Rebuilds the mint history from chain Transfer events, over a date range.
 *
 * WHY THIS EXISTS
 *
 * The local ledger (mint-ledger.jsonl) destroys every line ten minutes after the mint, on
 * purpose, so it is not an audit trail. The chain is: every mint is a `Transfer(0x0 -> to)`
 * log, which nothing can rewrite. This reads them back — and checks the thing an audit must not
 * merely assume, that the owner's key signed each one.
 *
 *   from the chain     recipient, amount, block, timestamp, tx hash, signer, and the owner at
 *                      that block. mint() is owner-only, so the last two must agree.
 *   only in the ledger which rule fired (floor or full) and which mint window was open. Gone
 *                      after ten minutes by design; amounts and recipients are not.
 *
 * Burns (`Transfer(feeWallet -> 0x0)`) are reported too: they are the only thing that lowers
 * totalSupply, and a supply audit that ignored them would be wrong.
 *
 *   node tools/mint-audit.mjs --rpc http://127.0.0.1:8545 --token 0x...
 *   node tools/mint-audit.mjs --rpc ... --token ... --from 2026-11-20 --to 2026-11-20
 *   node tools/mint-audit.mjs --rpc ... --token ... --json > mints.json
 *   node tools/mint-audit.mjs --rpc ... --token ... --invariant
 *   node tools/mint-audit.mjs --selftest
 *
 * --invariant audits the WHOLE chain (block 0 to the head, --from and --to ignored) and then
 * requires issued - burned to equal totalSupply(). A range would make that arithmetic
 * meaningless: a day's mints minus a day's burns is not the supply. This is the mode the
 * schedule runs, so an unauthorised mint or burn surfaces within a day instead of at audit
 * time, and a supply that does not add up is a failed check, not a footnote.
 *
 * A bare date is a whole UTC day; an ISO instant is taken as given.
 *
 * Exit codes: 0 the range was read and every mint was signed by the owner, 1 a check failed (a
 * mint the owner did not sign), 2 could not run — including an address with no contract on that
 * chain, which is a typo or the wrong network, not an empty audit.
 */
import { JsonRpcProvider, Interface, formatUnits } from 'ethers';
import { DEFAULT_DEPLOYMENTS, deploymentFor } from './deployments.mjs';

const DAY_MS = 86_400_000;
const CHUNK = 10_000; // blocks per eth_getLogs call, under every common node limit
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 || at === argv.length - 1 ? fallback : argv[at + 1];
};

/** Stop with the reason. Exit 2 says no answer was produced — not that the token is clean. */
function cannotRun(reason) {
  console.error(`  ${reason}`);
  process.exit(2);
}

const iso = (ms) => new Date(ms).toISOString();
const lvr = (wei) => formatUnits(wei, 18);

/** A bare date is that whole UTC day; anything else is an instant. */
const parseStart = (text) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text);
const parseEnd = (text) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.999Z` : text);

/**
 * First block in [0, latest] at or after `targetMs`, or null if every block is older.
 * Block times only move forward, so the height can be binary searched: a range on a chain of
 * millions of blocks costs a couple of dozen block reads, not millions.
 */
async function firstBlockAtOrAfter(timeAt, latest, targetMs) {
  if ((await timeAt(latest)) < targetMs) return null;
  if ((await timeAt(0)) >= targetMs) return 0;
  let low = 0;
  let high = latest; // invariant: time(low) < target <= time(high)
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if ((await timeAt(middle)) < targetMs) low = middle;
    else high = middle;
  }
  return high;
}

/** Last block at or before `targetMs`, or null if every block is later. */
async function lastBlockAtOrBefore(timeAt, latest, targetMs) {
  if ((await timeAt(0)) > targetMs) return null;
  const after = await firstBlockAtOrAfter(timeAt, latest, targetMs + 1);
  return after === null ? latest : after - 1;
}

if (has('--selftest')) {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = String(actual) === String(expected);
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) console.log(`       got ${actual}, expected ${expected}`);
  };

  // The search is the one piece that can be quietly off by a block, so it is checked against a
  // fixed timestamp sequence rather than trusted. Two blocks share a timestamp on purpose.
  const times = [1000, 2000, 2000, 5000];
  const timeAt = async (n) => times[n];

  check('first at or after an instant inside block 1', await firstBlockAtOrAfter(timeAt, 3, 1500), 1);
  check('first at or after a timestamp shared by two blocks picks the earlier', await firstBlockAtOrAfter(timeAt, 3, 2000), 1);
  check('first at or after the last block', await firstBlockAtOrAfter(timeAt, 3, 5000), 3);
  check('first at or after the chain is null', await firstBlockAtOrAfter(timeAt, 3, 5001), null);
  check('last at or before an instant inside block 3', await lastBlockAtOrBefore(timeAt, 3, 4000), 2);
  check('last at or before a timestamp shared by two blocks picks the later', await lastBlockAtOrBefore(timeAt, 3, 2000), 2);
  check('last at or before the first block', await lastBlockAtOrBefore(timeAt, 3, 1000), 0);
  check('last at or before the chain starts is null', await lastBlockAtOrBefore(timeAt, 3, 999), null);

  check('a bare date starts at midnight UTC', iso(parseStart('2026-11-20')), '2026-11-20T00:00:00.000Z');
  check('a bare date ends at the last millisecond of that UTC day', iso(parseEnd('2026-11-20')), '2026-11-20T23:59:59.999Z');
  check('an ISO instant passes through', iso(parseStart('2026-11-20T13:05:00Z')), '2026-11-20T13:05:00.000Z');

  console.log(failures === 0 ? '  audit selftest PASSED' : `  audit selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const invariant = has('--invariant');

const rpc = value('rpc', process.env.RPC_URL);
const givenToken = value('token', process.env.LOVERIVER_TOKEN);
if (!rpc) cannotRun('--rpc is required (or RPC_URL)');
if (givenToken && !/^0x[0-9a-fA-F]{40}$/.test(givenToken)) cannotRun(`--token ${givenToken} is not an address`);

const fromText = value('from', iso(Date.now() - DAY_MS));
const toText = value('to', iso(Date.now()));
const fromMs = parseStart(fromText);
const toMs = parseEnd(toText);
if (!Number.isFinite(fromMs)) cannotRun(`--from ${fromText} is not a date or an instant`);
if (!Number.isFinite(toMs)) cannotRun(`--to ${toText} is not a date or an instant`);
if (fromMs > toMs) cannotRun(`--from ${iso(fromMs)} is after --to ${iso(toMs)}`);

const provider = new JsonRpcProvider(rpc);
const network = await provider.getNetwork().catch(() => cannotRun(`cannot reach ${rpc}`));

// The address comes from deployments.json unless one was passed, looked up by the chain id the
// RPC reports rather than by whatever chain a copied command was written for.
let deployment = null;
let token = givenToken;
if (!token) {
  try {
    deployment = deploymentFor(network.chainId, value('deployments', DEFAULT_DEPLOYMENTS));
  } catch (error) {
    cannotRun(error.message);
  }
  token = deployment.token;
}

const code = await provider.getCode(token).catch(() => cannotRun(`cannot read the chain at ${rpc}`));
if (code === '0x') {
  cannotRun(
    `no contract at ${token} on chain ${network.chainId}, so there is no mint history to read.\n` +
      '  This is not an empty audit: nothing was read. Check the address for a typo, and check that\n' +
      '  the token lives on this chain — an address from another network has no code here either.'
  );
}

// mint() is owner-only, so the chain can prove the minting key: the sender of the transaction
// that carried the log has to be the owner at that moment.
const ownerIface = new Interface(['function owner() view returns (address)']);
const ownerCache = new Map();

/** owner() as of a block, or null where it cannot be read. Explicit eth_call with a tag:
 *  JsonRpcProvider.call(tx, blockTag) ignores the tag and answers from the head, which would
 *  compare every mint against today's owner and flag history the check exists to clear. */
async function ownerAt(blockTag) {
  if (ownerCache.has(blockTag)) return ownerCache.get(blockTag);
  let owner = null;
  try {
    const tag = typeof blockTag === 'number' ? `0x${blockTag.toString(16)}` : blockTag;
    const raw = await provider.send('eth_call', [{ to: token, data: ownerIface.encodeFunctionData('owner') }, tag]);
    if (raw && raw !== '0x') owner = ownerIface.decodeFunctionResult('owner', raw)[0].toLowerCase();
  } catch {
    owner = null;
  }
  ownerCache.set(blockTag, owner);
  return owner;
}

const currentOwner = await ownerAt('latest');
if (currentOwner === null) {
  cannotRun(
    `cannot read owner() from ${token}, so no mint can be shown to be owner-signed.\n` +
      '  Reporting the mints anyway would repeat the claim without checking it.'
  );
}

// deployments.json records who owned the token at deployment. If the chain disagrees, the file
// is stale - and a stale record is how an audit ends up confidently checking the wrong thing.
const recordedOwner = deployment?.owner ? deployment.owner.toLowerCase() : null;
const ownerDrifted = recordedOwner !== null && recordedOwner !== currentOwner;

const latest = await provider.getBlockNumber();
const timeCache = new Map();
async function timeAt(block) {
  if (!timeCache.has(block)) timeCache.set(block, (await provider.getBlock(block)).timestamp * 1000);
  return timeCache.get(block);
}

// --invariant has to see every mint and burn the token ever made, or the arithmetic below is
// comparing a slice against the whole.
const invariantStart = deployment?.deployBlock ?? 0;
const fromBlock = invariant ? invariantStart : await firstBlockAtOrAfter(timeAt, latest, fromMs);
const toBlock = invariant ? latest : await lastBlockAtOrBefore(timeAt, latest, toMs);
const inRange = fromBlock !== null && toBlock !== null && fromBlock <= toBlock;

const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = iface.getEvent('Transfer').topicHash;

/** Every log matching one topic set, in chunks a node will accept. */
async function transferLogs(from, to, topics) {
  const rows = [];
  for (let start = from; start <= to; start += CHUNK) {
    const logs = await provider.getLogs({ address: token, topics, fromBlock: start, toBlock: Math.min(start + CHUNK - 1, to) });
    rows.push(...logs);
  }
  return rows;
}

const shape = (log) => {
  const { args } = iface.parseLog({ topics: log.topics, data: log.data });
  return { block: log.blockNumber, txHash: log.transactionHash, to: args.to, amountWei: args.value };
};

const mints = inRange ? (await transferLogs(fromBlock, toBlock, [TRANSFER_TOPIC, ZERO_TOPIC])).map(shape) : [];
const burns = inRange ? (await transferLogs(fromBlock, toBlock, [TRANSFER_TOPIC, null, ZERO_TOPIC])).map(shape) : [];
for (const row of [...mints, ...burns]) row.at = iso(await timeAt(row.block));

// Verify the header's claim instead of restating it.
const signers = new Map();
const unsigned = [];
for (const row of mints) {
  if (!signers.has(row.txHash)) {
    const tx = await provider.getTransaction(row.txHash).catch(() => null);
    if (!tx) cannotRun(`transaction ${row.txHash} is not available, so the signer of the mint in block ${row.block} cannot be checked`);
    signers.set(row.txHash, tx.from.toLowerCase());
  }
  row.signer = signers.get(row.txHash);
  // The owner just before the mint. One in the deployment block has no earlier state, so it
  // falls forward to that block's own value — the constructor's owner.
  const before = row.block > 0 ? row.block - 1 : row.block;
  row.owner = (await ownerAt(before)) ?? (await ownerAt(row.block));
  if (row.owner === null) {
    cannotRun(`cannot read owner() at block ${before} or ${row.block}, so the mint in block ${row.block} cannot be checked`);
  }
  if (row.signer !== row.owner) unsigned.push(row);
}

const sum = (rows) => rows.reduce((total, row) => total + row.amountWei, 0n);
const issued = sum(mints);
const burned = sum(burns);
const net = issued - burned;
const blocksScanned = inRange ? toBlock - fromBlock + 1 : 0;

// A scan from 0 on a public chain is thousands of getLogs calls, which is how an audit gets
// rate limited into a confident "no mints". The start block comes from deployments.json; when
// the token was passed with --token there is no entry to read, so say what the fallback costs
// rather than leaving the operator to discover it as a timeout.
if (invariant && !deployment && fromBlock === 0 && blocksScanned > 0) {
  console.error(
    `  start block unknown: ${token} is not in deployments.json, so --invariant scans from block 0 - ` +
      `${Math.ceil(blocksScanned / CHUNK)} getLogs call(s) on this chain. Record the deploy with ` +
      'tools/record-deployment.mjs to start at its deploy block instead.'
  );
}

// The supply invariant: every token that exists came from a mint and every one that stopped
// existing went to a burn, so totalSupply() must equal issued - burned over the whole history.
const supplyIface = new Interface(['function totalSupply() view returns (uint256)']);
async function chainSupply() {
  try {
    const raw = await provider.send('eth_call', [{ to: token, data: supplyIface.encodeFunctionData('totalSupply') }, 'latest']);
    if (!raw || raw === '0x') return null;
    return supplyIface.decodeFunctionResult('totalSupply', raw)[0];
  } catch {
    return null;
  }
}

let chainTotal = null;
let supplyMatches = null;
if (invariant) {
  chainTotal = await chainSupply();
  if (chainTotal === null) {
    cannotRun(`cannot read totalSupply() from ${token}, so issued minus burned cannot be checked against the chain`);
  }
  supplyMatches = chainTotal === net;
}

const exitCode = unsigned.length > 0 || supplyMatches === false || ownerDrifted ? 1 : 0;
const amount = (row) => ({ ...row, amount: lvr(row.amountWei), amountWei: row.amountWei.toString() });

const report = {
  token,
  owner: currentOwner,
  chainId: Number(network.chainId),
  from: iso(fromMs),
  to: iso(toMs),
  fromBlock,
  toBlock,
  blocksScanned,
  deployment: deployment
    ? { chainId: deployment.chainId, token: deployment.token, deployBlock: deployment.deployBlock, owner: deployment.owner }
    : null,
  mints: mints.map(amount),
  burns: burns.map(amount),
  totals: { mintedWei: issued.toString(), minted: lvr(issued), burnedWei: burned.toString(), burned: lvr(burned) },
  ...(invariant
    ? { supply: { netWei: net.toString(), net: lvr(net), totalSupplyWei: chainTotal.toString(), totalSupply: lvr(chainTotal), matches: supplyMatches } }
    : {}),
};

if (has('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}

const out = [];
out.push(`  token  ${token} on chain ${network.chainId}${deployment ? ' (from deployments.json)' : ''}`);
out.push(`  owner  ${currentOwner}`);
if (ownerDrifted) out.push(`  record  deployments.json says owner ${deployment.owner}; the chain says ${currentOwner}`);
out.push(invariant ? `  range  block ${invariantStart} to the head, the whole life of the token (--invariant)` : `  range  ${iso(fromMs)} .. ${iso(toMs)}`);
if (fromBlock === null || toBlock === null) out.push('  blocks none: the chain has no block inside that range');
else if (fromBlock > toBlock) out.push(`  blocks none: blocks ${fromBlock} and later are already past ${iso(toMs)}`);
else out.push(`  blocks ${fromBlock}..${toBlock} (${blocksScanned} scanned)`);

if (mints.length === 0) out.push('  mints  none in this range');
else {
  out.push(`  mints  ${mints.length}, ${lvr(issued)} LVR issued`, '');
  for (const row of mints) {
    out.push(`  ${row.at}  block ${row.block}  ${lvr(row.amountWei)} LVR -> ${row.to}`);
    out.push(`  tx     ${row.txHash}`);
  }
}

if (mints.length > 0) {
  out.push('');
  if (unsigned.length === 0) {
    out.push(`  signed all ${mints.length} mint(s) by the owner`);
  } else {
    out.push(`  signed ${unsigned.length} of ${mints.length} mint(s) NOT by the owner:`);
    for (const row of unsigned) out.push(`    block ${row.block}  signer ${row.signer}  owner ${row.owner}  ${row.txHash}`);
    out.push('  mint() is owner-only, so a token that enforces it cannot produce this: the mint is');
    out.push('  either not owner-gated or the log did not come from that contract. Not clean.');
  }
}

if (burns.length > 0) {
  out.push('', `  burns  ${burns.length}, ${lvr(burned)} LVR destroyed`);
  for (const row of burns) {
    out.push(`  ${row.at}  block ${row.block}  ${lvr(row.amountWei)} LVR`);
    out.push(`  tx     ${row.txHash}`);
  }
}

if (mints.length > 0) {
  const byRecipient = new Map();
  for (const row of mints) byRecipient.set(row.to, (byRecipient.get(row.to) ?? 0n) + row.amountWei);
  out.push('', '  issued per recipient');
  for (const [address, total] of [...byRecipient].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))) {
    out.push(`    ${address}  ${lvr(total)} LVR`);
  }
}

out.push('', `  supply  ${lvr(issued)} issued, ${lvr(burned)} burned in this range; the chain has no window or rule column, only what happened`);

if (invariant) {
  out.push('');
  if (supplyMatches) {
    out.push(`  invariant  issued ${lvr(issued)} - burned ${lvr(burned)} = ${lvr(net)}, and totalSupply() is ${lvr(chainTotal)}: they agree`);
  } else {
    const delta = net - chainTotal;
    out.push('  INVARIANT FAILED: issued minus burned does not equal totalSupply().');
    out.push(`    issued - burned  ${lvr(net)} LVR`);
    out.push(`    totalSupply()    ${lvr(chainTotal)} LVR`);
    out.push(`    difference       ${lvr(delta)} LVR (${delta > 0n ? 'the chain holds less than the logs say' : 'the chain holds more than the logs say'})`);
    out.push('  One of these is true: a mint or burn happened without a Transfer log this run could');
    out.push('  see, the token exposes a supply it can change some other way, or the address is the');
    out.push('  wrong token on a chain that also carries this one. Treat the history as unverified.');
  }
}

console.log(out.join('\n'));
process.exit(exitCode);
