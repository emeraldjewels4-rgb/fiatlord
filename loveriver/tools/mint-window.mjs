/**
 * The year-end minting schedule, as functions rather than a script.
 *
 * The clock and the top-up gate must not be able to disagree about when minting is
 * allowed, so the schedule lives here once and both of them import it. `mint-clock.mjs` is
 * the read-only view of it; `topup.mjs --within-window` is the enforcement.
 *
 * Christmas Day at GMT+11 is the anchor. Each year has two four-week windows before it:
 *
 *   window 1   Christmas - 8 weeks  ->  Christmas - 4 weeks
 *   window 2   Christmas - 4 weeks  ->  Christmas Day
 *
 * Windows are half-open, [open, close), so a moment is never in two at once and a run at
 * the boundary belongs to the later window only.
 *
 * GMT+11 is a fixed offset, not a time-zone name: it does not follow daylight saving, so
 * every machine and every server agrees on the answer.
 *
 * `node tools/mint-window.mjs --selftest` pins the boundaries for several years against
 * literal dates, the same way gen-wallets checks its derivation: the schedule was lifted
 * out of the clock, and a refactor of the arithmetic must fail a test rather than quietly
 * move the minting season.
 */
import { isMain, selftest } from './selftest.mjs';

const OFFSET_MS = 11 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const WINDOWS = [
  { label: 'window 1', openWeeksBefore: 8, closeWeeksBefore: 4 },
  { label: 'window 2', openWeeksBefore: 4, closeWeeksBefore: 0 },
];

/** Christmas Day 00:00 at GMT+11 for a year, as a UTC instant. */
export function christmas(year) {
  // 25 Dec 00:00 +11:00 is 24 Dec 13:00 UTC.
  return Date.UTC(year, 11, 24, 13, 0, 0, 0);
}

