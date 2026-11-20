#!/usr/bin/env bash
# Snapshot and restore the main regtest chain in data/.
#
# Regtest has no peers, so a block mined here and then lost — a hard stop before it reached the disk
# is enough — cannot be fetched from anyone. The chain directory is the only copy there is, and
# that is not a tidiness argument: the rune etch at 112:1 lives in block 112, and no resync brings
# it back. So this tars data/ with the node stopped, which is the only way blocks/, chainstate/ and
# the wallets inside it are consistent with each other, and copies every loaded wallet out of it
# with backupwallet.
#
#   ./chain.sh snapshot           # .snapshot/<UTC stamp>/ ; the node is running again afterwards
#   ./chain.sh restore [dir]      # newest snapshot, or the one named; node running again afterwards
#   ./chain.sh bundle <path>      # one checksummed file outside this folder, verified after writing
#
# Restore replaces data/ wholesale, but renames the directory it replaces to
# data.before-restore-<UTC stamp> first and never overwrites one of those, so every restore keeps
# its own way back rather than deleting the previous one. Rolling the chain backwards (or putting
# another branch's tip in place) asks for the word `rollback` on stdin first, since the reason to
# restore is usually damage while the usual mistake is picking a snapshot older than the chain.
#
# Exit codes, as everywhere else in this folder: 0 worked and verified, 1 what it wrote or restored
# did not verify, 2 it could not run (no node to snapshot, node will not stop, bad arguments).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$DIR/data"
CONF="$DIR/bitcoin.conf"
SNAPS="$DIR/.snapshot"
RUNE_HEIGHT=112          # the block whose second tx is the rune etch on this chain
ORD_URL="http://127.0.0.1:8080"   # where ord-server.sh serves this folder's index

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
envfail() { echo "FAIL: $*" >&2; exit 2; }
winp() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }   # the *node* reads this path, not us

# A full disk is the one failure nothing here can repair: tar stops half-way and leaves an archive
# that still hashes as itself, and a restore with nowhere to unpack has no chain to put back. So the
# room is asked for before the first write, in the units df reports.
free_kb() { df -Pk "$DIR" 2>/dev/null | awk 'NR==2 {print $4}'; }
dir_kb() { du -sk "$1" 2>/dev/null | awk 'NR==1 {print $1}'; }

# A kept datadir is a directory, not an archive, so a checksum over it has to be one value that
# depends on every file in it. Each file is reduced to "sha256  path", the lines are sorted, and that
# text is hashed: the result changes if a byte changes, if a file appears, or if one is removed.
# MANIFEST.txt and the .verified marker are left out, because both are written by this script after
# the value is taken, and including them would make every check disagree with itself.
tree_list() {   # sha256 and path of every file, sorted; the input to tree_hash and its first reading
  ( cd "$1" || return 1
    find . -type f ! -name 'MANIFEST.txt' ! -name '.verified' -print0 2>/dev/null |
      sort -z | while IFS= read -r -d '' f; do
        printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "${f#./}"
      done )
}
tree_hash() { tree_list "$1" | sha256sum | cut -d' ' -f1; }
tree_files() { tree_list "$1" | wc -l | tr -d ' '; }
tree_bytes() {
  ( cd "$1" || return 1
    find . -type f ! -name 'MANIFEST.txt' ! -name '.verified' -printf '%s\n' 2>/dev/null |
      awk '{s += $1} END {printf "%d", s}' )
}

# One appended line per run that replaced or removed something. A chain that comes back shorter
# should have a recorded reason beside it rather than a bare different number, and this file is the
# sequence of those reasons: never rewritten, only added to.
HIST="$DIR/.history"
journal() {   # verb, old height, new height, what it used or removed
  printf '%s %s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:--}" "${3:--}" "${4:--}" \
    >>"$HIST" 2>/dev/null ||
    echo "  ($HIST would not take the line, so this run is not recorded)" >&2
}

human_kb() {    # KB -> "820 KB" or "18.0 MB", so a listing never rounds a small copy to nothing
  local kb=$1
  if [ "$kb" -lt 1024 ]; then printf '%s KB' "$kb"
  else printf '%s.%s MB' "$((kb / 1024))" "$(( (kb % 1024) * 10 / 1024 ))"
  fi
}

need_space() {   # KB needed, verb, what the room is for
  local need=$1 verb=$2 what=$3 free
  free=$(free_kb) || true
  [ -n "$free" ] ||
    envfail "$verb needs about $((need / 1024)) MB for $what, and df cannot say how much room $DIR has"
  [ "$free" -ge "$need" ] ||
    envfail "$verb needs about $((need / 1024)) MB for $what and $DIR has $((free / 1024)) MB free"
}

# snapshot, restore and verify stop or move the same node and the same data/, and two of them at
# once is how a datadir gets tarred while it is being swapped. One lock, taken by mkdir because that
# is atomic everywhere here, holding the pid and the verb so a refusal can say what is in the way.
LOCK="$DIR/.lock"

lock_release() {
  # Only the owner deletes it: a lock taken over by a newer run must not be removed by an older one
  # on its way out.
  [ -d "$LOCK" ] || return 0
  [ "$(sed -n '1s/ .*//p' "$LOCK/owner" 2>/dev/null)" = "$$" ] || return 0
  rm -rf "$LOCK" 2>/dev/null || true
}

cleanup() {
  local rc=${1-$?}
  trap - EXIT INT TERM HUP
  lock_release
  exit "$rc"
}

lock_acquire() {
  local verb=$1 pid overb
  # rehearse holds the lock for its whole run and calls this script inside it.
  [ "${REGTEST_LOCK_HELD:-}" = 1 ] && return 0
  if ! mkdir "$LOCK" 2>/dev/null; then
    pid=""; overb=""
    read -r pid overb <"$LOCK/owner" 2>/dev/null || true
    # The winner may have made the directory and not yet written its line.
    if [ -z "$pid" ]; then sleep 0.3; read -r pid overb <"$LOCK/owner" 2>/dev/null || true; fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "FAIL: $overb is running in this folder right now (pid $pid)." >&2
      echo "      It is using this folder's node, data/ and ord index, so $verb will not start on top." >&2
      echo "      Wait for it to finish, or look at it: ps -p $pid" >&2
      exit 2
    fi
    echo "taking over a lock left by ${overb:-an earlier run} (pid ${pid:-unknown}), which is gone"
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { echo "FAIL: another run took $LOCK at the same moment" >&2; exit 2; }
  fi
  printf '%s %s\n' "$$" "$verb" >"$LOCK/owner"
  # Every way out releases it, including an interrupt: a lock that outlives its run refuses the next
  # one for no reason.
  trap cleanup EXIT
  trap 'cleanup 130' INT
  trap 'cleanup 143' TERM
  trap 'cleanup 129' HUP
}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) CLI="$DIR/bin/bitcoin-cli.exe" ;;
  *)                    CLI="$DIR/bin/bitcoin-cli" ;;
esac
[ -x "$CLI" ] || envfail "no bitcoin-cli for $(uname -s) in $DIR/bin"
command -v sha256sum >/dev/null 2>&1 || envfail "sha256sum is not on PATH, so an archive could not be checked"

# -datadir/-conf are overridable so that verify() can ask the same questions of a scratch copy of
# the chain as the rest of this script asks of the real one; unset means the real one.
cli() { "$CLI" -rpcclienttimeout=10 -datadir="${CLI_DATA:-$DATA}" -conf="${CLI_CONF:-$CONF}" "$@"; }
up() { cli getblockchaininfo >/dev/null 2>&1; }
ord_up() { curl -s -m 2 "$ORD_URL/blockcount" >/dev/null 2>&1; }
wallets() { cli listwallets | tr -d '[]",\r\n' | tr -s ' ' | sed 's/^ //'; }

# Everything a restore has to prove, as lines that can be compared with ==: where the chain ends,
# which wallets were loaded, and the rune's block. One line of block 112 says whether the etch
# survived; "none" is what a chain without it (or younger than it) prints.
#
# Balances are deliberately not in here. They are not a property of the chain: after mining, the
# wallet settles its own balance asynchronously, so the same height and tip came back reading
# 600.00000000 where they had read 550 — and comparing that turned a good snapshot into a failure.
# Which wallets are loaded *is* deterministic, so the names are compared and the amounts are only
# printed.
state() {
  cli getblockcount | tr -d '\r' | sed 's/^/height /'
  cli getbestblockhash | tr -d '\r' | sed 's/^/tip /'
  printf 'loaded %s\n' "$(wallets)"
  if [ "$(cli getblockcount)" -ge "$RUNE_HEIGHT" ]; then
    local bh
    bh=$(cli getblockhash "$RUNE_HEIGHT" | tr -d '\r')
    printf 'rune-block %s\n' "$bh"
    printf 'rune-tx %s\n' "$(cli getblock "$bh" 1 | python -c '
import json, sys

txs = json.load(sys.stdin)["tx"]
print(txs[1] if len(txs) > 1 else "none")
' | tr -d '\r')"
  else
    printf 'rune-block none\nrune-tx none\n'
  fi
}

# A snapshot is only usable if its state.txt still describes what came back, but that file's format
# changed: older snapshots wrote one `wallet NAME amount` line per wallet where this one writes a
# single `loaded a b`. Comparing the text would fail such a snapshot after restoring its data
# correctly, so compare the fields both formats carry — height, tip, the rune's block and tx, and
# which wallets are loaded — and read an old wallet line as its name, never its amount (that is not
# a property of the chain anyway, see state()). One name per line, sorted, so order cannot matter.
norm_state() {
  awk '
    /^height / || /^tip / || /^rune-block / || /^rune-tx / { print; next }
    /^loaded / { n = split(substr($0, 8), a, " ")
                 for (i = 1; i <= n; i++) if (a[i] != "") print "loaded " a[i]; next }
    /^wallet / { print "loaded " $2 }
  ' | sort
}

