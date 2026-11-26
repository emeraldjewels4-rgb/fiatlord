// Dependency-free SHA-256, plus the double-SHA-256-of-an-80-byte-header path
// the miner runs in its inner loop. Synchronous on purpose: a Promise per hash
// costs more than the hash itself.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** One 64-byte block into `state` (8 words), using `w` as scratch. */
function compress(state, w, dv, off) {
  for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

/** SHA-256 over any byte array. */
export function sha256(bytes) {
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  dv.setUint32(total - 4, bits >>> 0);

  const state = new Uint32Array(IV);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) compress(state, w, dv, off);

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, state[i]);
  return out;
}

/** SHA-256(SHA-256(bytes)) — Bitcoin's block and tx hash. */
export function sha256d(bytes) {
  return sha256(sha256(bytes));
}

/**
 * Pre-allocated double-SHA-256 for exactly 80 bytes, the block header size.
 * Returns a function (header, out32) that writes into `out32` and allocates
 * nothing, because this runs hundreds of thousands of times a second.
 */
export function createHasher80() {
  const buf = new Uint8Array(128);
  const dv = new DataView(buf.buffer);
  const w = new Uint32Array(64);
  const state = new Uint32Array(8);
  const mid = new Uint8Array(32);
  const mdv = new DataView(mid.buffer);

  return function hash80(header, out) {
    // First hash: an 80-byte header pads to two 64-byte blocks.
    buf.fill(0);
    buf.set(header.subarray(0, 80), 0);
    buf[80] = 0x80;
    dv.setUint32(120, 0);
    dv.setUint32(124, 640); // message length in bits, low word
    state.set(IV);
    compress(state, w, dv, 0);
    compress(state, w, dv, 64);

    // Second hash: 32 bytes fit in one block, so its length word sits at
    // bytes 56..63 — not at the two-block offset used above.
    buf.fill(0);
    for (let i = 0; i < 8; i++) mdv.setUint32(i * 4, state[i]);
    buf.set(mid, 0);
    buf[32] = 0x80;
    dv.setUint32(56, 0);
    dv.setUint32(60, 256);
    state.set(IV);
    compress(state, w, dv, 0);

    // Stage two already produced sha256(sha256(header)); hand it back.
    for (let i = 0; i < 8; i++) mdv.setUint32(i * 4, state[i]);
    out.set(mid);
  };
}

export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '').padStart(64, '0').slice(-64);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** True when the hash has `nibbles` leading zero hex digits. */
export function targetMet(hash32, nibbles) {
  const full = nibbles >> 1;
  for (let i = 0; i < full; i++) if (hash32[i] !== 0) return false;
  if (nibbles & 1) return (hash32[full] & 0xf0) === 0;
  return true;
}
