// A Bitcoin keypair derived in the browser from a seed, with no dependencies.
//
// The vault shows this so that "address" means something concrete: an address is
// a public key, and a public key comes from a private key. It is a demo key for
// this tab, not a payout address - mined rewards are virtual and are never sent
// anywhere, least of all here.
//
// Everything below is the real thing, checked against published vectors in
// selftest.mjs:
//   sha256.js        SHA-256
//   ripemd160()      RIPEMD-160, the other half of hash160
//   secp256k1        public key = d * G, on the curve Bitcoin uses
//   bech32Address()  BIP-173 native SegWit (bc1q...) for a version-0 witness
//   wif()            base58check private key (version 0x80, compressed flag)

import { sha256, toHex } from './sha256.js';

// sha256.js's fromHex is a hash helper: it pads and truncates to 32 bytes, which
// is right for a digest and wrong for a 33-byte public key. Keys get their own.
function bytesFromHex(hex) {
  const clean = String(hex ?? '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('hex string must have an even number of digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

/* ------------------------------------------------------------------ integers */

const mod = (value, m = P) => ((value % m) + m) % m;

function modPow(base, exponent, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/* --------------------------------------------------------------- secp256k1 */

// Jacobian coordinates: each addition step would otherwise need a modular
// inversion, and 256 of those make a keypair feel slow to a click. Working with
// (X/Z², X/Z³) needs none until the very end, where one inversion converts back.
const J_INFINITY = { x: 1n, y: 1n, z: 0n };

function jacobianDouble(p) {
  if (p.z === 0n || p.y === 0n) return J_INFINITY;
  const a = mod(p.x * p.x);
  const b = mod(p.y * p.y);
  const c = mod(b * b);
  const d = mod(2n * (mod((p.x + b) * (p.x + b)) - a - c));
  const e = mod(3n * a);
  const f = mod(e * e);
  const x = mod(f - 2n * d);
  return { x, y: mod(e * (d - x) - 8n * c), z: mod(2n * p.y * p.z) };
}

function jacobianAddAffine(p, q) {
  if (p.z === 0n) return { x: q.x, y: q.y, z: 1n };
  const z1z1 = mod(p.z * p.z);
  const u2 = mod(q.x * z1z1);
  const s2 = mod(q.y * p.z * z1z1);
  const h = mod(u2 - p.x);
  const r = mod(2n * (s2 - p.y));
  if (h === 0n) return r === 0n ? jacobianDouble(p) : J_INFINITY;
  const i = mod(4n * h * h);
  const j = mod(h * i);
  const v = mod(p.x * i);
  const x = mod(r * r - j - 2n * v);
  return {
    x,
    y: mod(r * (v - x) - 2n * p.y * j),
    z: mod((p.z + h) * (p.z + h) - z1z1 - h * h),
  };
}

/** k * point, or `null` for the point at infinity (k a multiple of the order). */
export function pointMultiply(scalar, point = G) {
  const k = mod(scalar, N);
  if (k === 0n) return null;
  let acc = J_INFINITY;
  for (const bit of k.toString(2)) {
    acc = jacobianDouble(acc);
    if (bit === '1') acc = jacobianAddAffine(acc, point);
  }
  if (acc.z === 0n) return null;
  const zinv = modPow(acc.z, P - 2n);
  const zinv2 = mod(zinv * zinv);
  return { x: mod(acc.x * zinv2), y: mod(acc.y * zinv2 * zinv) };
}

const pad32 = (value) => value.toString(16).padStart(64, '0');

/** Compressed SEC public key (33 bytes) for a private scalar. */
export function publicKeyFor(privateKey) {
  const point = pointMultiply(privateKey);
  if (point === null) throw new Error('private key is not a valid secp256k1 scalar');
  return bytesFromHex(`${point.y & 1n ? '03' : '02'}${pad32(point.x)}`);
}

/* ---------------------------------------------------------------- ripemd160 */

// RIPEMD-160, needed because Web Crypto has no RIPEMD and hash160 is
// RIPEMD-160(SHA-256(x)). Constants are the specification's tables.
const RL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
  4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];
const RR = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
  12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];
const SL = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
  9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];
const SR = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
  8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];
const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

const rotl = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0;

function f(round, x, y, z) {
  switch (round) {
    case 0:
      return (x ^ y ^ z) >>> 0;
    case 1:
      return ((x & y) | (~x & z)) >>> 0;
    case 2:
      return ((x | ~y) ^ z) >>> 0;
    case 3:
      return ((x & z) | (y & ~z)) >>> 0;
    default:
      return (x ^ (y | ~z)) >>> 0;
  }
}

