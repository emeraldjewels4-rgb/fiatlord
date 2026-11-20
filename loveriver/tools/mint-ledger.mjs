#!/usr/bin/env node
/**
 * The mint ledger: a ten-minute hot journal, not an audit trail.
 *
 * WHAT IT RECORDS
 *
 *   One line per mint that topup.mjs actually broadcast, with the six fields the brief
 *   names: the whole instant, which rule issued it (floor or full), which mint window was
 *   open, the admin wallet, the amount, and the transaction hash.
 *
 * WHAT IT DELETES, AND WHEN
 *
 *   Anything ten minutes old or older. A purge does not archive, move, compress or copy:
 *   the expired lines are simply not written back, and when nothing is left the file is
 *   removed. There is no history file, no rotation, no backup and no "--keep" flag, because
 *   the point of the rule is that the record is gone rather than filed somewhere else.
 *
 *   Expiry does not wait for a reader. Three mechanisms, in order of how much they can be
 *   relied on:
 *
 *     1. An installed one-minute job (ops/ledger-purge.*). This is the only one that lives
 *        outside any process, so it is the only one that survives a reboot, a crash or a
 *        machine that was asleep when the retention ran out.
 *     2. A detached one-shot spawned by the run that minted (deferPurge, below), so the
 *        common case is exact even where no scheduler has been installed.
 *     3. Purge-on-touch in topup.mjs and --show, now only a backstop.
 *
 *   What none of them can do is run while the machine is off. Entries written before a
 *   shutdown are destroyed at the first tick after it boots, which is later than ten minutes;
 *   nothing in this file can fix that, and the README says so rather than implying otherwise.
 *
 * TWO RUNS AT ONCE
 *
 *   Appends and purges take an exclusive lock, `<file>.lock`. Without it there are two failures,
 *   and the second is silent: interleaved writes can produce a torn line (dropped on read, so a
 *   mint record simply disappears), and a purge that reads, filters and renames can be overtaken
 *   by an append in between — the rename then replaces the file with a copy that never contained
 *   the new line. Holding the lock across read-filter-rename is what makes the second impossible.
 *
 *   Reads stay lock-free on purpose: the rename is atomic, so a reader sees either the old file or
 *   the purged one, and an unparsable line is skipped rather than fatal. That also keeps
 *   readLedger callable from inside a held lock.
 *
 * WHAT IT CANNOT DO, SAID PLAINLY
 *
 *   1. It cannot make a mint disappear. Minting is an owner call on a public chain: the
 *      transaction stays in every block explorer and every full node forever. Deleting the
 *      local line destroys the convenience copy, and that is all it can mean.
 *   2. It cannot guarantee the bytes are unrecoverable from the disk. Deleting a file
 *      removes the name and the blocks the filesystem still points at; journals, SSD wear
 *      levelling, snapshots and cloud backups may hold older copies of it. Promising
 *      "gone from every digital imprint" would be a promise this code cannot keep.
 *
 *   What it does give: the running machine does not accumulate a table of who was paid
 *   what, which is what a surprise device inspection or a leak of this directory would
 *   otherwise hand over. The currency itself is untouched — deleting a ledger line moves no
 *   tokens, and nothing here has a key.
 *
 * TYPE OF EVENT
 *
 *   `rule` is 'floor' (the never-empty backstop) or 'full' (issuance inside a window), and
 *   `window` is 'ungated' when the run did not consult the calendar, 'none' when the floor
 *   was restored outside a window. Trades, swaps, withdrawals, deposits and card payments
 *   are not events this repository can produce — it has no market, no bank and no card
 *   processor — so there is no honest entry to write for them, and inventing one would make
 *   the ledger a worse record of what actually happened.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMain, selftest } from './selftest.mjs';
import { resolveNow } from './mint-window.mjs';

/** How long an entry lives. The brief's ten minutes, in one place. */
export const RETENTION_MS = 10 * 60 * 1000;

/** The fields an entry has, in the order they are written. */
export const FIELDS = ['at', 'rule', 'window', 'admin', 'amount', 'txHash'];

