#!/usr/bin/env node
/**
 * Records a deployment into deployments.json from the broadcast that produced it.
 *
 * `deployments.json` is the one place the audit, the top-up and the funder learn which token to
 * talk to. It used to be filled in by hand from the deploy output, which has two failure modes:
 * a digit typed wrong, and - more likely - a file that is simply never updated after a redeploy,
 * so every tool keeps checking the previous token and reports confidently about it. This reads
 * Forge's own broadcast artifact instead: the chain id, the new address, the block it landed in
 * and the account that signed are all in that file already.
 *
 *   node tools/record-deployment.mjs                 record the newest broadcast (one chain only)
 *   node tools/record-deployment.mjs --chain 1       record the newest run on that chain
 *   node tools/record-deployment.mjs --dry-run       say what it would write
 *   node tools/record-deployment.mjs --check         exit 1 if the record is stale (writes nothing)
 *   node tools/record-deployment.mjs --selftest
 *
 * Exit codes: 0 recorded (or already current), 1 --check found the record stale or a check
 * failed, 2 it could not run (no usable artifact, unreadable file, a reverted deploy).
 *
 * What is taken from the artifact, and why not guessed:
 *   chain       `chain` in the artifact, the chain the transactions were actually sent to
 *   token       the CREATE whose contract is Loveriver
 *   deployBlock the receipt block of that CREATE, which is what the invariant audit scans from
 *   owner       the `from` of that CREATE - the script broadcasts as the owner, so this is the
 *               account that can mint, not an address to be copied from a terminal
 *
 * An entry already in the file keeps its `name` and `note`; only the three facts a redeploy
 * changes are replaced. Other chains are untouched, and the `_readme` note is preserved.
 *
 * It will not pick a chain for you when more than one has broadcasts. The newest run by timestamp
 * is a fine default on a checkout that only ever deployed to anvil, and a trap on one that also
 * ran mainnet: it would write the local anvil address into the entry the audit and the funder read
 * on the real chain, and every one of them would then check, fund or report the wrong token without
 * complaining. With two candidates the only safe answer is the one the operator gives: --chain.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getAddress } from 'ethers';
import { DEFAULT_DEPLOYMENTS, readDeployments } from './deployments.mjs';

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

/** The broadcast directory Forge writes: one subdirectory per chain id. */
const BROADCAST_ROOT = resolve('broadcast/Deploy.s.sol');

/**
 * Newest non-empty run artifact. One chain only: the chain must be named, or be the only one with
 * artifacts. `chains` on the result is what the caller reports, and is empty only when there is
 * nothing to compare against at all - the difference between "skipped" and "refused".
 */
