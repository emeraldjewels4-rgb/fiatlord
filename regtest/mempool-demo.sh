#!/usr/bin/env bash
# Real scarcity on regtest: a tiny block limit, so fee rate decides who confirms.
#
# A regtest block is 4M weight, so nothing is ever left out and fees never matter. This script
# runs its own node with -blockmaxweight small enough for about seven transactions, fills the
# mempool past that, and shows the two ways a stuck tx gets in:
#
#   - COUNT txs at 2 sat/vB and one at 200 sat/vB, all unconfirmed
#   - mine one block: only the top few by fee rate fit, the rest keep waiting
#   - RBF: bump a stuck one to 50 sat/vB and it takes the next block
#   - CPFP: a 1 sat/vB parent cannot get in at all; a child that overpays for both does
#
# MODE=pool shows the other kind of scarcity instead: a full mempool, where the pool itself
# throws out the cheapest transactions and then refuses to take them back.
#
# Your main chain (data/), its wallets and the ord server are not touched.
#
#   ./mempool-demo.sh                # 31 txs into a block that fits 7
#   MODE=pool ./mempool-demo.sh      # fill a 5 MB mempool until it evicts
#   COUNT=60 ./mempool-demo.sh       # more block pressure
set -euo pipefail

# Defined before the platform case below, which fails when bin/ holds nothing for this platform:
# a function has to exist before the line that calls it.
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# Exit codes: 0 every claim held; 1 a claim came out false; 2 this demo could not run at all —
# unrunnable or missing binaries, a node that will not start, too few coinbases, or a situation
# the demo needs that never arose. parity.sh and any CI can tell a false claim from a broken
# machine by the difference.
fail() { echo "FAIL: $*" >&2; exit 1; }
envfail() { echo "FAIL: $*" >&2; exit 2; }
winp() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }   # native python wants C:\... paths

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# bin/ holds the Windows builds this demo was set up with. Pick the pair by platform, not by
# testing whether "bitcoind" exists: on Windows that name resolves to bitcoind.exe, so such a
# test always passes and sends a Windows node down the nohup path instead of PowerShell.
WINDOWS=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) WINDOWS=1
                        CLI="$DIR/bin/bitcoin-cli.exe"; DAEMON="$DIR/bin/bitcoind.exe" ;;
  *)                    CLI="$DIR/bin/bitcoin-cli";     DAEMON="$DIR/bin/bitcoind" ;;
esac
[ -x "$DAEMON" ] && [ -x "$CLI" ] ||
  envfail "no bitcoin-cli and bitcoind for $(uname -s) in $DIR/bin"
# -x proves a file can be executed, not that it runs here: the fallback branch takes the Linux pair
# on any uname that is not Windows, so a macOS host would learn that only when it tried one, and a
# mixed pair (a Windows daemon beside a Linux cli, or the reverse) would fail later at the first
# RPC. --version costs a fraction of a second per binary and fails here with its own explanation.
# The shell's reason is "<script>: line N: <path>: <why>", and that path is the one this message
# already names, so keep what follows it.
runnable() {
  local out
  out=$("$1" --version 2>&1) ||
    envfail "$1 is not runnable on $(uname -s): ${out#*"$1": }"
}
runnable "$DAEMON"
runnable "$CLI"
MODE="${MODE:-block}"                 # block = tiny blocks, pool = tiny mempool
COUNT="${COUNT:-30}"
BLOCKWEIGHT="${BLOCKWEIGHT:-12000}"   # must exceed -blockreservedweight, 8000 by default
MAXMEMPOOL="${MAXMEMPOOL:-5}"         # pool mode; 5 MB is the smallest bitcoind accepts
OUTS="${OUTS:-3000}"                 # pool mode; outputs per tx, ~93 kB, the standard max
MAXTX="${MAXTX:-45}"                 # pool mode; cap on how many txs to broadcast
CROWD_RATE="${CROWD_RATE:-2}"         # above 1, so the 1 sat/vB parent is outbid rather than tied
PKG_RATE="${PKG_RATE:-50}"            # package rate the CPFP child buys
CHILD_VSIZE=110                       # a 1-in 1-out segwit child, used to size its fee
RPCPORT="${RPCPORT:-18543}"
P2PPORT="${P2PPORT:-18544}"
NODE="$DIR/.demo/node"
LOG="$DIR/.demo/node.log"