/** The same instant written as a GMT+11 wall-clock string, from components only. */
export function gmt11(instant) {
  const shifted = new Date(instant + OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} +11:00`
  );
}

/** Both windows of one calendar year (in UTC instant form). */
export function windowsFor(year) {
  const anchor = christmas(year);
  return WINDOWS.map((window) => ({
    label: window.label,
    year,
    open: anchor - window.openWeeksBefore * WEEK_MS,
    close: anchor - window.closeWeeksBefore * WEEK_MS,
  }));
}

/** The GMT+11 calendar year an instant falls in. */
export function yearAt(instant) {
  return new Date(instant + OFFSET_MS).getUTCFullYear();
}

/**
 * The window containing `instant`, or null. A window never crosses a year boundary, so only
 * the instant's own year can contain it.
 */
export function openWindowAt(instant) {
  return windowsFor(yearAt(instant)).find((window) => instant >= window.open && instant < window.close) || null;
}

/**
 * The next window to open. There is always one: a year's first window opens in October, so
 * after December's window closes the next year's is still ahead.
 */
export function nextWindowAfter(instant) {
  const year = yearAt(instant);
  return [...windowsFor(year), ...windowsFor(year + 1)].find((window) => window.open > instant);
}

/**
 * Parse an instant that carries its own offset. A bare local time is refused: "--now
 * 10:00" would otherwise mean something different on every machine that runs it.
 */
export function parseInstant(spec) {
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(spec)) return null;
  const parsed = Date.parse(spec);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * What `--now` means: the instant it names, or the current time when it is absent. This is
 * the one place the three tools resolve it, so the message and the exit code cannot drift.
 */
export function resolveNow(spec) {
  if (!spec) return Date.now();
  const parsed = parseInstant(spec);
  if (parsed === null) {
    console.error(`  --now ${spec} needs an explicit offset, e.g. 2026-11-28T10:00:00+11:00`);
    process.exit(2);
  }
  return parsed;
}

/**
 * The self-test, run with --selftest and only when this file is the one being executed (it
 * is imported by the clock and the top-up gate, which must never print a test).
 *
 * Every expected value is a literal date, not one recomputed from the same arithmetic: the
 * point is to catch the schedule moving, and a test that derives its own expectations
 * cannot. Leap years, the half-open boundaries and the offset are all pinned, because those
 * are the three places this arithmetic can go wrong without anything looking unusual.
 */
if (process.argv.includes('--selftest') && isMain(import.meta.url)) {
  const test = selftest('selftest');
  const { check } = test;
  const iso = (instant) => (instant === null ? 'none' : new Date(instant).toISOString());
  const opens = (year, index) => windowsFor(year)[index].open;
  const closes = (year, index) => windowsFor(year)[index].close;
  const containing = (spec) => {
    const window = openWindowAt(Date.parse(spec));
    return window ? `${window.label} of ${window.year}` : 'none';
  };

  console.log('  the anchor: Christmas Day 00:00 GMT+11, which is 13:00 UTC the day before');
  check('christmas 2026', iso(christmas(2026)), '2026-12-24T13:00:00.000Z');
  check('christmas 2027', iso(christmas(2027)), '2027-12-24T13:00:00.000Z');
  check('christmas 2028', iso(christmas(2028)), '2028-12-24T13:00:00.000Z');

  console.log('  the two windows of 2026, and a leap year that must not move them');
  check('window 1 opens', iso(opens(2026, 0)), '2026-10-29T13:00:00.000Z');
  check('window 1 closes', iso(closes(2026, 0)), '2026-11-26T13:00:00.000Z');
  check('window 2 opens', iso(opens(2026, 1)), '2026-11-26T13:00:00.000Z');
  check('window 2 closes', iso(closes(2026, 1)), '2026-12-24T13:00:00.000Z');
  check('window 1 of 2028 opens on the same day', iso(opens(2028, 0)), '2028-10-29T13:00:00.000Z');

  console.log('  the same instants as a GMT+11 wall clock');
  check('Christmas Day', gmt11(christmas(2026)), '2026-12-25 00:00:00 +11:00');
  check('window 1 opens', gmt11(opens(2026, 0)), '2026-10-30 00:00:00 +11:00');
  check('20:00 UTC on 31 Dec is already 2027', yearAt(Date.parse('2026-12-31T20:00:00Z')), 2027);
  check('12:00 UTC on 31 Dec is still 2026', yearAt(Date.parse('2026-12-31T12:00:00Z')), 2026);

  console.log('  half-open boundaries: the open instant is inside, the close instant is not');
  check('at window 1 open', containing('2026-10-29T13:00:00Z'), 'window 1 of 2026');
  check('1 ms before window 1', containing('2026-10-29T12:59:59.999Z'), 'none');
  check('at window 1 close, which is window 2 open', containing('2026-11-26T13:00:00Z'), 'window 2 of 2026');
  check('a morning in the season', containing('2026-10-30T09:00:00+11:00'), 'window 1 of 2026');
  check('1 ms before Christmas Day', containing('2026-12-24T12:59:59.999Z'), 'window 2 of 2026');
  check('Christmas Day 00:00 GMT+11', containing('2026-12-24T13:00:00Z'), 'none');

  console.log('  no gap, no overlap, four weeks each');
  check('window 1 ends where window 2 starts', closes(2026, 0) === opens(2026, 1), true);
  check('window 1 is 28 days', (closes(2026, 0) - opens(2026, 0)) / 86_400_000, 28);
  check('window 2 is 28 days', (closes(2026, 1) - opens(2026, 1)) / 86_400_000, 28);

  console.log('  what comes next');
  check(
    'after Christmas 2026',
    iso(nextWindowAfter(Date.parse('2026-12-26T00:00:00+11:00')).open),
    '2027-10-29T13:00:00.000Z'
  );
  check(
    'before the 2026 season',
    iso(nextWindowAfter(Date.parse('2026-10-01T00:00:00+11:00')).open),
    '2026-10-29T13:00:00.000Z'
  );

  console.log('  --now must carry its own offset');
  check('an offset-free time is refused', parseInstant('2026-11-28T10:00:00'), null);
  check('a z inside a date is not an offset', parseInstant('2026-11-28Tzebra'), null);
  check('+11:00 is kept', iso(parseInstant('2026-11-28T10:00:00+11:00')), '2026-11-27T23:00:00.000Z');
  check('Z is kept', iso(parseInstant('2026-11-28T10:00:00Z')), '2026-11-28T10:00:00.000Z');

  test.finish();
}
