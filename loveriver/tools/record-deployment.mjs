#!/usr/bin/env node
/**
 * Records a deployment into deployments.json from the broadcast that produced it.
 *
 * deployments.json is the one place the audit, the top-up and the funder learn which token to talk
 * to. It used to be filled in by hand from the deploy output, which fails two ways: a digit typed
 * wrong, and - more likely - a file nobody updated after a redeploy, so every tool goes on
 * reporting confidently about the previous token. Forge already writes the facts - chain id,
 * address, block and signer - into broadcast/Deploy.s.sol/<chain>/run-*.json, so they are read
 * from there and nothing is retyped.
 *
 *   node tools/record-deployment.mjs                  record the newest broadcast
 *   node tools/record-deployment.mjs --chain 1        the chain, when more than one has artifacts
 *   node tools/record-deployment.mjs --dry-run        say what it would write
 *   node tools/record-deployment.mjs --check          exit 1 if the record is stale, write nothing
 *   node tools/record-deployment.mjs --selftest
 *
 * Exit codes: 0 recorded (or already current, or nothing to compare against), 1 --check found the
 * record stale, 2 it could not run - no usable artifact, a reverted deploy, two chains and no
 * --chain.
 *
 * It will not pick a chain when more than one has broadcasts. Newest-by-timestamp is a fine default
 * on a checkout that only ever deployed to anvil and a trap on one that also ran mainnet: it would
 * write the local anvil address into the entry the audit and the funder read on the real chain.
 *
 * An entry keeps its `name` and `note`; only `token`, `deployBlock` and `owner` are replaced. Other
 * chains and the `_readme` note are untouched.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_DEPLOYMENTS } from './deployments.mjs';

// Loads ethers without importing it: nothing is resolved until the require below runs.
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const BROADCAST = resolve('broadcast/Deploy.s.sol');

/** The newest non-empty run artifact, from the one chain that has them. */
export function findArtifact(root = BROADCAST, chain = null) {
  const dirs = existsSync(root) ? readdirSync(root).filter((name) => /^\d+$/.test(name)) : [];
  const runs = [];
  for (const dir of dirs) {
    if (chain !== null && dir !== String(chain)) continue;
    for (const file of readdirSync(join(root, dir))) {
      const path = join(root, dir, file);
      // Forge leaves an empty file behind when a run is interrupted; it is not a deployment.
      if (!/^run-.*\.json$/.test(file) || statSync(path).size === 0) continue;
      runs.push({ path, chain: Number(dir), mtime: statSync(path).mtimeMs });
    }
  }
  const ran = [...new Set(runs.map((run) => run.chain))].sort((a, b) => a - b);
  if (runs.length === 0) return { path: null, ran, reason: `no run artifact under ${root}${chain === null ? '' : `/${chain}`}` };
  if (chain === null && ran.length > 1) {
    return { path: null, ran, reason: `artifacts exist for more than one chain (${ran.join(', ')}), so --chain is required` };
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  return { path: runs[0].path, ran, reason: null };
}

/** The four facts, or a throw saying which one the artifact cannot answer. */
export function readArtifact(path) {
  // ethers is required here rather than imported at the top so --check can answer "no broadcast to
  // compare" without node_modules: the hook runs it on every commit, and a machine that has never
  // run npm install has nothing to checksum and nothing to install first. createRequire keeps that
  // lazy load synchronous, so reading an artifact does not make its callers async.
  const { getAddress } = require('ethers');
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
  const chainId = Number(artifact.chain);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`${path} does not say which chain it ran on`);

  const creates = (artifact.transactions ?? []).filter((entry) => entry.transactionType === 'CREATE' && entry.contractAddress);
  const created = creates.find((entry) => /Loveriver/.test(String(entry.contractName)));
  if (!created) {
    throw new Error(`${path} does not create Loveriver (it creates: ${creates.map((entry) => entry.contractName ?? '?').join(', ') || 'nothing'})`);
  }
  const receipt = (artifact.receipts ?? []).find((entry) => entry.transactionHash === created.hash);
  if (!receipt) throw new Error(`${path} has no receipt for ${created.hash}`);
  if (Number(receipt.status) !== 1) throw new Error(`${path} records a reverted deploy (status ${receipt.status})`);

  // Number() reads both forms Forge writes: 8 and "0x8".
  const deployBlock = Number(receipt.blockNumber);
  if (!Number.isInteger(deployBlock) || deployBlock <= 0) throw new Error(`${path} has no usable block number`);
  const signer = created.transaction?.from ?? receipt.from;
  if (!signer) throw new Error(`${path} does not say which account sent the deploy`);

  return { chainId, token: getAddress(created.contractAddress), deployBlock, owner: getAddress(signer) };
}

