# Local Bitcoin regtest chain

A self-contained Bitcoin Core **v32.1.0** regtest node in this folder. Mine blocks instantly, move
coins between addresses, pay nothing, and never touch a real network.

Regtest is a private chain with its own genesis block and **no peers**: it cannot connect to
mainnet, testnet or signet, and every coin on it is worthless by construction. That makes it the
right place to rehearse scripts, wallets, `ord`/runes work, or fee logic before spending real sats.

## Quick start

```bash
./regtest/start.sh          # start the node, wait for RPC
./regtest/btc getblockchaininfo
./regtest/stop.sh           # stop it cleanly
```

For a from-scratch chain in one command — wipes `data/`, starts, creates a wallet, mines 101
blocks and prints the spendable balance. That erase takes the rune etch in block 112 with it, which
no peer can resend, so it asks you to type `wipe` and refuses to go on without the `chain.sh`
snapshot it takes first (`echo wipe | ./regtest/rehearse.sh` for a script). With no `data/` there is
nothing to lose and it asks nothing:

```bash
./regtest/rehearse.sh
```

`btc` is a thin wrapper around `bitcoin-cli` that supplies the datadir and config, so
`./regtest/btc <anything>` is a normal `bitcoin-cli` command.

| Path | What it is |
|---|---|
| `bitcoin.conf` | chain, ports, fallback fee |
| `data/` | datadir — chain state, wallet, keys, logs |
| `bin/` | `bitcoind.exe`, `bitcoin-cli.exe` |
| `start.sh` / `stop.sh` / `btc` | the three commands you need |
| `rehearse.sh` | reset + start + wallet + 101 blocks, one command |
| `mempool-demo.sh` | fee scarcity: tiny blocks (RBF, CPFP) or `MODE=pool` eviction |
| `bin/ord.exe` | ord 0.29.1, verified against the published SHA-256 |
| `ord` | wrapper: ord against this node with `--index-runes` |
| `ord-server.sh` | the HTTP server `ord wallet` commands talk to |
| `ord.yaml` | sets `server_url` to `127.0.0.1:8080` |
| `batch-throwaway.yaml` | rune etch used for the rehearsal |

RPC is on `127.0.0.1:18443` (cookie auth, no password in any file), P2P on `18444`, both bound to
loopback only.

## Mine and spend

```bash
# a wallet — rehearse.sh leaves one called "rehearse"; or create your own
./regtest/btc createwallet mywallet

# an address to mine to
ADDR=$(./regtest/btc getnewaddress mining)

# coinbase needs 100 confirmations before it is spendable,
# so mine 101 to have one mature reward
./regtest/btc generatetoaddress 101 "$ADDR"
./regtest/btc getbalance          # -> 50.00000000

# send to a second address
ADDR2=$(./regtest/btc getnewaddress recipient)
TXID=$(./regtest/btc sendtoaddress "$ADDR2" 12.5)

# a regtest block is mined on demand, so confirmation is one command
./regtest/btc generatetoaddress 1 "$ADDR"
./regtest/btc getrawtransaction "$TXID" true | grep confirmations
```

Verified on this machine from a fresh chain:

```
balance after 101 blocks: 50.00000000
sendtoaddress 12.5 -> txid 2fb8f11b9c3ae37ea15d20ce560061bc64395e2bb9e18f20f37698ba7a5126e2
confirmations after one block: 1
getreceivedbyaddress recipient: 12.50000000
```

## Regtest facts worth remembering

- **Block subsidy is 50 BTC**, and halving happens every 150 blocks.
- **Coinbase matures after 100 blocks** — a fresh reward is not spendable immediately.
- **Blocks are mined on demand.** There is no target interval and no mempool wait; `generatetoaddress`
  produces them instantly. Fees therefore never rise on their own.
- **Addresses start `bcrt1…`**, not `bc1…`. A mainnet wallet will refuse them, which is the point.
- **`-daemon` does not exist on Windows.** `start.sh` detaches via PowerShell `Start-Process`;
  on Linux/macOS the same script uses `nohup`.
- **Wallets are not auto-loaded in v32.** After a restart `getbalance` fails with "No wallet is
  loaded" until `loadwallet` runs. `start.sh` loads every wallet it finds in the datadir, so you
  normally never see this.
- `fallbackfee` is set in the config because regtest has no fee history to estimate from — without
  it `sendtoaddress` fails.

## Current state of this chain

Last `rehearse.sh` run left it at **block 101**, wallet `rehearse` loaded and auto-loaded on
restart, with **50.00000000 BTC spendable** (one mature coinbase) and 100 immature ones behind it.

Re-running `rehearse.sh` always returns to exactly that state — verified twice in a row. `start.sh`
is idempotent, and the chain plus wallet survive a stop/start cycle.

## Fees: scarcity, when there is any

```bash
./regtest/mempool-demo.sh             # 31 txs into a block that fits 7
MODE=pool ./regtest/mempool-demo.sh   # fill a 5 MB mempool until it evicts
COUNT=60 ./regtest/mempool-demo.sh    # more pressure
```

