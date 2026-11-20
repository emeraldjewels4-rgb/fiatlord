#!/usr/bin/env bash
# Does the demo really give the same numbers on both platform paths?
#
# The README says both paths are exercised "with the same numbers". This runs block mode and pool
# mode twice — once through Windows (Start-Process) and once through WSL1 (nohup) — and compares
# the lines that carry the claims. One list of patterns decides both what must be printed and what
# is compared, so a renamed or dropped claim fails by name instead of quietly shrinking the
# comparison. Lines containing txids are not compared, since those cannot match by design.
#
#   ./parity.sh                  # both modes, about three minutes
#   MODES=pool ./parity.sh       # just one mode
#   WSL_DISTRO=Debian ./parity.sh
#   RUN_TIMEOUT=600 ./parity.sh  # a run that wedges on its node is killed after 300s by default
#
# Refuses to start, with exit 2, when 18543/18544 are already listening: the demo's ports are fixed,
# so a stray node there would otherwise read as "the node did not start" or as a leak.
#
# Exits 0 when both paths agree, 1 when a claim is false or the two disagree, 2 when this check could
# not run at all — the same distinction mempool-demo.sh makes.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISTRO="${WSL_DISTRO:-Ubuntu-24.04}"
MODES="${MODES:-block pool}"
RUN_TIMEOUT="${RUN_TIMEOUT:-300}"     # slower than any honest run: 81s is the worst seen under load
RPCPORT="${RPCPORT:-18543}"           # what the demo uses unless told otherwise
P2PPORT="${P2PPORT:-18544}"

# Same contract as the demo, and it is passed through: 0 both paths agree, 1 a claim came out false
# or the paths disagree, 2 this check could not run (no distro, no timeout, ports already taken, a
# run that would not start, a wedged run). That difference is the whole point of having two codes.
fail() { echo "FAIL: $*" >&2; exit 1; }
envfail() { echo "FAIL: $*" >&2; exit 2; }

[ -x "$DIR/mempool-demo.sh" ] || envfail "no executable mempool-demo.sh beside this script"
command -v wsl.exe >/dev/null 2>&1 ||
  envfail "wsl.exe is not on PATH, so there is only one platform path to run"
command -v timeout >/dev/null 2>&1 ||
  envfail "coreutils timeout is not on PATH, so a wedged run could not be stopped"
WSLDIR=$(wsl.exe -d "$DISTRO" -e wslpath -a "$(cygpath -w "$DIR")" 2>/dev/null | tr -d '\r') ||
  envfail "cannot reach the '$DISTRO' distro; set WSL_DISTRO to one that exists"
[ -n "$WSLDIR" ] || envfail "wslpath gave no path for $DIR inside $DISTRO"

# Whatever is listening on the demo's fixed ports, one line each. One view is enough even though the
# demo runs on both paths: WSL1 shares Windows' network stack, and a listener opened inside the
# distro does show up here (measured, not assumed) while /proc/net/tcp inside WSL1 is empty.
busy_ports() {
  netstat -ano 2>/dev/null | grep -E ":($RPCPORT|$P2PPORT) " | grep -i LISTENING | head -n 3 || true
}

# The demo uses fixed ports, so a process already holding one does not surface as "the port is
# busy": the run cannot bind and says "node did not start", and another check's node looks like a
# leak this check caused. Ask before the first run, in those terms.
busy=$(busy_ports)
if [ -n "$busy" ]; then
  echo "FAIL: ports $RPCPORT/$P2PPORT are already listening, so a run would fail to bind" >&2
  echo "rather than show anything. Stop that process, or set RPCPORT/P2PPORT if it is not this" >&2
  echo "demo's:" >&2
  printf '%s\n' "$busy" | sed 's/^/  /' >&2
  exit 2
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

run() {   # run <windows|wsl1> <mode>
  local where=$1 mode=$2 out="$TMP/$1-$2.txt" rc=0 leak
  # -k 5 so a demo that ignores TERM, or a node that holds its parent, still gets killed 5s later.
  case "$where" in
    windows) ( cd "$DIR" && exec timeout -k 5 "$RUN_TIMEOUT" env MODE="$mode" ./mempool-demo.sh ) >"$out" 2>&1 || rc=$? ;;
    wsl1)    wsl.exe -d "$DISTRO" -e bash -lc "cd '$WSLDIR' && timeout -k 5 $RUN_TIMEOUT env MODE=$mode ./mempool-demo.sh" >"$out" 2>&1 || rc=$? ;;
  esac
  [ "$rc" = 0 ] && return 0
  # 124 is timeout's own status: the demo never finished, so there is no verdict to report, only the
  # wedge — and what it may have left behind, since its node outlives the script.
  if [ "$rc" = 124 ]; then
    leak=$(leaks)
    envfail "the $mode run under $where hit the ${RUN_TIMEOUT}s timeout and was killed${leak:+; $leak}"
  fi
  # The demo's own FAIL line is not reliably in the tail: its stdout is buffered into this file while
  # the complaint goes to stderr, so the reason can land above the last lines. Print the complaints
  # first, then the tail for context.
  grep -a '^FAIL' "$out" | tr -d '\r' | tail -n 3 >&2 || true
  grep -av '^FAIL' "$out" | tr -d '\r' | tail -n 15 >&2 || true
  # The demo's own codes are passed through: 1 means it ran and a claim was false, anything else
  # (2, or a shell failure) means it never got far enough to have an opinion.
  [ "$rc" = 1 ] || envfail "the $mode run under $where could not run (exit $rc); see above"
  fail "a claim came out false in the $mode run under $where; see above"
}

