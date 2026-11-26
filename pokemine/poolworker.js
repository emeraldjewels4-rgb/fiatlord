// Mines a pool's job in the browser, at the pool's share target.
//
// The server holds the socket and the pool credential; this file only turns a
// job into an 80-byte header and looks for a hash under the share target. When
// one is found the nonce goes back to the server, which submits it.
//
// Nothing here reaches the block target: at 300 kH/s, a difficulty-1 share takes
// roughly four hours and a real block would take longer than the age of the
// universe. Shares are the only realistic output.

import { createHasher80, sha256d, toHex } from './sha256.js';

// 0xffff * 2^208: the same constant as stratum.mjs, and the same trap.
export const DIFF1_TARGET = 0x00000000ffff0000n << 192n;

export function targetForDifficulty(difficulty) {
  const diff = Number(difficulty);
  if (!Number.isFinite(diff) || diff <= 0) return 0n;
  return (DIFF1_TARGET * 1000000n) / BigInt(Math.round(diff * 1000000));
}

/** Big-endian 32-byte array for a target, for byte-wise comparison. */
function targetBytes(target) {
  const out = new Uint8Array(32);
  let value = target;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function meets(hash, target) {
  for (let i = 0; i < 32; i += 1) {
    if (hash[i] < target[i]) return true;
    if (hash[i] > target[i]) return false;
  }
  return true;
}

const hexWordLE = (hex) => {
  const clean = String(hex).padStart(8, '0').slice(-8);
  return [6, 4, 2, 0].map((i) => parseInt(clean.slice(i, i + 2), 16));
};

/**
 * Build the header template for one extranonce2. Everything except the nonce is
 * fixed, so the scan loop only rewrites bytes 76..79.
 */
export function headerParts({ job, extranonce1, extranonce2, ntime }) {
  const coinbase = `${job.coinb1}${extranonce1}${extranonce2}${job.coinb2}`;
  const coinbaseBytes = new Uint8Array(coinbase.length / 2);
  for (let i = 0; i < coinbaseBytes.length; i += 1) coinbaseBytes[i] = parseInt(coinbase.slice(i * 2, i * 2 + 2), 16);

  // coinbase -> merkle root: hash it, then fold each branch in.
  let root = sha256dBytes(coinbaseBytes);
  for (const branch of job.merkleBranch) {
    const sibling = new Uint8Array(branch.length / 2);
    for (let i = 0; i < sibling.length; i += 1) sibling[i] = parseInt(branch.slice(i * 2, i * 2 + 2), 16);
    const joined = new Uint8Array(64);
    joined.set(root, 0);
    joined.set(sibling, 32);
    root = sha256dBytes(joined);
  }

  const header = new Uint8Array(80);
  header.set(hexWordLE(job.version), 0);
  for (let i = 0; i < 32; i += 1) header[4 + i] = parseInt(job.prevhashField.slice(i * 2, i * 2 + 2), 16);
  header.set(root, 36);
  header.set(hexWordLE(ntime), 68);
  header.set(hexWordLE(job.nbits), 72);
  return header;
}

// The coinbase and the 64-byte merkle nodes are not 80-byte headers, so they take
// the generic path; the nonce scan uses the fixed-width fast one.
const sha256dBytes = (bytes) => sha256d(bytes);

export class PoolWorker {
  constructor({ onSubmit, onTick } = {}) {
    this.onSubmit = onSubmit || (() => {});
    this.onTick = onTick || (() => {});
    this.job = null;
    this.extranonce1 = null;
    this.extranonce2Size = 4;
    this.difficulty = 1;
    this.target = targetBytes(targetForDifficulty(1));
    this.header = null;
    this.nonce = 0;
    this.extranonce2 = '';
    this.ntime = '00000000';
    this.running = false;
    this.frame = null;
    this.hashes = 0;
    this.startedAt = 0;
    this.sampleAt = 0;
    this.sampleHashes = 0;
    this.hashrate = 0;
    this.best = 0;
    this.inflight = 0;
    this.hasher = createHasher80();
    this.hash = new Uint8Array(32);
  }

  /** A new job (or a new extranonce) invalidates the header being scanned. */
  setJob({ job, extranonce1, extranonce2Size, difficulty }) {
    if (!job || !extranonce1) return;
    const extranonceChanged = extranonce1 !== this.extranonce1 || extranonce2Size !== this.extranonce2Size;
    this.job = job;
    this.extranonce1 = extranonce1;
    this.extranonce2Size = extranonce2Size || 4;
    if (extranonceChanged || !this.extranonce2) {
      this.extranonce2 = toHex(crypto.getRandomValues(new Uint8Array(this.extranonce2Size)));
      this.nonce = 0;
    }
    if (Number.isFinite(difficulty) && difficulty > 0) this.setDifficulty(difficulty);
    this.rebuild();
  }

  setDifficulty(difficulty) {
    this.difficulty = difficulty;
    this.target = targetBytes(targetForDifficulty(difficulty));
  }

  rebuild() {
    if (!this.job || !this.extranonce1) return;
    this.ntime = String(this.job.ntime || '00000000');
    this.header = headerParts({
      job: this.job,
      extranonce1: this.extranonce1,
      extranonce2: this.extranonce2,
      ntime: this.ntime,
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.sampleAt = this.startedAt;
    this.sampleHashes = 0;
    this.frame = requestAnimationFrame(() => this.tick());
  }

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  tick() {
    if (!this.running) return;
    if (!this.header) {
      this.frame = requestAnimationFrame(() => this.tick());
      return;
    }
    const deadline = performance.now() + 9;
    let found = null;
    while (performance.now() < deadline) {
      const header = this.header;
      const nonce = (this.nonce = (this.nonce + 1) >>> 0);
      header[76] = nonce & 0xff;
      header[77] = (nonce >>> 8) & 0xff;
      header[78] = (nonce >>> 16) & 0xff;
      header[79] = (nonce >>> 24) & 0xff;
      this.hasher(header, this.hash);
      this.hashes += 1;
      if (meets(this.hash, this.target)) {
        found = { nonce, extranonce2: this.extranonce2, ntime: this.ntime, hash: toHex(this.hash) };
        break;
      }
      // Track the best hash seen, as a share-difficulty equivalent, so the panel
      // shows progress rather than a zero.
      const value = BigInt(`0x${toHex(this.hash)}`);
      const equivalent = Number((DIFF1_TARGET * 1000000n) / (value === 0n ? 1n : value)) / 1e6;
      if (equivalent > this.best) this.best = equivalent;
    }

    const now = performance.now();
    if (now - this.sampleAt >= 1000) {
      const seconds = (now - this.sampleAt) / 1000;
      this.hashrate = (this.hashes - this.sampleHashes) / seconds;
      this.sampleAt = now;
      this.sampleHashes = this.hashes;
      this.onTick({ hashrate: this.hashrate, hashes: this.hashes, best: this.best, difficulty: this.difficulty });
    }

    if (found) {
      this.inflight += 1;
      Promise.resolve(this.onSubmit({ ...found, jobId: this.job.id }))
        .catch(() => {})
        .finally(() => {
          this.inflight -= 1;
        });
      // Fresh extranonce2 for the next search, so a stale share cannot repeat.
      this.extranonce2 = toHex(crypto.getRandomValues(new Uint8Array(this.extranonce2Size)));
      this.rebuild();
    }

    this.frame = requestAnimationFrame(() => this.tick());
  }
}
