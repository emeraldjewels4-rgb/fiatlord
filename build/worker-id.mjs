// Content identity for build/site-fiatlord.worker.js.
//
// The value lives in the worker as `const WORKER_ID = "<12 hex>";` and is the
// first 12 hex of sha256 over the worker's own source with that value zeroed
// out. Zeroing is what makes it self-referential but stable: the id can be
// recomputed from any clone, and it cannot be guessed from the deployed answer.
//
// The harness recomputes it and fails when the stamp is stale, so editing the
// worker without restamping breaks `make_site_fiatlord.py --check` instead of
// shipping a host that misreports which code it runs.
//
//     node build/worker-id.mjs            # print the id this source hashes to
//     node build/worker-id.mjs --check    # exit 1 if the stamp is stale
//     node build/worker-id.mjs --write    # restamp the file in place
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const WORKER_FILE = new URL("./site-fiatlord.worker.js", import.meta.url);

const STAMP = /const WORKER_ID = "[0-9a-f]{12}";/;
const ZEROED = 'const WORKER_ID = "000000000000";';
const HEX12 = /^[0-9a-f]{12}$/;

export function computeWorkerId(source) {
  if (!STAMP.test(source)) {
    throw new Error('the worker has no `const WORKER_ID = "<12 hex>";` line');
  }
  const zeroed = source.replace(STAMP, ZEROED);
  return createHash("sha256").update(zeroed, "utf8").digest("hex").slice(0, 12);
}

export function stampedWorkerId(source) {
  const stamp = source.match(STAMP);
  if (!stamp) return null;
  const value = stamp[0].match(/"([0-9a-f]{12})"/);
  return value && HEX12.test(value[1]) ? value[1] : null;
}

function main(argv) {
  const source = readFileSync(WORKER_FILE, "utf8");
  const expected = computeWorkerId(source);
  const stamped = stampedWorkerId(source);

  if (argv.includes("--write")) {
    if (stamped === expected) {
      console.log(`worker id ${expected} already current`);
      return 0;
    }
    writeFileSync(WORKER_FILE, source.replace(STAMP, `const WORKER_ID = "${expected}";`), "utf8");
    console.log(`stamped worker id ${expected}`);
    return 0;
  }

  if (argv.includes("--check")) {
    if (stamped !== expected) {
      console.error(`stale worker id: file says ${stamped}, source hashes to ${expected}`);
      console.error("run: node build/worker-id.mjs --write");
      return 1;
    }
    console.log(`worker id ${expected} current`);
    return 0;
  }

  console.log(expected);
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  process.exitCode = main(process.argv.slice(2));
}
