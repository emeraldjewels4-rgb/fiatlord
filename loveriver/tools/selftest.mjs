/**
 * The self-test harness both schedule-side modules use.
 *
 * Two selftests is one more than a module should each grow on its own: they were identical
 * down to the "am I the file being executed" check, and the second copy is where the two
 * would start to disagree. So the guard and the pass/fail bookkeeping live here once, and
 * `check()` prints `got` and `expected` only when something fails — a passing run is one
 * line per check, which is what makes it worth reading.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** True only when this module is the file node was asked to run, not when it is imported. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === metaUrl;
}

/** A self-test: `check()` records a comparison, `finish()` prints the verdict and exits. */
export function selftest(name) {
  let failures = 0;
  return {
    check(label, actual, expected) {
      if (actual === expected) {
        console.log(`  ok   ${label}`);
        return;
      }
      failures++;
      console.log(`  FAIL ${label}`);
      console.log(`       got      ${actual}`);
      console.log(`       expected ${expected}`);
    },
    finish() {
      console.log(failures === 0 ? `  ${name} PASSED` : `  ${name} FAILED (${failures})`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}