export function findArtifact(root = BROADCAST_ROOT, chain = null) {
  if (!existsSync(root)) return { path: null, reason: `no broadcast directory at ${root}`, chains: [] };
  const chains = readdirSync(root).filter((name) => /^\d+$/.test(name));
  if (chains.length === 0) return { path: null, reason: `no chain directories under ${root}`, chains: [] };
  const candidates = [];
  for (const name of chains) {
    if (chain !== null && name !== String(chain)) continue;
    const dir = join(root, name);
    for (const file of readdirSync(dir)) {
      if (!/^run-.*\.json$/.test(file)) continue;
      const path = join(dir, file);
      const size = statSync(path).size;
      if (size === 0) continue; // Forge leaves an empty file behind if a run is interrupted
      candidates.push({ path, chain: Number(name), size, mtime: statSync(path).mtimeMs });
    }
  }
  if (candidates.length === 0) {
    return { path: null, reason: `no non-empty run-*.json in ${root}${chain !== null ? `/${chain}` : ''}`, chains: [] };
  }
  const ran = [...new Set(candidates.map((candidate) => candidate.chain))].sort((a, b) => a - b);
  if (chain === null && ran.length > 1) {
    return {
      path: null,
      chains: ran,
      reason: `broadcast artifacts exist for more than one chain (${ran.join(', ')}), and the newest run is not a safe choice between them`,
    };
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return { path: candidates[0].path, reason: null, chains: ran };
}

/** Pull the four facts out of one artifact, or throw with the reason it cannot answer. */
export function readArtifact(path) {
  let artifact;
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) throw new Error('the file is empty');
    artifact = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }

  const chain = Number(artifact.chain);
  if (!Number.isInteger(chain) || chain <= 0) throw new Error(`${path} does not say which chain it ran on`);

  const creates = (artifact.transactions ?? []).filter(
    (entry) => entry.transactionType === 'CREATE' && entry.contractAddress
  );
  if (creates.length === 0) throw new Error(`${path} records no contract creation, so there is nothing to record`);
  const created =
    creates.find((entry) => /Loveriver/.test(String(entry.contractName))) ?? (creates.length === 1 ? creates[0] : null);
  if (!created) {
    throw new Error(`${path} creates ${creates.map((entry) => entry.contractName).join(', ')}; none of them is Loveriver`);
  }

  const receipt = (artifact.receipts ?? []).find(
    (entry) => entry.transactionHash === created.hash || entry.contractAddress === created.contractAddress
  );
  if (!receipt) throw new Error(`${path} has no receipt for the creation of ${created.contractAddress}`);
  if (receipt.status !== undefined && Number(receipt.status) !== 1) {
    throw new Error(`${path} records a reverted deploy (status ${receipt.status}); nothing is worth recording`);
  }
  const blockNumber = Number.parseInt(String(receipt.blockNumber), receipt.blockNumber?.startsWith?.('0x') ? 16 : 10);
  if (!Number.isInteger(blockNumber) || blockNumber <= 0) {
    throw new Error(`${path} has no usable block number for the deploy`);
  }

  const signer = created.transaction?.from ?? receipt.from;
  if (!signer) throw new Error(`${path} does not say which account sent the deploy`);

  return {
    chainId: chain,
    token: getAddress(created.contractAddress),
    deployBlock: blockNumber,
    owner: getAddress(signer),
  };
}

/**
 * Write the deployment into the file, keeping everything that is not a redeploy fact.
 * Returns what changed, so --dry-run and --check can be honest without writing anything.
 */
export function recordDeployment(deployment, file = DEFAULT_DEPLOYMENTS, { dryRun = false } = {}) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const key = String(deployment.chainId);
  const existing = parsed[key];
  const next = {
    name: existing?.name ?? `chain ${deployment.chainId}`,
    token: deployment.token,
    deployBlock: deployment.deployBlock,
    owner: deployment.owner,
    ...(existing?.note ? { note: existing.note } : { note: 'recorded from the deploy broadcast' }),
  };

  const before = existing ? { token: existing.token, deployBlock: existing.deployBlock, owner: existing.owner } : null;
  const changed =
    !before ||
    before.token.toLowerCase() !== next.token.toLowerCase() ||
    Number(before.deployBlock) !== next.deployBlock ||
    String(before.owner ?? '').toLowerCase() !== next.owner.toLowerCase();

  if (!dryRun) {
    // _readme first, then every chain in its existing order, then a new chain at the end.
    const out = { _readme: parsed._readme };
    for (const [chainId, entry] of Object.entries(parsed)) {
      if (chainId === '_readme') continue;
      out[chainId] = chainId === key ? next : entry;
    }
    if (!(key in out)) out[key] = next;
    writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    // Re-read through the shared validator: a file this tool wrote must parse and be valid.
    const entries = readDeployments(file);
    if (!entries[key]) throw new Error(`${file} does not contain chain ${key} after writing it`);
  }

  return { changed, before, after: next };
}