Regtest only mines on demand **and** its blocks hold 4M weight, so in normal use nothing is ever
left out and fees never matter. Both are artifacts. This script removes the second one: it starts
its own node with `-blockmaxweight=12000` (a block that fits ~7 of its 141 vB transactions), fills
the mempool past that limit, and shows the two ways a stuck tx can still get in: RBF and CPFP.

Measured output on this machine:

```
height 134, 1700.00000000 BTC across 34 spendable coinbases
mempool: 31 txs, all unconfirmed, none spending another unconfirmed tx
template: 7 txs, from 31 in the mempool
   1     141     28200   200.00  32939b171558954b  <- the 200 sat/vB tx
   2     140       282     2.01  a17e8eb7569dcb51
   ...
   7     141       282     2.00  659a678a8beb4bf7
24 txs were left out: valid, fee-paying, and outbid

block 135: 4814 weight, 7 of 31 of our txs confirmed
cutoff: cheapest confirmed 2.00 sat/vB, most expensive still waiting 2.00 sat/vB
24 still waiting: same rule for everyone, they just bid less

stuck tx pays 2.00 sat/vB over 141 vB
replacement spends the same coins (b138a544…:0); the original is out of the mempool
after one more block: replacement confirmations 1, 17 txs still queued
that block holds the replacement and not the original, which never confirmed

parent pays 1.00 sat/vB over 141 vB and waits
mined a block anyway: parent still unconfirmed, 11 txs in the mempool
child spends that output and pays 112.81 sat/vB over 110 vB on its own
before mining: package of two pays 50.00 sat/vB over 251 vB
after mining: both in block 138, package pays 50.00 sat/vB over 251 vB
```

Transaction sizes vary between runs because the wallet picks the parent's coins; the package rate
stays at `PKG_RATE` because the child's fee is sized from the parent's actual vsize. The crowd pays
2 sat/vB rather than 1 so the CPFP parent at 1 sat/vB loses by arithmetic instead of by a
tie-break.

**CPFP is a child paying for its parent.** The child spends the parent's output, so a miner cannot
take the child without also taking the parent, and the two are weighed as one package: the parent's
1 sat/vB is dragged up by the child's overpayment to 50 sat/vB for the pair, which is what finally
beats the crowd. Nothing waits for the parent to confirm first. `-spendzeroconfchange=0` is also
why the child is built with `createrawtransaction` — the wallet would refuse to spend an
unconfirmed parent on its own.

The coins it spends are mature **coinbase outputs**: coinbase outputs to one address are still
separate UTXOs, so mining `104 + COUNT` blocks leaves more than `COUNT + 2` independent coins (the
crowd, the 200 sat/vB tx and the CPFP parent) and no split transaction is needed.

The script checks, rather than claims: that no tx depends on another unconfirmed tx, that the
template order is exactly fee-rate descending, that something was actually left out, that the
replacement spends the same inputs as the original, that the original leaves the mempool, that the
block after the bump holds the replacement and not the original, that no waiting tx outbid a
confirmed one (so the cutoff really was fee rate, not luck), that the CPFP parent is absent from a
block mined while it waits, that parent and child land in the same block, and that the package rate
measured from the mempool matches what the wallet reports afterwards.

### The other scarcity: a full mempool

A block limit leaves transactions waiting. A mempool limit throws them away. `MODE=pool` runs the
same node with `-maxmempool=5` (the smallest bitcoind accepts), fills it with ~93 kB transactions
at 1, 2, 3… sat/vB, and stops at the first evictions:

```
== 2. fill a 5 MB mempool with 3000-output txs, cheapest first
  8 sent after 19s: pool 8 txs, 1.2 MB of 5 MB
  32 sent after 30s: pool 32 txs, 4.6 MB of 5 MB
  40 sent after 34s: pool 34 txs, 4.9 MB of 5 MB

== 3. which ones survived
34 of 40 txs are still there, paying 7..40 sat/vB (measured, and equal to the bid)
evicted (6): 1,2,3,4,5,6 sat/vB — dropped for being cheapest, not for being bad

== 4. the pool now refuses the rate it just evicted
a fresh 1 sat/vB tx is refused; the pool now demands 6.10 sat/vB
```

Eviction is not a block decision: nothing was mined, and those six transactions now exist nowhere.
The pool also ratchets its own minimum fee up as it fills, so the rate it just threw out cannot
come back in.

The survivor rates above are read back out of the pool, not assumed: every one matched the rate
it was bid, and the pool's kept set is the top of the range with no gaps.

Three things matter if you tune it. The outputs are paid to addresses from a wallet that is then
unloaded — paying the demo wallet's own addresses makes every send take ~8.5s of wallet writes
instead of ~0.2s. The transactions are ~93 kB (3000 outputs) because filling even 5 MB with normal
141 vB transactions would take tens of thousands of them; mempool accounting runs about 1.6x
vsize, so roughly 34 of these fill the pool. And each tx goes out as a single `sendmany`, which
builds, signs and broadcasts inside the node: the same tx through `createrawtransaction` +
`signrawtransactionwithwallet` + `sendrawtransaction` costs ~1.04s against `sendmany`'s ~0.31s,
because nearly all of that is per-call cost (one `bitcoin-cli` call is ~89ms before the node does
any work) rather than the 93 kB. The run takes about 35 seconds, two fifths of it mining the
mature coins the sends spend.

