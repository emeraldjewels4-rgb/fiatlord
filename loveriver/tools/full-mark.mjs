/**
 * The admin full mark: how much an administrator wallet holds when it is full.
 *
 * It is stored rather than inferred, because the only moment the answer is visible on
 * chain is the moment before a distribution drains the admins to (almost) nothing. After
 * that, every admin balance is zero and there is nothing left to measure - so the number
 * has to be written down while it still exists.
 *
 * Amounts are kept as decimal strings of wei. JSON numbers are doubles, and 1e23 LVR in
 * wei is far past the point where a double is exact; a rounded mark would refill wallets
 * to the wrong amount.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** @returns {{fullMark: bigint, source: string, recordedAt: string}|null} */
export function readFullMark(file) {
  if (!existsSync(file)) return null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!/^\d+$/.test(String(saved.fullMark))) return null;
    return {
      fullMark: BigInt(saved.fullMark),
      source: String(saved.source || 'unknown'),
      recordedAt: String(saved.recordedAt || 'unknown'),
    };
  } catch {
    // A corrupt mark is not worth guessing at: treat it as absent and say so at the call
    // site, which then requires --target instead of refilling to a made-up number.
    return null;
  }
}

export function writeFullMark(file, fullMark, source) {
  writeFileSync(
    file,
    JSON.stringify(
      { version: 1, fullMark: fullMark.toString(), source, recordedAt: new Date().toISOString() },
      null,
      2
    ) + '\n'
  );
}