export function ripemd160(bytes) {
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const bitLength = bytes.length * 8;
  const blocks = Math.floor((bytes.length + 8) / 64) + 1;
  const buffer = new Uint8Array(blocks * 64);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(buffer.length - 8, bitLength >>> 0, true);
  view.setUint32(buffer.length - 4, Math.floor(bitLength / 0x100000000), true);

  for (let offset = 0; offset < buffer.length; offset += 64) {
    const x = [];
    for (let i = 0; i < 16; i += 1) x.push(view.getUint32(offset + i * 4, true));

    let [al, bl, cl, dl, el] = h;
    let [ar, br, cr, dr, er] = h;

    for (let j = 0; j < 80; j += 1) {
      const round = j >> 4;
      let t = (al + f(round, bl, cl, dl) + x[RL[j]] + KL[round]) >>> 0;
      t = (rotl(t, SL[j]) + el) >>> 0;
      al = el;
      el = dl;
      dl = rotl(cl, 10);
      cl = bl;
      bl = t;

      t = (ar + f(4 - round, br, cr, dr) + x[RR[j]] + KR[round]) >>> 0;
      t = (rotl(t, SR[j]) + er) >>> 0;
      ar = er;
      er = dr;
      dr = rotl(cr, 10);
      cr = br;
      br = t;
    }

    const t = (h[1] + cl + dr) >>> 0;
    h[1] = (h[2] + dl + er) >>> 0;
    h[2] = (h[3] + el + ar) >>> 0;
    h[3] = (h[4] + al + br) >>> 0;
    h[4] = (h[0] + bl + cr) >>> 0;
    h[0] = t;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  h.forEach((word, index) => outView.setUint32(index * 4, word, true));
  return out;
}

export function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

/* ------------------------------------------------------------------- bech32 */

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= BECH32_GENERATOR[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const char of hrp) out.push(char.charCodeAt(0) >> 5);
  out.push(0);
  for (const char of hrp) out.push(char.charCodeAt(0) & 31);
  return out;
}

function convertBits(bytes, from, to, pad) {
  let accumulator = 0;
  let bits = 0;
  const out = [];
  const maxValue = (1 << to) - 1;
  for (const byte of bytes) {
    accumulator = (accumulator << from) | byte;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >>> bits) & maxValue);
    }
  }
  if (pad && bits > 0) out.push((accumulator << (to - bits)) & maxValue);
  return out;
}

/** BIP-173 bech32 address for a version-0 witness program (hash160). */
export function bech32Address(program, hrp = 'bc') {
  const data = [0, ...convertBits(program, 8, 5, true)]; // witness version 0, then the program
  const checksum = bech32Polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  let address = `${hrp}1`;
  for (const value of data) address += BECH32_CHARSET[value];
  for (let i = 0; i < 6; i += 1) address += BECH32_CHARSET[(checksum >>> (5 * (5 - i))) & 31];
  return address;
}

/* --------------------------------------------------------------------- WIF */

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Compressed mainnet WIF for a private scalar: what a wallet imports. */
export function wif(privateKey) {
  const payload = new Uint8Array(34);
  payload[0] = 0x80;
  payload.set(bytesFromHex(pad32(privateKey)), 1);
  payload[33] = 0x01; // compressed public key
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(38);
  full.set(payload);
  full.set(checksum, 34);
  return base58encode(full);
}

/* ------------------------------------------------------------------ keypair */

/** 32 random bytes as hex, from the platform's CSPRNG. */
export function generateSeed() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

const utf8 = (text) => new TextEncoder().encode(text);

/**
 * seed (32 bytes, hex or bytes) -> { seed, privateKey, wif, publicKey, address }
 *
 * The scalar is SHA-256 of the seed with a domain string, folded into 1..n-1, so
 * the seed is not the key itself and the same seed always gives the same wallet.
 */
export function deriveKeypair(seed) {
  const bytes = typeof seed === 'string' ? bytesFromHex(seed) : seed;
  if (bytes.length !== 32) throw new Error('seed must be 32 bytes');
  const digest = sha256(new Uint8Array([...bytes, ...utf8('pokemine-keypair-v1')]));
  const privateKey = (BigInt(`0x${toHex(digest)}`) % (N - 1n)) + 1n;
  const publicKey = publicKeyFor(privateKey);
  return {
    seed: toHex(bytes),
    privateKey: pad32(privateKey),
    wif: wif(privateKey),
    publicKey: toHex(publicKey),
    address: bech32Address(hash160(publicKey)),
  };
}
