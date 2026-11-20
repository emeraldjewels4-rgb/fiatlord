#!/usr/bin/env node
/**
 * Backs up this repository's history as a git bundle, and proves a restore rebuilds it.
 *
 * The audit tooling is committed to a repo with no remote, so losing this working copy loses
 * the project. A bundle is a single file git can clone from, which makes it the one form of
 * backup that can be *tested* without a server - and testing it is the point: a truncated
 * bundle looks exactly like a good one until the day it is opened.
 *
 *   node tools/repo-backup.mjs                      bundle, verify, restore-check, write manifest
 *   node tools/repo-backup.mjs --out D:\elsewhere   a different destination
 *   node tools/repo-backup.mjs --keep 30            after a good run, prune to the newest 30
 *   node tools/repo-backup.mjs --verify-only <f>    verify a bundle on disk, then clone-check it
 *   node tools/repo-backup.mjs --selftest           prove the checks above can actually fail
 *
 * Exit codes: 0 the bundle verifies and a clone of it matches this repo, 1 a check failed,
 * 2 it could not run (no git, bad arguments, a bundle name already taken).
 *
 * A bundle holds committed history only. Uncommitted and untracked files are not in it, so
 * every run prints what `git status` would leave behind rather than implying a full copy.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUT = 'D:\\loveriver-backup';
const BUNDLE_PREFIX = 'loveriver-repo-';
const MANIFEST = 'MANIFEST-repo.txt';

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

/** Run a command and return its status instead of throwing, for checks that expect failure. */
function attempt(command, args, cwd) {
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) };
  }
}

function git(args, cwd) {
  const result = attempt('git', args, cwd);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

const gitOut = (args, cwd) => git(args, cwd).trim();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, '..');

function repoRoot() {
  const result = attempt('git', ['rev-parse', '--show-toplevel'], projectDir);
  if (result.status !== 0) cannotRun(`  no git repository at ${projectDir} (or git is not installed)`);
  return result.stdout.trim();
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** YYYYMMDD-HHMMSS in local time, matching the wallet backup's file naming. */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Every bundle in the destination, oldest first (the timestamp in the name sorts correctly). */
function inventory(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => name.startsWith(BUNDLE_PREFIX) && name.endsWith('.bundle'))
    .sort()
    .map((name) => {
      const file = join(outDir, name);
      return { name, file, bytes: statSync(file).size };
    });
}

/**
 * The check that makes this a backup rather than a file: clone the bundle into a scratch
 * directory and require the clone to carry the same history. fsck runs on the clone, so a
 * bundle that verifies but cannot produce a working repository is still caught.
 */
