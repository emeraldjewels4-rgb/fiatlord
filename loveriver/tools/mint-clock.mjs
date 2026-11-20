#!/usr/bin/env node
/**
 * The year-end mint clock, on GMT+11, as a plain read-only check.
 *
 * THE SCHEDULE
 *
 * Christmas Day is the anchor: 25 December, 00:00, GMT+11. Each year has TWO minting
 * windows, both negative offsets from that moment and four weeks apart:
 *
 *   window 1   Christmas - 8 weeks  ->  Christmas - 4 weeks
 *   window 2   Christmas - 4 weeks  ->  Christmas Day
 *
 * Read literally, the brief asks for supply to be minted twice at the end of the year,
 * before Christmas, at intervals of a negative four weeks from Christmas Day. Two windows,
 * each a whole multiple of four weeks before Christmas and each four weeks long, is the
 * version of that a calendar can execute: the last window closes exactly on Christmas Day
 * and no window starts after it. The eight weeks before Christmas are the minting period,
 * split in half.
 *
 * Windows are half-open, [open, close), so a moment is never in two windows at once and a
 * run at the boundary belongs to the later window only. The schedule itself lives in
 * tools/mint-window.mjs, because `topup.mjs --within-window` enforces the same definition:
 * one source of truth, two views of it.
 *
 * Exit codes, so a scheduler can gate on it:
 *   0  a minting window is open now
 *   1  no window is open
 *   2  the arguments could not be read
 *
 * It never mints and never signs. It answers "is it time, and what would be minted".
 *
 *   node tools/mint-clock.mjs
 *   node tools/mint-clock.mjs --supply 699999999999
 *   node tools/mint-clock.mjs --now 2026-11-28T10:00:00+11:00
 */
import { christmas, gmt11, nextWindowAfter, openWindowAt, resolveNow, windowsFor, yearAt } from './mint-window.mjs';

const argv = process.argv.slice(2);
const value = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

// --now rehearses a date. resolveNow handles both the absence of the flag and a date that
// carries no offset of its own, so it cannot mean different things here and in the gate.
const now = resolveNow(value('now', ''));

const supplyArg = value('supply', '699999999999');
if (!/^\d+$/.test(supplyArg)) {
  console.error(`  --supply ${supplyArg} is not a whole number of LVR`);
  process.exit(2);
}

const year = yearAt(now);
console.log(`  now ${gmt11(now)} (GMT+11)`);
console.log(`  Christmas ${year}: ${gmt11(christmas(year))}`);

const open = openWindowAt(now);
const upcoming = nextWindowAfter(now);

for (const window of windowsFor(year)) {
  const state = now >= window.close ? 'closed' : now >= window.open ? 'OPEN' : 'ahead';
  console.log(`    ${window.label}  ${gmt11(window.open)}  ->  ${gmt11(window.close)}  ${state}`);
}

const days = ((upcoming.open - now) / (24 * 60 * 60 * 1000)).toFixed(1);
console.log(`  next window opens ${gmt11(upcoming.open)} (in ${days} days)`);

if (!open) {
  console.log('  no minting window is open: mint nothing now');
  process.exit(1);
}

const daysLeft = ((open.close - now) / (24 * 60 * 60 * 1000)).toFixed(1);
console.log(`  ${open.label} is OPEN until ${gmt11(open.close)} (${daysLeft} days left)`);

// A split, not a mint: this script performs no transaction.
const share = BigInt(supplyArg) / 5n;
console.log(`  one mint of ${supplyArg} LVR split across 5 admins: ${share} LVR each`);
console.log(`  two mints a year: ${BigInt(supplyArg) * 2n} LVR, before Christmas`);
process.exit(0);
