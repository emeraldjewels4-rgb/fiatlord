// A real proof-of-work loop, not a timer that prints numbers.
//
// Each candidate is a genuine 80-byte header hashed twice with SHA-256, and a
// block is only found when the result carries the target number of leading
// zero nibbles. The reward is virtual; the hashing is not.

import { createHasher80, fromHex, sha256d, targetMet, toHex } from './sha256.js';

export class Miner {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.hasher = createHasher80();
    this.out = new Uint8Array(32);
    this.header = new Uint8Array(80);
    this.dv = new DataView(this.header.buffer);
    this.running = false;
    this.boost = 1;
    this.difficulty = 4;
    this.nonce = 0;
    this.lastNonce = 0;
    this.hashes = 0;
    this.workHashes = 0;
    this.startedAt = 0;
    this.startedHashes = 0;
    this.lastSample = 0;
    this.merkle = new Uint8Array(32);
  }

  /** Point the header at a chain tip and a coinbase message. */
  configure({ prevHashHex, coinbase, difficulty, timestamp, version }) {
    this.difficulty = Math.max(1, Math.min(8, Math.round(difficulty || 4)));
    this.coinbase = coinbase || '';
    this.merkle = sha256d(new TextEncoder().encode(this.coinbase));
    this.header.set(fromHex(prevHashHex), 4);
    this.merkle.forEach((b, i) => {
      this.header[36 + i] = b;
    });
    this.dv.setUint32(0, version ?? 0x20000000, true);
    this.dv.setUint32(68, timestamp ?? Math.floor(Date.now() / 1000), true);
    this.dv.setUint32(72, this.difficulty, true);
    this.nonce = 0;
    this.workHashes = 0;
    this.dv.setUint32(76, 0, true);
  }

  setBoost(value) {
    this.boost = Math.max(1, Math.min(4, Number(value) || 1));
  }

  headerHex() {
    return toHex(this.header);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = performance.now();
    this.startedHashes = this.hashes;
    this.lastSample = 0;
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  loop() {
    if (!this.running) return;
    const header = this.header;
    const out = this.out;
    const dv = this.dv;
    const deadline = performance.now() + 9 * this.boost;

    while (performance.now() < deadline) {
      for (let i = 0; i < 256; i++) {
        const nonce = this.nonce >>> 0;
        dv.setUint32(76, nonce, true);
        this.hasher(header, out);

        if (targetMet(out, this.difficulty)) {
          this.lastNonce = nonce;
          this.found(out);
          return;
        }

        this.nonce = (this.nonce + 1) >>> 0;
        this.hashes++;
        this.workHashes++;

        if (this.nonce === 0) {
          // The nonce space wrapped: new timestamp, new work.
          dv.setUint32(68, Math.floor(Date.now() / 1000), true);
          this.workHashes = 0;
        }
      }
      this.sample();
    }
    this.tick();
    this.raf = requestAnimationFrame(() => this.loop());
  }

  sample(force = false) {
    const now = performance.now();
    if (!force && now - this.lastSample < 220) return;
    this.lastSample = now;
    const hex = toHex(this.out);
    this.hooks.onSample?.({ hex, valid: targetMet(this.out, this.difficulty) });
  }

  found(hash32) {
    this.stop();
    const hash = toHex(hash32);
    // Re-hash the exact header that produced the block: the same function,
    // the same bytes. If this disagrees, the block was not real.
    const check = new Uint8Array(32);
    this.hasher(this.header, check);
    const verified = toHex(check) === hash && targetMet(check, this.difficulty);

    this.hashes++;
    this.workHashes++;
    this.sample(true);
    this.tick();
    this.hooks.onBlock?.({
      hash,
      headerHex: this.headerHex(),
      merkle: toHex(this.merkle),
      nonce: this.lastNonce,
      difficulty: this.difficulty,
      timestamp: this.dv.getUint32(68, true),
      verified,
    });
  }

  tick() {
    const seconds = Math.max(0.001, (performance.now() - this.startedAt) / 1000);
    const hashrate = (this.hashes - this.startedHashes) / seconds;
    // Probability at least one hit has been seen in this work.
    const expected = 16 ** this.difficulty;
    const progress = 1 - Math.exp(-this.workHashes / expected);
    this.hooks.onTick?.({
      hashrate,
      hashes: this.hashes,
      workHashes: this.workHashes,
      progress,
      running: this.running,
      nonce: this.dv.getUint32(76, true),
    });
  }
}
