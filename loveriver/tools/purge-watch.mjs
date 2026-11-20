#!/usr/bin/env node
/**
 * Watches the scheduled ledger purge, because a dead scheduler looks exactly like a working one.
 *
 * The ten-minute rule on mint-ledger.jsonl is enforced by `ops/ledger-purge.cmd` (Task Scheduler,
 * every minute) or `ops/ledger-purge.sh` (cron). Nothing else notices when that stops: the ledger
 * simply stops being emptied, quietly, and the entries that are supposed to live ten minutes sit
 * on disk instead. No error is raised anywhere, because no process is failing — there is simply
 * one fewer process running than there should be.
 *
 * Two things are checked, and they fail differently:
 *
 *   registered   the task still exists (a reinstall, a profile move or a `schtasks /Delete` can
 *                remove it, and the project directory can be moved out from under it).
 *   recently ran the purge left a heartbeat on disk within the last few minutes. This is the
 *                check that matters: a task can be registered and still never fire, and a
 *                heartbeat proves the whole chain ran — Task Scheduler, wscript, node, the purge.
 *
 * The heartbeat is one small file rewritten after each successful purge, so it does not grow and
 * does not turn into the per-minute log that the purge deliberately avoids writing.
 *
 *   node tools/purge-watch.mjs --status
 *   node tools/purge-watch.mjs --status --purge-task "Loveriver ledger purge"
 *   node tools/purge-watch.mjs --selftest
 *
 * `tools/topup.mjs` calls `assessPurge()` on every run and prints its warnings, so the check
 * rides along with a job that already runs, instead of needing a watcher of its own.
 *
 * Exit codes for --status: 0 the scheduler looks alive, 1 it looks dead or unverifiable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_TASK = 'Loveriver ledger purge';
export const DEFAULT_HEARTBEAT = 'logs/ledger-purge.heartbeat';
/** The purge runs every minute; a quarter of an hour of silence is not a missed tick. */
export const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

const minutes = (ms) => (ms === null || ms === undefined ? 'unknown' : Math.round(ms / 60000));

/** Is the scheduled job still registered? `known: false` means this machine could not be asked. */
export function registrationStatus(taskName, { platform = process.platform, run = execFileSync } = {}) {
  if (platform === 'win32') {
    try {
      run('schtasks', ['/query', '/tn', taskName], { stdio: 'ignore' });
      return { known: true, registered: true, how: `Task Scheduler task "${taskName}"` };
    } catch (error) {
      // A non-zero exit means "no such task"; anything else is still a missing registration as
      // far as this check is concerned, but the exit code is kept for the message.
      return { known: true, registered: false, how: `Task Scheduler task "${taskName}"`, code: error.status ?? null };
    }
  }

  try {
    const listing = run('crontab', ['-l'], { encoding: 'utf8' });
    return { known: true, registered: /ledger-purge\.sh/.test(String(listing)), how: 'crontab entry for ops/ledger-purge.sh' };
  } catch {
    // No crontab command, or no crontab for this user: unverifiable rather than dead, because
    // a systemd timer is a legitimate alternative this cannot see.
    return { known: false, registered: null, how: 'crontab (not available here)' };
  }
}

/** When did the purge last finish successfully? Its heartbeat's mtime is the answer. */
export function heartbeatStatus(file, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!existsSync(file)) return { exists: false, ran: false, ageMs: null, lastAt: null };
  const { mtimeMs } = statSync(file);
  const ageMs = now - mtimeMs;
  return { exists: true, ran: ageMs <= maxAgeMs, ageMs, lastAt: new Date(mtimeMs) };
}

/** What is actually sitting on disk, so a warning can say how much it matters. */
export function ledgerExposure(file, now = Date.now()) {
  if (!file || !existsSync(file)) return { entries: 0, oldestAgeMs: null };
  let entries = 0;
  let oldest = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    entries++;
    try {
      const at = Date.parse(JSON.parse(line).at);
      if (Number.isFinite(at) && (oldest === null || at < oldest)) oldest = at;
    } catch {
      // A torn line still counts as an entry on disk; its timestamp is simply unknown.
    }
  }
  return { entries, oldestAgeMs: oldest === null ? null : now - oldest };
}

/**
 * The whole verdict, as lines ready to print. Loud lines start with `!!` and are the ones that
 * mean the ten-minute rule is not being enforced.
 */
