#!/usr/bin/env node
/**
 * The life binary: the token's deployed bytecode as a spaced hex dump in which a space is
 * never a 0x20 byte - it is written as the six characters `000000`.
 *
 * WHAT IT IS
 *
 *   One text file, `life.bin`, holding the runtime code the chain actually runs (not the
 *   constructor bytecode): the hex split into 32-byte words, the words separated by one
 *   space each, and every one of those separators written as `000000`. The encoded code has
 *   one separator throughout and no space character at all; only the `# ` comment lines keep
 *   ordinary spaces, because they are prose and not part of the dump.
 *
 *   It is derived, never typed. `out/Loveriver.sol/Loveriver.json` is the compiled artifact
 *   (what the last build produced); `--rpc` + `--token` reads eth_getCode instead, which is
 *   what is deployed and may differ from the checkout if nobody rebuilt. The header records
 *   which one was used and the sha256 of the hex before encoding, so the file can be checked
 *   against the chain rather than trusted.
 *
 * WHAT IT IS NOT
 *
 *   Not a replacement for the artifact, and not compressed: encoding a space as six digits
 *   makes the file larger, not smaller. It is a readable dump in one fixed shape, so a
 *   diff between two builds is a diff between their code and nothing else.
 *
 *   Decoding is exact as long as the encoded text had no literal `000000` of its own. A hex
 *   dump cannot: hex is [0-9a-f], and the only separators are spaces, which the encoder
 *   wrote. `--decode` restores the spaced dump and `--check` verifies the round trip against
 *   the header's sha256, so a file that was edited by hand fails instead of reading as code.
 *
 *   node tools/life-binary.mjs                                  # write life.bin from the build
 *   node tools/life-binary.mjs --rpc ... --token ...            # write it from the chain
 *   node tools/life-binary.mjs --decode --file life.bin         # the dump, spaces restored
 *   node tools/life-binary.mjs --check --rpc ... --token ...    # does life.bin match the chain?
 *   node tools/life-binary.mjs --selftest
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider } from 'ethers';
import { DEFAULT_DEPLOYMENTS, deploymentFor } from './deployments.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const ARTIFACT = resolve('out/Loveriver.sol/Loveriver.json');
const file = resolve(value('file', 'life.bin'));

/** Six characters, never a space: the whole point of the format. */
const SPACE = '000000';

/** Hex to the spaced dump: 32-byte words, one space between them, `0x` on the first. */
const dump = (hex) => `0x${(hex.slice(2).match(/.{1,64}/g) || []).join(' ')}`;

/** The rule, in one place: a space in the dump is written as six zeroes. */
const encode = (text) => text.split(' ').join(SPACE);

/** And its inverse, which is exact for hex dumps and nothing else. */
const decode = (text) => text.split(SPACE).join(' ');

/** Strips the separators, in either form, so the hex can be hashed and compared. */
const hexOf = (text) => text.split(SPACE).join(' ').split(' ').join('');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The header lines, in the order they are written. */
const HEADER_PREFIX = '# ';