/** Write the deployment, keeping everything that is not a redeploy fact. */
export function recordDeployment(deployment, file = DEFAULT_DEPLOYMENTS, { write = true } = {}) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const key = String(deployment.chainId);
  const existing = parsed[key];
  const after = {
    name: existing?.name ?? `chain ${deployment.chainId}`,
    token: deployment.token,
    deployBlock: deployment.deployBlock,
    owner: deployment.owner,
    note: existing?.note ?? 'recorded from the deploy broadcast',
  };
  const changed =
    !existing ||
    existing.token.toLowerCase() !== after.token.toLowerCase() ||
    Number(existing.deployBlock) !== after.deployBlock ||
    String(existing.owner ?? '').toLowerCase() !== after.owner.toLowerCase();

  // JSON.stringify emits integer-like keys first, so _readme lands after the chains whatever order
  // this inserts them in. Order is cosmetic; the file parses either way.
  if (write && changed) writeFileSync(file, `${JSON.stringify({ ...parsed, [key]: after }, null, 2)}\n`);

  return { changed, before: existing ?? null, after };
}

if (has('--selftest')) {
  let failures = 0;
  const check = (label, ok) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), 'loveriver-record-selftest-'));
  const artifact = {
    chain: 31337,
    transactions: [
      { hash: '0xaaa', transactionType: 'CREATE', contractName: 'Loveriver', contractAddress: '0x' + 'A'.repeat(40), transaction: { from: '0x' + 'B'.repeat(40) } },
    ],
    receipts: [{ transactionHash: '0xaaa', blockNumber: '0x8', status: '0x1' }],
  };
  const writeFile = (name, content) => {
    const path = join(scratch, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return path;
  };
  const record = (name, chains) => {
    const root = join(scratch, name, 'Deploy.s.sol');
    for (const id of chains) {
      mkdirSync(join(root, String(id)), { recursive: true });
      writeFileSync(join(root, String(id), 'run-1.json'), JSON.stringify({ ...artifact, chain: id }));
    }
    return root;
  };
  try {
    const parsed = readArtifact(writeFile('run-latest.json', artifact));
    check(
      'chain id, token, block and signer are read from the artifact',
      parsed.chainId === 31337 && parsed.deployBlock === 8 && /^0x[a-fA-F0-9]{40}$/.test(parsed.owner) && parsed.token !== parsed.token.toLowerCase()
    );

    const base = {
      _readme: ['where the token lives', 'keys must be decimal chain ids'],
      '1': { name: 'mainnet', token: '0x' + '1'.repeat(40), deployBlock: 100, owner: '0x' + '2'.repeat(40) },
      '31337': { name: 'anvil', token: '0x' + '3'.repeat(40), deployBlock: 1, owner: '0x' + '4'.repeat(40), note: 'script/Deploy.s.sol' },
    };
    const file = writeFile('deployments.json', base);
    check('a dry run reports the change and leaves the file alone',
      recordDeployment(parsed, file, { write: false }).changed && JSON.parse(readFileSync(file, 'utf8'))['31337'].deployBlock === 1);

    recordDeployment(parsed, file);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    check('the entry carries the artifact values', written['31337'].token === parsed.token && written['31337'].deployBlock === 8 && written['31337'].owner === parsed.owner);
    check('name, note, the _readme and the other chain survive',
      written['31337'].name === 'anvil' && written['31337'].note === 'script/Deploy.s.sol' &&
      written._readme.length === 2 && written['1'].deployBlock === 100);
    check('re-running finds nothing to change', recordDeployment(parsed, file, { write: false }).changed === false);

    const fresh = writeFile('fresh.json', { _readme: ['note'] });
    check('a new chain gets an entry', recordDeployment(parsed, fresh).changed &&
      JSON.parse(readFileSync(fresh, 'utf8'))['31337'].token === parsed.token);

    const refused = (label, run) => {
      try { run(); return check(label, false); } catch { return check(label, true); }
    };
    refused('a reverted deploy is refused', () => readArtifact(writeFile('reverted.json', { ...artifact, receipts: [{ transactionHash: '0xaaa', blockNumber: '0x8', status: '0x0' }] })));
    refused('an empty artifact is refused', () => readArtifact(writeFile('empty.json', '')));

    const two = record('two', [1, 31337]);
    const ambiguous = findArtifact(two, null);
    check('two chains are refused, not resolved by timestamp', ambiguous.path === null && ambiguous.ran.join(',') === '1,31337');
    check('--chain picks one of them', findArtifact(two, 1).path !== null && findArtifact(two, 1).ran.join(',') === '1');
    check('one chain needs no --chain', findArtifact(record('one', [31337]), null).path !== null);
    const interrupted = record('interrupted', [31337]);
    writeFileSync(join(interrupted, '31337', 'run-2.json'), '');
    check('a zero-byte run file is skipped, not read as a deployment', findArtifact(interrupted, null).path.endsWith('run-1.json'));
  } catch (error) {
    failures++;
    console.log(`  FAIL the selftest itself threw: ${error.message}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '  record selftest PASSED' : `  record selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const stop = (message) => {
  console.error(`  ${message}`);
  process.exit(2);
};

const at = argv.indexOf('--chain');
const chain = at === -1 ? null : Number(argv[at + 1]);
if (at !== -1 && !Number.isInteger(chain)) stop('--chain needs a chain id, e.g. --chain 1');

const found = findArtifact(BROADCAST, chain);
if (!found.path) {
  // A fresh clone has no broadcast/ at all, and a record cannot be stale against a deploy this
  // checkout does not have. Two chains is not the same thing: there is something to compare, and
  // only the operator can say which one the record is meant to match.
  if (has('--check') && found.ran.length === 0) {
    console.log(`  check skipped: ${found.reason}`);
    process.exit(0);
  }
  stop(found.reason);
}

let deployment;
try {
  deployment = readArtifact(found.path);
} catch (error) {
  stop(error.message);
}
if (chain !== null && deployment.chainId !== chain) stop(`--chain ${chain} was asked for, but ${found.path} ran on chain ${deployment.chainId}`);

const file = resolve(DEFAULT_DEPLOYMENTS);
console.log(`  artifact    ${found.path}`);
console.log(`  chain       ${deployment.chainId}`);
console.log(`  token       ${deployment.token}`);
console.log(`  deployBlock ${deployment.deployBlock}`);
console.log(`  owner       ${deployment.owner}`);

const outcome = recordDeployment(deployment, file, { write: !has('--dry-run') && !has('--check') });
if (!outcome.changed) {
  console.log(`  ${file} already records this deployment`);
  process.exit(0);
}
if (has('--check')) {
  console.error('');
  console.error(`  STALE: ${file} does not match this broadcast`);
  console.error(`    recorded  token ${outcome.before?.token} block ${outcome.before?.deployBlock} owner ${outcome.before?.owner}`);
  console.error(`    broadcast token ${outcome.after.token} block ${outcome.after.deployBlock} owner ${outcome.after.owner}`);
  console.error('  run without --check to update it');
  process.exit(1);
}
if (has('--dry-run')) {
  console.log(`  DRY RUN: would update ${file}`);
  process.exit(0);
}
console.log(`  recorded    ${file}`);