# The block count the index on disk holds, read with this folder's own RPC port and its own cookie.
# Not through the ./ord wrapper, which passes no --bitcoin-rpc-url: ord would fall back to regtest's
# 18443, and in a copy of this folder that is the original's node, whose cookie this copy does not
# have. A 401 there reads as "the index would not say", which restore acts on by resetting an index
# that was fine. $1 is how long to wait: a corrupt index makes `index info` hang rather than fail,
# and a read that never returns says nothing about what is in the file. Leaves the count in
# ORD_BLOCKS_DISK (empty when it could not be read) and ord's first line of complaint in ORD_WHY.
ord_index_blocks() {
  local oexe ord_port oerr
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) oexe="$DIR/bin/ord.exe" ;;
    *)                    oexe="$DIR/bin/ord" ;;
  esac
  ord_port=$(sed -n 's/^rpcport=//p' "$DIR/bitcoin.conf" | head -n 1)
  oerr=$(mktemp)
  ORD_BLOCKS_DISK=$(timeout "${1:-120}" "$oexe" --chain regtest \
    --bitcoin-rpc-url "http://127.0.0.1:${ord_port:-18443}" \
    --bitcoin-data-dir "$(winp "$DIR/data")" --data-dir "$(winp "$DIR/ord-data")" \
    index info 2>"$oerr" | grep -o '"blocks_indexed": [0-9]*' | grep -o '[0-9]*$') || true
  ORD_WHY=$(tr -d '\r' <"$oerr" 2>/dev/null | head -n 1 || true)
  rm -f "$oerr"
  case ${ORD_BLOCKS_DISK:-} in ''|*[!0-9]*) ORD_BLOCKS_DISK="" ;; esac
}

# The height ord's index stands at, read without stopping anything: from the running server if it
# answers, and otherwise from the index itself (ord_index_blocks). Both readings happen while the
# node is up, because ord needs its cookie; afterwards the index is tarred as it stands, so this is
# the height the archive holds. `snapshot` and `bundle` both use it, since a half a week behind the
# chain restores fine and looks fine until something says how far apart the two halves were. Leaves
# the block count in ORD_BLOCKS (empty when it could not be read), how it was read in ORD_HOW, and 1
# in ORD_FROM_SERVER when the server answered. A caller that declares those three local gets its
# own; bash reads them from the nearest scope.
read_ord_blocks() {
  ORD_BLOCKS=""
  ORD_HOW=""
  ORD_FROM_SERVER=0
  if ord_up; then
    ORD_FROM_SERVER=1
    ORD_BLOCKS=$(curl -s -m 5 "$ORD_URL/blockcount" | tr -d '\r')
    ORD_HOW="read from the running server"
    case ${ORD_BLOCKS:-} in
      ''|*[!0-9]*) ORD_BLOCKS=""; ORD_HOW="not read: the server answered, without a block count" ;;
    esac
  else
    ord_index_blocks 120
    ORD_BLOCKS=$ORD_BLOCKS_DISK
    if [ -n "$ORD_BLOCKS" ]; then
      ORD_HOW="read from ord-data itself, with this folder's RPC port"
    else
      ORD_HOW="not read: ord said ${ORD_WHY:-nothing}"
    fi
  fi
}

# ord counts blocks, not heights: a tip at height 115 is 116 blocks, and both /blockcount and
# index info say 116. Subtracting once is what lets the index be compared with the chain at all.
# Sets ORD_HT to that height (or "unknown") and ORD_GAP to how it stands against chain height $1:
# "the same height as the chain" when they agree, a sentence naming the distance when they do not,
# and empty only when the index could not be read at all.
ord_height_vs() {
  local chain_h=${1:-}
  ORD_HT="unknown"
  ORD_GAP=""
  [ -n "${ORD_BLOCKS:-}" ] || return 0
  ORD_HT=$((ORD_BLOCKS > 0 ? ORD_BLOCKS - 1 : 0))
  case ${chain_h:-} in
    ''|*[!0-9]*)
      ORD_GAP="the chain height is unknown, so there is nothing to compare it with" ;;
    *)
      if [ "$ORD_HT" -eq "$chain_h" ]; then
        ORD_GAP="the same height as the chain"
      elif [ "$ORD_HT" -lt "$chain_h" ]; then
        ORD_GAP="$((chain_h - ORD_HT)) block(s) behind the chain, so the two halves are"\
" not of one moment"
      else
        ORD_GAP="$((ORD_HT - chain_h)) block(s) ahead of the chain"
      fi ;;
  esac
}

# Stop through stop.sh, the one place that knows how, then insist that it really stopped: RPC
# silent *and* the pid file gone, which the node removes itself only on a clean exit. A datadir
# still being written to is exactly what a tar must not capture.
stop_node() {
  if ! up; then echo "  the node was not running"; return 0; fi
  local out
  out=$("$DIR/stop.sh" 2>&1) || { printf '%s\n' "$out" >&2; envfail "stop.sh could not stop the node"; }
  local _
  for _ in $(seq 1 60); do
    if ! up && [ ! -f "$DATA/regtest/bitcoind.pid" ]; then echo "  stopped cleanly"; return 0; fi
    sleep 0.5
  done
  up && envfail "the node still answers after stop, so its datadir is still in use"
  envfail "the node went down without cleaning up: $DATA/regtest/bitcoind.pid is still there, so data/ may be mid-write"
}

start_node() {
  local out
  out=$("$DIR/start.sh" 2>&1) || { printf '%s\n' "$out" >&2; envfail "start.sh could not start the node; see data/regtest/debug.log"; }
  echo "  started, $(printf '%s' "$out" | head -1)"
}