# Every claim the demo must print for a mode, one pattern per line.
expected() {   # expected <mode>
  case "$1" in
    block) cat <<'EOF'
^mempool: [0-9]+ txs, all unconfirmed
^template: [0-9]+ txs, from [0-9]+ in the mempool
^[0-9]+ txs were left out: valid, fee-paying, and outbid
^block [0-9]+: .* of our txs confirmed
^cutoff: cheapest confirmed .* sat/vB, most expensive still waiting .* sat/vB
^stuck tx pays [0-9.]+ sat/vB over .* vB
^after one more block: replacement confirmations [0-9]+,
^parent pays [0-9.]+ sat/vB over .* vB and waits
^before mining: package of two pays .* sat/vB over .* vB
^after mining: both in block [0-9]+, package pays .* sat/vB over .* vB
EOF
      ;;
    pool) cat <<'EOF'
^[0-9]+ of [0-9]+ txs are still there, paying .*
^evicted \([0-9]+\): .*
^the pool is full, so what survives is exactly the top of the fee range
^a fresh 1 sat/vB tx is refused; the pool now demands [0-9.]+ sat/vB
EOF
      ;;
  esac
}

# Three things are redacted rather than compared, for one reason: an ECDSA signature is 70-72 bytes,
# so the same txs serialize a little differently between runs. That made one path's block 4815
# weight units against 4813, a two-tx package 251 vB against 250, and the parent's own rate 1.01
# against 1.00 — its fee is sized from an estimated vsize, so the printed rate carries a hundredth
# of rounding that moves with the real one. Counts and whole-sat rates are the claims; the bytes
# behind them are not, and the child's own rate is left out entirely, the package lines carry that.
claims() {   # claims <patterns-file> <output-file>
  grep -aEf "$1" "$2" | tr -d '\r' |
    sed -E -e 's/^(block [0-9]+: )[0-9]+( weight)/\1N\2/' \
           -e 's/ sat\/vB over [0-9]+ vB/ sat\/vB over N vB/' \
           -e 's/^(stuck tx|parent) pays ([0-9]+)\.[0-9]+/\1 pays \2/' || true
}

# A run that leaves its node behind wedges every later run, and that has happened twice here by
# hand. Reports what is still there and nothing when the run cleaned up: no listener on the demo's
# ports, no datadir left to find (the demo's stop_node only returns once that directory stays gone).
# A timeout is checked the same way, because the node is detached and does not die with the script.
leaks() {
  local busy out=""
  busy=$(busy_ports)
  [ -z "$busy" ] || out="still listening: $busy"
  [ ! -d "$DIR/.demo/node" ] || out="${out:+$out; }.demo/node is still there"
  printf '%s' "$out"
}

failed=0
for mode in $MODES; do
  expected "$mode" >"$TMP/$mode.patterns"
  [ -s "$TMP/$mode.patterns" ] || envfail "no expected claims are defined for mode '$mode'"
  want=$(wc -l <"$TMP/$mode.patterns" | tr -d ' ')
  for where in windows wsl1; do
    start=$(date +%s)
    run "$where" "$mode"
    echo "  $where $mode: ok in $(( $(date +%s) - start ))s"
    leak=$(leaks)
    [ -z "$leak" ] || envfail "after the $mode run under $where: $leak"
    while IFS= read -r pat; do
      grep -aqE "$pat" "$TMP/$where-$mode.txt" ||
        fail "the $mode run under $where never printed a line matching: $pat"
    done <"$TMP/$mode.patterns"
    claims "$TMP/$mode.patterns" "$TMP/$where-$mode.txt" >"$TMP/$where-$mode.claims"
    have=$(wc -l <"$TMP/$where-$mode.claims" | tr -d ' ')
    [ "$have" -eq "$want" ] ||
      fail "the $mode run under $where matched $have lines for $want claims; one claim is printing twice"
  done
  if diff -u --label windows --label wsl1 \
      "$TMP/windows-$mode.claims" "$TMP/wsl1-$mode.claims" >"$TMP/$mode.diff"; then
    echo "$mode: same numbers on both paths, $want of $want claims compared"
  else
    cat "$TMP/$mode.diff" >&2
    echo "FAIL: $mode numbers differ; '-' is Windows, '+' is WSL1" >&2
    failed=1
  fi
done
exit "$failed"
