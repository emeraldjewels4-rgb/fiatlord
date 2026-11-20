/**
 * The committed record of where the token lives: chain id -> { token, deployBlock, owner }.
 *
 * WHY THIS IS A FILE AND NOT AN ARGUMENT
 *
 * Every command used to carry `--token 0x...`, which is an address typed by hand into a shell
 * history, a scheduled task and a log line. One typo turns an audit into "no mints" for a
 * token that does not exist, and a wrong chain turns it into a confident report about nothing.
 * Reading the address from a reviewed file by the chain id the RPC reports removes the typing
 * without removing the ability to override it: `--token` still wins when someone needs to look
 * at something that is not in the file.
 *
 * deployBlock is what makes the whole-history invariant affordable: scanning from block 0 on a
 * public chain is thousands of getLogs calls, scanning from the deployment is one.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DEPLOYMENTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'deployments.json');

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Every deployment in the file, validated. Throws with the reason, never half-parsed. */
export function readDeployments(file = DEFAULT_DEPLOYMENTS) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not an object of chain id -> deployment`);
  }

  const entries = {};
  for (const [chainId, entry] of Object.entries(parsed)) {
    if (!/^\d+$/.test(chainId)) continue; // the leading note, and anything else added later
    if (!entry || typeof entry !== 'object') throw new Error(`${file}: chain ${chainId} is not an object`);
    if (!ADDRESS.test(String(entry.token))) {
      throw new Error(`${file}: chain ${chainId} has no valid token address`);
    }
    if (!Number.isInteger(entry.deployBlock) || entry.deployBlock < 0) {
      throw new Error(`${file}: chain ${chainId} needs a whole deployBlock (0 or later)`);
    }
    if (entry.owner !== undefined && !ADDRESS.test(String(entry.owner))) {
      throw new Error(`${file}: chain ${chainId} has an invalid owner address`);
    }
    entries[chainId] = {
      chainId: Number(chainId),
      token: entry.token,
      deployBlock: entry.deployBlock,
      owner: entry.owner ? String(entry.owner) : null,
      name: entry.name ?? null,
    };
  }
  return entries;
}

/** The deployment for one chain, or a throw that says exactly what to add. */
export function deploymentFor(chainId, file = DEFAULT_DEPLOYMENTS) {
  const entries = readDeployments(file);
  const entry = entries[String(chainId)];
  if (!entry) {
    const known = Object.keys(entries);
    throw new Error(
      `no deployment for chain ${chainId} in ${file} (it knows: ${known.length ? known.join(', ') : 'nothing'});\n` +
        `  add an entry, or pass --token to check an address outside the file`
    );
  }
  return entry;
}
