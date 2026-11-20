#!/usr/bin/env bash
# One look at the pieces that have disagreed here before: the node, its wallets, the tip it had at
# the last check, the ord index, the ports the fee demo needs, whether the newest snapshot still
# covers the chain, and the datadirs restore has kept. The node was down earlier with the ord index
# five blocks ahead of it, and that
# was found by chance; the snapshot drifts the other way, one block per mined block, and nobody
# notices until it is needed.
#
# It starts and stops nothing, and writes one line of memory: .last-seen holds the tip it saw, so
# the next run can tell a chain that grew from a chain that was rewound to the same height on a
# different history. Where it reads the ord index depends on whether the server is up — the server
# owns the index lock, so with it running the questions go over HTTP, and with it down they go
# through ./ord, which opens the index directly. The down case is the one you most want an answer
# for, so it is not skipped; opening the index can take a few seconds and may replay a recovery.
#
# Exits 0 when every check holds, 1 when one does not (every finding is printed, not just the
# first), 2 when it could not look at all: no wrappers, no python to read the JSON with.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$DIR/bitcoin.conf"
MAIN_RPC=$(sed -n 's/^rpcport=//p' "$CONF" | head -n 1)   # asked of the config, not assumed
DEMO_RPC="${RPCPORT:-18543}"
DEMO_P2P="${P2PPORT:-18544}"
ORD_URL="http://127.0.0.1:8080"
RUNE_NAME=THROWAWAYTEST
RUNE_ID=112:1
RUNE_BLOCK=${RUNE_ID%%:*}   # 112: the rune cannot be indexed before this block exists
STATE="$DIR/.last-seen"     # the tip last seen here; a rewind reads as one, not as growth
SNAPS_DIR="$DIR/.snapshot"
HIST="$DIR/.history"        # one line per destructive run, so a lost chain can say what removed it

ORDEXE="$DIR/bin/ord.exe"   # the ord binary this folder calls for a server-down index read
. "$DIR/chain.sh"   # ord_index_blocks + the sparse-snapshot helpers status.sh reuses
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
bad() { printf '  BAD  %s\n' "$*"; problems=$((problems + 1)); }
note() { printf '  --   %s\n' "$*"; }
# Whose index answers on 127.0.0.1:8080? A server reports whatever folder it was started in, so a
# copy of this one (a sandbox, a second checkout) asks its question and gets the real folder's
# answer — the "index 115, node 3" that blamed a sandbox for a 112-block lead that was never its
# own. The test is the one ord-server.sh uses before it will stop anything: a live ord process
# whose command line names this folder's ord-data. Copied rather than shared, because the folder
# has no library file.
ord_procs() {
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command \
      "Get-CimInstance Win32_Process -Filter \"Name='ord.exe'\" |"\
" ForEach-Object { \"\$(\$_.ProcessId) \$(\$_.CommandLine)\" }" \
      2>/dev/null | tr -d '\r'
  else
    ps -axo pid=,args= 2>/dev/null || true
  fi
}
ord_owners() {   # "<pid> <command line>" for each ord process that names this folder's ord-data
  local want_posix want_win line pid cmd norm
  want_posix=$(printf '%s' "$DIR/ord-data" | tr 'A-Z' 'a-z' | tr '\\' '/')
  want_win=""
  command -v cygpath >/dev/null 2>&1 &&
    want_win=$(printf '%s' "$(cygpath -w "$DIR/ord-data")" | tr 'A-Z' 'a-z' | tr '\\' '/')
  ord_procs | while IFS= read -r line; do
    pid=${line%% *}
    cmd=${line#* }
    # Whitespace around the path, so it is matched whole and not as a prefix of a longer one, and
    # quotes dropped because a command line may or may not carry them.
    norm=$(printf ' %s ' "$cmd" | tr 'A-Z' 'a-z' | tr '\\' '/' | tr -d "\"'")
    case "$norm" in
      *" $want_posix "*) printf '%s %s\n' "$pid" "$cmd" ;;
      *)
        if [ -n "$want_win" ]; then
          case "$norm" in *" $want_win "*) printf '%s %s\n' "$pid" "$cmd" ;; esac
        fi
        ;;
    esac
  done
}

