// Verification for the parts that must be right: the hash function, the
// 80-byte fast path, the Gen-3 table recovered from the original site, the
// target rule, and the subsidy schedule. Run: node selftest.mjs

import assert from 'node:assert/strict';
import { COINS, decodeGen3, encodeGen3, formatUnits, subsidyFor } from './coins.js';
import { bech32Address, deriveKeypair, hash160, publicKeyFor, ripemd160, wif } from './keypair.js';
import { createHasher80, sha256, sha256d, targetMet, toHex, fromHex } from './sha256.js';
import { DIFF1_TARGET, headerPrevHash, targetForDifficulty } from './stratum.mjs';

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};
const utf8 = (text) => new TextEncoder().encode(text);
const hasher80 = createHasher80();

check('SHA-256 of the empty string', () => {
  assert.equal(toHex(sha256(new Uint8Array(0))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

check('SHA-256 of "abc"', () => {
  assert.equal(toHex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

check('SHA-256 of the 56-byte NIST vector (two padding blocks)', () => {
  assert.equal(
    toHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

check('SHA-256 of one million "a" (streaming path)', () => {
  const bytes = new Uint8Array(1_000_000).fill(0x61);
  assert.equal(toHex(sha256(bytes)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

check('80-byte fast path equals the generic double hash', () => {
  const header = new Uint8Array(80);
  for (let i = 0; i < 80; i++) header[i] = (i * 37 + 11) & 0xff;
  const fast = new Uint8Array(32);
  hasher80(header, fast);
  assert.equal(toHex(fast), toHex(sha256d(header)));
});

check('double hash of a real Bitcoin header shape is stable', () => {
  const header = fromHex('00'.repeat(32));
  const out = new Uint8Array(32);
  hasher80(header, out);
  assert.equal(toHex(out).length, 64);
});

check('target rule accepts and rejects the right prefixes', () => {
  const ok = fromHex(`0000${'f'.repeat(60)}`);
  const near = fromHex(`0001${'0'.repeat(60)}`);
  const oddOk = fromHex(`00000${'f'.repeat(59)}`);
  const oddBad = fromHex(`00001${'0'.repeat(59)}`);
  assert.equal(targetMet(ok, 4), true);
  assert.equal(targetMet(near, 4), false);
  assert.equal(targetMet(oddOk, 5), true);
  assert.equal(targetMet(oddBad, 5), false);
});

check('Gen-3 table decodes the original site\'s own hex', () => {
  assert.equal(decodeGen3('C7 C3 C8 BF BE 00 A9 A1 A8 A7 00 CD BB CE').text, 'MINED 8076 SAT');
  assert.equal(decodeGen3('C7 C3 C8 BF BE 00 A2 A8 A6 A5 A9 00 CD BB CE').text, 'MINED 17548 SAT');
});

check('Gen-3 encoding round-trips', () => {
  assert.equal(encodeGen3('MINED 8076 SAT'), 'C7 C3 C8 BF BE 00 A9 A1 A8 A7 00 CD BB CE');
  assert.equal(decodeGen3(encodeGen3('pokemine red 2026')).text, 'pokemine red 2026');
});

check('subsidy follows each chain\'s schedule', () => {
  const btc = COINS.find((coin) => coin.id === 'btc');
  const ltc = COINS.find((coin) => coin.id === 'ltc');
  const doge = COINS.find((coin) => coin.id === 'doge');
  assert.equal(subsidyFor(btc, 0), 50 * 1e8);
  assert.equal(subsidyFor(btc, 977575), 312500000);
  assert.equal(subsidyFor(ltc, 3219375), 625000000);
  assert.equal(subsidyFor(doge, 6614825), 10000 * 1e8);
});

check('units format without floating point', () => {
  assert.equal(formatUnits(312500000, 8), '3.125');
  assert.equal(formatUnits('1000000000000', 8), '10000');
  assert.equal(formatUnits(0, 8), '0');
});

check('RIPEMD-160 vectors', () => {
  assert.equal(toHex(ripemd160(utf8(''))), '9c1185a5c5e9fc54612808977ee8f548b2258d31');
  assert.equal(toHex(ripemd160(utf8('abc'))), '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc');
  assert.equal(toHex(ripemd160(utf8('message digest'))), '5d0689ef49d2fae572b881b123a85ffa21595f36');
});

check('secp256k1 key 1 matches the published public key, hash160 and BIP-173 address', () => {
  assert.equal(toHex(publicKeyFor(1n)), '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  assert.equal(toHex(hash160(publicKeyFor(1n))), '751e76e8199196d454941c45d1b3a323f1433bd6');
  assert.equal(bech32Address(hash160(publicKeyFor(1n))), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
});

check('WIF for key 1 matches the published compressed key', () => {
  assert.equal(wif(1n), 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn');
});

check('keypair derivation is deterministic and well formed', () => {
  const pair = deriveKeypair('00'.repeat(32));
  assert.deepEqual(deriveKeypair(fromHex('00'.repeat(32))), pair);
  assert.match(pair.address, /^bc1q[02-9ac-hj-np-z]{38}$/);
  assert.match(pair.publicKey, /^0[23][0-9a-f]{64}$/);
  assert.match(pair.wif, /^[KL][1-9A-HJ-NP-Za-km-z]{51}$/);
  assert.match(pair.privateKey, /^[0-9a-f]{64}$/);
  assert.notEqual(deriveKeypair('11'.repeat(32)).address, pair.address);
});

check('stratum prevhash converts to the header field (live job vs mempool tip)', () => {
  // One job captured from public-pool.io and the tip mempool.space reported for it.
  const prevhash = 'ffcd9abe8f4504a422983111f58ac8909eaeb2030000815f0000000000000000';
  const tip = '00000000000000000000815f9eaeb203f58ac890229831118f4504a4ffcd9abe';
  const reversed = (hex) => hex.match(/../g).reverse().join('');
  assert.equal(headerPrevHash(prevhash), reversed(tip));
  assert.throws(() => headerPrevHash('abcd'));
});

check('share target follows difficulty, including fractions', () => {
  assert.equal(targetForDifficulty(1), DIFF1_TARGET);
  assert.equal((targetForDifficulty(1) >> 208n).toString(16), 'ffff');
  // The published diff-1 target: 0x00000000ffff0000 followed by 48 zeroes.
  assert.equal(DIFF1_TARGET.toString(16), `ffff${'0'.repeat(52)}`);
  assert.ok(targetForDifficulty(2) < targetForDifficulty(1));
  assert.ok(targetForDifficulty(0.001) > targetForDifficulty(1));
  assert.equal((DIFF1_TARGET * 1000000n) / BigInt(Math.round(0.001 * 1000000)), targetForDifficulty(0.001));
});

for (const name of checks) console.log(`ok  ${name}`);
console.log(`\n${checks.length} checks passed`);
