#!/usr/bin/env bash
# Wipe the chain, start clean, create a wallet, mine 101 blocks, print what is spendable.
#
# It erases data/, and on this chain that is not a replaceable thing: regtest has no peers, so
# block 112 and the rune etch inside it exist nowhere else. A habit is exactly the wrong way to
# reach that, so a run over an existing chain asks for the word `wipe` on stdin, then takes a
# chain.sh snapshot and refuses to go on unless that snapshot verifies. With no data/ there is
# nothing to lose, so a first run asks nothing and takes no snapshot. Non-interactive:
# `echo wipe | ./rehearse.sh` — any other word, or end of input, refuses.
#
# Exit codes, as everywhere else here: 0 rehearsed, 1 the snapshot before the erase did not verify
# (nothing was removed), 2 refused or could not run (no `wipe`, node will not start).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$DIR/data"
PRE_SNAP=""       # the snapshot taken before the erase: the way back, named in every early exit
ERASED=0          # 1 once data/ is gone, so the report says whether there is a chain to go back to
FINISHED=0

# The same lock chain.sh takes: this run stops the node, erases data/ and calls chain.sh snapshot,
# and any of those interleaved with a restore or another rehearsal is a datadir moved from under a
# running tar. chain.sh skips taking it again for the calls this script makes.
LOCK="$DIR/.lock"
lock_release() {
  [ -d "$LOCK" ] || return 0
  [ "$(sed -n '1s/ .*//p' "$LOCK/owner" 2>/dev/null)" = "$$" ] || return 0
  rm -rf "$LOCK" 2>/dev/null || true
}
# The same one-line record chain.sh keeps: a chain that comes back shorter should say why.
journal() {   # verb, old height, new height, what it used
  printf '%s %s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:--}" "${3:--}" "${4:--}" \
    >>"$DIR/.history" 2>/dev/null ||
    echo "  ($DIR/.history would not take the line, so this run is not recorded)" >&2
}

lock_acquire() {
  local pid overb
  [ "${REGTEST_LOCK_HELD:-}" = 1 ] && return 0
  if ! mkdir "$LOCK" 2>/dev/null; then
    pid=""; overb=""
    read -r pid overb <"$LOCK/owner" 2>/dev/null || true
    if [ -z "$pid" ]; then sleep 0.3; read -r pid overb <"$LOCK/owner" 2>/dev/null || true; fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "FAIL: $overb is running in this folder right now (pid $pid)." >&2
      echo "      It is using this folder's node, data/ and ord index, so a rehearsal will not start." >&2
      echo "      Wait for it to finish, or look at it: ps -p $pid" >&2
      exit 2
    fi
    echo "taking over a lock left by ${overb:-an earlier run} (pid ${pid:-unknown}), which is gone"
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { echo "FAIL: another run took $LOCK at the same moment" >&2; exit 2; }
  fi
  printf '%s %s\n' "$$" "rehearse" >"$LOCK/owner"
  export REGTEST_LOCK_HELD=1     # the chain.sh calls below run inside this lock, not against it
}

# An interrupt lands between "removing $DATA" and the first mined block, and that is the one moment
# this script can end with no chain at all. Whatever the reason, say which snapshot holds the chain
# that was erased and the exact command that puts it back.
rehearse_exit() {
  local rc=${1-$?}
  trap - EXIT INT TERM
  lock_release
  if [ -n "$PRE_SNAP" ] && [ "$FINISHED" != 1 ]; then
    if [ "$ERASED" = 1 ]; then
      printf '\nthe rehearsal stopped after erasing data/ (exit %s).\n' "$rc" >&2
      printf 'The chain it erased is in %s\n' "$PRE_SNAP" >&2
      printf 'To put it back:\n  cd "%s" && ./chain.sh restore .snapshot/%s\n' \
        "$DIR" "$(basename "$PRE_SNAP")" >&2
    else
      printf '\nthe rehearsal stopped before erasing anything (exit %s), so data/ is as it was.\n' \
        "$rc" >&2
      printf 'The snapshot it took first is %s\n' "$PRE_SNAP" >&2
    fi
  fi
  exit "$rc"
}
trap rehearse_exit EXIT
trap 'rehearse_exit 130' INT
trap 'rehearse_exit 143' TERM
lock_acquire
CONF="$DIR/bitcoin.conf"
CLI="$DIR/bin/bitcoin-cli.exe"
WALLET="rehearse"
LAST_SEEN="$DIR/.last-seen"
ORD_DATA="$DIR/ord-data"
ORD_URL="http://127.0.0.1:8080/blockcount"   # the ord server's count of blocks, not heights
ORD_WAS_UP=0                                 # so the server is put back only if it was put down

