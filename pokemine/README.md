# PokeMine Red — multi-chain mining console

A clone of `pokemon-blockchain.emergent.host`, rebuilt from its shipped bundle and extended so
every currency mines through one adapter instead of a Bitcoin-only simulation.

## What the original actually does

The original is a React/Tailwind single page. Its "mining" is a timer: the hash strings are
generated, the difficulty is a "0000…" display prefix, and the rewards are `Math.random()`. It says
so itself in the footer ("No real mining occurs"). Two things were worth keeping:

- **The layout and look** — black/red terminal panels, pixel headings, the rig HUD, scanner,
  hex encoder, memory scanner, vault and terminal.
- **The Gen-3 character table.** Its sample hex is real: `C7 C3 C8 BF BE 00 A9 A1 A8 A7 00 CD BB CE`
  decodes to `MINED 8076 SAT` with the FireRed charset (`A`=0xBB, `a`=0xD5, `0`=0xA1, space=0x00).
  `selftest.mjs` pins that against the site's own two samples.

Everything else here is different on purpose.

## What is real, and what is not

| Part | Status |
|---|---|
| Block hashing | **Real.** Double SHA-256 over an 80-byte header (version, prev hash, merkle, time, bits, nonce), implemented in `sha256.js`. Verified against Node's crypto in `selftest.mjs`. |
| Target rule | **Real.** A block is found only when the hash has `D` leading zero nibbles. `D4` means ~65,536 hashes per block. |
| Block verification | **Real.** On each find the exact header is hashed again; the terminal prints whether it reproduces. |
| Chain height / difficulty / subsidy | **Real, read live** through the local proxy. |
| USD prices | **Real,** from CoinGecko through the proxy. |
| Rewards and balances | **Virtual.** Nothing is signed, broadcast, or paid. Blocks extend a local chain on top of the live tip. |
| Pool shares | **Real.** Stratum connection to a real mainnet pool, real share target, real submissions. Expected payout at browser hashrate: none. |
| Vault keypair | **Real cryptography, demo key.** The vault derives a Bitcoin mainnet `bc1q…` address, its public key, WIF and seed in the browser from a random seed held only in the tab. It is labeled as Bitcoin mainnet and **does not change** when you select a different currency. Mined rewards are never sent to it. |
| Network hashrate | Not shown, because the browser's hashrate is its own. |

## Real pool shares (POOL BRIDGE)

The `POOL BRIDGE` panel mines **real mainnet work** and submits **real shares** to a real stratum
pool. It is the only part of this project that touches Bitcoin's network, and it is honest about
what that buys:

- A **share** is a header whose hash is under the pool's share target. The pool accepts it, counts
  it against the username (your payout address) and credits the account.
- A **block** is not reachable: at ~300 kH/s a difficulty-1 share takes about four hours, and the
  real block target is ~8.8×10¹⁸ times harder than the rig's `D4` target. Whole-network hashrate is
  ~965 EH/s; one browser is 3×10⁻¹⁶ of it, which is ~1.4×10⁻¹³ BTC/day if it were paid at all.
- The vault balances are still virtual and this panel cannot change them.

To use it, put **your own `bc1q…` address** in USERNAME (a solo pool pays that address) and click
CONNECT. Defaults are `public-pool.io:21496`, password `x`, suggested difficulty `0.001` — pools
clamp this (`public-pool` answers `1`), which is why shares stay rare.

The socket, the pool credential and the job live in `server.mjs`/`stratum.mjs`; the browser only
hashes an 80-byte header and hands back a winning nonce through `/api/pool/submit`. Pool control is
loopback-only and the password is never returned to the page.

## Running it

```bash
cd pokemine
npm start            # http://127.0.0.1:8077
npm run selftest     # 11 checks: SHA-256 vectors, fast path, target rule, Gen-3, subsidies
```

No dependencies. `server.mjs` serves the files and proxies chain reads, so the browser never needs
CORS permission from a chain API.

## Adding a currency

Every currency is one object, and there are two ways in.

**From the UI** — `+ CURRENCY` takes a name, ticker, decimals, subsidy, difficulty and an adapter:

| Adapter | Endpoint it calls |
|---|---|
| `mempool` | `${url}/api/v1/blocks` — mempool.space and its forks (Litecoin Space works unchanged) |
| `blockchair` | `${url}/${chain}/blocks?limit=1`, falling back to `/stats` |
| `rpc` | JSON-RPC `getblockchaininfo` (Bitcoin family) or `eth_getBlockByNumber` (EVM) |

The row is stored in `localStorage`, so it survives a reload with no code change.

**In the registry** — add an entry to `COINS` in `coins.js`, the single place the server and the
browser both read. `subsidyFor()` halves `baseReward` every `halvingEvery` blocks, or pays it flat
when that is `0` (Dogecoin).

## Endpoints

```
GET /api/chain?kind=mempool&url=https://mempool.space
GET /api/chain?kind=blockchair&url=https://api.blockchair.com&chain=dogecoin
GET /api/chain?kind=rpc&url=http://127.0.0.1:8545        # loopback allowed only here
GET /api/price?ids=bitcoin,litecoin,dogecoin
```

Reads are cached for 20 seconds and time out after 9. Upstream URLs must be HTTPS, except a
loopback node for the `rpc` adapter; private ranges and `.local` are refused, so the proxy cannot
be pointed at the host's own network.

## Files

```
index.html     the panels
styles.css     the look
app.js         UI wiring, wallet, scanner, hex encoder
miner.js       the proof-of-work loop
sha256.js      SHA-256 + the allocation-free 80-byte double-hash path
keypair.js     demo keypair: secp256k1, RIPEMD-160, bech32, WIF (no dependencies)
stratum.mjs    real pool connection: subscribe, authorize, jobs, share submission
poolworker.js  mines a pool job in the browser at the pool's share target
coins.js       currency registry, subsidies, Gen-3 table
server.mjs     static server + chain proxy
selftest.mjs   the checks above
```

## Limits worth knowing

- Browser SHA-256 runs at a few hundred kH/s, so `D6` takes minutes by design.
- A custom coin's local chain is per-browser (`localStorage`), not shared.
- Adding a currency whose API does not match one of the three adapters needs a new adapter in
  `server.mjs`, not just a URL.
- This is a console for watching proof-of-work happen; it is not a wallet and holds no keys.
  The vault is simulated state. For real Bitcoin keys, generate them offline with
  `../btc-wallet-gen/batch-wallets.mjs`, which writes independent mainnet seed phrases to a
  git-ignored file; this console never reads that file and no balance here comes from it.
