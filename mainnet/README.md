# Mainnet etch — the run you do, with your keys

This folder is the whole mainnet run: `batch.yaml`, the throwaway inscription it must carry, and the
commands. It was validated on the local regtest — `--dry-run` built the commit and reveal, the rune
output and the premine output, fee 411 sats at 1 sat/vB there — which proves the file parses, the
supply identity holds and the fee arithmetic works. It does **not** prove the name is free on
mainnet: only the mainnet index can say that.

## Before anything: the two permanent choices

- **The name.** A–Z only, unique ignoring spacers (`NAME` and `N•A•M•E` are the same rune), and
  gated by length: 13+ letters since block 840,000, one letter shorter every 17,500 blocks. At
  block 976,082 the shortest etchable name is **6 letters** (unlocked at 962,500); 5 letters arrive
  at 980,000, 4 at 997,500. Check the name is free, and check it on a second indexer too:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://ordinals.com/rune/WEBNINENINENINE
  ```

  `404` looks free, `200` is taken. 404 can also mean the indexer has not caught up, so settle it
  with a second source before spending anything.
- **The numbers.** `batch.yaml` carries the worked example from `runes-launch-plan.md`: premine
  1,000,000 of 700,000,000 (0.1%), and 699 mints of 1,000,000 (99.9% mintable). Change them
  deliberately — `supply` must equal `premine + terms.cap * terms.amount` exactly or ord refuses to
  etch, and everything is immutable once mined.

## The run

```bash
# 0. the gate — it signs nothing and sends nothing. It also skips nothing: on a fresh machine
#    it fails at check 1 (no node yet), so set up 1 and 2 and run it again before step 3
bash preflight.sh

# 1. a synced mainnet node, and ord's runes index over it. Every path is pinned by ord.yaml:
#    the index goes to ./ord-data and the RPC cookie is read from ./bitcoin-data/.cookie, so both
#    processes run from mainnet/ and bitcoind gets that same datadir. Left at its default, the
#    cookie lands in ~/.bitcoin (or %APPDATA%\Bitcoin) where ord will not look for it.
mkdir -p bitcoin-data         # bitcoin.conf goes here: server=1, prune=0,
                              # plus deprecatedrpc=bip125 on Core 32.x
bitcoind -datadir=./bitcoin-data -server=1 -rpcport=8332
ord --chain mainnet --config ord.yaml --index-runes server \
    --http --http-port 8080 --address 127.0.0.1   # keep it running; wallet commands talk to it

# 2. ord's own wallet, funded from yours — commit + postage + fees, ~0.001 BTC is comfortable
ord --chain mainnet --config ord.yaml --index-runes wallet create
ord --chain mainnet --config ord.yaml --index-runes wallet receive

# 3. what will be built, and what it costs, with nothing broadcast
ord --chain mainnet --config ord.yaml --index-runes wallet batch \
    --fee-rate 1 --batch batch.yaml --dry-run

# 4. the etch
ord --chain mainnet --config ord.yaml --index-runes wallet batch \
    --fee-rate 1 --batch batch.yaml