rpc() { "$CLI" -datadir="$DATA" -conf="$CONF" "$@"; }
wallet_rpc() { "$CLI" -datadir="$DATA" -conf="$CONF" -rpcwallet="$WALLET" "$@"; }

# A full disk here is worse than anywhere else: the snapshot taken below is the only copy of the
# chain about to be erased, and the rebuild needs room of its own on top of it.
# `|| true` because pipefail would otherwise abort on a failing df, and on a first run du fails
# against a data/ that does not exist yet — the cases the checks below are here to describe.
FREE_KB=$(df -Pk "$DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)
SIZE_KB=$(du -sk "$DATA" 2>/dev/null | awk '{print $1}' || true)
[ -n "$SIZE_KB" ] || SIZE_KB=0
NEED_KB=$(( SIZE_KB * 2 + 65536 ))   # the snapshot, plus a chain mined in its place
if [ -z "$FREE_KB" ]; then
  echo "FAIL: df cannot say how much room $DIR has, so a rehearsal will not start." >&2
  echo "      Nothing was removed." >&2
  exit 2
fi
if [ "$FREE_KB" -lt "$NEED_KB" ]; then
  echo "FAIL: a rehearsal needs about $((NEED_KB / 1024)) MB free — a snapshot of data/ and a chain" >&2
  echo "      mined in its place — and $DIR has $((FREE_KB / 1024)) MB. Nothing was removed." >&2
  exit 2
fi

if [ -d "$DATA" ]; then
  echo "about to erase $DATA: its chain, its wallets, and the rune etch in block 112,"
  echo "which no peer can resend. A snapshot is taken and kept first."
  printf 'type wipe to go ahead: '
  ANSWER=""
  read -r ANSWER || true      # end of input leaves it empty, which refuses like any other word
  if [ "$ANSWER" != "wipe" ]; then
    echo
    echo "refusing: nothing was removed" >&2
    exit 2
  fi

  # A snapshot needs a running node, and start.sh is idempotent, so this also covers a chain that is
  # stopped. Its output is only shown when it fails: that is the one failure chain.sh cannot name,
  # because it would report the node as absent and tell you to run the script that just failed.
  echo
  echo "== snapshot the chain before erasing it"
  if ! out=$("$DIR/start.sh" 2>&1); then
    printf '%s\n' "$out" >&2
    echo "FAIL: ./start.sh could not start the node, so there is no chain to snapshot." >&2
    echo "      Nothing was removed: $DATA is as it was." >&2
    exit 2
  fi
  # The name keeps the timestamp first, so chain.sh's newest() still orders snapshots by name.
  SNAP="$(date -u +%Y%m%dT%H%M%SZ)-pre-rehearse"
  "$DIR/chain.sh" snapshot "$SNAP" || {
    rc=$?
    if [ "$rc" = 1 ]; then
      echo "FAIL: the snapshot before the erase did not verify, so it was not safe to go on." >&2
    else
      echo "FAIL: the snapshot before the erase could not be taken (chain.sh exited $rc)." >&2
    fi
    echo "      Nothing was removed: $DATA is as it was." >&2
    exit "$rc"
  }
  PRE_SNAP="$DIR/.snapshot/$SNAP"
  echo

  # A snapshot proves the archive holds the right directories, not that it restores. The erase is the
  # one moment where that difference costs the chain, and verify is the only thing that closes it, so
  # it runs here — inside the same lock, on the copy this run is about to depend on.
  echo "== prove that snapshot restores, before anything is erased"
  VLOG="$DIR/.rehearse-verify.log"
  VRC=0
  "$DIR/chain.sh" verify "$PRE_SNAP" >"$VLOG" 2>&1 || VRC=$?
  if [ "$VRC" -ne 0 ]; then
    tail -6 "$VLOG" >&2 || true
    rm -f "$VLOG"
    echo "FAIL: the snapshot taken before the erase does not prove it restores, so nothing was removed." >&2
    echo "      data/ is as it was; the copy that could not be proved is $PRE_SNAP" >&2
    exit 2
  fi
  rm -f "$VLOG"
  echo "   it restores: the archive unpacks and comes back at the state it recorded"
  echo
fi

# The ord index was built over the chain about to be erased, and its server holds that file open.
# Both go first: an index left pointing at blocks this node no longer has is exactly what status.sh
# reports as blocks ahead of the chain, and nothing done to the chain after makes that true again.
# curl is what says whether the server is up, and ord-server.sh and status.sh ask it the same way.
if [ -d "$ORD_DATA" ]; then
  command -v curl >/dev/null 2>&1 || {
    echo "FAIL: curl is not on PATH, so whether the ord server holds its index cannot be checked." >&2
    echo "      Nothing was removed: $DATA is as it was." >&2
    exit 2
  }
  if curl -s -m 2 "$ORD_URL" >/dev/null 2>&1; then
    "$DIR/ord-server.sh" stop >/dev/null || {
      echo "FAIL: the ord server answers but would not stop, so its index is still open." >&2
      echo "      Nothing was removed: $DATA is as it was." >&2
      exit 2
    }
    ORD_WAS_UP=1
    echo "stopped the ord server; its index is rebuilt below"
  fi
fi

# The height it is leaving, before the node is stopped and the chain is gone.
OLD_H=""
if rpc getblockcount >/dev/null 2>&1; then OLD_H=$(rpc getblockcount | tr -d '\r'); fi

# Stop first: bitcoind holds a lock on the datadir.
"$DIR/stop.sh" >/dev/null 2>&1 || true

# $DATA is fixed relative to this script, so this can never touch another directory.
if [ -d "$DATA" ]; then
  echo "removing $DATA"
  ERASED=1
  rm -rf "$DATA"
fi

# The tip status.sh remembers describes the chain just erased, so it goes with the chain: left there
# every rehearsed reset would report a rewind until you deleted it by hand.
if [ -f "$LAST_SEEN" ]; then
  echo "clearing $(basename "$LAST_SEEN"): it remembered the tip of the chain just erased"
fi
rm -f "$LAST_SEEN"

"$DIR/start.sh" >/dev/null

rpc createwallet "$WALLET" >/dev/null

ADDR="$(wallet_rpc getnewaddress mining | tr -d '\r')"
wallet_rpc generatetoaddress 101 "$ADDR" >/dev/null

BLOCKS="$(rpc getblockcount | tr -d '\r')"
BALANCE="$(wallet_rpc getbalance | tr -d '\r')"
journal rehearse "${OLD_H:--}" "$BLOCKS" "${PRE_SNAP:+snapshot $(basename "$PRE_SNAP")}"

# The index is derived from the chain, so a reset means rebuilding it: it was built over the chain
# that was just erased, and status.sh would otherwise report it as blocks ahead of this one. Only
# the index goes — ord-data/regtest/wallets/*.redb, where the rune balance lives, is not touched.
if [ -f "$ORD_DATA/regtest/index.redb" ]; then
  echo
  echo "== rebuild the ord index over this chain"
  rm -f "$ORD_DATA/regtest/index.redb"
  if [ "$ORD_WAS_UP" != 1 ]; then
    # It was stopped before the wipe and is left stopped: this run put nothing back it did not put
    # down. The empty index is a note in status.sh, not a failure: it says to run ./ord-server.sh.
    echo "   the ord server was not running, so its index is left empty; ./regtest/ord-server.sh"
  elif ! "$DIR/ord-server.sh" >/dev/null; then
    echo "FAIL: the ord server did not start, so the index stays empty until it does:" >&2
    echo "      ./regtest/ord-server.sh   (it indexes from genesis, seconds at this size)" >&2
  else
    # No waiting here. A fresh index is behind the chain by construction, and status.sh reports an
    # index that is behind as a note ("it catches up itself"); only an *ahead* one is a failure,
    # which deleting it has already ruled out.
    echo "   ord server restarted; it indexes this chain from genesis"
  fi
fi

echo
echo "chain     : regtest, block $BLOCKS"
echo "wallet    : $WALLET (loaded)"
echo "mining to : $ADDR"
echo "spendable : $BALANCE BTC"
echo
echo "next      : ./regtest/btc -rpcwallet=$WALLET sendtoaddress \$(./regtest/btc -rpcwallet=$WALLET getnewaddress) 1"
FINISHED=1