function restoreCheck(bundleFile, root) {
  const scratch = mkdtempSync(join(tmpdir(), 'loveriver-restore-'));
  try {
    const clone = attempt('git', ['clone', '--no-hardlinks', '--quiet', bundleFile, scratch], root);
    if (clone.status !== 0) {
      return { ok: false, rows: [['clone from the bundle', `FAILED: ${(clone.stderr || clone.stdout).trim().split('\n')[0]}`]] };
    }

    const rows = [];
    const want = {
      commit: gitOut(['rev-parse', 'HEAD'], root),
      tree: gitOut(['rev-parse', 'HEAD^{tree}'], root),
      commits: Number(gitOut(['rev-list', '--count', 'HEAD'], root)),
      files: gitOut(['ls-files'], root).split('\n').filter(Boolean).length,
    };
    const got = {
      commit: gitOut(['rev-parse', 'HEAD'], scratch),
      tree: gitOut(['rev-parse', 'HEAD^{tree}'], scratch),
      commits: Number(gitOut(['rev-list', '--count', 'HEAD'], scratch)),
      files: gitOut(['ls-files'], scratch).split('\n').filter(Boolean).length,
    };

    for (const key of ['commit', 'tree', 'commits', 'files']) {
      rows.push([key, `${got[key]}${got[key] === want[key] ? '  (matches)' : `  MISMATCH, this repo has ${want[key]}`}`]);
    }

    const fsck = attempt('git', ['fsck', '--strict', '--no-progress'], scratch);
    rows.push(['fsck on the clone', fsck.status === 0 ? 'clean' : `FAILED: ${(fsck.stderr || fsck.stdout).trim().split('\n')[0]}`]);

    // Every branch the bundle advertises has to point at the same commit here.
    const advertised = gitOut(['bundle', 'list-heads', bundleFile], root)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '))
      .filter(([, ref]) => ref && ref.startsWith('refs/heads/'));
    const mismatched = advertised.filter(([sha, ref]) => {
      const here = attempt('git', ['rev-parse', '--verify', '--quiet', ref], root);
      return here.status !== 0 || here.stdout.trim() !== sha;
    });
    rows.push([
      'branches',
      advertised.length === 0
        ? 'MISMATCH, the bundle advertises no branches'
        : `${advertised.length} advertised, ${mismatched.length === 0 ? 'all match' : `MISMATCH on ${mismatched.map(([, ref]) => ref).join(', ')}`}`,
    ]);

    const ok =
      got.commit === want.commit &&
      got.tree === want.tree &&
      got.commits === want.commits &&
      got.files === want.files &&
      fsck.status === 0 &&
      advertised.length > 0 &&
      mismatched.length === 0;
    return { ok, rows };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Verify a bundle file on disk: git's own integrity check, the sidecar, and the restore check. */
function verifyBundle(bundleFile, root) {
  if (!existsSync(bundleFile)) return { ok: false, rows: [['file', `MISSING: ${bundleFile}`]] };

  // Hashed once: this used to read the whole file three times and hash it twice.
  const actual = sha256(bundleFile);
  const rows = [['file', `${bundleFile}  (${statSync(bundleFile).size} bytes)`]];

  const verify = attempt('git', ['bundle', 'verify', bundleFile], root);
  const verifyText = (verify.stdout + verify.stderr).trim();
  rows.push(['git bundle verify', verify.status === 0 ? 'ok' : `FAILED: ${verifyText.split('\n').slice(-1)[0]}`]);

  // The sidecar is optional - a bundle written before it existed still verifies - so an absent
  // hash is reported as absent, never as a mismatch.
  const sidecar = `${bundleFile}.sha256`;
  const recorded = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] : null;
  const hashOk = recorded === null || recorded === actual;
  rows.push(['sha256', recorded === null
    ? 'no .sha256 next to it (checked, absent)'
    : hashOk ? `${actual}  (matches the .sha256)` : `MISMATCH: file is ${actual}, recorded ${recorded}`]);

  // Not optional: `git bundle verify` alone passes on a file truncated to half (measured by
  // --selftest), so the clone is the check rather than an extra one.
  const restore = restoreCheck(bundleFile, root);
  if (restore.ok) rows.push(['restore', 'a clone of the bundle carries the same history']);
  return { ok: verify.status === 0 && hashOk && restore.ok, rows: [...rows, ...(restore.ok ? [] : restore.rows)] };
}

/** The manifest beside the bundles: what these files are and how to get the history back. */
function writeManifest(outDir, bundles, latestFile, root) {
  const latest = basename(latestFile);
  const lines = [
    'Loveriver repository backup',
    '',
    'What this is',
    '  Git bundles of the whole repository history. A bundle is a single file git can clone',
    '  from, so a restore needs no server and no network:',
    '',
    '    git clone "' + join(outDir, latest) + '" loveriver-restored',
    '',
    '  Or check one without writing anything:',
    '',
    '    node tools/repo-backup.mjs --verify-only "' + join(outDir, latest) + '"',
    '',
    'What this is NOT',
    '  Committed history only. Uncommitted and untracked files are not in the bundle. Files',
    '  listed by `git status` on the laptop at backup time are the gap - commit them or copy',
    '  them by hand. The wallet seed is not here either; that is the JSON in this same folder,',
    '  backed up by docs/BACKUP-RESTORE.md.',
    '',
    'Housekeeping',
    '  Each bundle has a .sha256 beside it. Nothing here is overwritten: every run writes a new',
    '  timestamped file. Pruning is explicit (-keep N on tools/repo-backup.mjs).',
    '',
    'Schedule',
    '  ops/install-repo-backup-task.ps1 registers the daily task; see docs/BACKUP-RESTORE.md.',
    '',
    'Contents at ' + new Date().toISOString(),
    '  repository  ' + root,
    '  bundles     ' + bundles.length,
    ...bundles.map((b, i) => `  ${i === bundles.length - 1 ? 'latest    ' : '          '}${b.name}  ${b.bytes} bytes`),
    '',
    'Verified',
    '  ' + new Date().toISOString().slice(0, 10) + ': latest bundle passed git bundle verify, its sha256',
    '  matched the recorded sidecar, and a clone of it carried the same HEAD commit, tree,',
    '  commit count, file count and branches as the repository (see logs for the run).',
    '',
  ];
  // Written to a temporary name and renamed: a run interrupted mid-write would otherwise leave a
  // truncated manifest beside intact bundles. Written only once a bundle has passed its checks,
  // so the file never claims a verification that did not happen.
  const manifest = join(outDir, MANIFEST);
  writeFileSync(`${manifest}.partial`, lines.join('\n'));
  renameSync(`${manifest}.partial`, manifest);
}

function createBundle(outDir, root, { keep = 0 } = {}) {
  mkdirSync(outDir, { recursive: true });

  const finalFile = join(outDir, `${BUNDLE_PREFIX}${stamp()}.bundle`);
  if (existsSync(finalFile)) cannotRun(`  ${finalFile} already exists; refusing to overwrite a backup`);
  const tempFile = `${finalFile}.partial`;

  // Bundling shows any uncommitted work that the backup will not contain.
  const dirty = gitOut(['status', '--porcelain'], root).split('\n').filter(Boolean);

  console.log(`  repository  ${root}`);
  console.log(`  bundle      ${basename(finalFile)}`);
  console.log(`  refs        HEAD ${gitOut(['rev-parse', '--short', 'HEAD'], root)}, ` +
    `${gitOut(['rev-list', '--count', 'HEAD'], root)} commits, ` +
    `${gitOut(['ls-files'], root).split('\n').filter(Boolean).length} tracked files`);

  // Built under a .partial name so an interrupted run cannot leave a half file that looks
  // like a backup. The rename only happens after git has verified it.
  const created = attempt('git', ['bundle', 'create', tempFile, '--all'], root);
  if (created.status !== 0) {
    rmSync(tempFile, { force: true });
    cannotRun(`  git bundle create failed: ${(created.stderr || created.stdout).trim().split('\n')[0]}`);
  }

  const verify = attempt('git', ['bundle', 'verify', tempFile], root);
  if (verify.status !== 0) {
    rmSync(tempFile, { force: true });
    console.error('  git bundle verify FAILED on the file it just wrote; the .partial file was removed');
    console.error(`  ${(verify.stderr || verify.stdout).trim().split('\n').slice(-1)[0]}`);
    return { ok: false };
  }
  renameSync(tempFile, finalFile);

  const hash = sha256(finalFile);
  writeFileSync(`${finalFile}.sha256`, `${hash}  ${basename(finalFile)}\n`);
  console.log(`  sha256      ${hash}`);

  const check = restoreCheck(finalFile, root);
  for (const [label, detail] of check.rows) console.log(`  ${label.padEnd(11)} ${detail}`);

  if (dirty.length > 0) {
    console.log('');
    console.log(`  NOT in the bundle - ${dirty.length} uncommitted or untracked path(s):`);
    for (const line of dirty.slice(0, 8)) console.log(`    ${line}`);
    if (dirty.length > 8) console.log(`    ... and ${dirty.length - 8} more`);
  }

  if (!check.ok) {
    // Nothing is pruned and the manifest is left exactly as it was. Pruning here would delete an
    // older bundle - possibly the last good one - on the strength of a bundle that just proved it
    // does not restore, which is the one way this tool could lose a backup.
    console.error('  RESTORE CHECK FAILED: the bundle does not rebuild the same history');
    console.error(`  kept ${basename(finalFile)} for inspection; nothing pruned, manifest unchanged`);
    return { ok: false };
  }

  // Retention runs only after the new bundle has been proved to restore, and the bundle just
  // written is never a candidate, whatever its name sorts like.
  const newest = basename(finalFile);
  const bundles = inventory(outDir);
  if (keep > 0 && bundles.length > keep) {
    const doomed = bundles.filter((bundle) => bundle.name !== newest).slice(0, bundles.length - keep);
    for (const old of doomed) {
      rmSync(old.file, { force: true });
      rmSync(`${old.file}.sha256`, { force: true });
      console.log(`  pruned      ${old.name}`);
    }
  }

  const kept = inventory(outDir);
  writeManifest(outDir, kept, finalFile, root);
  console.log(`  ${kept.length} bundle(s) in ${outDir}; restore check passed`);
  return { ok: true };
}

// The teeth: a verifier that cannot fail is decoration. Every check here is run against a
// throwaway repository in the temp directory, so nothing real is involved.
if (has('--selftest')) {
  let failures = 0;
  const check = (label, ok) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), 'loveriver-backup-selftest-'));
  try {
    const repo = join(scratch, 'repo');
    mkdirSync(repo);
    const commitAs = ['-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest'];
    git(['init', '--quiet', '--initial-branch=master', repo]);
    // Two commits, then a bundle: this is the stale-backup case, produced the way a real one
    // is - by taking the backup and then carrying on working.
    for (const round of [1, 2]) {
      writeFileSync(join(repo, 'history.txt'), `round ${round}\n`);
      git([...commitAs, 'add', 'history.txt'], repo);
      git([...commitAs, 'commit', '--quiet', '-m', `round ${round}`], repo);
    }
    const stale = join(scratch, 'stale.bundle');
    git(['bundle', 'create', stale, '--all'], repo);

    writeFileSync(join(repo, 'history.txt'), 'round 3\n');
    git([...commitAs, 'add', 'history.txt'], repo);
    git([...commitAs, 'commit', '--quiet', '-m', 'round 3'], repo);

    const good = join(scratch, 'good.bundle');
    git(['bundle', 'create', good, '--all'], repo);
    check('a freshly written bundle verifies', attempt('git', ['bundle', 'verify', good], repo).status === 0);
    const restored = restoreCheck(good, repo);
    check('and a clone of it matches the repository', restored.ok);

    // Measured, not assumed: verify only parses the header, so half a file still passes it.
    const truncated = join(scratch, 'truncated.bundle');
    copyFileSync(good, truncated);
    const whole = readFileSync(truncated);
    writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));
    check(
      'git bundle verify alone still passes on a bundle truncated to half',
      attempt('git', ['bundle', 'verify', truncated], repo).status === 0
    );
    check('the clone check is what catches a truncated bundle', restoreCheck(truncated, repo).ok === false);

    const staleCheck = restoreCheck(stale, repo);
    check('a stale bundle (two commits, not three) is caught as a mismatch', staleCheck.ok === false);
    check(
      'and the mismatch names the commit it got',
      staleCheck.rows.some(([label, detail]) => label === 'commit' && detail.includes('MISMATCH'))
    );
  } catch (error) {
    failures++;
    console.log(`  FAIL the selftest itself threw: ${error.message}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '  backup selftest PASSED' : `  backup selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

const root = repoRoot();

if (has('--verify-only')) {
  // One flag, one behaviour. --restore-check was an alias for exactly this and only made the
  // usage text look like it offered two different checks.
  const named = value('verify-only');
  const outDir = resolve(value('out', DEFAULT_OUT));
  const bundles = inventory(outDir);
  const target = named ?? (bundles.length > 0 ? bundles[bundles.length - 1].file : null);
  if (!target) cannotRun(`  no bundle named and none in ${outDir}`);
  const result = verifyBundle(target, root);
  for (const [label, detail] of result.rows) if (detail) console.log(`  ${label.padEnd(18)} ${detail}`);
  console.log(result.ok ? '  VERIFIED' : '  VERIFICATION FAILED');
  process.exit(result.ok ? 0 : 1);
}

const outDir = resolve(value('out', DEFAULT_OUT));
const keep = Number(value('keep', '0'));
if (!Number.isInteger(keep) || keep < 0) cannotRun('  --keep needs a whole number of bundles to retain (0 keeps all)');

const result = createBundle(outDir, root, { keep });
process.exit(result.ok ? 0 : 1);