# Every loaded wallet as a .dat that restorewallet can load, plus its descriptors: the .dat is what
# a restore uses, and the descriptors are the only form in which the keys can be read back by eye
# if the .dat is the thing that got damaged. v32 has no dumpwallet, which is why this is
# listdescriptors.
backup_wallets() {
  local out=$1 w
  for w in $(wallets); do
    cli -rpcwallet="$w" backupwallet "$(winp "$out/$w.dat")" >/dev/null || envfail "backupwallet failed for $w"
    cli -rpcwallet="$w" listdescriptors true >"$out/$w.descriptors.json" ||
      envfail "listdescriptors failed for $w"
    printf '  %s: %s bytes\n' "$w" "$(wc -c <"$out/$w.dat" | tr -d ' ')"
  done
  chmod 600 "$out"/* 2>/dev/null || true   # keys, worthless coins or not; NTFS ignores modes
}

snapshot() {
  local name=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
  lock_acquire snapshot
  local snap="$SNAPS/$name"
  up || envfail "the main node is not answering; ./start.sh first, or there is no state to stop cleanly"
  [ ! -e "$snap" ] || envfail "$snap already exists; give this one another name"
  # The tar lands in its final directory, so a half-written archive is not distinguishable from a
  # whole one afterwards. Ask first: the archive is either complete or never started.
  local size
  # `|| true` on each of these: with pipefail, a failing du/gzip/tar inside a substitution would
  # abort the script with its status and no message, which is exactly what these checks exist to say.
  size=$(dir_kb "$DATA" || true)
  [ -n "$size" ] || envfail "the size of $DATA cannot be read, so whether the archive fits cannot be known"
  local osize
  osize=$(dir_kb "$DIR/ord-data" 2>/dev/null || true)
  [ -n "$osize" ] || osize=0
  need_space $(( size + osize + (size + osize) / 10 + 4096 )) snapshot "the archives of data/ and ord-data/"
  mkdir -p "$snap/wallets"

  say "1. write down the state this snapshot is of"
  state >"$snap/state.txt" || envfail "the node stopped answering while its state was read"
  sed 's/^/  /' "$snap/state.txt"
  local w
  for w in $(wallets); do
    printf '       %s holds %s BTC (not compared: the wallet settles this on its own schedule)\n' \
      "$w" "$(cli -rpcwallet="$w" getbalance | tr -d '\r')"
  done

  say "2. copy every loaded wallet out of data/"
  backup_wallets "$snap/wallets"

  say "3. stop the node and the ord server, tar data/ and ord-data/, bring them back"
  # What height the index in this snapshot stands at, read now, with the node still up. An ord half
  # that is a week behind its chain restores fine and looks fine, so the height is recorded beside
  # the archive's checksum and compared with the chain's, which is the one thing that makes the pair
  # of halves judgeable afterwards. Same two readings bundle uses, for the same reason.
  local ORD_BLOCKS ORD_HOW ORD_FROM_SERVER ORD_HT ORD_GAP
  if [ -d "$DIR/ord-data" ]; then
    read_ord_blocks
    ord_height_vs "$(sed -n 's/^height //p' "$snap/state.txt")"
    echo "  ord index height ${ORD_HT}${ORD_GAP:+ ($ORD_GAP)}"
  fi
  local ord_was_up=0
  if ord_up; then
    "$DIR/ord-server.sh" stop >/dev/null || envfail "the ord server answers but would not stop"
    ord_was_up=1
    echo "  ord server stopped; it held the index lock on ord-data"
  fi
  stop_node
  tar -czf "$snap/data.tar.gz" -C "$DIR" data
  chmod 600 "$snap/data.tar.gz"   # it carries the wallets, so their keys: POSIX modes, NTFS ignores them
  # An archive is only worth the chain it can be read back to, so check the directories a restore
  # depends on are in it rather than trusting tar's exit status.
  tar -tzf "$snap/data.tar.gz" >"$snap/contents.txt"
  local want
  for want in data/regtest/blocks/ data/regtest/chainstate/ data/regtest/wallets/; do
    grep -q "^$want" "$snap/contents.txt" || envfail "the archive has no $want"
  done
  # ord's index and its own wallet, which is the half data.tar.gz does not hold: the bitcoind wallet
  # named ord is in data/, but ord's wallet file is what knows which inscriptions are its own, and
  # without it a restore starts ord with a fresh wallet and no rune balance. Tarred here, with the
  # server stopped, or the copy is of a file being written.
  if [ -d "$DIR/ord-data" ]; then
    tar -czf "$snap/ord-data.tar.gz" -C "$DIR" ord-data
    chmod 600 "$snap/ord-data.tar.gz" 2>/dev/null || true
    tar -tzf "$snap/ord-data.tar.gz" >"$snap/ord-contents.txt"
    if ! grep -q "^ord-data/regtest/wallets/ord.redb$" "$snap/ord-contents.txt"; then
      echo "  (ord-data carries no wallet here; the index is in the snapshot, the wallet is not)"
    fi
  fi
  start_node
  if [ "$ord_was_up" = 1 ]; then
    "$DIR/ord-server.sh" >/dev/null 2>&1 ||
      echo "  the ord server it stopped did not come back; ./ord-server.sh starts it" >&2
  fi

  say "4. the chain is back, and must be where it was"
  local after
  after=$(state) || envfail "the node did not answer after starting; see data/regtest/debug.log"
  if [ "$after" != "$(cat "$snap/state.txt")" ]; then
    printf 'before:\n%s\nafter:\n%s\n' "$(cat "$snap/state.txt")" "$after" >&2
    fail "the chain came back at a different state than the one just written down"
  fi

  local sha bytes osha="" osha_bytes=""
  sha=$(sha256sum "$snap/data.tar.gz" | cut -d' ' -f1)
  bytes=$(wc -c <"$snap/data.tar.gz" | tr -d ' ')
  if [ -f "$snap/ord-data.tar.gz" ]; then
    osha=$(sha256sum "$snap/ord-data.tar.gz" | cut -d' ' -f1)
    osha_bytes=$(wc -c <"$snap/ord-data.tar.gz" | tr -d ' ')
  fi
  {
    echo "created $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -s) from $DIR"
    echo "archive $bytes bytes, sha256 $sha"
    echo "wallets $(ls "$snap/wallets" | tr '\n' ' ')"
    echo "wallets/ is a second copy of each of those: NAME.dat to restorewallet, and NAME.descriptors.json"
    echo "for reading the keys back by eye, both for when data.tar.gz is the part that is damaged."
    echo "Neither is in the archive's checksum, so ./chain.sh verify loads each .dat back."
    echo "state above in state.txt, archive listing in contents.txt"
    if [ -f "$snap/ord-data.tar.gz" ]; then
      echo "ord-archive $osha_bytes bytes, sha256 $osha"
      # A height and a comparison, not a number alone: this is what says whether the index in the
      # archive was of the same moment as the chain in it, and "unknown" is itself a finding.
      echo "ord index height at capture: ${ORD_HT}${ORD_GAP:+ — $ORD_GAP}"
      echo "  the height was ${ORD_HOW}"
      echo "ord-data.tar.gz is ord's index and wallet, tarred with the server stopped."
    fi
  } >"$snap/manifest.txt"

  echo
  echo "snapshot: $snap"
  echo "  data.tar.gz $(du -h "$snap/data.tar.gz" | cut -f1), sha256 $sha"
  [ -z "$osha" ] || echo "  ord-data.tar.gz $(du -h "$snap/ord-data.tar.gz" | cut -f1), sha256 $osha"
  echo "  the chain is up again at height $(sed -n 's/^height //p' "$snap/state.txt"), unchanged by this"
}

# Newest means newest *complete* one: a run that failed before writing its manifest leaves an
# archive with nothing to check it against, and picking that would turn "restore" into a refusal.
newest() {
  local d last=""
  for d in "$SNAPS"/*/; do
    [ -f "$d/manifest.txt" ] || continue
    last=$d
  done
  [ -n "$last" ] || envfail "no complete snapshots in $SNAPS; run ./chain.sh snapshot first"
  printf '%s' "${last%/}"
}

# The swap is two renames, and between them there is no data/ at all: killed there, the folder is
# left with nothing to start, which is worse than a wrong chain. So every exit after the first
# rename goes through this. The staged copy was checked before anything moved, so finishing the
# swap is safe; if it is gone, the original goes back. Either way there is a data/ afterwards.
restore_swap=none           # none -> moving (armed) -> done
restore_stage=""
restore_kept=""
swap_guard() {
  local rc=${1-$?} started=0
  trap - EXIT INT TERM
  if [ "$restore_swap" = moving ] && [ ! -e "$DATA" ]; then
    if [ -d "$restore_stage/data" ]; then
      mv "$restore_stage/data" "$DATA" 2>/dev/null || true
      rm -rf "$restore_stage" 2>/dev/null || true
      printf 'interrupted between the two renames: finished the swap, so data/ is the restored\n' >&2
      printf '  snapshot and not the chain this run started with. What it replaced is in\n' >&2
      printf '  %s\n' "${restore_kept:-nothing -- there was no data/ to keep}" >&2
      started=1
    elif [ -n "$restore_kept" ] && [ -d "$restore_kept" ]; then
      mv "$restore_kept" "$DATA" 2>/dev/null || true
      printf 'interrupted between the two renames: put the original data/ back; nothing changed.\n' >&2
      started=1
    fi
    if [ "$started" = 1 ]; then
      printf '  the node is stopped; ./regtest/start.sh starts it on whatever data/ now holds\n' >&2
    fi
  fi
  # A staging directory left behind is a copy of a datadir under a name nothing reads.
  if [ -n "$restore_stage" ] && [ -d "$restore_stage" ]; then rm -rf "$restore_stage" 2>/dev/null; fi
  cleanup "$rc"          # which also releases the lock
}

