#!/usr/bin/env node
/**
 * Rebuilds the mint history from chain Transfer events, over a date range.
 *
 * WHY THIS EXISTS
 *
 * The local ledger (mint-ledger.jsonl) destroys every line ten minutes after the mint, on
 * purpose. That makes it useless as an audit trail, and it was never meant to be one: the
 * chain is. The contract emits the standard Transfer event for everything, and a mint is
 * specifically `Transfer(address(0) -> to, amount)`, so the complete, permanent record of
 * every issuance is already in the blocks. This reads it back.
 *
 * What it can and cannot recover is worth stating, because the difference is the point of
 * comparing the two records:
 *
 *   from the chain   recipient, amount, block, timestamp, tx hash, and the fact that the
 *                    owner's key signed it. Permanent and uneditable.
 *   only in the ledger  which rule fired (floor or full) and which mint window was open.
 *                    That context is gone after ten minutes, by design; the amounts and
 *                    recipients are not.
 *
 * It also reports burns, `Transfer(feeWallet -> address(0))`, since those are the only thing
 * that lowers totalSupply and an audit of supply that ignored them would be wrong.
 *
 *   node tools/mint-audit.mjs --rpc http://127.0.0.1:8545 --token 0x...
 *   node tools/mint-audit.mjs --rpc ... --token ... --from 2026-11-20 --to 2026-11-20
 *   node tools/mint-audit.mjs --rpc ... --token ... --json > mints.json
 *   node tools/mint-audit.mjs --selftest
 *
 * A bare date is a whole UTC day: --from 2026-11-20 means from 00:00:00.000Z, and --to
 * 2026-11-20 means through 23:59:59.999Z. An ISO instant is taken as given.
 *
 * Exit codes: 0 the range was read (including "no mints"), 1 a check failed, 2 could not run.
 */
import { JsonRpcProvider, Interface, ZeroAddress, formatUnits } from 'ethers';

const DAY_MS = 86_400_000;
const DEFAULT_CHUNK = 10_000;

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

/** A bare date is that whole UTC day; anything else is an instant. */
function parseStart(text) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00.000Z`);
  return Date.parse(text);
}
function parseEnd(text) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T23:59:59.999Z`);
  return Date.parse(text);
}

/**
 * First block whose timestamp is at or after `targetMs`, or null if the chain is older than
 * that. Blocks are ordered in time, so this is a binary search rather than a scan: a range on
 * a chain of millions of blocks costs a couple of dozen block reads, not millions.
 */