// The teeth, on throwaway files: an artifact that is reverted, empty or ambiguous must be
// refused, and a record that lags the artifact must be reported as stale.
if (has('--selftest')) {
  let failures = 0;
  const check = (label, ok) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), 'loveriver-record-selftest-'));
  const write = (name, content) => {
    const path = join(scratch, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return path;
  };
  try {
    const base = {
      _readme: ['where the token lives', 'keys must be decimal chain ids'],
      '1': { name: 'mainnet', token: '0x' + '1'.repeat(40), deployBlock: 100, owner: '0x' + '2'.repeat(40) },
      '31337': { name: 'anvil (local, deterministic)', token: '0x' + '3'.repeat(40), deployBlock: 1, owner: '0x' + '4'.repeat(40), note: 'script/Deploy.s.sol' },
    };
    const artifact = {
      chain: 31337,
      transactions: [
        { hash: '0xaaa', transactionType: 'CREATE', contractName: 'Loveriver', contractAddress: '0x' + 'A'.repeat(40), transaction: { from: '0x' + 'B'.repeat(40) } },
      ],
      receipts: [{ transactionHash: '0xaaa', blockNumber: '0x8', status: '0x1' }],
    };

    const parsed = readArtifact(write('run-latest.json', artifact));
    check('chain id, token, block and signer are read from the artifact',
      parsed.chainId === 31337 && parsed.deployBlock === 8 && /^0x[a-fA-F0-9]{40}$/.test(parsed.token) && /^0x[a-fA-F0-9]{40}$/.test(parsed.owner));
    check('the address is checksummed, not left lowercase', parsed.token !== parsed.token.toLowerCase());

    const file = write('deployments.json', base);
    const result = recordDeployment(parsed, file, { dryRun: true });
    check('a dry run reports the change without touching the file', result.changed && JSON.parse(readFileSync(file, 'utf8'))['31337'].deployBlock === 1);

    recordDeployment(parsed, file);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    check('the entry now carries the artifact values', written['31337'].token === parsed.token && written['31337'].deployBlock === 8 && written['31337'].owner === parsed.owner);
    check('the _readme note survives', Array.isArray(written._readme) && written._readme.length === 2);
    check('another chain is untouched', written['1'].token === base['1'].token && written['1'].deployBlock === 100);
    check('name and note are kept, not overwritten', written['31337'].name === base['31337'].name && written['31337'].note === base['31337'].note);
    check('re-running finds nothing to change', recordDeployment(parsed, file, { dryRun: true }).changed === false);

    const fresh = write('fresh.json', { _readme: ['note'] });
    recordDeployment(parsed, fresh);
    check('a new chain gets an entry', JSON.parse(readFileSync(fresh, 'utf8'))['31337'].token === parsed.token);

    const reverted = { ...artifact, receipts: [{ transactionHash: '0xaaa', blockNumber: '0x8', status: '0x0' }] };
    let refused = false;
    try { readArtifact(write('reverted.json', reverted)); } catch { refused = true; }
    check('a reverted deploy is refused', refused);

    let emptyRefused = false;
    try { readArtifact(write('empty.json', '')); } catch { emptyRefused = true; }
    check('an empty artifact is refused, not read as a deployment', emptyRefused);

    const twoCreates = { ...artifact, transactions: [...artifact.transactions, { hash: '0xbbb', transactionType: 'CREATE', contractName: 'Something', contractAddress: '0x' + 'C'.repeat(40), transaction: { from: '0x' + 'B'.repeat(40) } }] };
    const chosen = readArtifact(write('two.json', twoCreates));
    check('with several contracts it still picks Loveriver', chosen.token === parsed.token);

    // Two chains that both broadcast: the newest-by-timestamp answer is exactly the one that must
    // not be taken, because it could be anvil's deploy landing in mainnet's entry.
    const multi = join(scratch, 'broadcast', 'Deploy.s.sol');
    for (const [id, seconds] of [['1', '2000'], ['31337', '1000']]) {
      mkdirSync(join(multi, id), { recursive: true });
      writeFileSync(join(multi, id, `run-${seconds}.json`), JSON.stringify({ ...artifact, chain: Number(id) }));
    }
    const ambiguous = findArtifact(multi, null);
    check('two chains with artifacts is refused instead of resolved by timestamp',
      ambiguous.path === null && ambiguous.chains.join(',') === '1,31337');
    const named = findArtifact(multi, 1);
    check('--chain picks that chain and no other', named.path !== null && named.path.includes(`${sep}1${sep}`) && named.chains.join(',') === '1');
    const alone = join(scratch, 'single', 'Deploy.s.sol');
    mkdirSync(join(alone, '31337'), { recursive: true });
    writeFileSync(join(alone, '31337', 'run-1.json'), JSON.stringify(artifact));
    const single = findArtifact(alone, null);
    check('one chain on its own still needs no --chain', single.path !== null && single.chains.join(',') === '31337');
  } catch (error) {
    failures++;
    console.log(`  FAIL the selftest itself threw: ${error.message}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '  record selftest PASSED' : `  record selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const file = resolve(value('deployments', DEFAULT_DEPLOYMENTS));
const chain = value('chain', null);
const explicit = value('artifact', null);

let artifactPath = explicit;
if (!artifactPath) {
  const found = findArtifact(BROADCAST_ROOT, chain === null ? null : Number(chain));
  if (!found.path) {
    // --check runs from the pre-commit hook, where "no broadcast to compare against" is the normal
    // state of a fresh clone, not a failure: the record cannot be stale against a deploy this
    // checkout does not have. Recording still refuses in that state, because there is nothing to
    // read the facts from and a written guess is worse than no entry.
    if (has('--check') && found.chains.length === 0) {
      console.log(`  check skipped: ${found.reason}`);
      process.exit(0);
    }
    // Ambiguity is not a skip: there are artifacts, so the record must be checked against one, and
    // only the operator can say which.
    const advice = found.chains.length > 0
      ? `; pass --chain <id> to say which deployment this is`
      : '; run script/Deploy.s.sol with --broadcast first, or pass --artifact <path>';
    cannotRun(`  ${found.reason}${advice}`);
  }
  artifactPath = found.path;
}

let deployment;
try {
  deployment = readArtifact(artifactPath);
} catch (error) {
  cannotRun(`  ${error.message}`);
}

if (chain !== null && Number(chain) !== deployment.chainId) {
  cannotRun(`  --chain ${chain} was asked for, but ${artifactPath} ran on chain ${deployment.chainId}`);
}

console.log(`  artifact    ${artifactPath}`);
console.log(`  chain       ${deployment.chainId}`);
console.log(`  token       ${deployment.token}`);
console.log(`  deployBlock ${deployment.deployBlock}`);
console.log(`  owner       ${deployment.owner}`);

const outcome = recordDeployment(deployment, file, { dryRun: has('--dry-run') || has('--check') });

if (!outcome.changed) {
  console.log(`  ${file} already records this deployment; nothing to do`);
  process.exit(0);
}

if (has('--check')) {
  console.error('');
  console.error(`  STALE: ${file} does not match this broadcast`);
  if (outcome.before) {
    console.error(`    recorded  token ${outcome.before.token}  block ${outcome.before.deployBlock}  owner ${outcome.before.owner}`);
    console.error(`    broadcast token ${outcome.after.token}  block ${outcome.after.deployBlock}  owner ${outcome.after.owner}`);
  } else {
    console.error(`    chain ${deployment.chainId} has no entry at all`);
  }
  console.error('  run without --check to update it');
  process.exit(1);
}

if (has('--dry-run')) {
  console.log(`  DRY RUN: would update ${file}${outcome.before ? '' : ' with a new entry'}`);
  process.exit(0);
}

console.log(`  recorded    ${file}${outcome.before ? ' (entry updated)' : ' (entry added)'}`);