### Which platforms this runs on

Both paths are exercised, with the same numbers:

- **Windows**, through `Start-Process`, which needs `powershell.exe` and `cygpath` on `PATH` — a
  Windows binary can only be handed `C:\` paths. If either is missing the script stops within a
  second and says so, instead of waiting 30s on a node that was never started. Verified here too:
  block mode took 27-54s and pool mode 69-81s across runs on a busy machine, so it is load
  sensitive in the same way as the WSL1 figures below.
- **Linux**, through `nohup`: `bin/bitcoind` and `bin/bitcoin-cli` are native builds and the
  datadir is passed as an ordinary path. Verified under WSL1 (Ubuntu 24.04, kernel 4.4): block mode
  takes about 15s and pool mode about 25s on a quiet machine, but load dominates both — the same
  runs took 18-39s and 45-48s on a busy one. WSL2 would need virtualization enabled in firmware,
  which the machine this was tested on has switched off.

`parity.sh` checks that "same numbers" claim rather than leaving it to the eye: it runs both modes
through both paths and fails if any of the claims differ, so all four runs take a few minutes
(`MODES=pool ./parity.sh` or `MODES=block ./parity.sh` narrows it to one mode). Before the first
run it also checks that 18543 and 18544 are free — `RPCPORT`/`P2PPORT` to change them — and exits 2
if not, because the demo's ports are fixed and a stray node there would otherwise read as "the node
did not start" or as a leak.

Both paths need `python` on `PATH`: Ubuntu ships only `python3`, so a `python` symlink or alias has
to be added first. The demo does not check for it up front.

`bin/` carries both pairs, `bitcoind`/`bitcoin-cli` and `bitcoind.exe`/`bitcoin-cli.exe`. The
script picks by `uname` rather than by testing whether the file exists, because on Windows the
name `bitcoind` resolves to `bitcoind.exe`. For the same reason copy the native binaries in from
the Linux side: a Git Bash `cp` to `bin/bitcoind` lands on `bin/bitcoind.exe` and overwrites the
Windows build. Anything that is neither Windows nor Linux, macOS say, takes the same fallback
branch and picks the Linux pair. Both binaries are asked for their `--version` once before anything
starts, so that host stops there with `FAIL: …/bitcoind is not runnable on Darwin: cannot execute
binary file: Exec format error` instead of an exec-format error from the launch itself.

**Block mode: the pool is never full.** 31 transactions against a 300 MB default mempool is nothing; scarcity
here comes from the block limit, which is where it comes from on mainnet too. `-blockmaxweight` is
startup-only and must exceed `-blockreservedweight` (8000 by default), which is why the demo runs
its own node instead of reconfiguring yours: it lives in `.demo/node` on RPC `18543` / P2P `18544`
and is stopped when the script exits. Your chain, wallets and the ord server are untouched.

Tune with `COUNT`, `BLOCKWEIGHT`, `CROWD_RATE` and `PKG_RATE` for block mode, `MAXMEMPOOL`, `OUTS`
and `MAXTX` for pool mode.

### Exit codes

Every script here exits `0` when everything it checked held, `1` when it did not, and `2` when it
could not run at all: missing or unrunnable binaries, a node that will not start, too few coinbases,
or a situation the demo needs that never arose (`-blockmaxweight` too generous, a pool that never
filled). Automation can read the difference — `1` means what the script says is wrong, `2` means the
machine is. `parity.sh` passes the demo's code through, `status.sh` counts each failed check,
`chain.sh` fails verification — a snapshot whose checksum does not match, a chain that came back
at a different state, a bundle that does not read back — and `2` covers their own preconditions:
no `sha256sum`, no node to snapshot, an ord server that will not stop, a bundle path inside this
folder or already in use, `rehearse.sh` without the typed `wipe`.

## ord and runes

ord 0.29.1 is installed and pointed at this node. Wallet commands go through `ord server` (its HTTP
port defaults to 80, so `ord.yaml` sets `server_url` to 8080):

```bash
./regtest/ord-server.sh        # leave running; wallet commands need it
./regtest/ord wallet balance
./regtest/ord wallet batch --fee-rate 1 --batch regtest/batch-throwaway.yaml --dry-run
```

A **throwaway rune is already etched** here: `THROW•AWAY•TEST`, ID **112:1**, premine 1000, terms
1000 × 999, one mint performed (balance 2000). Query it through the server: with the server running,
`ord runes` and `ord balances` fail fast with `Database already open. Cannot acquire lock.`, and
with it stopped they blocked for minutes rather than returning. The server endpoint is the practical
path:

```bash
curl -s -H 'Accept: application/json' http://127.0.0.1:8080/rune/THROWAWAYTEST
```

Two compatibility facts this setup encodes:

- **`deprecatedrpc=bip125`** is in `bitcoin.conf`. Core 32.1 drops `bip125-replaceable` from mempool
  RPCs, and ord 0.29.1 fails mid-etch with `missing field 'bip125-replaceable'` without it.
- **A rune-only batch is rejected** by ord 0.29 (`batchfile must contain at least one inscription`),
  so `batch-throwaway.yaml` carries a one-line text inscription alongside the etch.

## Checking the setup

```bash
./regtest/status.sh     # 0 all good, 1 a check failed, 2 it could not look
```

One pass over the things that have disagreed here before: bitcoind's height and tip, which wallets
are loaded (v32 loads none by itself, and a wallet that is on disk but not loaded is invisible to
`getbalance`), each loaded wallet's balance, where the ord index got to, whether it still knows rune
`112:1`, whether the demo's fixed ports 18543/18544 are free, and whether the newest complete
snapshot still covers the chain — a backup nobody refreshed being the failure the snapshot tool
exists for — whether that snapshot's `data.tar.gz` is still the archive its manifest recorded, and
which `data.before-restore-<stamp>` copies are on disk with their age and height (a note: nothing
prunes them, and they hold wallet keys).
The height alone would not notice a truncated or rotted archive whose `state.txt` survived, so the
checksum is checked too, and so is the marker `verify` leaves behind: `proven to restore at
<time>` when the archive is still the file that was proved, `checksum-checked only` when nothing
has restored it yet. A snapshot written before manifests carried a checksum is reported as
checkable by height only rather than passed quietly.

Every snapshot older than the newest is listed too, with which of those three states it is in — a
deep fallback nobody has ever restored once is a hypothesis, and the check says so for each one (or
says there is no other snapshot to fall back on at all). Each older archive is held to the same
checksum, so one that has rotted reads as `BAD` rather than as an old backup that merely lacks
proof — a fault and a to-do should never be the same message, least of all for the copy you reach
for when the newest one has failed — and one whose archive is gone is named as missing. An archive
that is there but cannot be read is its own `BAD` rather than the end of the run: reporting it and
carrying on is the point of checking the rest.

Mining a block turns the snapshot check red until the next `chain.sh snapshot`, which is the
intended nag.

The index height is only reported when the server that answered is proved to be this folder's: an
`ord` process whose command line names this folder's `ord-data`, the same test `./ord-server.sh`
uses before it will stop anything. A copy of the folder — a sandbox, a second checkout — asks
`127.0.0.1:8080` and gets whichever server is listening, and without that check it would report the
original folder's index as its own and call it a 112-block lead. When ownership cannot be
established the check says so and reports no height, rather than a number that belongs to someone
else.

The node gets the same treatment one port over, because a node that answers on 18443 is not
yet this folder's node: another checkout, or a copy pointed at the same port, can be holding
it. A `bitcoind` process whose command line names this folder's `data/` — the `-datadir=`
argument `start.sh` passes — is what settles it, and until it does no height, wallet or chain
is taken from that node. A node it cannot identify at all is reported as such rather than
trusted: no chain history is compared against `.last-seen`, and the snapshot check reports no
height. A copy that shares the original's cookie would otherwise authenticate and have its
chain reported as this folder's.

It also writes one line of memory. `.last-seen` holds the tip it found, and the next run compares by
descent instead of by height: a tip that is known but off the main chain is a rewind, and a tip the
node has never heard of means the blocks it was in are gone. That is the case a height alone cannot
see — a hard stop loses a block, new blocks are mined back to the same height on a different
history, and every count still looks right. The record is only replaced by a tip that agrees, so a
rewind keeps being reported until you `rm regtest/.last-seen` to accept the chain as it is.

`.history` is the other record, and unlike `.last-seen` it is not overwritten: one appended line
per destructive run — timestamp, verb (`restore`, `rehearse`, `prune`), the height it left, the
height it produced, and the snapshot it used or what it removed:

```
2026-11-16T14:19:40Z restore 7 5 snapshot s5; ord index kept (at 5, not ahead of 5)
2026-11-16T14:20:46Z rehearse 5 101 snapshot 20261116T141944Z-pre-rehearse
2026-11-16T14:21:50Z prune - - removed 3 snapshot(s) and 3 kept copy(ies)
```

When the height check finds the chain shorter than it was, or a tip it no longer knows, it prints
the last line of that file — so the finding says what removed the blocks, which the height alone
never could. A run with nothing wrong prints it too, as a note, so a clean status still says when
the chain was last wiped or rolled back; a folder with no `.history` is reported as such when
something is wrong, and passed over in silence when nothing is.

The ord part answers over HTTP when the server is up and opens the index itself when it is not,
because the server owns the index lock either way and a down server is the case worth asking about.
It opens it with this folder's own `rpcport` rather than `./ord`'s default, so a copy of the folder
asks its own node instead of the original's. It prints every finding rather than stopping at the
first, so one run is the whole picture.

**An index ahead of the node** is the one finding that needs a decision: it means the index saw
blocks the chain no longer has (a restore, or a node that came back short), so it is not just behind
and waiting. ord counts blocks rather than heights, so an index that agrees with a tip at height 113
reports 114 — `status.sh` accounts for that, and the number in a finding is a height difference.
Rebuild it without touching the ord wallet:

```bash
./regtest/ord-server.sh stop
rm regtest/ord-data/regtest/index.redb
./regtest/ord-server.sh          # reindexes from genesis, a minute at this size
```

`ord-server.sh stop` stops the process whose command line names this folder's `ord-data`, and only
that one: several `ord.exe` can be running (another checkout, a sandbox), and the first of them is
not a thing to guess at. If something answers on 8080 but no ord process names this folder's data,
it says so and stops nothing.

### Do the safety gates still hold?

```bash
./regtest/selftest.sh          # about two minutes; KEEP=1 leaves its folder behind
```

Every guarantee above is a property of the scripts, and a property does not survive an edit by
itself: move one `read` earlier, reorder the two renames, and the gate is gone with nothing to
notice. This builds a throwaway copy of the folder in a temp directory (its own ports, its own
chain) and asserts 27 things about it. Nothing in it reads printed text: every assertion is an exit
code, the presence or absence of a file, or the bytes of one — a message can be reworded while the
behaviour behind it changes, and a test that greps prose passes on a sentence describing a gate
that no longer exists.

- `restore` without `rollback`, `prune` without `prune` and `rehearse` without `wipe` all exit 2
and leave the chain unchanged — asserted as the block files byte for byte, the tip, and every
wallet's balance, because bitcoind rewrites its own bookkeeping on start and stop and a digest of
the whole datadir would change for reasons that have nothing to do with a restore. A refusal also
leaves no staging directory, and does not alter the snapshot it was pointed at;
- a corrupted archive makes `verify` exit 1, writes no `.verified` marker, and removes its scratch
datadir;
- a lock held by a live process refuses the next run with exit 2 and writes nothing; the same lock
from a process that is gone is taken over, and the run finishes with a manifest to show for it;
- a restore killed *between* its two renames still leaves a `data/` at the snapshot's height, with
exactly one kept datadir, no staging directory, and no lock — the guard is provoked
deterministically, by a copy of `chain.sh` that kills itself inside that window, rather than raced.

It exits 0 when every case held, 1 when one did not (naming the value it measured), 2 when it could
not run at all — ports already taken, no node. Removing a gate makes it fail: taking the word check
out of `restore` produced four findings — exit 0 instead of 2, the tip moving from 5 to 3, two kept
datadirs, and a later case seeing the extra copy — for rc 1, with no message matching involved.

## Snapshot and restore the chain

Regtest has no peers, so a block mined here and then lost — a hard stop before it reached the disk
is enough — cannot be fetched from anyone; the rune etch at 112:1 exists only in `data/`. Two
verbs, and both leave the node running:

```bash
./regtest/chain.sh snapshot          # -> .snapshot/<UTC stamp>/
./regtest/chain.sh restore [dir]     # newest by default
./regtest/chain.sh drill             # the same swap, on this folder, with the newest snapshot
```

`drill` exists because `verify` never touches `data/`: it proves an archive restores into a scratch
datadir, so the two renames a restore performs, the guard armed between them and the comparison
against the real `data/` run for the first time during an actual restore — the worst moment to find
out they are broken. A drill runs exactly that path with the newest snapshot and prints what it
compared, line by line, from that snapshot's `state.txt`. If the newest snapshot is behind the chain
the drill would drop blocks, so it asks for the word `drill` first, like `rollback`; at the chain's
own height it asks nothing. What it replaces is kept as `data.before-restore-<stamp>`, nothing is
deleted, and `.history` records the run as a `drill` so a chain that comes back shorter has its
reason on file.

`snapshot` writes down the state (height, tip, which wallets are loaded, block 112's etch tx) and
the balances beside it, copies every loaded wallet out with `backupwallet` plus
`listdescriptors true` (v32 has no `dumpwallet`), stops the node through `stop.sh`, tars `data/`,
and starts it again through `start.sh`. It then refuses to finish unless the chain comes back at
exactly the state it wrote down. Balances are printed but not compared: the wallet settles them on
its own schedule, so the same tip can legitimately read a different balance a moment later.

Tarring a *running* datadir is what the stop avoids: `blocks/` and `chainstate/` would not agree
with each other.

`rehearse.sh` is the other thing that destroys `data/`, so it takes one of these snapshots first,
refuses to run without a typed `wipe` (`echo wipe | ./rehearse.sh` in a script), and exits with
`chain.sh`'s code — `data/` untouched — if that snapshot is not taken and verified. Taking it is not
the same as it restoring, so the rehearsal then runs `chain.sh verify` on that copy before it erases
anything: if the archive cannot be proven to unpack into the chain it recorded, the run stops with
`data/` as it was. It is named `<UTC stamp>-pre-rehearse` and kept, so the chain a rehearsal
replaced can be restored. The run also clears `.last-seen`, whose tip described the chain just
erased.

`ord-data` is handled rather than left behind: the ord server is stopped before the erase, the index
is deleted with it, and the server is started again over the new chain, which rewrites the index
from genesis. Only `index.redb` goes — `ord-data/regtest/wallets/ord.redb` holds the rune balance
and is never touched. Nothing waits for the rebuild: an index that is behind is a note in
`status.sh` ("it catches up itself"), and only one that is ahead is a failure, which deleting it
has already ruled out. A rehearsal therefore ends at a state the check calls clean whether the
index is rebuilt by the time you look or not. If the server will not start, it says so and the
index stays empty, which `status.sh` also reports as a note.

### Proving a backup restores

A checksum says the file is the file. `verify` says the backup is a chain: it unpacks the archive —
or copies the kept datadir — into a scratch datadir, starts a node on a port of its own (18643;
`RPCPORT=` to move it, and no P2P at all), loads every wallet there is — the only code anywhere here
that reads those `.dat` files back — and compares the result with the state that was written down. A
chain that comes back at the wrong block, or a `.dat` that will not load, fails it.

```bash
./regtest/chain.sh verify                       # the newest snapshot, the one restore would pick
./regtest/chain.sh verify .snapshot/20261115T090713Z
./regtest/chain.sh verify /d/backups/regtest-2026-11-16.tar.gz   # a bundle
```

Both shapes carry copies of their own, and `verify` opens them rather than counting them: every
`.dat` beside the archive — `wallets/` in a snapshot, `chain/wallets/` in a bundle — is loaded into
the scratch node with `restorewallet`, under a name of its own so it cannot collide with the copy
the archive restored, and then read back. The ord wallet is opened too — in a bundle it is inside `ord/ord-data.tar.gz`, in a snapshot in
`ord-data.tar.gz` beside the chain archive: an `ord server` on a spare port, over the extracted
data, asked for the wallet's descriptors, because ord reads a wallet only through its server. These are the copies to reach for
when the archive is the thing that broke, so they have to open, not merely exist.

A verification that passes leaves `.verified` in the snapshot it proved — when, which archive
(`sha256`), and at what height — and `status.sh` reports that line beside the checksum it already
checks: `proven to restore at <time>`, or `checksum-checked only` when no run has proved it yet, or
`was proven … but the archive has changed since` when the file no longer matches the hash the marker
recorded. That difference matters because the two checks answer different questions: the checksum
says the bytes are the ones that were written, `verify` says they come back as a chain.

Exit codes as everywhere: `0` restores to the recorded state with its wallets, `1` it does not —
mismatched checksum, a wallet that will not load, a chain that comes back somewhere else — and `2`
it could not run (no such path, the port is taken, the scratch node will not start). Your `data/`
and the running node are not touched: the copy is stopped and deleted on every way out, including
the failures, and the trap that does it is why a failed verification leaves no second set of keys
on disk.

`restore` checks the archive against the sha256 in the manifest, unpacks it into a staging directory
while the current `data/` is still in place, and only then swaps. The directory it replaces is kept
as `data.before-restore-<UTC stamp>`, and an existing one is never written over — the second
restore keeps its own way back instead of destroying the first's. It compares the result against
the snapshot's recorded state and fails if they differ. That comparison uses only the fields every
snapshot format carries — height, tip, the rune's block and tx, and which wallets are loaded —
so a snapshot taken before the state file changed (its wallet lines carried balances) still
verifies, with the amounts read as nothing more than names.

Rolling the chain backwards — or putting another branch's tip in place — asks you to type
`rollback` first: the usual mistake is picking a snapshot older than the chain, and a word typed at
the moment of the mistake is harder to repeat out of habit than a flag exported in a shell. Nothing
is touched before it is typed, so a refusal leaves `data/` as it is; from a script,
`echo rollback | ./regtest/chain.sh restore <snapshot>`.

The ord index is rolled back with the chain, because it is the other half of the same claim. An
index ahead of the restored height still holds the blocks the chain has just lost, and it keeps
serving their inscriptions and runes as fact — on a chain that carries a real rune, that is the
one wrong answer that looks entirely right. So `restore` stops this folder's ord server before the
swap (through `ord-server.sh stop`, so a server belonging to another folder is never stopped), then
reads what the index is at: ahead of the restored height, or unreadable (and says why, in ord's own
words, so a wrong port or cookie is not taken for a corrupt file), and deletes
`ord-data/regtest/index.redb` so the next `./ord-server.sh` rebuilds it from the restored chain;
not ahead, and it is kept, since it tails forward by itself. An index that arrives inside a
snapshot, restored into a folder that had none, is held to the same rule from the height the
snapshot's manifest recorded at capture: above the restored chain, it is deleted before the node
comes back up, and the run says so. That line is a record rather than a measurement, so the
price of believing it wrongly is a rebuild, not a wrong answer. The index is derived data and the
chain is the authority; the ord wallet beside it is never touched either way. The server is
started again only when its index was kept — after a reset it needs the rebuild first, and the run
says so. What happened to the index is printed and appended to `.history` with the rest of the run.

Nothing prunes those copies: each one is a full datadir, wallet keys included. `restore` writes a
small `.txt` beside each saying when it was kept and what height it held, and `status.sh` lists
the ones present with their age and height — as a note, not a failure, since deleting them is a
decision and the folder cannot know when you are done with one.

A kept datadir also carries a `MANIFEST.txt` inside it, written by `restore` at the one moment it
can be written honestly: after the node stopped, while the directory was still static. It records
the state that was in it (height, tip, wallets, the rune block and tx), how many files and bytes
there are, and a `tree sha256` over every file's hash and path. That makes the copy a restore
replaced as checkable as a snapshot — `./chain.sh verify
regtest/data.before-restore-<stamp>` recomputes the tree, then starts a node on a copy of it and
compares it with the manifest — which matters because it is the copy reached for when the restore
turns out to be the mistake. `verify` writes a `.verified` marker into it, with the tree hash rather
than an archive hash, so the same rule applies: the marker stops counting the moment the files are
not the ones that were proved.

Neither verb can end with no `data/` at all. The swap is two renames with a moment in between when
`data/` does not exist, so every exit from that moment goes through a guard: it finishes the swap
when the staged copy is still there and puts the original back when it is not, then says which of
the two happened and names the directory it kept. A rehearsal that dies after the erase prints the
snapshot it took and the exact command that restores it — `cd regtest && ./chain.sh restore
.snapshot/<stamp>-pre-rehearse` — and nothing has to be reconstructed from memory.

`snapshot`, `restore`, `verify`, `rehearse` and `ord-server.sh` take one lock — `.lock` in this
folder — for the length of the run, because they all stop or move the same node, the same `data/`
and the same ord index (`ord-server.sh` starts and stops the process holding `index.redb` open,
which a rehearsal deletes). A second one refuses and names the verb and pid already running there
instead of interleaving; a lock whose pid is gone is taken over with a line saying so, and an
interrupt releases it like any other exit.

`snapshot`, `restore` and `rehearse` also ask for room before they write anything: a snapshot wants
what `data/` occupies, a restore the unpacked size of the archive it is about to unpack, a rehearsal
the snapshot plus a chain mined in its place. If the folder has less, or `df` cannot say, they refuse
with exit 2 and name the megabytes — rather than half-writing an archive that hashes as itself, or
unpacking into a full disk.

`chain.sh prune [--keep N] [--keep-kept N]` bounds both piles, since nothing else deletes either
(defaults: 5 snapshots, 2 kept copies). It prints every path it would remove with its size and the
height it holds, then asks for the word `prune`; a wrong word or end of input deletes nothing. Two
things are never candidates whatever `--keep` says: the newest snapshot, and the newest
`-pre-rehearse` snapshot — that one is the way back from the last wipe, and no count makes deleting
it safe. `status.sh` keeps listing whatever survives, so pruning does not hide a copy, it only stops
the folder growing without limit.

A snapshot carries `ord-data.tar.gz` as well as its chain: the ord index can be rebuilt from
`data/` with `ord --index-runes`, but the ord wallet — where a rune *balance* actually sits —
cannot, and a snapshot without it restores ord as a fresh wallet. It is tarred with the ord server
stopped, because the server holds the lock on the index, and the manifest records its size and
`sha256` on an `ord-archive` line, which `verify` checks and then opens the wallet out of it. Beside
that checksum it writes `ord index height at capture: <height> — <how it stands against the chain>`,
read while the node was still up — from the running server, or from the index itself with this
folder's RPC port — and compared with the height in the snapshot's own `state.txt`. A snapshot whose
index is a week behind its chain restores fine and looks fine, so the distance is recorded where the
restore will see it; a height of `unknown` there is a finding, not a blank. What
it does *not* replace is the folder's own `ord-data/` during a rollback: `restore` uses the
snapshot's copy only where there is none at all, as when a snapshot is restored into an empty
folder. A folder that does have an `ord-data/` but no wallet in it keeps that copy too, and
`restore` says so: that is the case where the snapshot's wallet is not installed and nothing else
would report the balance as missing. Snapshots written before this carry no `ord-data.tar.gz`;
`verify` says so rather than passing them silently. And `.snapshot/*/wallets/` holds private keys;
regtest keys for worthless coins, but keys, so do not publish that directory. It is a copy of the
wallets that the snapshot's checksums do not cover, which is why `verify` loads each `.dat` in it
back rather than leaving it unopened.

### To somewhere that is not this folder

All of it — `data/`, `ord-data/`, every `.snapshot/` — is one folder on one disk, so snapshot
and restore protect against restoring the wrong thing, not against losing the folder. `bundle`
writes one self-contained file elsewhere, holding the chain and both wallets:

```bash
./regtest/chain.sh bundle /d/backups/regtest-$(date -u +%F).tar.gz
```

Inside it, `chain/` is exactly a snapshot directory (the node-stopped `data.tar.gz`, `state.txt`, a
`.dat` and descriptors per loaded wallet), and `ord/ord-data.tar.gz` is the ord index and the ord
wallet, tarred with the ord server stopped because it holds the lock. So a restore needs no new
code:

```bash
tar -xzf <bundle> -C /tmp/x && ./regtest/chain.sh restore /tmp/x/chain
```

Across the top there is a `manifest.txt`, and `SHA256SUMS` lists every file in it. Writing it is
not the whole of it: the script then unpacks the file it just wrote into a second directory and
checks that copy — every checksum, the wallet backups, that both archives still list what a
restore needs, and that the recorded chain state is the chain running here — and exits `1` instead
of `0` if any of that fails. A copy nobody has read back is a hope, and the failure this catches
is the ugly one: a bundle that looks fine until the day it is needed. It also writes a
`<bundle>.sha256` beside the file, so the copy can be checked again wherever it ends up —
`sha256sum -c regtest-2026-11-16.tar.gz.sha256` in the directory holding it. That line names the
file, so keep the bundle's name with it, or edit the name in the `.sha256`.

It refuses a destination inside `regtest/` — the folder it exists to survive — and an existing
file, because this is a backup and not something to overwrite. The node and the ord server are
stopped for the copy and started again afterwards, and the chain is verified to be unchanged by it.
Keep the file on another disk or off the machine: a bundle beside the data shares the data's single
point of failure. Measured here: 24 seconds from a chain at height 115, 320 kB written.

## Reset to an empty chain

```bash
./regtest/stop.sh
rm -rf regtest/data
./regtest/start.sh          # fresh genesis, block 0, no wallet
```

Deleting `data/` destroys the wallets and their keys. That is safe *only* because the coins are
worthless — never run this pattern against a datadir holding real funds. On this chain it also
destroys the rune etch in block 112 and the balance in the ord wallet, so take
`./regtest/chain.sh snapshot` first: `rehearse.sh` does exactly that, and asks before it starts.

## What actually depends on `bin/`

Every script resolves its binaries from `bin/` and nowhere else: `start.sh`, `stop.sh`, `btc`,
`rehearse.sh`, `ord`, `ord-server.sh`. Nothing in this folder hard-codes the `threads/` path — that
appears only in the provenance paragraph below. So `bin/` is the single external dependency, and it
is 29 MB of the folder's ~47 MB.

Everything else is self-contained state: `data/` holds the chain and the bitcoind wallets (`rehearse`,
`ord`), `ord-data/` holds the ord index and the ord wallet (`regtest/wallets/ord.redb`, where the
2000 rune balance lives).

| Missing | Effect |
|---|---|
| `bin/bitcoind.exe`, `bin/bitcoin-cli.exe` | `start.sh` fails inside `Start-Process`; `btc`, `stop.sh` and `rehearse.sh` fail with "No such file or directory" |
| `bin/ord.exe` | `ord` and `ord-server.sh` fail; the bitcoind side still works |
| `data/` | chain and both bitcoind wallets gone; `rehearse.sh` rebuilds from scratch |
| `ord-data/` | ord index and ord wallet gone — the rune stays on chain, but the premine is unreachable without that wallet or its mnemonic |

**Recovery is real, not theoretical.** A copy of this folder with `bin/` deleted, repopulated with
the official Bitcoin Core 32.1 zip, started on the existing `data/` at height 113, loaded both
wallets, reported `rehearse` at 648.99996700 BTC, and served rune `112:1` with an ord balance of
2000. Upgrades read an older datadir fine; **downgrades are not guaranteed**, so going backwards
means deleting `data/` and rebuilding.

To avoid losing the rune balance, keep either `ord-data/` or the ord wallet mnemonic. `ord wallet
create` printed it once and it is not stored in plain text in `ord-data/`.

## Getting a current official build

Do not rely on the copy taken from `threads/f7110928…/btc/bitcoin-32.1/bin`. That tree belongs to
another conversation's build, it can disappear, and its MSVC sibling would not even start on this
machine (missing UCRT DLLs). Official builds are one command away and come with published digests:

```bash
# Bitcoin Core — bitcoincore.org publishes binaries plus a SHA256SUMS file
mkdir -p /tmp/core && cd /tmp/core
curl -sLO https://bitcoincore.org/bin/bitcoin-core-32.1/bitcoin-32.1-win64.zip
curl -sL -o SHA256SUMS https://bitcoincore.org/bin/bitcoin-core-32.1/SHA256SUMS
grep win64.zip SHA256SUMS | sha256sum -c -        # must print: OK
unzip -oq bitcoin-32.1-win64.zip
cp bitcoin-32.1/bin/bitcoind.exe bitcoin-32.1/bin/bitcoin-cli.exe <this-folder>/bin/
```

```bash
# ord — GitHub releases, per-asset sha256 digests in the release metadata
# https://github.com/ordinals/ord/releases  ->  ord-<ver>-x86_64-pc-windows-msvc.zip
#   sha256sum ord-<ver>-x86_64-pc-windows-msvc.zip   and compare to the published digest
```

Two rules: **verify the digest before running anything** (`sha256sum -c` so a mismatch is an error,
not a line to eyeball), and **keep the file names** `bitcoind.exe`, `bitcoin-cli.exe`, `ord.exe` —
the scripts resolve those exact paths and nothing else needs editing.

This node is also what `ord --chain regtest` talks to — see
[../runes-launch-plan.md](../runes-launch-plan.md).