```

### The gate: what `preflight.sh` refuses

Step 0 changes no money — there is no signer in it, and it never calls `wallet batch`, not even
with `--dry-run`. It exits 0 when all six checks hold, 1 when one fails (the message names it and
says what to do) and 2 when it cannot run at all, because a tool or a file is missing. The order is
deliberate: each check is cheaper and more fundamental than the one after it, so the first failure
is the one worth fixing.

| # | Check | What it refuses |
|---|---|---|
| 1 | a mainnet node, reachable and synced | no node; a node answering for another chain; one still in initial block download; one more than 2 blocks behind its own headers |
| 2 | the ord server on `127.0.0.1:8080` | nothing answering `/blockcount`, and it prints the `ord ... server` command to start |
| 3 | a wallet that exists | `wallet balance` failing because there is no wallet yet; and, as exit 2, a balance it cannot parse rather than a guessed one |
| 4 | enough sats to pay | a `spendable` balance below the 20,000 postage plus 20 sat/vB over 900 vB, with the shortfall; runes and inscriptions already in the wallet cannot pay a fee |
| 5 | the name is still free | a 200 (already etched); any answer that is neither 404 nor 200; and a control lookup of `UNCOMMON•GOODS` that is not 200, because an outage must not read as "free" |
| 6 | today's fee rate | a half-hour rate above the 20 sat/vB ceiling — the balance was only proved against the ceiling, so a higher rate means the wallet was never shown to be enough |

Two of its inputs are **copies** of values in `batch.yaml`, and nothing reconciles them:
`RUNE_NAME` (default `WEB•NINE•NINE•NINE•NINE`) repeats `etching.rune`, and `POSTAGE_SATS` (20,000)
is `postage` twice — 10,000 for the premine output, 10,000 for the ride-along inscription. Change
one file and not the other and the gate passes the wrong thing: a renamed rune is still checked
under the old name, and a raised `postage` leaves the balance check exactly that many sats short.
Edit both, or override the copy for one run — `RUNE_NAME=... POSTAGE_SATS=... bash preflight.sh`.

The script's own caps (`MAX_FEE_RATE=20`, `VSIZE=900`) are the numbers check 4 proves the balance
against, so raising `--fee-rate` past 20 at etch time puts the run outside what was checked.

### What the dry run must show

Step 3 is the last moment nothing can be lost, so it is read against four things rather than
skimmed. Each one failing means the etch is not run:

- **`rune.destination` is the address from `ord wallet receive`.** Write that address down in step 2
  and compare it character for character: the reveal pays the premine there, and a destination you
  did not expect is a premine you will spend the rest of the run watching from outside.
- **`total_fees` sits inside preflight's envelope.** At the rate you are about to pass it should be
  about 411 × the rate — the measured size of this same batch on regtest — and must stay under
  900 × the rate, the vB ceiling `preflight.sh` proved the balance against. At 3 sat/vB that is
  ~1,233 sats expected and 2,700 at the ceiling; a figure outside that is not the transaction that
  was checked.
- **The echoed etching equals `batch.yaml`, field for field:** `premine: 1000000`,
  `supply: 700000000`, `terms.amount: 1000000`, `terms.cap: 699`, `turbo: true`,
  `divisibility: 0`, `symbol: ¤`. A mismatch means ord read a different file, or the numbers moved
  after the name was proved free — either is permanent once mined.
- **The postage is postage.** 10,000 sats in the premine output and 10,000 in the throwaway
  inscription's own output, both still yours; only `total_fees` is spent. A dry run that merges those
  two into one output is not the shape `batch.yaml` describes (`mode: separate-outputs`) and the
  etch should wait until it is.

`ord.yaml` must contain `server_url: http://127.0.0.1:8080`. There is no `--server-url` flag;
without it every wallet command fails against `http://127.0.0.1/blockcount`. Re-price `--fee-rate`
immediately before step 4 — it is the most volatile input in the run — by reading both
`curl -s https://mempool.space/api/v1/fees/recommended` and the gateway's `estimatesmartfee 2`
from the section below (its `feerate` is BTC/kvB, so 0.00001003 is 1.003 sat/vB). When the two
disagree, take the higher: the difference is a few hundred sats across two transactions, while a
commit left sitting in the mempool is a name you have already proved free and someone else can
claim first — read at block 977,526 they disagreed exactly like that, 3 sat/vB for the next half
hour against 1.003, so the etch would have gone out at 3.

An etch is two transactions: a **commit** broadcast first, then a **reveal** that matures after 6
confirmations, so expect roughly an hour. The name is claimed by the reveal, and the premine is paid
to ord's wallet address in that same transaction.

### Why the node is local, and what the Tatum gateway is for

A public JSON-RPC gateway looks like it would spare you the sync: `https://bitcoin-mainnet.gateway.tatum.io`
answers `getblockchaininfo` with no key and no account — `chain: main` at block 977,525, Core 32.1.0 —
and `estimatesmartfee 2` with 1.003 sat/vB, so the numbers are real. It is the access that is not.

- **The free tier allows 5 requests a minute.** The next call inside the same minute is refused with
  `429 You have exceeded your limit of 5 requests per minute`. `ord --index-runes` reads the chain
  block by block from genesis: at this height that is 977,525 `getblock` calls before the wallet can
  answer anything, which at five a minute is about 136 days, and it never catches up while a block
  arrives every ten minutes. A runes index is a scan, not a lookup, so a rate-limited endpoint cannot
  serve it at any price below the paid tier.
- **ord has nowhere to put the credentials.** `ord.yaml` points at loopback and reads the node's cookie
  from `bitcoin_data_dir`, which is what keeps a password out of a tracked file; a remote RPC needs
  `bitcoin_rpc_username`/`bitcoin_rpc_password` written down instead. Pointing `bitcoin_rpc_url` at the
  gateway would trade a working node for a slower one *and* a secret in git, which is the opposite of
  what the comment in `ord.yaml` is there to prevent.

So the gateway is good for exactly one thing: a one-off check from a machine that has no node — the
current height, or the fee rate re-priced immediately before step 4:

```bash
RPC=https://bitcoin-mainnet.gateway.tatum.io
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getblockchaininfo","params":[]}' $RPC
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"estimatesmartfee","params":[2]}' $RPC
```

`GET /` answers 405 — "Method not allowed, POST is the only valid for JSON-RPC interface" — so opening
it in a browser tells you nothing about whether it works. Keep `ord.yaml` on `http://127.0.0.1:8332`:
the etch, the audit and the funder all need the local node.

## After it mines

```bash
ord --chain mainnet --config ord.yaml --index-runes wallet balance   # the premine, in whole units
curl -s https://ordinals.com/rune/WEBNINENINENINE | head             # rune id, supply, terms
```

Write down the rune ID (`BLOCK:TX`). Confirm the premine is in an address you control, that the
supply and terms read as intended, and that the mint window (`offset.end: 52500` blocks, about a
year) is what you meant. Anything wrong here cannot be fixed — the only remedy is a second rune.

## Do not

- Do not reuse the regtest wallet, its keys or its backup for the mainnet wallet.
- Do not skip the dry run, and do not skim it: check it against the four acceptance criteria above,
  not just its exit code.
- Do not etch a locked (too short) or already-taken name: the etching is not honoured and the fee is
  still spent.