# -regtest on the client too: the cookie is written to <datadir>/regtest/.cookie, and without
# the flag bitcoin-cli looks in <datadir>/.cookie and fails with "Authorization failed".
dbc() { "$CLI" -regtest -rpcclienttimeout=30 -datadir="$NODE" -rpcport="$RPCPORT" "$@"; }
w() { dbc -rpcwallet=demo "$@"; }
jget() { python -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1" | tr -d '\r'; }
# a mempool entry as "fee_sats vsize rate", the three numbers every fee argument here needs
mentry() { python -c '
import json, sys
d = json.load(sys.stdin)
fee = d["fees"]["base"] * 1e8
print(int(round(fee)), d["vsize"], "%.2f" % (fee / d["vsize"]))
' | tr -d '\r'; }
fee_sats() { python -c 'import json,sys; print(int(round(-json.load(sys.stdin)["fee"] * 1e8)))' | tr -d '\r'; }
satrate() { python -c 'import sys; print("%.2f sat/vB" % (int(sys.argv[1]) / int(sys.argv[2])))' "$1" "$2"; }
# the inputs of a tx, so a bump can be shown to spend the very same coins
vin() { python -c 'import json,sys; d=json.load(sys.stdin); print(",".join(sorted("%s:%s" % (v["txid"], v["vout"]) for v in d["vin"])))'; }
# whether the named txids are in a block
inblock() { python -c '
import json, sys
txs = set(json.load(sys.stdin)["tx"])
print(" ".join("yes" if t in txs else "no" for t in sys.argv[1:]))
' "$@" | tr -d '\r'; }
# No timeout wrapper on running(): `timeout` execs a program and dbc is a shell function, so
# `timeout 5 dbc ...` fails with 127 and the node would look dead forever. -rpcclienttimeout
# in dbc() bounds a hung call instead, and this probe asks for 2s rather than dbc()'s 30s: a node
# that is starting or wedged would otherwise hold each probe for its full timeout, and the wait
# loops below would take minutes to give up.
running() { "$CLI" -regtest -rpcclienttimeout=2 -datadir="$NODE" -rpcport="$RPCPORT" getblockchaininfo >/dev/null 2>&1; }
# A start that fails explains itself in one of three files: the shell's own redirect of the
# process ($LOG), PowerShell's complaint about Start-Process ($NODE/start.err), or bitcoind's own
# log. $LOG is empty on Windows, where bitcoind logs to <datadir>/regtest/debug.log instead, so
# print whichever of them actually have something rather than pointing at one of them.
node_log_tail() {
  local f shown=0
  for f in "$LOG" "$NODE/start.err" "$NODE/regtest/debug.log"; do
    [ -s "$f" ] || continue
    printf '  --- %s ---\n' "${f#"$DIR"/}" >&2
    # The tail alone can be noise: a node that failed to bind keeps retrying Tor afterwards, and
    # those retries are last. Show its first error lines as well as its last lines.
    grep -a -m3 -E '\[error\]|Error:|Unable to' "$f" 2>/dev/null | tr -d '\r' | sed 's/^/  ! /' >&2 || true
    tail -n 5 "$f" | tr -d '\r' | sed 's/^/  /' >&2 || true
    shown=1
  done
  [ "$shown" = 1 ] || echo "  (nothing was written to any log)" >&2
  return 0
}
stop_node() {
  if running; then
    dbc stop >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do running || break; sleep 0.5; done
  fi
  # RPC stops answering before the process lets go of its datadir. Starting the next node in
  # that window half-works and then dies, which shows up later as a confusing RPC timeout, so
  # wait until the datadir can actually be removed.
  for _ in $(seq 1 20); do
    # || true because this runs from the EXIT trap: one failed rm (a file the exiting node still
    # holds) would abort the trap under set -e, and bash then reports that status, so the run ends
    # 1 with no message and the retry below never happens.
    rm -rf "$NODE" 2>/dev/null || true
    # Sleep after removing, then look again: on a POSIX filesystem an unlink succeeds even while
    # the node still holds the files open, so a node that is mid-shutdown recreates debug.log and
    # mempool.dat inside the path we just deleted. Only a directory that stays gone is gone.
    sleep 0.5
    [ ! -d "$NODE" ] && return 0
  done
  # Reported and returned, not exited: this also runs from the EXIT trap, where an exit here
  # would overwrite the code the run was already leaving with.
  echo "FAIL: could not remove $NODE; a previous node is still running" >&2
  return 1
}
trap 'rc=$?; rm -f "$DIR"/.demo/pool-*.txt; stop_node || { [ "$rc" -ne 0 ] || rc=2; }; exit $rc' EXIT

# The last line of this script claims the main chain was untouched. This is what that means, so it
# can be compared rather than asserted: the main node runs from data/ with its config beside this
# script, and both clients accept those paths (MSYS rewrites them for the .exe, WSL sees /mnt/c).
maincli() { "$CLI" -datadir="$DIR/data" -conf="$DIR/bitcoin.conf" "$@"; }
main_state() {   # height, tip and each loaded wallet's balance; nothing when that node is not up
  maincli getblockcount >/dev/null 2>&1 || return 1
  printf 'height %s\n' "$(maincli getblockcount)"
  printf 'tip %s\n' "$(maincli getbestblockhash)"
  for w in $(maincli listwallets | tr -d '[]",\r\n'); do
    printf 'wallet %s %s\n' "$w" "$(maincli -rpcwallet="$w" getbalance 2>/dev/null)"
  done
}
# Saying the main chain was untouched is the cheap half; this compares it with the state captured
# before the run started. Both modes end with this same check.
main_check() {
  MAIN_AFTER=$(main_state || true)
  if [ -z "$MAIN_BEFORE" ]; then
    echo "your main chain could not be checked: it was not reachable when this run started."
  elif [ "$MAIN_BEFORE" != "$MAIN_AFTER" ]; then
    printf 'before:\n%s\nafter:\n%s\n' "$MAIN_BEFORE" "$MAIN_AFTER" >&2
    fail "the main chain changed while this demo ran, which it never does"
  else
    echo "your main chain was untouched: this node lived in .demo/node and is now stopped."
  fi
}

mkdir -p "$DIR/.demo"
stop_node || exit 2

MAIN_BEFORE=$(main_state || true)

say "1. start a throwaway node with a ${BLOCKWEIGHT}-weight block limit"
mkdir -p "$NODE"   # stop_node() above already waited for the old datadir to be released
# -spendzeroconfchange=0 stops the wallet funding one tx from another tx's unconfirmed change,
# which is what keeps the crowd independent instead of chained.
ARGS=("-datadir=$(winp "$NODE")" -regtest -server "-rpcport=$RPCPORT" "-port=$P2PPORT"
      -fallbackfee=0.0002 "-blockmaxweight=$BLOCKWEIGHT" -spendzeroconfchange=0
      # a throwaway node has nothing worth reloading, and a 3 MB mempool.dat written on the way
      # out is exactly the thing that reappears in a directory that is being deleted
      -persistmempool=0
      # This node talks to nothing: no peers, no DNS, no onion service. Left on, the Tor control-port
      # retries cost startup time and, worse, filled the failure excerpt with "connect() to
      # 127.0.0.1:9051 failed" instead of the reason the node did not start.
      -noonion -listenonion=0 -dnsseed=0 -nodnsseed)
if [ "$MODE" = pool ]; then
  [ "$MAXMEMPOOL" -ge 5 ] || MAXMEMPOOL=5
  ARGS+=("-maxmempool=$MAXMEMPOOL")
fi
# Windows has no -daemon, so detach with Start-Process; elsewhere nohup is enough. A Windows
# binary needs cygpath as well, because it can only be handed C:\-style paths. Getting this wrong
# used to show up as 30 seconds of silence followed by an empty log, so say what is missing.
if [ "$WINDOWS" = 1 ]; then
  if ! command -v powershell.exe >/dev/null 2>&1 || ! command -v cygpath >/dev/null 2>&1; then
    envfail "$DAEMON is a Windows binary, and starting it needs powershell.exe and cygpath, which are
not on PATH. Run from Git Bash on Windows, or put native bitcoind and bitcoin-cli in $DIR/bin."
  fi
  LIST=$(printf "'%s'," "${ARGS[@]}"); LIST="${LIST%,}"
  # Start-Process reports a bad argument list on stderr and nothing in the log, so keep it in a
  # file rather than a $(...): the node it spawns inherits stdout, so capturing that would block
  # until the node exits. The file sits in the datadir, which stop_node removes.
  # -PassThru so its PID can be written down for the failure path below. That write happens after
  # Start-Process returns, so the node cannot inherit the handle and the read cannot block.
  NODE_PID=""
  powershell.exe -NoProfile -Command \
    "\$p = Start-Process -FilePath '$(winp "$DAEMON")' -ArgumentList $LIST -WindowStyle Hidden -PassThru -RedirectStandardError '$(winp "$LOG")'; \$p.Id | Out-File -Encoding ascii '$(winp "$NODE/start.pid")'" >/dev/null 2>"$NODE/start.err" ||
    envfail "Start-Process could not start the node: $(tr -d '\r' < "$NODE/start.err" | tr '\n' ' ')"
  if [ -s "$NODE/start.pid" ]; then NODE_PID=$(tr -d '\r\n' < "$NODE/start.pid"); fi
else
  nohup "$DAEMON" "${ARGS[@]}" >"$LOG" 2>&1 &
  NODE_PID=$!
fi
# A 20 second budget, because a count of probes is not a count of seconds: a port that accepts
# the connection and never answers costs the probe its whole 2s timeout, which turned a failed start
# into a 113s wait before it said so.
deadline=$((SECONDS + 20))
while [ "$SECONDS" -lt "$deadline" ] && ! running; do sleep 0.5; done
if ! running; then
  echo "FAIL: node did not start; last lines of its logs:" >&2
  node_log_tail
  # What is left behind here may be a live node: the trap can only stop it over RPC, which is the
  # thing that does not answer, and removing the datadir does not end the process either. That is
  # how a demo node once outlived its own failed start and kept 18543/18544 busy for later runs,
  # so kill the PID captured at launch and let the trap clean up the directory.
  if [ -n "$NODE_PID" ]; then
    if [ "$WINDOWS" = 1 ]; then
      taskkill //PID "$NODE_PID" //F >/dev/null 2>&1 || true
    else
      kill "$NODE_PID" 2>/dev/null || true
    fi
    sleep 1
  fi
  exit 2
fi

dbc createwallet demo >/dev/null
MINER=$(w getnewaddress)
# Coinbase outputs to one address are still separate UTXOs, and a regtest coinbase needs 101
# blocks behind it before it is spendable. Mine enough that every tx below has its own coin:
# COUNT + 3 in block mode (crowd, rich tx, CPFP parent), one per send in pool mode.
NEED=$((COUNT + 2))
if [ "$MODE" = pool ]; then NEED=$((MAXTX + 1)); fi
dbc generatetoaddress $((102 + NEED)) "$MINER" >/dev/null
COINS=$(dbc listunspent 1 | python -c 'import json,sys; print(len(json.load(sys.stdin)))' | tr -d '\r')
echo "height $(dbc getblockcount), $(w getbalance) BTC across $COINS spendable coinbases"
[ "$COINS" -ge "$NEED" ] || envfail "$COINS mature coinbases is not enough for $NEED txs"

# ---------------------------------------------------------------------------------------
# MODE=pool: scarcity in the pool rather than in the block.
# ---------------------------------------------------------------------------------------
if [ "$MODE" = pool ]; then
  say "2. fill a ${MAXMEMPOOL} MB mempool with ${OUTS}-output txs, cheapest first"
  # Pay addresses no loaded wallet watches: a wallet that owns these outputs records every one
  # of them, which made each send take ~8.5s instead of ~0.2s (measured). Only the descriptor is
  # needed afterwards, so the wallet goes straight back out.
  dbc createwallet burn >/dev/null
  DESC=$(dbc -rpcwallet=burn listdescriptors | python -c '
import json, sys
print([d["desc"] for d in json.load(sys.stdin)["descriptors"]
       if d["active"] and not d["internal"] and d["desc"].startswith("wpkh(")][0])
' | tr -d '\r')
  # sendmany builds, signs and broadcasts inside the node in one call: ~0.31s for a 93 kB tx,
  # against ~1.04s for createrawtransaction + signrawtransactionwithwallet +
  # sendrawtransaction, which is almost all per-call overhead rather than the 93 kB. Its fee_rate
  # is in sat/vB, so each bid below is the rate the tx actually pays.
  BASE="$DIR/.demo/pool-args.txt"
  SEND="$DIR/.demo/pool-send.txt"
  dbc deriveaddresses "$DESC" "[0,$((OUTS - 1))]" | python -c '
import json, sys
print("amounts=" + json.dumps({a: 0.0001 for a in json.load(sys.stdin)}))
print("minconf=0")
print("replaceable=true")
' > "$BASE"
  dbc unloadwallet burn >/dev/null

  BIDS="$DIR/.demo/pool-bids.txt"   # "txid bid", in send order, for the accounting below
  : > "$BIDS"
  SENT=0
  GONE=0
  for i in $(seq 1 "$MAXTX"); do
    { cat "$BASE"; printf 'fee_rate=%s\n' "$i"; } > "$SEND"
    TX=$(w -named -stdin sendmany < "$SEND" 2>&1 | tr -d '"\r')
    [ ${#TX} -eq 64 ] || envfail "the tx at $i sat/vB was not sent: $TX"
    printf '%s %s\n' "$TX" "$i" >> "$BIDS"
    SENT=$i
    if [ $((i % 8)) -eq 0 ]; then
      dbc getmempoolinfo | python -c '
import json, sys
d = json.load(sys.stdin)
print("  %s sent after %ss: pool %d txs, %.1f MB of %.0f MB"
      % (sys.argv[1], sys.argv[2], d["size"], d["usage"] / 1e6, d["maxmempool"] / 1e6))
' "$i" "$SECONDS"
    fi
    # stop once the pool has actually thrown something out
    if [ $((i % 4)) -eq 0 ]; then
      GONE=$(dbc getrawmempool | python -c '
import json, sys
live = set(json.load(sys.stdin))
print(sum(1 for t, _ in (l.split() for l in sys.argv[1].splitlines()) if t not in live))
' "$(cat "$BIDS")")
      if [ "$GONE" -ge 3 ]; then break; fi
    fi
  done
  [ "$GONE" -ge 3 ] || envfail "the pool took $SENT txs without evicting one, so it never filled"

  say "3. which ones survived"
  # verbose, so these rates are what the pool charged rather than what we asked for. Both lists
  # have entries: the line above failed the run otherwise.
  read -r SURVN RANGE EVICTED OK < <(dbc getrawmempool true | python -c '
import json, sys
pool = json.load(sys.stdin)
bids = dict((t, int(r)) for t, r in (l.split() for l in sys.argv[1].splitlines()))
kept = sorted(bids[t] for t in bids if t in pool)
dropped = sorted(bids[t] for t in bids if t not in pool)
off = max(abs(pool[t]["fees"]["base"] * 1e8 / pool[t]["vsize"] - bids[t]) for t in bids if t in pool)
print(len(kept), "%s..%s" % (kept[0], kept[-1]), ",".join(map(str, dropped)),
      "yes" if kept[0] >= dropped[-1] and off < 0.01 else "no")
' "$(cat "$BIDS")" | tr -d '\r')
  echo "$SURVN of $SENT txs are still there, paying $RANGE sat/vB (measured, and equal to the bid)"
  echo "evicted ($((SENT - SURVN))): $EVICTED sat/vB — dropped for being cheapest, not for being bad"
  [ "$OK" = yes ] || fail "the pool kept a cheaper tx than one it evicted, or charged other than the bid"
  echo "the pool is full, so what survives is exactly the top of the fee range"

  say "4. the pool now refuses the rate it just evicted"
  { cat "$BASE"; printf 'fee_rate=1\n'; } > "$SEND"
  # the wallet signs and keeps the tx even when the node will not take it, so ask the pool
  FRESH=$(w -named -stdin sendmany < "$SEND" 2>&1 | tr -d '"\r' | tail -1) || true
  [ ${#FRESH} -eq 64 ] || envfail "a 1 sat/vB tx could not even be built: $FRESH"
  dbc getmempoolentry "$FRESH" >/dev/null 2>&1 && fail "a fresh 1 sat/vB tx got into a full pool"
  FLOOR=$(dbc getmempoolinfo | python -c '
import json, sys
print("%.2f" % (json.load(sys.stdin)["mempoolminfee"] * 1e5))
' | tr -d '\r')
  echo "a fresh 1 sat/vB tx is refused; the pool now demands $FLOOR sat/vB"
  echo
  echo "block scarcity leaves a tx waiting; pool scarcity throws it away and then refuses it."
  main_check
  exit 0
fi

say "2. broadcast $COUNT txs at ${CROWD_RATE} sat/vB plus one at 200 sat/vB, and do not mine"
DEST=$(w getnewaddress)
TXIDS=()
for _ in $(seq 1 "$COUNT"); do
  TXIDS+=("$(w -named sendtoaddress address="$DEST" amount=0.001 fee_rate="$CROWD_RATE" replaceable=true | tr -d '"')")
done
RICH=$(w -named sendtoaddress address="$DEST" amount=0.001 fee_rate=200 replaceable=true | tr -d '"')

# They have to be peers: a tx chained behind another unconfirmed one could not be bumped alone,
# which would make the fee contest below meaningless.
read -r SIZE DEPS < <(dbc getrawmempool true | python -c '
import json, sys
mp = json.load(sys.stdin)
print(len(mp), sum(1 for e in mp.values() if e["depends"]))
' | tr -d '\r')
[ "$DEPS" -eq 0 ] || envfail "$DEPS txs depend on another unconfirmed tx"
[ "$SIZE" -eq $((COUNT + 1)) ] || envfail "expected $((COUNT + 1)) mempool txs, saw $SIZE"
echo "mempool: $SIZE txs, all unconfirmed, none spending another unconfirmed tx"
echo "a 300 MB pool would never reject these: the limit here is the block, not the pool"

say "3. what fits: block template under a ${BLOCKWEIGHT}-weight limit"
ORDER=$(dbc getblocktemplate '{"rules":["segwit"]}' | python -c 'import json,sys; print(" ".join(t["txid"] for t in json.load(sys.stdin)["transactions"]))')
# getblocktemplate reports the 4M consensus ceiling, never the -blockmaxweight we set, so the
# real limit comes from the shell rather than from the template.
dbc getrawmempool true | python -c '
import json, sys
mp = json.load(sys.stdin)
order = sys.argv[1].split()
rich, limit = sys.argv[2], sys.argv[3]
rows = [(t, mp[t]["vsize"], mp[t]["fees"]["base"] * 1e8) for t in order]
print("this node assembles at most %s weight per block (consensus allows 4000000)" % limit)
print("template: %d txs, from %d in the mempool" % (len(order), len(mp)))
print("%4s %7s %9s %8s  %s" % ("rank", "vsize", "fee sat", "sat/vB", "txid"))
for i, (t, vs, fee) in enumerate(rows):
    if 3 <= i < len(rows) - 2:
        if i == 3:
            print("   ...")
        continue
    print("%4d %7d %9.0f %8.2f  %s%s" % (i + 1, vs, fee, fee / vs, t[:16],
                                         "  <- the 200 sat/vB tx" if t == rich else ""))
rates = [fee / vs for _, vs, fee in rows]
print()
print("template order is exactly fee rate, descending" if rates == sorted(rates, reverse=True)
      else "WARNING: template order is not fee-rate descending")
print("%d txs were left out: valid, fee-paying, and outbid" % (len(mp) - len(order)))
' "$ORDER" "$RICH" "$BLOCKWEIGHT"

say "4. mine one block under the same limit: who actually confirmed?"
# Fee rate of everything waiting, captured before the block empties part of the mempool: the
# confirmed txs are gone from it afterwards, so their rates have to be noted in advance.
RATES=$(dbc getrawmempool true | python -c '
import json, sys
for t, e in json.load(sys.stdin).items():
    print("%s %.6f" % (t, e["fees"]["base"] * 1e8 / e["vsize"]))
')
w generatetoaddress 1 "$MINER" >/dev/null
read -r BH BW CONF WAIT LO HI CUT < <(dbc getblock "$(dbc getbestblockhash)" 1 | python -c '
import json, sys
d = json.load(sys.stdin)
intx = set(d["tx"])
rates = dict((l.split()[0], float(l.split()[1])) for l in sys.argv[1].splitlines() if l.strip())
ours = sys.argv[2:]
conf = [r for t, r in rates.items() if t in intx]
wait = [r for t, r in rates.items() if t not in intx]
lo, hi = (min(conf), max(wait)) if conf and wait else (0.0, 0.0)
print("%d %d %d %d %.2f %.2f %s" % (d["height"], d["weight"],
      sum(t in intx for t in ours), sum(t not in intx for t in ours), lo, hi,
      "yes" if conf and wait and lo >= hi else "no"))
' "$RATES" "${TXIDS[@]}" "$RICH" | tr -d '\r')
echo "block $BH: $BW weight, $CONF of $((COUNT + 1)) of our txs confirmed"
[ "$WAIT" -gt 0 ] || envfail "everything fit, so there is no scarcity to show; lower BLOCKWEIGHT"
[ "$CUT" = yes ] || fail "fee rate did not set the cutoff: cheapest confirmed $LO sat/vB, most expensive left out $HI sat/vB"
echo "cutoff: cheapest confirmed $LO sat/vB, most expensive still waiting $HI sat/vB"
echo "$WAIT still waiting: same rule for everyone, they just bid less"

say "5. RBF: bump one of the stuck txs to 50 sat/vB"
# one call for the whole mempool beats probing each txid in turn
STUCK=$(dbc getrawmempool | python -c '
import json, sys
waiting = set(json.load(sys.stdin))
print(next((t for t in sys.argv[1:] if t in waiting), ""))
' "${TXIDS[@]}" | tr -d '\r')
[ -n "$STUCK" ] || envfail "nothing was left out, so there is no bump to show"
read -r _ SVS SRATE < <(dbc getmempoolentry "$STUCK" | mentry)
echo "stuck tx pays $SRATE sat/vB over $SVS vB"
BEFORE=$(dbc getrawtransaction "$STUCK" 1 | vin)
BUMP=$(w -named bumpfee txid="$STUCK" fee_rate=50)
NEW=$(echo "$BUMP" | jget txid)
AFTER=$(dbc getrawtransaction "$NEW" 1 | vin)
[ "$BEFORE" = "$AFTER" ] || fail "replacement spends different coins, so it is not a replacement"
if dbc getmempoolentry "$STUCK" >/dev/null 2>&1; then fail "original is still in the mempool"; fi
# The ask was 50 sat/vB and bumpfee rounds up, so this is a floor rather than an equality.
read -r _ NVS NRATE < <(dbc getmempoolentry "$NEW" | mentry)
[ "${NRATE%%.*}" -ge 50 ] || fail "the bump bought $NRATE sat/vB, not the 50 asked for"
echo "replacement spends the same coins ($BEFORE) at $NRATE sat/vB; the original is out of the mempool"
w generatetoaddress 1 "$MINER" >/dev/null
# Ask the block, not the wallet: the wallet drops its record of a replaced tx.
read -r NEW_IN OLD_IN < <(dbc getblock "$(dbc getbestblockhash)" 1 | inblock "$NEW" "$STUCK")
NCONF=$(w gettransaction "$NEW" | jget confirmations)
[ "$NCONF" = 1 ] || fail "the replacement has $NCONF confirmations one block later, expected 1"
echo "after one more block: replacement confirmations $NCONF, $(dbc getmempoolinfo | jget size) txs still queued"
[ "$NEW_IN" = yes ] || fail "the replacement did not make it into the block"
[ "$OLD_IN" = no ] || fail "the replaced tx made it into the block"
echo "that block holds the replacement and not the original, which never confirmed"

say "6. CPFP: a 1 sat/vB parent that cannot get in, and a child that pays for both"
PADDR=$(w getnewaddress)
PARENT=$(w -named sendtoaddress address="$PADDR" amount=0.05 fee_rate=1 | tr -d '"')
# 1 sat/vB against a crowd paying more: this tx loses every block on its own
read -r PVOUT PVAL < <(w listunspent 0 9999999 "[\"$PADDR\"]" | python -c '
import json, sys
u = json.load(sys.stdin)[0]
print(u["vout"], int(round(u["amount"] * 1e8)))
' | tr -d '\r')
read -r PFEE PVS PRATE < <(dbc getmempoolentry "$PARENT" | mentry)
echo "parent pays $PRATE sat/vB over $PVS vB and waits"
w generatetoaddress 1 "$MINER" >/dev/null
read -r P_IN < <(dbc getblock "$(dbc getbestblockhash)" 1 | inblock "$PARENT")
[ "$P_IN" = no ] || envfail "the parent got in alone, so there is no CPFP to show"
echo "mined a block anyway: parent still unconfirmed, $(dbc getmempoolinfo | jget size) txs in the mempool"

# The child spends the parent's output and has no change, so everything not sent is its fee.
CFEE=$(( PKG_RATE * (PVS + CHILD_VSIZE) - PFEE ))
CAMT=$(python -c 'import sys; v = int(sys.argv[1]); print("%d.%08d" % (v // 100000000, v % 100000000))' "$((PVAL - CFEE))")
CADDR=$(w getnewaddress)
RAW=$(dbc createrawtransaction "$(printf '[{"txid":"%s","vout":%d}]' "$PARENT" "$PVOUT")" "$(printf '[{"%s":"%s"}]' "$CADDR" "$CAMT")")
CHILD=$(dbc sendrawtransaction "$(w signrawtransactionwithwallet "$RAW" | jget hex)" | tr -d '"')
read -r CFEE CVS CRATE < <(dbc getmempoolentry "$CHILD" | mentry)
PKGVS=$((PVS + CVS))
# Measured from the mempool, not from the arithmetic above: this is the child's real fee.
PKGRATE=$(satrate $((PFEE + CFEE)) "$PKGVS")
[ "${PKGRATE%%.*}" -ge "$PKG_RATE" ] ||
  fail "the package pays $PKGRATE over $PKGVS vB, short of the $PKG_RATE sat/vB it was sized for"
echo "child spends that output and pays $CRATE sat/vB over $CVS vB on its own"
echo "before mining: package of two pays $PKGRATE over $PKGVS vB"
w generatetoaddress 1 "$MINER" >/dev/null
read -r PAR_IN CHI_IN < <(dbc getblock "$(dbc getbestblockhash)" 1 | inblock "$PARENT" "$CHILD")
[ "$PAR_IN" = yes ] || fail "the parent did not confirm with the child"
[ "$CHI_IN" = yes ] || fail "the child did not confirm"
# the same package, measured this time from what the wallet says it paid
PFEE2=$(w gettransaction "$PARENT" | fee_sats)
CFEE2=$(w gettransaction "$CHILD" | fee_sats)
PKGRATE2=$(satrate $((PFEE2 + CFEE2)) "$PKGVS")
# The wallet's own fee records must agree with the mempool's, or one of the two is lying.
[ "${PKGRATE2%%.*}" -ge "$PKG_RATE" ] ||
  fail "the wallet's fees make the package $PKGRATE2, not the $PKG_RATE sat/vB it was sized for"
echo "after mining: both in block $(dbc getblockcount), package pays $PKGRATE2 over $PKGVS vB"

say "7. what this shows"
echo "RBF replaces a tx with the same coins at a higher fee; CPFP pays for a parent through a"
echo "child, so the pair is mined even though the parent alone was priced out."
main_check