/** How long an append or purge waits for the lock before giving up on the other run. */
const LOCK_WAIT_MS = 5000;

/** A lock older than this is a crash, not a slow run, and is reclaimed. */
const LOCK_STALE_MS = 30_000;

/** Sleep without spinning the CPU (Atomics.wait on a buffer nobody shares). */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `fn` while holding the ledger's lock.
 *
 * The lock is a file created with `wx`, which fails if it already exists — an atomic test-and-set
 * on every filesystem that matters, without needing flock (Node has none on Windows). The pid
 * goes in it so a stuck lock can be traced to the run that left it.
 *
 * A lock left by a killed process would wedge the ledger forever, so one older than
 * LOCK_STALE_MS is removed and retried. That reclaim is itself racy in principle: two runs can
 * both decide a lock is stale, and one can delete the other's fresh lock in between. The window
 * is a few milliseconds against a 30-second threshold, and the cost of being wrong is one
 * interleaved pair of writes, not a corrupted file.
 */
export function withLedgerLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const handle = openSync(lock, 'wx');
      writeSync(handle, String(process.pid));
      closeSync(handle);
      break;
    } catch (error) {
      // Windows reports a lock file that is being created or deleted by someone else as EPERM or
      // EACCES rather than EEXIST, so treating "not EEXIST" as fatal turns ordinary contention
      // into a crash. Every one of these means the same thing here: somebody else is in there.
      const contended = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!contended) throw error;
      let age;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between the failed open and the stat: try again at once
      }
      if (age > LOCK_STALE_MS) {
        try {
          unlinkSync(lock);
        } catch {
          // someone else reclaimed it first, which is the outcome we wanted
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`ledger is locked (${lock}, held ${Math.round(age)} ms); another run is still working`);
      }
      pause(5);
    }
  }

  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone; never mask the real result with a release failure
    }
  }
}

/** Entries still on file, oldest first. A torn line from a crash is dropped, not repaired. */
export function readLedger(file) {
  if (!existsSync(file)) return [];
  const entries = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A half-written line is evidence of an interrupted write, not an entry.
    }
  }
  return entries;
}

/**
 * Destroy every entry that is RETENTION_MS old or older, and return what happened.
 *
 * The boundary is deliberate: an entry exactly ten minutes old is gone, so "kept for ten
 * minutes" means at most ten minutes and never ten minutes plus however long the process
 * took to wake up.
 */
function purgeUnlocked(file, now, retention) {
  const entries = readLedger(file);
  const cutoff = now - retention;
  const kept = entries.filter((entry) => Date.parse(entry.at) > cutoff);

  if (kept.length === entries.length) return { kept: kept.length, removed: 0 };
  if (kept.length === 0) {
    rmSync(file, { force: true });
    return { kept: 0, removed: entries.length };
  }

  // Write beside the file and rename over it, so a purge interrupted midway leaves either
  // the old ledger or the purged one, never a half-written mix of the two.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${kept.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 });
  // A test seam, never set in normal operation: hold the file between writing the replacement and
  // renaming it over the ledger, so the selftest can put a concurrent append inside the window by
  // construction instead of hoping the scheduler produces one.
  const holdMs = Number(process.env.LOVERIVER_PURGE_HOLD_MS ?? 0);
  if (holdMs > 0) pause(holdMs);
  renameSync(temporary, file);
  return { kept: kept.length, removed: entries.length - kept.length };
}

/**
 * Purge under the lock. The read, the filter and the rename all happen while no append can run,
 * so a line written by another process is either in the file before the read and kept, or waits
 * for the lock and lands after the rename. It cannot be erased by the rewrite.
 */
export function purgeLedger(file, now, retention = RETENTION_MS) {
  return withLedgerLock(file, () => purgeUnlocked(file, now, retention));
}

/** Append one entry. Append-only in the sense that entries are never edited in place. */
export function appendLedger(file, entry) {
  withLedgerLock(file, () => {
    writeFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: 'a' });
  });
}