# What an archive is, and whether anything has proved it restores, in the order that makes the first
# true statement the one printed: is the file there, does its manifest say what it should be, is the
# file that, and what does the marker claim. Both the newest snapshot and every older one go through
# this under their own names, so the two cannot drift apart again — they had already, over which
# condition wins when the archive is missing.
snap_archive() {   # <dir> <label>
  local dir=$1 label=$2 pre="$2: " man when sha now verdict tail
  man=$(sed -n 's/^archive [0-9]* bytes, sha256 //p' "$dir/manifest.txt" 2>/dev/null || true)
  when=$(sed -n 's/^verified //p' "$dir/.verified" 2>/dev/null || true)
  sha=$(sed -n 's/^archive //p' "$dir/.verified" 2>/dev/null || true)
  # One word, decided once, and everything below reads it instead of re-deriving it: the marker tail
  # used to test -z "$now" for "the archive is gone", which is also true of a file that is merely
  # unreadable, and to repeat the manifest comparison the branch above had just made. A failing
  # sha256sum is its own verdict rather than the end of the run: under set -euo pipefail an
  # unguarded substitution would exit 1 with no message, as if a check had failed, and skip every
  # section after this one.
  now="" verdict=absent
  if [ -f "$dir/data.tar.gz" ]; then
    if now=$(sha256sum "$dir/data.tar.gz" | cut -d' ' -f1); then
      if [ -z "$man" ]; then verdict=nosum
      elif [ "$man" != "$now" ]; then verdict=changed
      else verdict=ok
      fi
    else
      now="" verdict=unreadable
    fi
  fi

  case $verdict in
    absent)
      bad "${pre}there is no data.tar.gz file here, so there is nothing to restore" ;;
    unreadable)
      bad "${pre}data.tar.gz is there but could not be read, so nothing here can judge it:"
      note "sha256sum refused it — a permission, or another process holding it open" ;;
    nosum)
      note "${pre}its manifest carries no checksum, so nothing here can check it — "\
"./chain.sh snapshot writes one that can be checked" ;;
    changed)
      bad "${pre}its archive is not the one the manifest recorded:"
      note "manifest ${man:0:16}…, on disk ${now:0:16}… — this is rot or a changed file,"\
" not an old backup" ;;
    ok)
      ok "${pre}its archive is the one the manifest recorded (sha256 ${man:0:16}…)" ;;
  esac

  # A checksum says the bytes are the ones written, not that they restore. verify() proves that in a
  # scratch node and leaves .verified; it only counts while the archive is still the file it proved.
  if [ -f "$dir/.verified" ]; then
    # The marker carries its own hash of what it proved, so it is judged against the file and not
    # against the manifest: a snapshot whose manifest predates checksums can still be proven. The
    # verdict only words a failure — a file that could not be read, not one that changed.
    if [ -n "$now" ] && [ "$sha" = "$now" ]; then
      note "${pre}proven to restore at ${when:-an unrecorded time} (./chain.sh verify)"
    else
      # What became of a proof that no longer holds, said per verdict so that a file which could not
      # be read is not reported as one that changed.
      case $verdict in
        absent) tail="its archive is gone" ;;
        unreadable) tail="the archive could not be read to compare" ;;
        *) tail="the archive has changed since" ;;
      esac
      note "${pre}was proven to restore at ${when:-an unrecorded time}, but $tail"
    fi
  elif [ "$verdict" = ok ]; then
    # The one verdict where a checksum was recorded, found, and matched: anywhere else this
    # sentence would claim a check that did not happen.
    note "${pre}checksum-checked only: ./chain.sh verify proves it restores, and records that here"
  fi
}

# What the journal says happened last — the reason a finding about missing blocks can point at, and
# on a clean run simply when the chain was last wiped or rolled back. `quiet` means: say nothing
# when there is no journal, since a run with nothing wrong should not complain about a missing file.
HIST_SAID=0
note_last_run() {
  if [ -f "$HIST" ]; then
    note "last recorded destructive run: $(tail -n 1 "$HIST")"
    HIST_SAID=1
  elif [ "${1:-}" != quiet ]; then
    note "no $(basename "$HIST") here, so nothing records what did this"
  fi
}

problems=0
# An ISO stamp to "3 hours", for notes about things that are read rather than judged.
age_of() {
  local then s
  then=$(date -u -d "$1" +%s 2>/dev/null) || return 0
  s=$(( $(date -u +%s) - then ))
  [ "$s" -ge 0 ] || s=0
  if [ "$s" -lt 120 ]; then echo "under 2 minutes"
  elif [ "$s" -lt 7200 ]; then echo "$((s / 60)) minutes"
  elif [ "$s" -lt 172800 ]; then echo "$((s / 3600)) hours"
  else echo "$((s / 86400)) days"
  fi
}