restore() {
  local snap=${1:-}
  lock_acquire restore
  [ -n "$snap" ] || snap=$(newest)
  [ -f "$snap/data.tar.gz" ] && [ -f "$snap/state.txt" ] && [ -f "$snap/manifest.txt" ] ||
    envfail "not a snapshot: $snap (needs data.tar.gz, state.txt and manifest.txt)"

  # Unpacking needs room for the whole archive at once, in a staging directory that sits beside
  # data/ rather than inside it. That is what a full disk takes away, so it is asked before anything
  # is read, moved or stopped.
  # How large the chain grows when unpacked: gzip's header says so in one call, the tar listing says
  # the same by hand. Neither working means it cannot be said, and this check does not guess.
  local need_kb
  need_kb=$(gzip -l "$snap/data.tar.gz" 2>/dev/null | awk 'NR==2 {print int($2 / 1024)}' || true)
  if [ -z "$need_kb" ] || [ "$need_kb" -le 0 ]; then
    need_kb=$(tar -tzvf "$snap/data.tar.gz" 2>/dev/null | awk '{s += $3} END {printf "%d", s / 1024}' || true)
  fi
  if [ -z "$need_kb" ] || [ "$need_kb" -le 0 ]; then
    envfail "the size $snap/data.tar.gz unpacks to cannot be read, so whether it fits cannot be known"
  fi
  need_space $(( need_kb + need_kb / 10 + 4096 )) restore "unpacking $(basename "$snap")"

  say "1. check the archive against the checksum the manifest recorded"
  local want got
  want=$(sed -n 's/^archive [0-9]* bytes, sha256 //p' "$snap/manifest.txt")
  [ -n "$want" ] || envfail "$snap/manifest.txt carries no checksum"
  got=$(sha256sum "$snap/data.tar.gz" | cut -d' ' -f1)
  [ "$got" = "$want" ] ||
    fail "the archive is not the one that was snapshotted: sha256 $got, the manifest says $want"

  local want_h want_tip ws
  ws=$(cat "$snap/state.txt")
  want_h=$(sed -n 's/^height //p' "$snap/state.txt")
  want_tip=$(sed -n 's/^tip //p' "$snap/state.txt")
  [ -n "$want_h" ] && [ -n "$want_tip" ] || envfail "$snap/state.txt does not say what state it is of"

  say "2. make sure this is the rollback that was meant"
  if up; then
    local now_h why=""
    now_h=$(cli getblockcount | tr -d '\r')
    if [ "$now_h" -gt "$want_h" ]; then
      why="the chain is at $now_h and this snapshot is $want_h, so restoring drops $((now_h - want_h)) block(s)"
    fi
    if cli getblockhash "$want_h" >/dev/null 2>&1 &&
      [ "$(cli getblockhash "$want_h" | tr -d '\r')" != "$want_tip" ]; then
      why="${why:+$why, and }block $want_h here is not this snapshot's tip, so it is another branch"
    fi
    if [ -n "$why" ]; then
      echo "  $why." >&2
      if [ "${DRILL:-0}" = 1 ]; then
        echo "  drill: going ahead without the word, because this swap is what the drill is for" >&2
      else
        echo "  data/ is untouched; ./chain.sh verify $snap proves the archive restores before you commit." >&2
        printf 'type rollback to go ahead: '
        ANSWER=""
        read -r ANSWER || true      # end of input refuses, like any other word
        if [ "$ANSWER" != "rollback" ]; then
          echo
          echo "refusing: data/ was not touched" >&2
          exit 2
        fi
      fi
    fi
  fi

  # Decided before anything is unpacked: refusing here has to leave nothing behind, and staging a
  # datadir only to refuse would leave a full copy of it — wallets and all — next to the real one.
  local before="" kept_state=""
  if [ -d "$DATA" ]; then
    before="$DATA.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    [ ! -e "$before" ] ||
      envfail "$before already exists, so this restore would overwrite an earlier undo; move it aside"
  fi

  say "3. the ord index is rolled back with the chain"
  # An index ahead of the restored height is holding blocks the chain will no longer have, and it
  # would keep serving their inscriptions and runes as fact: on a chain that carries a real rune that
  # is the one wrong answer that looks completely right. The index is derived data — the restored
  # chain is the authority — so one that cannot be shown to be behind the target is reset rather than
  # trusted. The ord wallet beside it is never touched, and the next ./ord-server.sh rebuilds.
  local ord_note="" ord_idx="" ord_stopped=0 ord_kept=0
  if [ -f "$DIR/ord-data/regtest/index.redb" ]; then
    if ord_up; then
      if REGTEST_LOCK_HELD=1 "$DIR/ord-server.sh" stop >/dev/null 2>&1; then
        ord_stopped=1
        echo "  stopped this folder's ord server, so the index is not written while it is reset"
      else
        echo "  something answers on $ORD_URL but it is not this folder's server (ord-server.sh refused"
        echo "  to stop it), so nothing was stopped: this folder's index is not the one being served"
      fi
    fi
    ord_index_blocks 30
    ord_idx=$ORD_BLOCKS_DISK
    if [ -z "$ord_idx" ]; then
      rm -f "$DIR/ord-data/regtest/index.redb"
      ord_note="ord index reset (it would not say what it held)"
      echo "  it would not say what it holds, so it cannot be trusted rather than wrong: reset"
      # ord's complaint, because it tells the cases apart: a file that is not an index, a port that
      # is another node's, and a cookie this folder does not have all read the same as "would not
      # say" otherwise, and only one of them is a corrupt index.
      if [ -n "$ORD_WHY" ]; then
        echo "  ord said: $ORD_WHY"
      else
        echo "  we got nothing back from ord about the file, so a reset here is not on its own a finding"
      fi
    elif [ "$ord_idx" -gt 0 ] && [ "$((ord_idx - 1))" -gt "$want_h" ]; then
      rm -f "$DIR/ord-data/regtest/index.redb"
      ord_note="ord index reset (was $((ord_idx - 1)), chain goes back to $want_h)"
      echo "  it is at $((ord_idx - 1)), ahead of the restored $want_h, so it holds blocks the chain will"
      echo "  no longer have: reset. ./ord-server.sh rebuilds it from the restored chain, wallet and all"
    else
      ord_kept=1
      ord_note="ord index kept (at $((ord_idx > 0 ? ord_idx - 1 : 0)), not ahead of $want_h)"
      echo "  it is at $((ord_idx > 0 ? ord_idx - 1 : 0)), not ahead of $want_h, so it was kept: it tails"
      echo "  forward from the restored chain, and its wallet was not touched"
    fi
  else
    ord_note="no ord index here to reset"
    echo "  there is no ord-data/regtest/index.redb, so nothing here can serve blocks the chain has lost"
  fi

  say "4. unpack into a staging directory before touching data/"
  local stage="$DIR/.restore.tmp"
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xzf "$snap/data.tar.gz" -C "$stage" || envfail "the archive could not be unpacked; data/ is untouched"
  [ -d "$stage/data/regtest/blocks" ] || envfail "the archive has no data/regtest/blocks; data/ is untouched"

  say "5. replace data/, keeping the directory it replaces"
  trap swap_guard EXIT
  trap 'swap_guard 130' INT
  trap 'swap_guard 143' TERM
  restore_stage="$stage"
  restore_kept="$before"
  restore_swap=moving
  if [ -n "$before" ]; then
    # What it holds, recorded while the node can still be asked: nothing inside a datadir says its
    # height without a node started over it, and status.sh reports these copies by age and height.
    # The whole state is kept, not just the height and tip: it is what verify compares a restored
    # copy against, and a comparison that only knows two fields is not the one a snapshot gets.
    kept_state=$(state 2>/dev/null || true)
    {
      printf 'kept %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '%s\n' "$kept_state" | sed -n '/^height /p;/^tip /p' || true
    } > "$before.txt"
  fi
  stop_node
  # Measured while data/ is stopped and still under its own name, then written into it after the
  # rename: the kept datadir ends up describing itself, so it can be proved the way a snapshot is.
  local kept_tree="" kept_files="" kept_bytes=""
  if [ -n "$before" ]; then
    kept_tree=$(tree_hash "$DATA" || true)
    kept_files=$(tree_files "$DATA" || true)
    kept_bytes=$(tree_bytes "$DATA" || true)
    mv "$DATA" "$before"
    if [ -n "$kept_tree" ]; then
      {
        printf 'kept %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf '%s\n' "${kept_state:-}" |
          sed -n '/^height /p;/^tip /p;/^wallet /p;/^loaded /p;/^rune-/p' || true
        printf 'files %s\n' "$kept_files"
        printf 'bytes %s\n' "$kept_bytes"
        printf 'tree sha256 %s\n' "$kept_tree"
      } >"$before/MANIFEST.txt" 2>/dev/null ||
        echo "  ($before would not take a MANIFEST.txt; ./chain.sh verify will not be able to check it)" >&2
    fi
  fi
  mv "$stage/data" "$DATA"
  restore_swap=done
  rm -rf "$stage"
  # A snapshot carries ord's index and wallet. A rollback keeps the folder's own ord-data — step 3
  # has already decided whether its index is ahead and must be reset — but where there is none at
  # all, as when a snapshot is restored into an empty folder, the snapshot's copy is what stops ord
  # starting with a fresh wallet and no rune balance.
  local ordw=ord-data/regtest/wallets/ord.redb snap_idx=""
  if [ -f "$snap/ord-data.tar.gz" ]; then
    if [ ! -d "$DIR/ord-data" ]; then
      if tar -xzf "$snap/ord-data.tar.gz" -C "$DIR"; then
        echo "  ord-data/ came from the snapshot: its index and its wallet"
        # Step 3 asked the index that was here and found none; this one arrives after it ran, so
        # the height the manifest recorded is the only witness left. That is a record, not a
        # measurement: a snapshot that predates the line, or recorded "unknown", is not called
        # ahead on no evidence.
        snap_idx=$(sed -n 's/^ord index height at capture: \([0-9]*\).*/\1/p' \
          "$snap/manifest.txt")
        if [ -n "$snap_idx" ] && [ "$snap_idx" -gt "$want_h" ] &&
          [ -f "$DIR/ord-data/regtest/index.redb" ]; then
          rm -f "$DIR/ord-data/regtest/index.redb"
          ord_note="ord index from the snapshot reset (manifest said $snap_idx, chain is $want_h)"
          echo "  the manifest puts the index at $snap_idx, ahead of the restored $want_h: reset,"
          echo "  so it cannot serve blocks this chain lacks; the wallet is kept, ord rebuilds it"
        fi
      else
        echo "  the snapshot's ord data did not unpack; ord will start with a fresh wallet" >&2
      fi
    elif [ ! -s "$DIR/$ordw" ] && grep -qxF -- "$ordw" "$snap/ord-contents.txt" 2>/dev/null; then
      # The keys rule is unchanged: a folder with an ord-data/ keeps it, even a half-prepared one.
      # But a copy with no wallet would drop the snapshot's wallet without a word, and nothing
      # later fails — ord starts, with a fresh wallet and no rune balance.
      echo "  this folder's ord-data/ carries no wallet and is kept: the snapshot's wallet was not"
      echo "  installed, so no rune balance is here; move ord-data/ aside to take the snapshot's"
    fi
  fi
  start_node

  say "6. the restored chain must be the state that was snapshotted"
  local after want_ok got_ok
  after=$(state) || envfail "the restored node did not answer; the datadir it replaced is at ${before:-data/}"
  # Normalised, not text: a snapshot written before this state format would otherwise restore its
  # data correctly and then fail on the wording of state.txt (see norm_state above).
  want_ok=$(printf '%s\n' "$ws" | norm_state)
  got_ok=$(printf '%s\n' "$after" | norm_state)
  if [ "$want_ok" != "$got_ok" ]; then
    printf 'snapshot:\n%s\nrestored:\n%s\n' "$want_ok" "$got_ok" >&2
    fail "the restored chain is not the state that was snapshotted; the datadir it replaced is at ${before:-data/}"
  fi
  if [ "${DRILL:-0}" = 1 ]; then
    # A drill exists to say what was compared, not just that it matched: these are the lines the
    # restored datadir was held to, each one checked for presence in it.
    echo "  compared with $(basename "$snap")/state.txt, line by line:"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      if printf '%s\n' "$got_ok" | grep -qxF -- "$line"; then
        printf '    ok   %s\n' "$line"
      else
        printf '    !=   %s\n' "$line"
      fi
    done <<<"$want_ok"
  else
    sed 's/^/  /' <<<"$got_ok"
  fi
  echo
  echo "restored: $snap"
  if [ -n "$before" ]; then
    echo "  the datadir it replaced is at $(basename "$before"); nothing deleted it, and the next"
    echo "  restore will not write over it"
    if [ -n "$kept_tree" ]; then
      echo "  it carries a MANIFEST.txt (tree sha256 ${kept_tree:0:16}…): ./chain.sh verify $(basename "$before")"
      echo "  proves it restores, the same way a snapshot is proved"
    fi
  fi
  echo "  ord:      $ord_note"
  # The server that was stopped is only put back when its index was kept; after a reset it must
  # rebuild first, and that is a minute of work the caller can see rather than one this run hides.
  if [ "$ord_stopped" = 1 ] && [ "$ord_kept" = 1 ]; then
    if REGTEST_LOCK_HELD=1 "$DIR/ord-server.sh" >/dev/null 2>&1; then
      echo "  the ord server it stopped is up again on this folder's index"
    else
      echo "  the ord server did not come back up; ./ord-server.sh starts it" >&2
    fi
  elif [ "$ord_stopped" = 1 ]; then
    echo "  the ord server was stopped for the reset and is not running: ./ord-server.sh rebuilds the"
    echo "  index from the restored chain (about a minute at this size)"
  fi
  if [ "${DRILL:-0}" = 1 ]; then
    journal drill "${now_h:--}" "$want_h" "snapshot $(basename "$snap"); $ord_note"
  else
    journal restore "${now_h:--}" "$want_h" "snapshot $(basename "$snap"); $ord_note"
  fi
  # swap_guard is still the trap and its state is done, so it does nothing but clean up and release.
}