export async function firstBlockAtOrAfter(blockTimeAt, latest, targetMs) {
  let low = 0;
  let high = latest;
  let found = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const at = await blockTimeAt(middle);
    if (at >= targetMs) {
      found = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

/** Last block whose timestamp is at or before `targetMs`, or null if the chain starts later. */
export async function lastBlockAtOrBefore(blockTimeAt, latest, targetMs) {
  let low = 0;
  let high = latest;
  let found = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const at = await blockTimeAt(middle);
    if (at <= targetMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

const iso = (ms) => new Date(ms).toISOString();
const lvr = (wei) => formatUnits(wei, 18);
const day = (ms) => iso(ms).slice(0, 10);

// The search is the one piece here that can be quietly off by a block, so it is checked
// against a fixed timestamp sequence rather than trusted.
if (has('--selftest')) {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = String(actual) === String(expected);
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) console.log(`       got ${actual}, expected ${expected}`);
  };

  const times = [1000, 2000, 2000, 5000];
  const blockTimeAt = async (n) => times[n];

  check('first at or after an instant inside block 1', await firstBlockAtOrAfter(blockTimeAt, 3, 1500), 1);
  check('first at or after a timestamp shared by two blocks picks the earlier', await firstBlockAtOrAfter(blockTimeAt, 3, 2000), 1);
  check('first at or after the last block', await firstBlockAtOrAfter(blockTimeAt, 3, 5000), 3);
  check('first at or after the chain is null', await firstBlockAtOrAfter(blockTimeAt, 3, 5001), null);
  check('last at or before an instant inside block 3', await lastBlockAtOrBefore(blockTimeAt, 3, 4000), 2);
  check('last at or before a timestamp shared by two blocks picks the later', await lastBlockAtOrBefore(blockTimeAt, 3, 2000), 2);
  check('last at or before the first block', await lastBlockAtOrBefore(blockTimeAt, 3, 1000), 0);
  check('last at or before the chain starts is null', await lastBlockAtOrBefore(blockTimeAt, 3, 999), null);

  check('a bare date starts at midnight UTC', iso(parseStart('2026-11-20')), '2026-11-20T00:00:00.000Z');
  check('a bare date ends at the last millisecond of that UTC day', iso(parseEnd('2026-11-20')), '2026-11-20T23:59:59.999Z');
  check('an ISO instant passes through', iso(parseStart('2026-11-20T13:05:00Z')), '2026-11-20T13:05:00.000Z');

  console.log(failures === 0 ? '  audit selftest PASSED' : `  audit selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const rpc = value('rpc', process.env.RPC_URL);
const token = value('token', process.env.LOVERIVER_TOKEN);
if (!rpc || !token) cannotRun('  --rpc and --token are required (or RPC_URL and LOVERIVER_TOKEN)');
if (!/^0x[0-9a-fA-F]{40}$/.test(token)) cannotRun(`  --token ${token} is not an address`);

const nowMs = Date.now();
const fromText = value('from', iso(nowMs - DAY_MS));
const toText = value('to', iso(nowMs));
const fromMs = parseStart(fromText);
const toMs = parseEnd(toText);
if (!Number.isFinite(fromMs)) cannotRun(`  --from ${fromText} is not a date or an instant`);
if (!Number.isFinite(toMs)) cannotRun(`  --to ${toText} is not a date or an instant`);
if (fromMs > toMs) cannotRun(`  --from ${iso(fromMs)} is after --to ${iso(toMs)}`);

const chunk = Number(value('chunk', DEFAULT_CHUNK));
if (!Number.isInteger(chunk) || chunk < 1) cannotRun(`  --chunk ${value('chunk')} is not a positive block count`);

const provider = new JsonRpcProvider(rpc);
const network = await provider.getNetwork().catch(() => cannotRun(`  cannot reach ${rpc}`));
const latest = await provider.getBlockNumber();

const timeCache = new Map();
async function blockTime(n) {
  if (!timeCache.has(n)) {
    const block = await provider.getBlock(n);
    if (!block) throw new Error(`block ${n} is not available from this node`);
    timeCache.set(n, block.timestamp * 1000);
  }
  return timeCache.get(n);
}

const fromBlock = await firstBlockAtOrAfter(blockTime, latest, fromMs);
const toBlock = await lastBlockAtOrBefore(blockTime, latest, toMs);

const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = iface.getEvent('Transfer').topicHash;
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

/** Every Transfer matching one topic filter, in chunks a node will accept. */
async function transferLogs(from, to, topics) {
  const rows = [];
  let requests = 0;
  for (let start = from; start <= to; start += chunk) {
    const end = Math.min(start + chunk - 1, to);
    const logs = await provider.getLogs({ address: token, topics, fromBlock: start, toBlock: end });
    requests++;
    if (logs.length > 0) rows.push(...logs);
  }
  return { rows, requests };
}

let mints = [];
let burns = [];
let requests = 0;
if (fromBlock !== null && toBlock !== null && fromBlock <= toBlock) {
  const mintLogs = await transferLogs(fromBlock, toBlock, [TRANSFER_TOPIC, ZERO_TOPIC]);
  const burnLogs = await transferLogs(fromBlock, toBlock, [TRANSFER_TOPIC, null, ZERO_TOPIC]);
  requests = mintLogs.requests + burnLogs.requests;

  const shape = (log) => {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    return {
      block: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.index,
      to: parsed.args.to,
      amountWei: parsed.args.value,
    };
  };

  mints = mintLogs.rows.map(shape);
  burns = burnLogs.rows.map(shape);
  for (const row of [...mints, ...burns]) row.at = iso(await blockTime(row.block));
  mints.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}
for (const row of [...mints, ...burns]) delete row.logIndex;

const issued = mints.reduce((sum, row) => sum + row.amountWei, 0n);
const destroyed = burns.reduce((sum, row) => sum + row.amountWei, 0n);

if (has('--json')) {
  console.log(
    JSON.stringify(
      {
        token,
        chainId: Number(network.chainId),
        from: iso(fromMs),
        to: iso(toMs),
        fromBlock,
        toBlock,
        blocksScanned: fromBlock !== null && toBlock !== null ? toBlock - fromBlock + 1 : 0,
        mints: mints.map((row) => ({ ...row, amount: lvr(row.amountWei), amountWei: row.amountWei.toString() })),
        burns: burns.map((row) => ({ ...row, amount: lvr(row.amountWei), amountWei: row.amountWei.toString() })),
        totals: { mintedWei: issued.toString(), minted: lvr(issued), burnedWei: destroyed.toString(), burned: lvr(destroyed) },
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(`  token  ${token} on chain ${network.chainId}`);
console.log(`  range  ${iso(fromMs)} .. ${iso(toMs)}`);
if (fromBlock === null || toBlock === null) {
  console.log('  blocks none: the chain has no block inside that range');
} else if (fromBlock > toBlock) {
  console.log(`  blocks none: blocks ${fromBlock} and later are already past ${iso(toMs)}`);
} else {
  console.log(`  blocks ${fromBlock}..${toBlock} (${toBlock - fromBlock + 1} scanned in ${requests} request(s))`);
}

if (mints.length === 0) {
  console.log('  mints  none in this range');
} else {
  const width = Math.max(...mints.map((row) => lvr(row.amountWei).length));
  console.log(`  mints  ${mints.length}, ${lvr(issued)} LVR issued`);
  console.log('');
  console.log('  timestamp                 block  recipient                                     amount');
  for (const row of mints) {
    console.log(`  ${row.at}  ${String(row.block).padStart(5)}  ${row.to}  ${lvr(row.amountWei).padStart(width)}`);
    console.log(`  ${''.padEnd(26)}  ${''.padEnd(5)}  ${row.txHash}`);
  }
}

if (burns.length > 0) {
  console.log('');
  console.log(`  burns  ${burns.length}, ${lvr(destroyed)} LVR destroyed`);
  for (const row of burns) console.log(`  ${row.at}  ${String(row.block).padStart(5)}  ${lvr(row.amountWei)}  ${row.txHash}`);
}

if (mints.length > 0) {
  const byRecipient = new Map();
  for (const row of mints) byRecipient.set(row.to, (byRecipient.get(row.to) ?? 0n) + row.amountWei);
  console.log('');
  console.log('  issued per recipient');
  [...byRecipient.entries()]
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
    .forEach(([address, total]) => console.log(`    ${address}  ${lvr(total)} LVR`));

  const byDay = new Map();
  for (const row of mints) byDay.set(day(Date.parse(row.at)), (byDay.get(day(Date.parse(row.at))) ?? 0n) + row.amountWei);
  console.log('');
  console.log('  issued per UTC day');
  [...byDay.entries()].sort().forEach(([date, total]) => console.log(`    ${date}  ${lvr(total)} LVR`));
}

console.log('');
console.log(
  `  supply  ${lvr(issued)} issued, ${lvr(destroyed)} burned in this range; the chain has no window or rule column, only what happened`
);