[ -x "$DIR/btc" ] && [ -x "$DIR/ord" ] ||
  { echo "FAIL: btc and ord wrappers are missing from $DIR" >&2; exit 2; }
command -v python >/dev/null 2>&1 ||
  { echo "FAIL: python is not on PATH, so the JSON from btc and ord cannot be read" >&2; exit 2; }

say "node"
HEIGHT=""
TIP=""
if ! "$DIR/btc" getblockchaininfo >/dev/null 2>&1; then
  bad "bitcoind is not answering on RPC $MAIN_RPC — ./start.sh"
  note "starts it; nothing below depends on it being up"
else
  HEIGHT=$("$DIR/btc" getblockcount | tr -d '\r')
  TIP=$("$DIR/btc" getbestblockhash | tr -d '\r')
  ok "height $HEIGHT, tip ${TIP:0:16}…"

  # v32 does not auto-load wallets, so "the chain is up" and "you can spend from it" are two
  # different facts: a wallet sitting in data/ and not in listwallets is invisible to getbalance.
  # tr -d '\r' because python on this platform ends even a piped print with CRLF, and a trailing
  # CR turns "rehearse" into a name no RPC will match.
  ON_DISK=$("$DIR/btc" listwalletdir | python -c '
import json, sys
print(" ".join(w["name"] for w in json.load(sys.stdin)["wallets"]))
' | tr -d '\r')
  LOADED=$("$DIR/btc" listwallets | python -c '
import json, sys
print(" ".join(json.load(sys.stdin)))
' | tr -d '\r')
  [ -n "$LOADED" ] ||
    bad "no wallet is loaded, so nothing can be spent from here; ./start.sh loads them"
  for w in $ON_DISK; do
    case " $LOADED " in
      *" $w "*) ;;
      *) bad "wallet $w is in data/ but not loaded — loadwallet $w, or ./start.sh" ;;
    esac
  done
  for w in $LOADED; do
    printf '       %-10s %s BTC\n' "$w" "$("$DIR/btc" -rpcwallet="$w" getbalance | tr -d '\r')"
  done
fi

say "chain history"
# A height on its own cannot see the failure the snapshot tool exists for: a hard stop loses a
# block, new blocks are mined back to the same height on a different history, and every number
# about the chain's size still looks right. So the tip is remembered and compared by descent: a
# tip that is known but off the main chain (confirmations -1) is a rewind, and a tip the node
# does not know at all means the blocks it was in are gone. Only a tip that agrees replaces the
# record, which is what makes a rewind keep being reported instead of being forgotten by the
# next run.
if [ -z "$HEIGHT" ]; then
  note "the node is down, so there is no tip to compare with $(basename "$STATE")"
elif [ ! -f "$STATE" ]; then
  note "first check: remembering height $HEIGHT, tip ${TIP:0:16}… to compare next time"
  printf 'height %s\ntip %s\n' "$HEIGHT" "$TIP" >"$STATE.new" && mv "$STATE.new" "$STATE"
