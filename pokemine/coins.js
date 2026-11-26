// Currency registry. One entry is all a new currency needs.
//
// `adapter` describes how to read the live chain head:
//   mempool    -> `${url}/api/v1/blocks`          (mempool.space and its chain forks)
//   blockchair -> `${url}/${chain}/blocks?limit=1`
//   rpc        -> JSON-RPC getblockchaininfo, or eth_getBlockByNumber
//   local      -> no upstream; a virtual collectible mined locally in this app
// The browser never calls an upstream directly: server.mjs fetches it and
// normalises the answer, so there is one place where a chain is understood.

export const COINS = [
  {
    id: 'btc',
    ticker: 'BTC',
    name: 'Bitcoin',
    symbol: '₿',
    decimals: 8,
    // 50 BTC >> (height / 210000); recomputed from the live height, not stored.
    baseReward: 50,
    halvingEvery: 210000,
    blockSeconds: 600,
    difficulty: 4,
    addressPrefix: 'bc1q',
    priceId: 'bitcoin',
    color: '#f7931a',
    adapter: { kind: 'mempool', url: 'https://mempool.space' },
  },
  {
    id: 'ltc',
    ticker: 'LTC',
    name: 'Litecoin',
    symbol: 'Ł',
    decimals: 8,
    baseReward: 50,
    halvingEvery: 840000,
    blockSeconds: 150,
    difficulty: 4,
    addressPrefix: 'ltc1q',
    priceId: 'litecoin',
    color: '#a6a9aa',
    adapter: { kind: 'mempool', url: 'https://litecoinspace.org' },
  },
  {
    id: 'doge',
    ticker: 'DOGE',
    name: 'Dogecoin',
    symbol: 'Ð',
    decimals: 8,
    // Dogecoin has paid a flat 10,000 DOGE per block since 2015.
    baseReward: 10000,
    halvingEvery: 0,
    blockSeconds: 60,
    difficulty: 4,
    addressPrefix: 'D',
    priceId: 'dogecoin',
    color: '#c2a633',
    adapter: { kind: 'blockchair', url: 'https://api.blockchair.com', chain: 'dogecoin' },
  },
  {
    id: 'zipcoin',
    ticker: 'ZIP',
    name: 'Zipcoin Rune',
    symbol: 'Ƶ',
    decimals: 0,
    // PokeMine collectible form of Zipcoin: each find awards 100 ZIP.
    // Virtual/local only — no on-chain broadcast or deployment.
    // Real Rune candidate (regtest draft only): ZIP•COIN (ZIPCOIN), symbol ¤;
    // see regtest/zipcoin-rune-plan.md. Mainnet etch requires explicit approval.
    baseReward: 100,
    halvingEvery: 0,
    blockSeconds: 0,
    difficulty: 3,
    addressPrefix: 'zip',
    priceId: null,
    color: '#7cff6b',
    collectible: true,
    kindLabel: 'RUNE COLLECTIBLE',
    source: 'Local rune collection (virtual)',
    description: 'Zipcoin Rune (ZIP, Ƶ): a virtual PokeMine collectible with supply 6,999,999,911. Inspired by the open collectible spirit of UNCOMMON•GOODS (Rune #0), with no affiliation or on-chain link. A ZIP•COIN Bitcoin Rune candidate exists as a regtest-only draft; no mainnet etch/broadcast without explicit approval. When a wallet's balance reaches zero it refills to the full supply, resetting to 6,999,999,911 ZIP.',
    adapter: { kind: 'local', url: 'local://zipcoin' },
  },
  {
    id: 'ucg-rune',
    ticker: 'UCG',
    name: 'Uncommon Goods Rune',
    symbol: '◈',
    decimals: 0,
    // Inspired by the UNCOMMON•GOODS idea (Rune #0) as a collectible theme only.
    // This is not the real UNCOMMON•GOODS rune and has no on-chain connection.
    baseReward: 1,
    halvingEvery: 0,
    blockSeconds: 0,
    difficulty: 4,
    addressPrefix: 'ucg',
    priceId: null,
    color: '#d97706',
    collectible: true,
    kindLabel: 'RUNE COLLECTIBLE',
    source: 'Local rune collection (virtual)',
    description: 'Inspired by the UNCOMMON•GOODS (Rune #0) idea — a virtual in-app collectible, not the real rune, with no on-chain broadcast or deployment.',
    adapter: { kind: 'local', url: 'local://ucg-rune' },
  },
];

/** Smallest-unit subsidy at a height: 50 coins halved per halving interval. */
export function subsidyFor(coin, height) {
  const whole = Number(coin.baseReward) || 0;
  if (!coin.halvingEvery) return Math.round(whole * 10 ** coin.decimals);
  const halvings = Math.max(0, Math.floor((Number(height) || 0) / coin.halvingEvery));
  // Beyond 64 halvings the subsidy is zero; JS shifts are 32-bit, so divide.
  const amount = halvings >= 64 ? 0 : whole / 2 ** halvings;
  return Math.round(amount * 10 ** coin.decimals);
}

/** Base units -> a decimal string with the coin's precision. */
export function formatUnits(value, decimals) {
  const digits = typeof value === 'string' ? value.replace(/[^0-9]/g, '') || '0' : String(Math.max(0, Math.round(Number(value) || 0)));
  const n = BigInt(digits);
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** A short, readable count for hashrates and difficulties. */
export function shortNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(0);
}

export const GEN3_CHARSET = (() => {
  // The FireRed/Gen-3 character table, as used by the site being cloned:
  // digits start at 0xA1, 'A' at 0xBB, 'a' at 0xD5, and 0x00 is the space.
  const map = new Map();
  map.set(0x00, ' ');
  for (let i = 0; i < 10; i++) map.set(0xa1 + i, String(i));
  map.set(0xab, '!');
  map.set(0xac, '?');
  map.set(0xad, '.');
  map.set(0xae, '-');
  map.set(0xb8, ',');
  for (let i = 0; i < 26; i++) map.set(0xbb + i, String.fromCharCode(65 + i));
  for (let i = 0; i < 26; i++) map.set(0xd5 + i, String.fromCharCode(97 + i));
  map.set(0xef, ':');
  return map;
})();

const GEN3_REVERSE = new Map([...GEN3_CHARSET].map(([code, ch]) => [ch, code]));

export function encodeGen3(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const code = GEN3_REVERSE.get(ch);
    bytes.push(code === undefined ? 0xac : code); // unknown characters become '?'
  }
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function decodeGen3(hex) {
  const tokens = String(hex).trim().split(/[\s,]+/).filter(Boolean);
  let out = '';
  for (const token of tokens) {
    const byte = parseInt(token, 16);
    if (Number.isNaN(byte)) return { text: out, bad: token };
    out += GEN3_CHARSET.get(byte) ?? '?';
  }
  return { text: out, bad: null };
}