export function assessPurge({
  taskName = DEFAULT_TASK,
  heartbeatFile = DEFAULT_HEARTBEAT,
  ledgerFile = 'mint-ledger.jsonl',
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
  platform = process.platform,
  run = execFileSync,
} = {}) {
  const registered = registrationStatus(taskName, { platform, run });
  const beat = heartbeatStatus(heartbeatFile, { now, maxAgeMs });
  const exposure = ledgerExposure(ledgerFile, now);
  const lines = [];
  const loud = [];

  const onDisk =
    exposure.entries === 0
      ? 'the ledger holds nothing right now'
      : `${exposure.entries} entr${exposure.entries === 1 ? 'y' : 'ies'} on disk, oldest ${minutes(exposure.oldestAgeMs)} minutes old`;

  if (registered.known && registered.registered === false) {
    loud.push(
      '!! LEDGER PURGE IS NOT SCHEDULED — the ten-minute rule is not running.',
      `!!   ${registered.how} was not found${registered.code !== null && registered.code !== undefined ? ` (schtasks exit ${registered.code})` : ''}.`,
      '!!   Entries are now deleted only by a topup run or by the detached purge after a mint;',
      '!!   if nothing else runs, lines stay on disk indefinitely.',
      `!!   ${onDisk}.`
    );
  }

  if (!beat.exists) {
    loud.push(
      '!! LEDGER PURGE HAS NEVER REPORTED A SUCCESSFUL RUN — no heartbeat on disk.',
      `!!   expected at ${heartbeatFile}, written by ops/ledger-purge.cmd or .sh after each run.`,
      '!!   Either the scheduled job has never fired, or the wrapper predates the heartbeat.',
      `!!   ${onDisk}.`
    );
  } else if (!beat.ran) {
    loud.push(
      `!! LEDGER PURGE HAS NOT RUN FOR ${minutes(beat.ageMs)} MINUTES — it is scheduled to run every one.`,
      `!!   last successful purge ${beat.lastAt.toISOString()}.`,
      `!!   A registered task that does not fire is the failure this check exists for.`,
      `!!   ${onDisk}.`
    );
  }

  if (!registered.known) {
    lines.push(`  ` + `.. the scheduled purge cannot be verified here (${registered.how}); the heartbeat is the only evidence.`);
  }
  if (loud.length === 0) {
    const age = beat.ageMs === null ? 'just now' : `${minutes(beat.ageMs)} min ago`;
    lines.push(`  ok   ledger purge scheduled (${registered.how}) and last ran ${age}`);
  }

  return {
    ok: loud.length === 0 && registered.registered !== false,
    registered,
    heartbeat: beat,
    exposure,
    loud,
    lines,
  };
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 || at === argv.length - 1 ? fallback : argv[at + 1];
};

if (flag('selftest')) {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = String(actual) === String(expected);
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) console.log(`       got ${actual}, expected ${expected}`);
  };

  const runs = () => ({ stdio: 'ignore' });
  check(
    'a task that exists is registered',
    registrationStatus('X', { platform: 'win32', run: runs }).registered,
    true
  );
  const refusing = () => {
    const error = new Error('not found');
    error.status = 1;
    throw error;
  };
  const missing = registrationStatus('X', { platform: 'win32', run: refusing });
  check('a task that does not exist is not registered', missing.registered, false);
  check('and its exit code is kept for the message', missing.code, 1);
  check(
    'a crontab without the purge line is not registered',
    registrationStatus('X', { platform: 'linux', run: () => 'MAILTO=me\n' }).registered,
    false
  );
  check(
    'a crontab with the purge line is registered',
    registrationStatus('X', { platform: 'linux', run: () => '*/1 * * * * /x/ops/ledger-purge.sh\n' }).registered,
    true
  );
  check(
    'no crontab command at all is unverifiable, not dead',
    registrationStatus('X', {
      platform: 'linux',
      run: () => {
        throw new Error('ENOENT');
      },
    }).known,
    false
  );

  const heartbeat = resolve('cache', 'purge-watch-heartbeat');
  const { mkdirSync, writeFileSync, utimesSync, rmSync } = await import('node:fs');
  // cache/ is gitignored, so a fresh clone has no such directory: the first write threw ENOENT,
  // which failed this selftest and made the pre-commit hook refuse the clone's first commit.
  mkdirSync(resolve('cache'), { recursive: true });
  rmSync(heartbeat, { force: true });
  check('a missing heartbeat has not run', heartbeatStatus(heartbeat).ran, false);
  writeFileSync(heartbeat, 'x');
  const now = Date.now();
  utimesSync(heartbeat, new Date(now - 60_000), new Date(now - 60_000));
  check('a minute-old heartbeat has run', heartbeatStatus(heartbeat, { now }).ran, true);
  utimesSync(heartbeat, new Date(now - 40 * 60_000), new Date(now - 40 * 60_000));
  check('a forty-minute-old heartbeat has not', heartbeatStatus(heartbeat, { now }).ran, false);
  rmSync(heartbeat, { force: true });

  console.log(failures === 0 ? '  purge-watch selftest PASSED' : `  purge-watch selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

if (flag('status')) {
  const verdict = assessPurge({
    taskName: value('purge-task', DEFAULT_TASK),
    heartbeatFile: resolve(value('purge-heartbeat', DEFAULT_HEARTBEAT)),
    ledgerFile: resolve(value('ledger', 'mint-ledger.jsonl')),
    maxAgeMs: Number(value('purge-max-age', DEFAULT_MAX_AGE_MS / 60000)) * 60000,
  });
  for (const line of verdict.loud) console.error(line);
  for (const line of verdict.lines) console.log(line);
  process.exit(verdict.ok ? 0 : 1);
}

console.log('  nothing to do: pass --status or --selftest');