else
  PREV_H=$(sed -n 's/^height //p' "$STATE")
  PREV_TIP=$(sed -n 's/^tip //p' "$STATE")
  ACCEPT=0
  if [ -z "$PREV_H" ] || [ -z "$PREV_TIP" ]; then
    note "$(basename "$STATE") has no height and tip to compare with; recording this run's instead"
    ACCEPT=1
  elif [ "$HEIGHT" -lt "$PREV_H" ]; then
    bad "the chain is $((PREV_H - HEIGHT)) block(s) below the last check:"
    note "was $PREV_H, now $HEIGHT — blocks were lost. Deliberate (a restore)?"
    note "rm $(basename "$STATE") to accept it"
    note_last_run
  else
    CONF=$("$DIR/btc" getblockheader "$PREV_TIP" 2>/dev/null | python -c '
import json, sys
try:
    c = json.load(sys.stdin).get("confirmations")
except Exception:
    sys.exit(0)
print(c if isinstance(c, int) else "")
' | tr -d '\r') || true
    if [ -z "$CONF" ]; then
      bad "the last-seen tip ${PREV_TIP:0:16}… (height $PREV_H) is not known to this node at all:"
      note "the blocks it was in are gone. If that was deliberate,"
      note "rm $(basename "$STATE") to accept it"
      note_last_run
    elif [ "$CONF" -lt 0 ]; then
      bad "the last-seen tip ${PREV_TIP:0:16}… is known but off the main chain: the chain runs on a"
      note "different branch at the same height, which a height alone cannot see."
      note "Deliberate? rm $(basename "$STATE") to accept the chain as it is"
      note_last_run
    elif [ "$PREV_TIP" = "$TIP" ]; then
      ok "tip unchanged since the last check (height $PREV_H, ${TIP:0:16}…)"
      ACCEPT=1
    else
      ok "height $HEIGHT builds on the last-seen block at $PREV_H (+$CONF confirmations)"
      ACCEPT=1
    fi
  fi
  if [ "$ACCEPT" = 1 ]; then
    printf 'height %s\ntip %s\n' "$HEIGHT" "$TIP" >"$STATE.new" && mv "$STATE.new" "$STATE"
  fi
fi
# Nothing wrong is still worth one line: when the chain was last wiped or rolled back.
[ "$HIST_SAID" = 1 ] || note_last_run quiet

say "ord"
IDX=""
IDX_H=""
RUNE=""
ORD_ERR=""
ORD_UNSURE=0
if command -v curl >/dev/null 2>&1 && curl -s -m 2 "$ORD_URL/blockcount" >/dev/null 2>&1; then
  ORD_OWN=$(ord_owners || true)
  ORD_N=$(printf '%s' "$ORD_OWN" | grep -c . || true)
  if [ "$ORD_N" -eq 0 ]; then
    ORD_UNSURE=1
    note "a server answers on $ORD_URL, but no ord process names this folder's ord-data, so the"
    note "index it reports is another folder's: no height is reported rather than a wrong one"
    note "(a copy of this folder reaching the original's server is the usual way this happens)"
  elif [ "$ORD_N" -gt 1 ]; then
    ORD_UNSURE=1
    note "$ORD_N ord processes name this folder's ord-data, so which one serves"
    note "$ORD_URL cannot be told:"
    printf '%s\n' "$ORD_OWN" | sed 's/^/  --   /'
  else
    note "server up on $ORD_URL (pid ${ORD_OWN%% *} names this folder's ord-data)"
    IDX=$(curl -s -m 5 "$ORD_URL/blockcount" | tr -d '\r\n "')
    RUNE=$(curl -s -m 5 -H 'Accept: application/json' "$ORD_URL/rune/$RUNE_NAME" | python -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(json.dumps(d) if "id" in d else "")
' 2>/dev/null) || true
  fi
else
  note "server is not answering on $ORD_URL, so the index is read from ord-data, on port"
  note "${MAIN_RPC:-18443} — this folder's own, not the ./ord wrapper's default"
  ord_index_blocks 120
  IDX=$ORD_BLOCKS_DISK
  ORD_ERR=$ORD_WHY
  ERR=$(mktemp)
  RUNEOF=$(mktemp)
  IDX=$(timeout 120 "$ORDEXE" --chain regtest     --bitcoin-rpc-url "http://127.0.0.1:${MAIN_RPC:-18443}"     --bitcoin-data-dir "$(winp "$DIR/data")" --data-dir "$(winp "$DIR/ord-data")"     index info 2>"$ERR" | grep -o '"blocks_indexed": [0-9]*' | grep -o '[0-9]*$') || true
  RUNE=$( (timeout 120 "$ORDEXE" --chain regtest     --index-runes --bitcoin-rpc-url "http://127.0.0.1:${MAIN_RPC:-18443}"     --bitcoin-data-dir "$(winp "$DIR/data")" --data-dir "$(winp "$DIR/ord-data")"     runes) >"$RUNEOF") 2>"$ERR" || true
  RUNE=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1])).get("runes",{});print(json.dumps(d[sys.argv[2]]) if sys.argv[2] in d else "")' "$RUNEOF" "$RUNE_NAME" 2>/dev/null) || true
  ORD_ERR=$(tr -d '
' <"$ERR" | head -n 2 | tr '
' ' ')
  rm -f "$RUNEOF"
  rm -f "$ERR"
fi

if [ "$ORD_UNSURE" = 1 ]; then
  :   # already said why, and a height from a stranger is worse than none
elif [ -z "$IDX" ]; then
  bad "the ord index could not be read${ORD_ERR:+: $ORD_ERR}"
else
  # ord counts blocks, not heights: a tip at height 113 is 114 blocks, and both /blockcount and
  # index info report 114. Subtracting once here is what keeps "two blocks ahead" from meaning
  # three, and what made the index's 119 the five-block lead it was. Clamped at zero, because an
  # index with nothing in it has no height and "height -1" is not a thing to print.
  IDX_H=$((IDX > 0 ? IDX - 1 : 0))
  if [ "$IDX" -eq 0 ]; then
    note "the index is empty (0 blocks): ./ord-server.sh indexes it from genesis"
  elif [ -z "$HEIGHT" ]; then
    note "index height $IDX_H; no node height to compare it with"
  elif [ "$IDX_H" -gt "$HEIGHT" ]; then
    bad "the ord index is $((IDX_H - HEIGHT)) block(s) AHEAD of bitcoind:"
    note "index $IDX_H, node $HEIGHT. It saw blocks the node no longer has. Rebuild it, which"
    note "leaves the ord wallet alone:"
    note "./ord-server.sh stop && rm ord-data/regtest/index.redb && ./ord-server.sh"
  elif [ "$IDX_H" -lt "$HEIGHT" ]; then
    note "the index is $((HEIGHT - IDX_H)) block(s) behind (index $IDX_H, node $HEIGHT);"
    note "it catches up itself"
  else
    ok "ord index height matches bitcoind ($IDX_H)"
  fi
fi

if [ -z "$RUNE" ]; then
  # Only a finding if the index could be read *and* has reached the etch: an index that stops before
  # block 112 cannot know this rune, and reporting that as "ord does not know it" would send you
  # looking for a lost rune instead of a short index.
  if [ -z "$IDX" ] && [ "$ORD_UNSURE" = 1 ]; then
    note "rune $RUNE_ID not checked: the server answering is not this folder's index"
  elif [ -z "$IDX" ]; then
    note "rune $RUNE_ID not checked: the index could not be read"
  elif [ "$IDX_H" -lt "$RUNE_BLOCK" ]; then
    note "rune $RUNE_ID not checked: the index reaches height $IDX_H, short of block $RUNE_BLOCK"
  else
    bad "ord does not know rune $RUNE_ID ($RUNE_NAME)"
  fi
else
  read -r RID RSUP < <(printf '%s' "$RUNE" | python -c '
import json, sys

d = json.load(sys.stdin)
entry = d.get("entry", d)   # the server wraps the rune in an entry, the CLI does not
amount = (entry.get("terms") or {}).get("amount") or 0
print(d.get("id") or entry.get("id") or "?",
      d.get("supply") if d.get("supply") is not None
      else entry.get("premine", 0) + entry.get("mints", 0) * amount)
' | tr -d '\r')
  if [ "$RID" = "$RUNE_ID" ]; then
    ok "rune $RUNE_ID $RUNE_NAME, supply $RSUP"
  else
    bad "ord puts $RUNE_NAME at $RID, expected $RUNE_ID"
  fi
fi

say "demo ports"
# The demo's ports are fixed, so anything listening there turns a later run into "the node did not
# start" instead of "the port is taken". Checked here so that is never the first you hear of it.
BUSY=$(netstat -ano 2>/dev/null | grep -E ":($DEMO_RPC|$DEMO_P2P) " |
  grep -i LISTENING | head -n 3) || true
if [ -z "$BUSY" ]; then
  ok "$DEMO_RPC and $DEMO_P2P are free for mempool-demo.sh and parity.sh"
else
  bad "$DEMO_RPC/$DEMO_P2P already listening, so a demo run would fail to bind:"
  printf '%s\n' "$BUSY" | sed 's/^/       /'
fi

say "snapshot"
# The snapshot tool exists for one failure mode: a backup nobody refreshed. The newest *complete*
# one is what restore would pick, so that is what the chain is measured against — a directory
# left behind by a run that failed before writing its manifest is not a candidate, exactly as in
# chain.sh.
NEW=""
for d in "$DIR"/.snapshot/*/; do
  [ -f "$d/manifest.txt" ] && [ -f "$d/state.txt" ] && NEW=$d
done
if [ -z "$NEW" ]; then
  bad "no complete snapshot in .snapshot/ — ./chain.sh snapshot"
else
  NEW_NAME=$(basename "$NEW")
  SNAP_H=$(sed -n 's/^height //p' "$NEW/state.txt")
  SNAP_WHEN=$(sed -n 's/^created \([^ ]*\) .*/\1/p' "$NEW/manifest.txt")
  # A height in state.txt says what the snapshot is of. It says nothing about the archive still
  # being that archive: a truncated copy, a half-written tar or a bit rot all leave state.txt
  # intact and the height matching. The archive and its marker are judged by the same function the
  # older snapshots use, so this path adds only what is genuinely its own: the height comparison
  # below.
  snap_archive "$NEW" "$NEW_NAME"
  if [ -z "$SNAP_H" ]; then
    bad "$NEW_NAME has no height in its state.txt, so it cannot be checked against the chain"
  elif [ -z "$HEIGHT" ]; then
    note "newest snapshot takes the chain to height $SNAP_H; no node height to compare it with"
  elif [ "$HEIGHT" -gt "$SNAP_H" ]; then
    bad "the newest snapshot $NEW_NAME is $((HEIGHT - SNAP_H)) block(s) behind the chain"
    note "(snapshot $SNAP_H, node $HEIGHT, taken ${SNAP_WHEN:-an unrecorded time}):"
    note "it does not hold what the node holds now."
    note "./chain.sh snapshot, which stops and restarts the node"
  elif [ "$SNAP_H" -gt "$HEIGHT" ]; then
    note "the snapshot is $((SNAP_H - HEIGHT)) block(s) ahead of the chain"
    note "(snapshot $SNAP_H, node $HEIGHT): this node has fewer blocks than it did, and restore"
    note "would ask you to type rollback"
  else
    ok "newest snapshot $NEW_NAME is at the chain's height ($SNAP_H), ${SNAP_WHEN:-undated}"
  fi

  # Anything older is the fallback for the day the newest one is the thing that broke, and a
  # fallback nobody has restored once is a hypothesis. Said as a note, not a failure: proving one
  # is a run (`verify`), not a property the folder can give itself.
  OLDER=0
  for d in "$SNAPS_DIR"/*/; do
    [ -f "$d/manifest.txt" ] && [ -f "$d/state.txt" ] || continue
    [ "${d%/}" = "${NEW%/}" ] && continue
    OLDER=$((OLDER + 1))
    snap_archive "${d%/}" "$(basename "${d%/}")"
  done
  if [ "$OLDER" -eq 0 ]; then
    note "no snapshot older than the newest: one backup, and nothing to fall back on if it is"
    note "the one that fails — ./chain.sh snapshot keeps another"
  fi
fi

say "kept datadirs"
# restore keeps the data/ it replaces and deletes none of them, so every rollback leaves a full copy
# of a datadir — wallet keys included. Said, never judged: keeping one is how a restore is undone.
KEPT=0
for d in "$DIR"/data.before-restore-*/; do
  [ -d "$d" ] || continue
  d=${d%/}   # no trailing slash: the .txt that goes with it is a sibling, not a child
  KEPT=$((KEPT + 1))
  KEPT_WHEN="" KEPT_H="" KEPT_TIP=""
  if [ -f "$d.txt" ]; then
    KEPT_WHEN=$(sed -n 's/^kept //p' "$d.txt")
    KEPT_H=$(sed -n 's/^height //p' "$d.txt")
    KEPT_TIP=$(sed -n 's/^tip //p' "$d.txt")
  fi
  # A copy with no .txt, or a .txt with a timestamp nothing can read, still has the time it was
  # written on disk.
  [ -n "$KEPT_WHEN" ] || KEPT_WHEN=$(date -u -r "$d" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
  AGE=$(age_of "$KEPT_WHEN")
  if [ -n "$AGE" ]; then AGE="$AGE old"; else AGE="age unknown"; fi
  if [ -n "$KEPT_H" ]; then
    HELD="held height $KEPT_H${KEPT_TIP:+, tip ${KEPT_TIP:0:16}…}"
  else
    HELD="height not recorded"
  fi
  note "$(basename "$d"): $AGE, $HELD"
done
if [ "$KEPT" -eq 0 ]; then
  note "none: a restore keeps the data/ it replaces, and none has been kept here"
else
  note "kept copies: $KEPT, each a full data/ with its wallets — delete the ones you do not need"
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "all checks passed"
  exit 0
fi
echo "$problems check(s) failed"
exit 1