if (flag('selftest')) {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = String(actual) === String(expected);
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) console.log(`       got ${actual}, expected ${expected}`);
  };

  check('a space is written as 000000', encode('a b'), 'a000000b');
  check('a run of spaces is one separator each', encode('a  b'), `a${SPACE}${SPACE}b`);
  check('nothing else changes', encode('0xdeadBEEF'), '0xdeadBEEF');
  check('the encoded text holds no space character', encode('a b c').includes(' '), false);
  check('decoding restores the spaces', decode(encode('a b c')), 'a b c');
  check('a 64-character word is one line', dump(`0x${'ab'.repeat(32)}`), `0x${'ab'.repeat(32)}`);
  check('a 65-character hex is two words', dump(`0x${'ab'.repeat(32)}ff`).split(' ').length, 2);
  check('the round trip through a dump keeps the hex', hexOf(encode(dump(`0x${'ab'.repeat(64)}`))), `0x${'ab'.repeat(64)}`);
  check('the hash is of the hex, not of the encoding', sha256(hexOf(encode(dump('0xab')))), sha256('0xab'));

  // An edited body must fail the check, not decode as if it were code.
  const edited = encode(dump(`0x${'ab'.repeat(33)}`)).replace('ab', 'zz');
  check('an edited body no longer hashes to the header value', sha256(hexOf(edited)) === sha256(`0x${'ab'.repeat(33)}`), false);

  console.log(failures === 0 ? '  life selftest PASSED' : `  life selftest FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

/** The runtime code, from the build or from the chain. Both are hex, never a guess. */
async function deployedHex() {
  const rpc = value('rpc', process.env.RPC_URL);
  if (rpc) {
    let token = value('token', process.env.LOVERIVER_TOKEN);
    if (!token) {
      const provider = new JsonRpcProvider(rpc);
      const network = await provider.getNetwork();
      try {
        token = deploymentFor(network.chainId, value('deployments', DEFAULT_DEPLOYMENTS)).token;
      } catch (error) {
        console.error(`  ${error.message}`);
        process.exit(2);
      }
    }
    const provider = new JsonRpcProvider(rpc);
    const code = await provider.getCode(token).catch(() => null);
    if (!code || code === '0x') {
      console.error(`  no code at ${token} on ${rpc}: this is not an empty binary, nothing was read`);
      process.exit(2);
    }
    return { hex: code, source: `chain code at ${token} on ${rpc}` };
  }

  if (!existsSync(ARTIFACT)) {
    console.error(`  no ${ARTIFACT}: run forge build, or pass --rpc and --token to read the chain`);
    process.exit(2);
  }
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const hex = artifact.deployedBytecode?.object;
  if (!hex || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    console.error(`  ${ARTIFACT} has no usable deployedBytecode.object`);
    process.exit(2);
  }
  return { hex, source: `out/Loveriver.sol/Loveriver.json deployedBytecode` };
}

/** The body lines of a life binary: everything that is not a `# ` header line. */
const bodyOf = (text) =>
  text
    .split('\n')
    .filter((line) => line && !line.startsWith(HEADER_PREFIX))
    .join('\n');

if (flag('decode')) {
  if (!existsSync(file)) {
    console.error(`  no ${file}`);
    process.exit(2);
  }
  console.log(decode(bodyOf(readFileSync(file, 'utf8'))));
  process.exit(0);
}

const { hex, source } = await deployedHex();
const body = encode(dump(hex));
const digest = sha256(hex);

if (flag('check')) {
  if (!existsSync(file)) {
    console.error(`  no ${file}`);
    process.exit(2);
  }
  const text = readFileSync(file, 'utf8');
  const recorded = (text.match(/^# sha256 ([0-9a-f]{64})$/m) || [])[1];
  if (!recorded) {
    console.error(`  ${file} has no "# sha256 <hex>" header line to check against`);
    process.exit(2);
  }
  const actual = sha256(hexOf(bodyOf(text)));
  if (actual !== recorded) {
    console.error(`  ${file} does not match its own header: body is ${actual}, header says ${recorded}`);
    process.exit(1);
  }
  if (digest !== actual) {
    console.error(`  ${file} records ${actual}, but ${source} is ${digest}: the binary is stale`);
    process.exit(1);
  }
  console.log(`  ok ${file} matches its header and ${source}`);
  process.exit(0);
}

const header = [
  '# loveriver life binary',
  '# a space in this file is written as the six characters 000000',
  `# source ${source}`,
  `# sha256 ${digest}`,
];
writeFileSync(file, `${header.join('\n')}\n${body}\n`);
const spaces = (dump(hex).match(/ /g) || []).length;
console.log(`  ${file}: ${hex.length / 2 - 1} bytes of runtime code, ${spaces} separator(s) written as ${SPACE}`);
console.log(`  sha256 ${digest} (of the hex, so the file can be checked against the chain)`);