# Nothing else ever deletes a snapshot or a kept datadir, and both are copies of a datadir with its
# wallet keys in them — so this lists every path it would remove, gives the totals, and asks for the
# word `prune` before removing anything. The newest snapshot is never touched whatever --keep says,
# and neither is the newest -pre-rehearse one: that is the way back from the last wipe, and there is
# no rule that makes deleting it safe.
prune() {
  lock_acquire prune
  local keep=5 keep_kept=2
  while [ $# -gt 0 ]; do
    case $1 in
      --keep) keep=${2:-}; shift 2 || envfail "--keep needs a number" ;;
      --keep-kept) keep_kept=${2:-}; shift 2 || envfail "--keep-kept needs a number" ;;
      *) envfail "prune takes --keep N and --keep-kept N, not $1" ;;
    esac
  done
  case $keep in ''|*[!0-9]*) envfail "--keep takes a number, not '$keep'" ;; esac
  case $keep_kept in ''|*[!0-9]*) envfail "--keep-kept takes a number, not '$keep_kept'" ;; esac

  local -a snaps=() kepts=() doomed=()
  local d
  for d in "$SNAPS"/*/; do
    [ -f "$d/manifest.txt" ] && [ -f "$d/state.txt" ] || continue
    snaps+=("${d%/}")
  done
  for d in "$DIR"/data.before-restore-*/; do
    [ -d "$d" ] || continue
    kepts+=("${d%/}")
  done
  local newest_snap="" newest_pre="" s
  for s in "${snaps[@]}"; do
    newest_snap=$s
    case $(basename "$s") in *-pre-rehearse) newest_pre=$s ;; esac
  done

  say "1. what would go, and what would not"
  local total budget i entry path kb held freed=0
  total=${#snaps[@]}
  budget=$(( total - keep )); [ "$budget" -gt 0 ] || budget=0
  for ((i = 0; i < total; i++)); do
    [ "$budget" -gt 0 ] || break
    s=${snaps[i]}
    [ "$s" = "$newest_snap" ] && continue
    [ "$s" = "$newest_pre" ] && continue
    doomed+=("snapshot:$s")
    budget=$(( budget - 1 ))
  done
  total=${#kepts[@]}
  budget=$(( total - keep_kept )); [ "$budget" -gt 0 ] || budget=0
  for ((i = 0; i < total; i++)); do
    [ "$budget" -gt 0 ] || break
    doomed+=("kept:${kepts[i]}")
    budget=$(( budget - 1 ))
  done

  if [ "${#doomed[@]}" -eq 0 ]; then
    echo "  nothing: ${#snaps[@]} snapshot(s) and ${#kepts[@]} kept copy(ies) are within --keep $keep"
    echo "  and --keep-kept $keep_kept"
    echo
    echo "nothing to prune"
    return 0
  fi
  for entry in "${doomed[@]}"; do
    path=${entry#*:}
    kb=$(dir_kb "$path" || true); [ -n "$kb" ] || kb=0
    freed=$(( freed + kb ))
    case $entry in
      snapshot:*)
        printf '  --   %-.40s  %s, height %s\n' "$(basename "$path")" "$(human_kb "$kb")" \
          "$(sed -n 's/^height //p' "$path/state.txt")" ;;
      kept:*)
        held=$(sed -n 's/^height //p' "$path.txt" 2>/dev/null || true)
        printf '  --   %-.40s  %s, held height %s\n' "$(basename "$path")" "$(human_kb "$kb")" \
          "${held:-not recorded}" ;;
    esac
  done
  echo
  echo "  keeping $(basename "${newest_snap:-none}") as the newest snapshot${newest_pre:+, and $(basename "$newest_pre") as the newest pre-rehearsal one}"
  printf 'type prune to go ahead: '
  ANSWER=""
  read -r ANSWER || true      # end of input refuses, like any other word
  if [ "$ANSWER" != "prune" ]; then
    echo
    echo "refusing: nothing was deleted" >&2
    exit 2
  fi

  say "2. remove them"
  local removed_s=0 removed_k=0
  for entry in "${doomed[@]}"; do
    path=${entry#*:}
    case $path in "$DIR"/*) ;; *) envfail "refusing to delete outside $DIR: $path" ;; esac
    rm -rf "$path"
    case $entry in
      kept:*) rm -f "$path.txt"; removed_k=$((removed_k + 1)) ;;
      snapshot:*) removed_s=$((removed_s + 1)) ;;
    esac
    echo "  removed $(basename "$path")"
  done
  journal prune - - "removed $removed_s snapshot(s) and $removed_k kept copy(ies)"

  say "3. what is left"
  local left=0
  for d in "$SNAPS"/*/; do
    [ -f "$d/manifest.txt" ] && [ -f "$d/state.txt" ] || continue
    left=$(( left + 1 ))
  done
  echo "  snapshots: $left, kept copies: $(ls -d "$DIR"/data.before-restore-*/ 2>/dev/null | wc -l) (counted by glob)"
  echo "  freed $(human_kb "$freed")"
}

# A snapshot lives in .snapshot/ inside this folder, and so do data/, ord-data/ and every archive:
# all of it is one disk, so snapshot and restore protect against restoring the wrong thing but not
# against losing the folder. This writes one file somewhere else holding the same pieces — a
# stopped-node tar of data/, the wallet .dat and descriptors for each loaded wallet, and ord-data/
# with the ord wallet — plus a checksum per file and a checksum of the file itself beside it. Then
# it reads the archive back and compares every file with its checksum, because a copy nobody has
# read is a hope, not a backup. Nothing is deleted from the tree, and the node and ord server are
# stopped for the length of the copy and started again afterwards.
#
#   ./chain.sh bundle /d/backups/regtest-$(date -u +%F).tar.gz
bundle() {
  local dest=${1:-}
  [ -n "$dest" ] || envfail "usage: ./chain.sh bundle <path outside this folder>.tar.gz"
  [ -d "$(dirname "$dest")" ] || envfail "there is no directory $(dirname "$dest") to write into"
  local destdir
  destdir=$(cd "$(dirname "$dest")" && pwd)
  case "$destdir/" in
    "$DIR"/*) envfail "$destdir is inside $DIR, the one folder this is meant to survive losing" ;;
  esac
  dest="$destdir/$(basename "$dest")"
  [ ! -e "$dest" ] || envfail "$dest already exists; move it aside instead of overwriting a backup"
  [ ! -e "$dest.sha256" ] || envfail "$dest.sha256 already exists; move it aside too"
  up || envfail "the main node is not answering; ./start.sh first, so the bundle describes a chain that exists"

  local stage="$DIR/.bundle.tmp" verify="$DIR/.bundle.verify"
  rm -rf "$stage" "$verify"
  mkdir -p "$stage/chain/wallets" "$stage/ord" "$stage/tooling/bin"

  say "1. write down the state this bundle is of, and back the wallets up"
  state >"$stage/chain/state.txt" || envfail "the node stopped answering while its state was read"
  sed 's/^/  /' "$stage/chain/state.txt"
  backup_wallets "$stage/chain/wallets"
  # The scripts and conf that make this folder this folder. Without them a machine holding only this
  # tar has a chain, wallets and no idea how to put either back: the data is replaceable from the
  # chain, the tools are not. The binaries stay out — they are not this folder's, they are 40MB, and
  # the manifest names the versions a restore needs — but tooling/bin/ exists for them to land in,
  # which is where every script here looks.
  local t
  for t in chain.sh btc ord ord.yaml ord-server.sh start.sh stop.sh status.sh bitcoin.conf; do
    cp "$DIR/$t" "$stage/tooling/$t" || envfail "could not copy $t into the bundle's tooling/"
  done
  chmod +x "$stage/tooling"/*.sh "$stage/tooling/btc" "$stage/tooling/ord" 2>/dev/null || true
  echo "  tooling: $(ls "$stage/tooling" | tr '\n' ' ')"

  say "2. stop the node and the ord server, and tar both directories"
  local ORD_BLOCKS ORD_HOW ORD_FROM_SERVER ORD_HT ORD_GAP
  local ord_was_up=0 chain_h
  # The index is readable without its server — that is how status.sh asks when the server is down —
  # and this is the last moment it can be read, because ord needs the node's cookie and the node
  # stops a few lines below. Read first and stop afterwards, so the height is of the index the tar
  # will hold either way; recorded as "unknown", a bundle cannot be told apart from one whose ord
  # half is a week behind its chain half, but a height and a comparison can.
  read_ord_blocks
  if [ "$ORD_FROM_SERVER" = 1 ]; then
    "$DIR/ord-server.sh" stop >/dev/null || envfail "the ord server answers but would not stop"
    ord_was_up=1
    echo "  ord server stopped; it held the index lock on ord-data"
  else
    echo "  ord server was not answering, so nothing to stop"
  fi
  chain_h=$(sed -n 's/^height //p' "$stage/chain/state.txt")
  ord_height_vs "$chain_h"
  echo "  ord index height ${ORD_HT}${ORD_GAP:+ ($ORD_GAP)}"
  stop_node
  tar -czf "$stage/chain/data.tar.gz" -C "$DIR" data
  tar -czf "$stage/ord/ord-data.tar.gz" -C "$DIR" ord-data
  chmod 600 "$stage/chain/data.tar.gz" "$stage/ord/ord-data.tar.gz" "$stage"/chain/wallets/* \
    2>/dev/null || true
  tar -tzf "$stage/chain/data.tar.gz" >"$stage/chain/contents.txt"
  local want
  for want in data/regtest/blocks/ data/regtest/chainstate/ data/regtest/wallets/; do
    grep -q "^$want" "$stage/chain/contents.txt" || envfail "the data archive has no $want"
  done
  # (snapshot() checks its own archive the same way, and its listing was already written to a file
  # for the same reason: a pipe into grep -q fails under pipefail when grep stops reading early.)
  tar -tzf "$stage/ord/ord-data.tar.gz" >"$stage/ord/contents.txt"
  local ordw=ord-data/regtest/wallets/ord.redb
  grep -q "^$ordw$" "$stage/ord/contents.txt" ||
    envfail "the ord archive has no $ordw, which is the ord wallet"
  {
    echo "ord-data tarred while the server was stopped"
    echo "ord index height at capture: ${ORD_HT}${ORD_GAP:+ — $ORD_GAP}"
    echo "  ${ORD_HOW}"
    echo "the ord wallet is $ordw; the rune balance lives in it, not in the index"
  } >"$stage/ord/info.txt"
  start_node
  if [ "$ord_was_up" = 1 ]; then
    "$DIR/ord-server.sh" >/dev/null || envfail "the ord server did not come back; run ./ord-server.sh"
    echo "  ord server back up"
  fi

  say "3. the chain must be back where it was, since the archive was taken from it"
  # Normalised, not text: the node loads the wallets it finds in an order of its own, so with more
  # than one wallet the same chain can come back as `loaded w ord` where it left as `ord w`.
  local after want
  after=$(state) || envfail "the node did not answer after starting; see data/regtest/debug.log"
  want=$(norm_state <"$stage/chain/state.txt")
  after=$(printf '%s\n' "$after" | norm_state)
  if [ "$after" != "$want" ]; then
    printf 'before:\n%s\nafter:\n%s\n' "$want" "$after" >&2
    fail "the chain came back at a different state than the one just written down"
  fi

  say "4. checksums for every file, and a manifest saying what this is"
  local dsha dbytes f bh
  bh=$(sed -n 's/^height //p' "$stage/chain/state.txt")
  dsha=$(sha256sum "$stage/chain/data.tar.gz" | cut -d' ' -f1)
  dbytes=$(wc -c <"$stage/chain/data.tar.gz" | tr -d ' ')
  # In the snapshot format, so that chain.sh restore accepts the extracted chain/ unchanged.
  {
    echo "created $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -s) from $DIR"
    echo "archive $dbytes bytes, sha256 $dsha"
    echo "wallets $(ls "$stage/chain/wallets" | tr '\n' ' ')"
    echo "state above in state.txt, archive listing in contents.txt"
  } >"$stage/chain/manifest.txt"
  # The versions a restore on another machine has to have. The tar carries this folder's scripts and
  # conf, not the binaries, so it has to say which ones to fetch and where the scripts expect them.
  local binext="" btver="" ordver=""
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) binext=".exe" ;; esac
  # Both print a sentence; the token is what a person has to match against a download page.
  btver=$("$DIR/bin/bitcoind$binext" --version 2>/dev/null | head -n 1 |
    tr -d '\r' | sed 's/.*version //; s/ [A-Za-z]*$//')
  ordver=$("$DIR/bin/ord$binext" --version 2>/dev/null | head -n 1 | sed 's/^ord //' | tr -d '\r')
  {
    echo "regtest bundle, created $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -s)"
    echo "source $DIR"
    echo "chain height $bh (chain/ is a chain.sh snapshot)"
    echo "ord index height at capture: ${ORD_HT}${ORD_GAP:+ — $ORD_GAP}"
    echo "  ord/ord-data.tar.gz holds the index and the ord wallet"
    echo "  the height was ${ORD_HOW}"
    echo "files are listed in SHA256SUMS, which was checked by unpacking this archive again"
    echo "tooling/ is this folder's own scripts and conf (chain.sh, btc, ord, ord.yaml, bitcoin.conf,"
    echo "  ord-server.sh, start.sh, stop.sh, status.sh): what a machine with only this file needs"
    echo "  to put any of it back. The binaries are not in it — they are not this folder's and they"
    echo "  are tens of megabytes — so put bitcoind$binext, bitcoin-cli$binext and ord$binext there."
    echo "  it was written with: bitcoind ${btver:-unknown} / ord ${ordver:-unknown}"
    echo "restore: tar -xzf <this file> -C <new folder>   (gives <new folder>/tooling and /chain)"
    echo "restore the chain: cd <new folder>/tooling && ./chain.sh restore ../chain"
    echo "restore ord, after the chain, from <new folder> (not from tooling/: the wrapper is a file"
    echo "  named ord, so a directory ord/ cannot be unpacked beside it):"
    echo "  tar -xzf <this file> ./ord/ord-data.tar.gz && tar -xzf ord/ord-data.tar.gz -C tooling"
  } >"$stage/manifest.txt"
  (
    cd "$stage" || exit 1
    for f in $(find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort); do sha256sum "$f"; done
  ) >"$stage/SHA256SUMS"

  say "5. write the bundle"
  tar -czf "$dest" -C "$stage" .
  local sha bytes
  sha=$(sha256sum "$dest" | cut -d' ' -f1)
  bytes=$(wc -c <"$dest" | tr -d ' ')
  printf '%s  %s\n' "$sha" "$(basename "$dest")" >"$dest.sha256"
  echo "  $dest"
  echo "  $bytes bytes, $(du -h "$dest" | cut -f1), sha256 $sha"

  say "6. read the copy back and check what it holds"
  mkdir -p "$verify"
  tar -xzf "$dest" -C "$verify" || fail "the file just written does not unpack: $dest"
  local bad n
  bad=$(cd "$verify" && sha256sum -c SHA256SUMS 2>&1 | grep -v ': OK$' || true)
  n=$(wc -l <"$verify/SHA256SUMS" | tr -d ' ')
  if [ -n "$bad" ]; then
    printf '%s\n' "$bad" >&2
    fail "a file read back out of $dest does not match its checksum"
  fi
  echo "  $n file(s) read back and matching SHA256SUMS"
  local w
  for w in $(wallets); do
    [ -s "$verify/chain/wallets/$w.dat" ] || fail "the bundle has no backup of wallet $w"
  done
  # Listed into files rather than piped into grep: grep -q exits on the first match, tar then dies of
  # SIGPIPE, and under pipefail that reads as a failed check on an archive that is perfectly good.
  tar -tzf "$verify/chain/data.tar.gz" >"$verify/data.list"
  tar -tzf "$verify/ord/ord-data.tar.gz" >"$verify/ord.list"
  for want in data/regtest/blocks/ data/regtest/chainstate/ data/regtest/wallets/; do
    grep -q "^$want" "$verify/data.list" || fail "the bundled data archive has no $want"
  done
  grep -q "^$ordw$" "$verify/ord.list" || fail "the bundled ord archive has no $ordw"
  # Normalised for the same reason as step 3: the wallet names this chain has loaded are a set.
  if [ "$(norm_state <"$verify/chain/state.txt")" != "$(state | norm_state)" ]; then
    fail "the bundled chain state is not the chain that is running here"
  fi
  echo "  data/ and ord-data/ list what a restore needs, and the chain state is this chain's"
  [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$sha" ] ||
    fail "$dest changed between writing it and reading it back"
  echo "  the file on disk still has the sha256 recorded beside it"
  rm -rf "$stage" "$verify"

  echo
  echo "bundle: $dest"
  echo "  chain at height $bh; sha256 in $(basename "$dest").sha256, keep both off this machine"
  echo "  restore with: tar -xzf <bundle> -C <new folder>, put the binaries in its tooling/bin/,"
  echo "    then: cd <new folder>/tooling && ./chain.sh restore ../chain"
}

# Scratch state for verify(): a datadir unpacked from a backup, the conf it is started with, and
# the pid of the node running on it. The trap in verify() means every way out takes the node and the
# copy with it, so a failed verification does not leave a second set of wallet keys on disk.
V=""
VNODE=""
OSRV=""     # the ord server verify started over a bundle's ord data, if it got that far
vcli() { "$CLI" -rpcclienttimeout=10 -datadir="$V/data" -conf="$V/bitcoin.conf" "$@"; }

# A .dat beside an archive is a second copy of key material, and a copy is only a copy if something
# has opened it: restorewallet loads it under a name of its own, so it cannot collide with the wallet
# of the same name the archive restored, and the node is then asked about the wallet it loaded.
# `what` names whose copy it is, for the failure. verify() calls this for both shapes it accepts.
prove_dat_copies() {
  local dir=$1 what=$2 f n
  if [ ! -d "$dir" ]; then
    echo "  this $what has no wallets/ beside its archive, so there is no second copy to open"
    return 0
  fi
  for f in "$dir"/*.dat; do
    [ -f "$f" ] || continue
    n=$(basename "$f" .dat)
    vcli restorewallet "from-dat-$n" "$(winp "$f")" >/dev/null 2>&1 ||
      fail "the $what's $n.dat does not restore, so that copy cannot recover wallet $n"
    vcli -rpcwallet="from-dat-$n" getwalletinfo >/dev/null 2>&1 ||
      fail "the $what's $n.dat restored but does not answer, so it is not a usable wallet"
    echo "  $n.dat restores: loaded it as from-dat-$n beside the archive's copy"
  done
}

cleanup_verify() {
  if [ -n "$OSRV" ]; then kill "$OSRV" 2>/dev/null || true; OSRV=""; fi
  [ -n "$V" ] && [ -d "$V" ] || return 0
  if vcli getblockchaininfo >/dev/null 2>&1; then
    vcli stop >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do vcli getblockchaininfo >/dev/null 2>&1 || break; sleep 0.25; done
  fi
  # Not `[ -n "$VNODE" ] && kill …`: the node has usually already stopped above, kill then fails, and
  # a failing last command of an && list is an exit under set -e — inside a cleanup that should never
  # be able to abort.
  if [ -n "$VNODE" ]; then kill "$VNODE" 2>/dev/null || true; fi
  rm -rf "$V" 2>/dev/null || true
  return 0
}

# A checksum says the file is the file. This says the backup is a chain: it unpacks the archive into
# a scratch datadir, starts a node on ports of its own, loads every wallet the archive carries — the
# only thing anywhere here that reads those .dat files back — and compares the result with the state
# the snapshot wrote down. Give it a snapshot directory or a bundle; with neither, the newest
# snapshot, which is the one restore would pick. data/ and the running node are untouched.
#
#   ./chain.sh verify [snapshot-dir|bundle.tar.gz]      RPCPORT=18643 to move the scratch node
verify() {
  local src=${1:-}
  lock_acquire verify
  [ -n "$src" ] || src=$(newest)
  # V and VNODE stay global: vcli() and cleanup_verify() are the only things that need them, and a
  # local copy would leave the cleanup reading an empty path.
  V="$DIR/.verify.tmp"
  VNODE=""
  local chain want got w loaded=0 tip want_h osha_man=""
  # Two shapes are verifiable: an archive (a snapshot, or a bundle's chain/) and a kept datadir, which
  # is what a restore leaves behind. The second is a directory nobody could check before, and it is
  # the copy reached for when the restore itself turns out to be wrong.
  local kept="" statefile=""
  local RPCPORT=${RPCPORT:-18643}
  trap 'rc=$?; cleanup_verify; cleanup $rc' EXIT
  rm -rf "$V"
  mkdir -p "$V"

  say "1. find what is being verified, and check it against what it says it is"
  if [ -d "$src" ] && [ -f "$src/MANIFEST.txt" ] && [ ! -f "$src/data.tar.gz" ]; then
    kept=$src
    statefile="$kept/MANIFEST.txt"
    want=$(sed -n 's/^tree sha256 //p' "$kept/MANIFEST.txt")
    [ -n "$want" ] || envfail "$kept/MANIFEST.txt carries no tree checksum"
    echo "  a kept datadir: $(sed -n 's/^files //p' "$kept/MANIFEST.txt") files," \
      "$(sed -n 's/^bytes //p' "$kept/MANIFEST.txt") bytes described by its MANIFEST.txt"
    got=$(tree_hash "$kept") && [ -n "$got" ] || envfail "the files under $kept cannot be read"
    [ "$got" = "$want" ] ||
      fail "the datadir is not the one its MANIFEST.txt describes: tree sha256 $got, the manifest says $want"
    echo "  every file matches the tree checksum that was taken while the node was stopped"
  elif [ -d "$src" ]; then
    chain=$src
    [ -f "$chain/data.tar.gz" ] && [ -f "$chain/state.txt" ] && [ -f "$chain/manifest.txt" ] ||
      envfail "not a snapshot: $src (needs data.tar.gz, state.txt and manifest.txt)"
    want=$(sed -n 's/^archive [0-9]* bytes, sha256 //p' "$chain/manifest.txt")
    [ -n "$want" ] || envfail "$chain/manifest.txt carries no checksum"
    [ "$(sha256sum "$chain/data.tar.gz" | cut -d' ' -f1)" = "$want" ] ||
      fail "$chain/data.tar.gz is not the archive its manifest describes"
    echo "  data.tar.gz matches the sha256 in its manifest"
    # Only snapshots written since the ord half was added carry this, and only those can be held to
    # it; one whose manifest promises an archive that is not there is a different matter.
    osha_man=$(sed -n 's/^ord-archive [0-9]* bytes, sha256 //p' "$chain/manifest.txt")
    if [ -f "$chain/ord-data.tar.gz" ]; then
      if [ -n "$osha_man" ]; then
        [ "$(sha256sum "$chain/ord-data.tar.gz" | cut -d' ' -f1)" = "$osha_man" ] ||
          fail "$chain/ord-data.tar.gz is not the archive its manifest describes"
        echo "  ord-data.tar.gz matches the sha256 in the same manifest"
      else
        echo "  ord-data.tar.gz is here, but its manifest records no checksum for it"
      fi
    elif [ -n "$osha_man" ]; then
      fail "$chain/manifest.txt describes an ord-data.tar.gz that is not here"
    fi
  elif [ -f "$src" ]; then
    mkdir -p "$V/bundle"
    tar -xzf "$src" -C "$V/bundle" || envfail "that file does not unpack: $src"
    ( cd "$V/bundle" && sha256sum -c SHA256SUMS >/dev/null ) ||
      fail "a file in $src does not match the checksums it carries"
    chain="$V/bundle/chain"
    [ -f "$chain/state.txt" ] ||
      envfail "$src has no chain/state.txt, so it is not a bundle of this chain"
    echo "  every file in it matches SHA256SUMS"
  else
    envfail "no such snapshot directory or bundle: $src"
  fi
  : "${statefile:=$chain/state.txt}"
  [ -n "$(sed -n 's/^tip //p' "$statefile")" ] ||
    envfail "$statefile does not say what state it is of"

  say "2. put a copy of it in a scratch datadir with a conf of its own"
  if [ -n "$kept" ]; then
    mkdir -p "$V/data"
    cp -r "$kept/." "$V/data/" 2>/dev/null ||
      envfail "the kept datadir could not be copied into the scratch directory"
    # Not part of a datadir, and the scratch node should see exactly what a restore would have.
    rm -f "$V/data/MANIFEST.txt" "$V/data/.verified"
    [ -d "$V/data/regtest/blocks" ] || envfail "the kept datadir has no regtest/blocks"
  else
    tar -xzf "$chain/data.tar.gz" -C "$V" || envfail "the archive does not unpack"
    [ -d "$V/data/regtest/blocks" ] || envfail "the archive has no data/regtest/blocks"
  fi
  # listen=0, so there is no second P2P port to collide with anything and nothing to configure.
  {
    echo "regtest=1"
    echo "server=1"
    echo "fallbackfee=0.0002"
    echo "deprecatedrpc=bip125"
    echo "[regtest]"
    # The chain this checks was built with txindex=1, and ord asks bitcoind for a transaction by
    # txid while it reads a wallet's inscriptions. Without the index the scratch node answers
    # "No such mempool transaction", the ord wallet looks unrecoverable, and the check would fail
    # on a good bundle for a setting the backup has nothing to do with.
    echo "txindex=1"
    echo "listen=0"
    echo "rpcport=$RPCPORT"
    echo "rpcbind=127.0.0.1"
    echo "rpcallowip=127.0.0.1"
  } >"$V/bitcoin.conf"

  say "3. start a node on it, and load every wallet the archive carries"
  if netstat -ano 2>/dev/null | grep -q ":$RPCPORT .*LISTENING"; then
    envfail "port $RPCPORT is already in use, so the scratch node cannot be told apart from it; RPCPORT=<free port>"
  fi
  local BIND
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) BIND="$DIR/bin/bitcoind.exe" ;;
    *)                    BIND="$DIR/bin/bitcoind" ;;
  esac
  [ -x "$BIND" ] || envfail "no bitcoin daemon in $DIR/bin to start a scratch node with"
  "$BIND" -datadir="$(winp "$V/data")" -conf="$(winp "$V/bitcoin.conf")" >"$V/bitcoind.out" 2>&1 &
  VNODE=$!
  local i
  for i in $(seq 1 120); do
    if vcli getblockchaininfo >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  vcli getblockchaininfo >/dev/null 2>&1 || {
    tail -5 "$V/bitcoind.out" >&2 || true
    envfail "the scratch node did not come up on port $RPCPORT; its log is above"
  }
  for w in "$V"/data/regtest/wallets/*/; do
    [ -d "$w" ] || continue
    w=$(basename "$w")
    vcli loadwallet "$w" >/dev/null 2>&1 ||
      fail "wallet \"$w\" does not load from its .dat, so this backup cannot restore that wallet"
    loaded=$((loaded + 1))
    echo "  loaded $w from its .dat"
  done
  [ "$loaded" -gt 0 ] || echo "  the archive carries no wallets"

  say "4. compare what came back with the state that was written down"
  CLI_DATA="$V/data"
  CLI_CONF="$V/bitcoin.conf"
  want=$(sed -n '/^height /p;/^tip /p;/^wallet /p;/^loaded /p;/^rune-/p' "$statefile" | norm_state)
  got=$(state | norm_state) || fail "the scratch node stopped answering before its state could be read"
  CLI_DATA=""
  CLI_CONF=""
  if [ "$want" != "$got" ]; then
    printf 'written down:\n%s\nrestored:\n%s\n' "$want" "$got" >&2
    fail "it does not restore to the state recorded in $statefile"
  fi
  sed 's/^/  /' <<<"$got"

  # Read before the cleanup: for a bundle, chain/ lives inside the scratch directory that step 6
  # removes, so anything read from it afterwards would be reading a deleted file.
  want_h=$(sed -n 's/^height //p' "$statefile")
  tip=$(sed -n 's/^tip //p' "$statefile")

  say "5. the recovery copies: every wallet .dat, and the ord wallet"
  # Both shapes carry each wallet twice — inside data.tar.gz, and as a .dat beside it — and a bundle
  # carries the ord wallet in an archive of its own. Both were checked only for being present: a
  # non-empty file, and a name inside a tar listing. A copy nobody has opened is not a copy.
  local what=snapshot
  case "$chain" in */bundle/chain) what=bundle ;; esac
  [ -n "$kept" ] || prove_dat_copies "$chain/wallets" "$what"
  # Where the ord half is, when there is one: a bundle keeps it under ord/, a snapshot beside its
  # chain archive. That path is the only thing the two shapes differ in — both were tarred with
  # the server stopped and both hold the wallet — so from there it is one path, and a check added
  # for one shape is a check on the other.
  local ordarc=""
  if [ -f "$V/bundle/ord/ord-data.tar.gz" ]; then
    ordarc="$V/bundle/ord/ord-data.tar.gz"
  elif [ -n "$chain" ] && [ -f "$chain/ord-data.tar.gz" ]; then
    ordarc="$chain/ord-data.tar.gz"
  fi
  if [ -n "$ordarc" ]; then
    local oexe oport i oup odump_ok=1
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*) oexe="$DIR/bin/ord.exe" ;;
      *)                    oexe="$DIR/bin/ord" ;;
    esac
    if [ ! -x "$oexe" ]; then
      echo "  no ord binary here can open the ord wallet, so that copy is not opened"
    else
      tar -xzf "$ordarc" -C "$V" ||
        fail "the ord archive does not unpack"
      # Checked by name as well as by reading it: a server over an ord data dir with no wallet
      # creates one, so a bundle that lost its ord wallet would otherwise dump a fresh one and pass.
      [ -s "$V/ord-data/regtest/wallets/ord.redb" ] ||
        fail "the ord archive carries no ord wallet, so the keys are not in it"
      oport=$((RPCPORT + 20))
      while netstat -ano 2>/dev/null | grep -q ":$oport .*LISTENING"; do oport=$((oport + 1)); done
      printf 'server_url: http://127.0.0.1:%s\n' "$oport" >"$V/ord-server.yaml"
      # ord is a Windows binary even under Git Bash, so every path it is handed goes through winp:
      # a /tmp/... path would be read as C:\tmp\..., and the server would serve nothing and say so
      # only in its log.
      "$oexe" --chain regtest --bitcoin-rpc-url "http://127.0.0.1:$RPCPORT" \
        --bitcoin-data-dir "$(winp "$V/data")" --data-dir "$(winp "$V/ord-data")" \
        server --http --http-port "$oport" --address 127.0.0.1 >"$V/ord-server.out" 2>&1 &
      OSRV=$!
      oup=0
      for i in $(seq 1 60); do
        if curl -s -m 2 -o /dev/null "http://127.0.0.1:$oport/status"; then oup=1; break; fi
        sleep 0.5
      done
      if [ "$oup" != 1 ]; then
        fail "the ord data does not serve on a port of its own, so its index is unreadable"
      fi
      # ord opens a wallet only through its server, so the copy is asked for its descriptors with
      # a server of its own running over the extracted data. A corrupt redb hangs there rather
      # than answering, so the timeout is part of the check: 124 is a finding, not a skipped run.
      timeout 90 "$oexe" --config "$(winp "$V/ord-server.yaml")" --chain regtest \
        --bitcoin-rpc-url "http://127.0.0.1:$RPCPORT" --bitcoin-data-dir "$(winp "$V/data")" \
        --data-dir "$(winp "$V/ord-data")" wallet dump >"$V/ord-wallet.json" \
        2>"$V/ord-wallet.err" || odump_ok=0
      kill "$OSRV" 2>/dev/null || true
      wait "$OSRV" 2>/dev/null || true
      OSRV=""
      if [ "$odump_ok" != 1 ] || ! grep -q '"descriptors"' "$V/ord-wallet.json"; then
        sed 's/^/  /' "$V/ord-wallet.err" 2>/dev/null | head -n 3
        fail "the ord wallet does not open, so its keys may not be recoverable from it"
      fi
      echo "  the ord wallet opens, and gives up its descriptors"
    fi
  elif [ -n "$chain" ] && [ "$what" = snapshot ]; then
    echo "  this snapshot carries no ord-data.tar.gz (it predates snapshots carrying it), so ord's"
    echo "  wallet cannot be proved from it: a restore from it leaves ord to start a fresh one"
  fi

  say "6. stop the scratch node and remove the copy"
  cleanup_verify
  # Proof that this archive restores, for status.sh to report: a checksum says the bytes are the ones
  # that were written, not that they can be restored, and only this run can say the second thing.
  # The hash goes in too, so the marker stops counting the moment the archive is not that file.
  if [ -n "$kept" ]; then
    {
      printf 'verified %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'tree %s\n' "$(tree_hash "$kept")"
      printf 'height %s\n' "$want_h"
    } >"$kept/.verified" 2>/dev/null ||
      echo "  the kept directory would not take a .verified marker" >&2
  elif [ -d "$src" ] && [ -f "$src/manifest.txt" ]; then
    {
      printf 'verified %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'archive %s\n' "$(sha256sum "$src/data.tar.gz" | cut -d' ' -f1)"
      printf 'height %s\n' "$want_h"
    } >"$src/.verified" 2>/dev/null ||
      echo "  the snapshot directory would not take a .verified marker; status.sh will not know" >&2
  fi
  echo
  echo "verified: $src"
  echo "  restored to height $want_h, tip ${tip:0:16}…"
  if [ -n "$kept" ]; then
    echo "  from a copy of the kept datadir, with every wallet loaded from its .dat; data/ was not touched"
  else
    echo "  in a scratch datadir with every wallet loaded from its .dat; data/ was not touched"
  fi
}

