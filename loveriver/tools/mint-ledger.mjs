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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
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
export function purgeLedger(file, now, retention = RETENTION_MS) {
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
  renameSync(temporary, file);
  return { kept: kept.length, removed: entries.length - kept.length };
}

/** Append one entry. Append-only in the sense that entries are never edited in place. */
export function appendLedger(file, entry) {
  writeFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: 'a' });
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