/**
 * Destroy the ledger once its newest entry has expired, without a scheduler.
 *
 * A timer is the only way a file expires while nothing is running, but a once-a-minute job is
 * the wrong timer: on Windows it is a Task Scheduler entry and a console window every minute,
 * on a laptop it fires while the lid is shut, and in every case it is watching a file that
 * holds entries for ten minutes after a run that minted. So the run that writes them spawns
 * one detached process, which sleeps past the retention, purges once and exits.
 *
 * The margin is not decoration: waking at exactly the retention can beat the newest entry's
 * own timestamp by a millisecond and leave that one line for the next run to find.
 */
export function deferPurge(file, delayMs = RETENTION_MS + 1000) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--purge', '--file', file, '--after', String(delayMs)],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
  return child.pid;
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

if (flag('selftest') && isMain(import.meta.url)) {
  const test = selftest('ledger selftest');
  const file = join(tmpdir(), `lvr-ledger-${process.pid}.jsonl`);
  const now = Date.parse('2026-11-20T12:00:00.000Z');
  const entry = (agoMs, admin = '0x1') => ({
    at: new Date(now - agoMs).toISOString(),
    rule: 'floor',
    window: 'window 1 of 2026',
    admin,
    amount: '14000000000.0',
    txHash: '0xdead',
  });

  try {
    test.check('an absent file reads as empty', readLedger(file).length, 0);

    appendLedger(file, entry(0));
    appendLedger(file, entry(60_000, '0x2'));
    test.check('each append is one line', readFileSync(file, 'utf8').trim().split('\n').length, 2);
    test.check('read gives them back in order', readLedger(file).map((e) => e.admin).join(','), '0x1,0x2');
    test.check('the six fields, in order', Object.keys(readLedger(file)[0]).join(','), FIELDS.join(','));

    writeFileSync(file, '{"at":"2026-11-20T1\n');
    appendLedger(file, entry(1_000, '0x3'));
    test.check('a torn line is dropped, the good one kept', readLedger(file).map((e) => e.admin).join(','), '0x3');

    const fresh = join(tmpdir(), `lvr-ledger-boundary-${process.pid}.jsonl`);
    writeFileSync(fresh, '');
    appendLedger(fresh, entry(RETENTION_MS));
    appendLedger(fresh, entry(RETENTION_MS - 1, '0x4'));
    const boundary = purgeLedger(fresh, now);
    test.check('exactly ten minutes old is destroyed', boundary.removed, 1);
    test.check('one millisecond newer survives', boundary.kept, 1);
    test.check('the survivor is the newer one', readLedger(fresh).map((e) => e.admin).join(','), '0x4');

    writeFileSync(fresh, '');
    appendLedger(fresh, entry(RETENTION_MS));
    purgeLedger(fresh, now);
    test.check('nothing left means no file at all', existsSync(fresh), false);
    test.check('and no stray temporary', existsSync(`${fresh}.tmp`), false);

    const purged = purgeLedger(fresh, now);
    test.check('purging a missing file is not an error', `${purged.kept}/${purged.removed}`, '0/0');
    rmSync(fresh, { force: true });
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}.tmp`, { force: true });
  }

  // A killed run leaves its lock behind. An append must reclaim it rather than block for the
  // full wait, or one crash wedges the ledger permanently.
  const staleFile = join(tmpdir(), `lvr-ledger-stale-${process.pid}.jsonl`);
  rmSync(staleFile, { force: true });
  appendLedger(staleFile, entry(0, 'stale-1'));
  writeFileSync(`${staleFile}.lock`, '99999');
  const longAgo = new Date(Date.now() - LOCK_STALE_MS - 5000);
  utimesSync(`${staleFile}.lock`, longAgo, longAgo);
  const started = Date.now();
  appendLedger(staleFile, entry(0, 'stale-2'));
  test.check('a stale lock is reclaimed, not waited out', readLedger(staleFile).length, 2);
  test.check('and reclaimed at once, not after the timeout', Date.now() - started < 2000, true);
  test.check('the lock is gone once the work is done', existsSync(`${staleFile}.lock`), false);

  // The deterministic race: hold the purge inside its rewrite window and append during the hold.
  // With the lock that append waits and lands after the rename; without it the rename replaces the
  // file with a copy that never contained the line, and nothing reports it.
  const heldFile = join(tmpdir(), `lvr-ledger-held-${process.pid}.jsonl`);
  rmSync(heldFile, { force: true });
  appendLedger(heldFile, {
    at: new Date(Date.now() - RETENTION_MS - 60_000).toISOString(),
    rule: 'floor',
    window: 'none',
    admin: 'held-old',
    amount: '1.0',
    txHash: '0xold',
  });
  appendLedger(heldFile, {
    at: new Date().toISOString(),
    rule: 'full',
    window: 'window 1 of 2026',
    admin: 'held-keep',
    amount: '2.0',
    txHash: '0xkeep',
  });
  const purger = spawn(process.execPath, [fileURLToPath(import.meta.url), '--purge', '--file', heldFile], {
    stdio: 'ignore',
    env: { ...process.env, LOVERIVER_PURGE_HOLD_MS: '800' },
  });
  const purgerDone = new Promise((done) => purger.on('exit', done));
  // Wait for the temporary file to appear: that is the window, by construction.
  let windowOpen = false;
  for (let attempt = 0; attempt < 600 && !windowOpen; attempt++) {
    windowOpen = existsSync(`${heldFile}.tmp`);
    if (!windowOpen) await new Promise((done) => setTimeout(done, 5));
  }
  appendLedger(heldFile, {
    at: new Date().toISOString(),
    rule: 'full',
    window: 'window 1 of 2026',
    admin: 'held-during',
    amount: '3.0',
    txHash: '0xduring',
  });
  await purgerDone;
  const heldAdmins = readLedger(heldFile).map((row) => row.admin);
  test.check('the purge window really was open', windowOpen, true);
  test.check('a write during the purge rewrite survives', heldAdmins.includes('held-during'), true);
  test.check('and the entry the purge kept is still there', heldAdmins.includes('held-keep'), true);
  test.check('the expired entry it targeted is gone', heldAdmins.includes('held-old'), false);
  rmSync(heldFile, { force: true });
  rmSync(`${heldFile}.lock`, { force: true });
  rmSync(`${heldFile}.tmp`, { force: true });

  // The same race under load: two real processes append while this one purges
  // a file that contains expired lines (so every purge really does rewrite). Every appended line
  // must survive exactly once. Without the lock the rewrite drops whichever line landed between
  // its read and its rename, and nothing anywhere reports it.
  const raceFile = join(tmpdir(), `lvr-ledger-race-${process.pid}.jsonl`);
  const workerFile = join(tmpdir(), `lvr-ledger-worker-${process.pid}.mjs`);
  rmSync(raceFile, { force: true });
  // Seeded against the REAL clock, not the fixed `now` the deterministic checks use: purging
  // with Date.now() would otherwise keep them, because that fixed instant is hours in the future
  // and a future timestamp is never expired.
  const expiredAt = new Date(Date.now() - RETENTION_MS - 60_000).toISOString();
  for (let i = 0; i < 60; i++) {
    appendLedger(raceFile, {
      at: expiredAt,
      rule: 'floor',
      window: 'none',
      admin: `old-${i}`,
      amount: '1.0',
      txHash: '0xold',
    });
  }
  writeFileSync(
    workerFile,
    [
      `import { appendLedger } from ${JSON.stringify(import.meta.url)};`,
      'const [file, count, tag] = process.argv.slice(2);',
      'for (let i = 0; i < Number(count); i++) {',
      '  appendLedger(file, { at: new Date().toISOString(), rule: "floor", window: "none",',
      '    admin: tag + "-" + i, amount: "1.0", txHash: "0x" + tag + i });',
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);',
      '}',
    ].join('\n')
  );
  const writers = ['a', 'b'].map((tag) =>
    spawn(process.execPath, [workerFile, raceFile, '60', tag], { stdio: 'ignore' })
  );
  // Attached before anything is awaited, so a writer that finishes early cannot be missed.
  const exited = writers.map((writer) => new Promise((done) => writer.on('exit', done)));

  // Purge while they append. Two things about this loop are load-bearing:
  //   - it yields between purges, because a child's exitCode is only updated when its exit event
  //     is handled, so a purely synchronous loop can never observe a writer finishing;
  //   - it does not hammer the lock, or the writers sit in their five-second wait and the test
  //     measures starvation instead of the rewrite race.
  let purges = 0;
  let rewrites = 0;
  for (let attempt = 0; attempt < 400; attempt++) {
    // One expired line per pass, so every purge really rewrites the file. Without this the first
    // purge clears the seeded lines, every later purge takes the "nothing removed" early return,
    // and the test never opens the window it exists to hit — it passes with the lock removed.
    appendLedger(raceFile, {
      at: expiredAt,
      rule: 'floor',
      window: 'none',
      admin: `churn-${attempt}`,
      amount: '0.0',
      txHash: '0xchurn',
    });
    const outcome = purgeLedger(raceFile, Date.now());
    if (outcome.removed > 0) rewrites++;
    purges++;
    if (writers.every((writer) => writer.exitCode !== null)) break;
    await new Promise((done) => setTimeout(done, 2));
  }
  const stillRunning = writers.some((writer) => writer.exitCode === null);
  if (stillRunning) writers.forEach((writer) => writer.kill());
  await Promise.all(exited);
  // A writer killed mid-append cannot release its own lock; in the normal case there is no lock
  // file here and this removes nothing.
  rmSync(`${raceFile}.lock`, { force: true });

  purgeLedger(raceFile, Date.now());
  const survivors = readLedger(raceFile);
  const admins = survivors.map((row) => row.admin);
  test.check('both writers finished while purges were running', purges > 1 && !stillRunning, true);
  test.check('the purges really rewrote the file, not just early-returned', rewrites > 10, true);
  test.check('every concurrent append survived the purge rewrite', survivors.length, 120);
  test.check('and none were duplicated', new Set(admins).size, 120);
  test.check('the seeded expired lines are gone', admins.filter((a) => String(a).startsWith('old-')).length, 0);
  rmSync(raceFile, { force: true });
  rmSync(`${raceFile}.lock`, { force: true });
  rmSync(workerFile, { force: true });

  test.finish();
}

if (isMain(import.meta.url) && !flag('selftest')) {
  const file = value('file', 'mint-ledger.jsonl');
  if (flag('show')) {
    const { removed } = purgeLedger(file, Date.now());
    if (removed > 0) console.log(`  ${removed} expired entries destroyed before showing`);
    const entries = readLedger(file);
    console.log(`  ${file}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, none older than 10 minutes`);
    for (const entry of entries) {
      console.log(
        `    ${entry.at}  ${entry.rule.padEnd(5)}  ${String(entry.window).padEnd(18)}  ` +
          `${entry.amount} LVR  ${entry.admin}  ${entry.txHash}`
      );
    }
  } else if (flag('purge')) {
    // --after is the sleep deferPurge's detached child is given; 0 purges immediately.
    const after = Number(value('after', '0'));
    if (after > 0) await new Promise((done) => setTimeout(done, after));
    const { kept, removed } = purgeLedger(file, resolveNow(value('now', '')));
    // Silent when there was nothing to destroy: this runs once a minute from a scheduler, and
    // a log line saying "destroyed nothing" 1,439 times a day is noise, not evidence.
    if (removed > 0) console.log(`  destroyed ${removed} expired entr${removed === 1 ? 'y' : 'ies'}, kept ${kept}`);
  } else if (flag('forget')) {
    const existed = existsSync(file);
    rmSync(file, { force: true });
    rmSync(`${file}.tmp`, { force: true });
    console.log(existed ? `  removed ${file}` : `  ${file} was already absent`);
  } else {
    console.error('  --show, --purge, --forget or --selftest');
    process.exit(2);
  }
}