# The one path verify cannot reach. `verify` proves an archive restores in a scratch datadir, and
# `rehearse` proves the wipe, but the two renames, the trap armed between them and the comparison with
# the real data/ only run when a restore runs — which is the worst moment to learn they are broken.
# A drill runs exactly that path with the newest snapshot, on this folder, and says what it compared.
# What it replaces is kept, as any restore keeps it, so the way back is the run's own leftover.
drill() {
  local snap want_h now_h kept ANSWER=""
  snap=$(newest)
  [ -f "$snap/state.txt" ] ||
    envfail "$(basename "$snap") has no state.txt, so there is nothing to drill against"
  want_h=$(sed -n 's/^height //p' "$snap/state.txt")
  now_h=""
  up && now_h=$(cli getblockcount | tr -d '\r')

  say "drill: the swap a restore does, on this folder's data/"
  echo "  restoring $(basename "$snap") (height ${want_h:-unknown}) over data/ (${now_h:-node down})"
  echo "  the two renames, the trap armed between them, and the state comparison: the parts"
  echo "  ./chain.sh verify never reaches, because it never touches data/"
  if [ -n "$now_h" ] && [ -n "$want_h" ] && [ "$now_h" -gt "$want_h" ]; then
    echo "  the chain is at $now_h, so this drill drops $((now_h - want_h)) block(s), which is exactly"
    echo "  the rollback that a restore would make you type a word for"
    printf 'type drill to go ahead: '
    read -r ANSWER || true
    echo
    if [ "$ANSWER" != "drill" ]; then
      echo "refusing: data/ was not touched" >&2
      exit 2
    fi
  fi
  echo "  what it replaces is kept as data.before-restore-<stamp>; nothing is deleted"
  echo
  DRILL=1 restore "${snap#"$DIR"/}"
  kept=$(ls -d "$DIR"/data.before-restore-*/ 2>/dev/null | sort | tail -1)
  echo
  echo "drill: the swap path works on this folder"
  echo "  compared: the archive's sha256 against its manifest, then every line of $(basename "$snap")/state.txt"
  if [ -n "$kept" ]; then
    echo "  kept:     $(basename "$kept")"
  else
    echo "  kept:     nothing -- there was no data/ to replace"
  fi
  echo "  recorded: .history names this a drill, so a shorter chain has its reason on file"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
case "${1:-}" in
  snapshot) shift; snapshot "${1:-}" ;;
  restore) shift; restore "${1:-}" ;;
  drill) drill ;;
  bundle) shift; bundle "${1:-}" ;;
  verify) shift; verify "${1:-}" ;;
  prune) shift; prune "$@" ;;
  *)
    echo "usage: ./chain.sh snapshot [name] | restore [snapshot-dir] | drill | bundle <path> | verify [dir|bundle]" >&2
    echo "  snapshot stops the main node, tars data/ with wallet backups, and starts it again" >&2
    echo "  restore swaps data/ for a snapshot, keeping the old one as data.before-restore-<stamp>" >&2
    echo "  drill does that same swap with the newest snapshot, on this folder, and says what it compared" >&2
    echo "  bundle writes one checksummed file outside this folder and reads it back to check it" >&2
    echo "  verify restores a snapshot, bundle or kept datadir in a scratch datadir and compares the state" >&2
    echo "  prune [--keep N] [--keep-kept N] lists and then deletes old snapshots and kept copies" >&2
    exit 2
    ;;
esac
fi
