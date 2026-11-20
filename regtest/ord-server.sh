#!/usr/bin/env bash
# ord server on 127.0.0.1:8080. Wallet commands talk to this, not straight to bitcoind.
#   ./ord-server.sh        start (detached) and wait until it answers
#   ./ord-server.sh stop   stop it, so `ord runes` / `ord balances` can take the index lock
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/ord-data/server.log"
ERR="$DIR/ord-data/server.err.log"
mkdir -p "$DIR/ord-data"

# The same lock chain.sh and rehearse.sh take. This script starts and stops the process that holds
# index.redb open, which is the file a rehearsal deletes and rebuilds, so it is not a bystanding
# reader: it belongs inside the lock, not beside it.
LOCK="$DIR/.lock"
lock_release() {
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
  [ "${REGTEST_LOCK_HELD:-}" = 1 ] && return 0   # rehearse holds it and calls this inside it
  if ! mkdir "$LOCK" 2>/dev/null; then
    pid=""; overb=""
    read -r pid overb <"$LOCK/owner" 2>/dev/null || true
    if [ -z "$pid" ]; then sleep 0.3; read -r pid overb <"$LOCK/owner" 2>/dev/null || true; fi
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "FAIL: $overb is running in this folder right now (pid $pid)." >&2
      echo "      It is using this folder's node, data/ and ord index," >&2
      echo "      so $verb will not start on top." >&2
      echo "      Wait for it to finish, or look at it: ps -p $pid" >&2
      exit 2
    fi
    echo "taking over a lock left by ${overb:-an earlier run} (pid ${pid:-unknown}), which is gone"
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null ||
      { echo "FAIL: another run took $LOCK at the same moment" >&2; exit 2; }
  fi
  printf '%s %s\n' "$$" "$verb" >"$LOCK/owner"
  trap cleanup EXIT
  trap 'cleanup 130' INT
  trap 'cleanup 143' TERM
  trap 'cleanup 129' HUP
}

lock_acquire "ord-server ${1:-start}"

is_up() { curl -s -m 2 http://127.0.0.1:8080/blockcount >/dev/null 2>&1; }

# Which ord processes are running, as "pid command-line". A PID alone is not something to act on:
# every ord.exe on the machine is one, and stopping "the first" is how another folder's server — or
# a sandbox — gets taken down instead of this one.
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

# One thing identifies this folder's server and nothing else's: the ord data it was pointed at.
# That path is what it locks, and no other checkout or sandbox can share it.
ord_owners() {
  local want_posix want_win line pid cmd norm
  want_posix=$(printf '%s' "$DIR/ord-data" | tr 'A-Z' 'a-z' | tr '\\' '/')
  want_win=""
  command -v cygpath >/dev/null 2>&1 &&
    want_win=$(printf '%s' "$(cygpath -w "$DIR/ord-data")" | tr 'A-Z' 'a-z' | tr '\\' '/')
  ord_procs | while IFS= read -r line; do
    pid=${line%% *}
    cmd=${line#* }
    # Whitespace around it, so a path is matched whole and not as a prefix of a longer one, and
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

if [ "${1:-}" = "stop" ]; then
  if ! is_up; then echo "ord server not running"; exit 0; fi
  OWNERS=$(ord_owners || true)
  COUNT=$(printf '%s' "$OWNERS" | grep -c . || true)
  if [ "$COUNT" -eq 0 ]; then
    echo "FAIL: something answers on 127.0.0.1:8080, but no ord process names this folder's" >&2
    echo "      ord data ($DIR/ord-data), so it is not ours to stop. Nothing was stopped: it is" >&2
    echo "      another folder's server or a sandbox. To see what owns the port:" >&2
    echo "      ps -W | grep -i ord.exe" >&2
    exit 2
  fi
  if [ "$COUNT" -gt 1 ]; then
    echo "FAIL: $COUNT ord processes name this folder's ord data; refusing to pick one:" >&2
    printf '%s\n' "$OWNERS" | sed 's/^/      /' >&2
    exit 2
  fi
  PID=${OWNERS%% *}
  taskkill //F //PID "$PID" >/dev/null 2>&1 || kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 10); do is_up || { echo "stopped (pid $PID)"; exit 0; }; sleep 1; done
  echo "stop requested but still answering (pid $PID)" >&2; exit 1
fi

if is_up; then
  echo "ord server already answering on 127.0.0.1:8080"
  exit 0
fi

# Windows has no -daemon for ord either, so detach with Start-Process; else nohup.
if command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command \
    "Start-Process -FilePath '$(cygpath -w "$DIR/bin/ord.exe")' -ArgumentList"\
" '--config','$(cygpath -w "$DIR/ord.yaml")','--chain','regtest','--index-runes',"\
"'--bitcoin-data-dir','$(cygpath -w "$DIR/data")','--data-dir',"\
"'$(cygpath -w "$DIR/ord-data")','server','--http','--http-port','8080',"\
"'--address','127.0.0.1' -WindowStyle Hidden"\
" -RedirectStandardOutput '$(cygpath -w "$LOG")'"\
" -RedirectStandardError '$(cygpath -w "$ERR")'" >/dev/null
else
  nohup "$DIR/bin/ord.exe" --config "$DIR/ord.yaml" --chain regtest --index-runes \
    --bitcoin-data-dir "$DIR/data" --data-dir "$DIR/ord-data" \
    server --http --http-port 8080 --address 127.0.0.1 >"$LOG" 2>&1 &
fi

for _ in $(seq 1 60); do
  if is_up; then
    UP_H=$(curl -s -m 5 http://127.0.0.1:8080/blockcount)
    echo "ord server up on 127.0.0.1:8080 (height $UP_H)"
    exit 0
  fi
  sleep 1
done

echo "ord server did not answer within 60s; see $ERR" >&2
exit 1
