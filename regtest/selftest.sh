#!/usr/bin/env bash
# Do the safety gates still hold?
#
# Every guarantee this folder makes about destructive verbs is a property of the scripts, and no
# property survives an edit by itself: move one `read` earlier, reorder the two renames, add an early
# return, and the gate is gone with nothing to notice. This builds a throwaway copy of the folder in
# a temp directory, works it like a real one, and asserts the behaviours the README claims — by
# looking at exit codes and at what happened to data/, not at what was printed.
#
#   ./selftest.sh                 # about three minutes: one node, five blocks, eight cases
#   KEEP=1 ./selftest.sh          # leave the temp folder behind for inspection
#
# Each case prints ok or BAD with the value it measured, so a failure says what changed rather than
# that something did. Assertions are exit codes, the presence or absence of a file, or the byte
# content of one, with one exception: case 7 reads status.sh's report. status.sh's output *is* its
# product, and the branch order that decides which line a bad snapshot gets is invisible in an exit
# code — a missing archive, a mismatched one and an unreadable one all exit 1. That case greps six
# short phrases, one per verdict, and says so where it does it. Everywhere else a message can be
# reworded while the behaviour behind it changes, and a test that greps prose passes on a sentence
# describing a gate that no longer exists. Refuses to start, with exit 2, when 18643/18644 are
# listening: the copy uses those ports, and a stray node there would read as a gate that failed.
#
# Exits 0 when every case held, 1 when one did not, 2 when this check could not run at all — the same
# distinction chain.sh, parity.sh and mempool-demo.sh make.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RPCPORT="${RPCPORT:-18643}"     # chain.sh verify's default, and the copy's node
P2PPORT="${P2PPORT:-18644}"
KEEP="${KEEP:-0}"

envfail() { echo "FAIL: $*" >&2; exit 2; }
PASSED=0
FAILED=0
ok() { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$*"; }
bad() { FAILED=$((FAILED + 1)); printf '  BAD  %s\n' "$*"; }
say() { printf '\n== %s\n' "$*"; }

busy=$(netstat -ano 2>/dev/null | grep -E ":($RPCPORT|$P2PPORT) " | grep -i LISTENING | head -n 3 || true)
if [ -n "$busy" ]; then
  echo "FAIL: ports $RPCPORT/$P2PPORT are already listening, so the copy's node could not bind and" >&2
  echo "      every case below would report the wrong reason:" >&2
  printf '%s\n' "$busy" | sed 's/^/  /' >&2
  exit 2
fi

ROOT=$(mktemp -d) || envfail "mktemp cannot make a working directory"
SB="$ROOT/regtest"          # the throwaway copy, addressed as if it were a folder of its own
mkdir -p "$SB"

stop_copy() { ( cd "$SB" 2>/dev/null && ./stop.sh >/dev/null 2>&1 ) || true; }
# The folder holds a datadir and its wallets, so leaving it behind on purpose has to be a choice.
# Windows keeps a handle for a moment after the node exits, so removal is retried rather than
# reported as done when it did not happen.
finish() {
  stop_copy
  if [ "$KEEP" = 1 ]; then
    echo
    echo "kept: $SB"
    return 0
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    rm -rf "$ROOT" 2>/dev/null && return 0
    sleep 0.5
  done
  echo "note: $ROOT could not be removed yet (a handle is still open); remove it by hand" >&2
}
trap finish EXIT

# bin/ holds both bitcoind and bitcoind.exe, and to NTFS those are one name: copying the directory
# wholesale copies the extensionless (Linux) binary over the .exe, and the node then fails as "not a
# valid application for this OS platform". Only the .exe files are copied, by name.
mkdir -p "$SB/bin"
for b in bitcoind.exe bitcoin-cli.exe ord.exe; do
  cp "$DIR/bin/$b" "$SB/bin/$b" || envfail "cannot copy bin/$b into the throwaway folder"
done
for f in start.sh stop.sh btc chain.sh status.sh rehearse.sh ord ord.yaml bitcoin.conf \
  ord-server.sh; do
  cp "$DIR/$f" "$SB/$f" || envfail "cannot copy $f into the throwaway folder"
done
chmod +x "$SB"/*.sh "$SB/btc" "$SB/ord"
# The copy gets its own ports, so it can run beside the real folder and beside anything else here.
sed -i "s/18443/$RPCPORT/g; s/18444/$P2PPORT/g" "$SB/bitcoin.conf"

cd "$SB"
./start.sh >/dev/null 2>&1 || envfail "the throwaway node would not start; see $SB"
./btc createwallet w >/dev/null 2>&1 || envfail "the throwaway node would not make a wallet"
ADDR=$(./btc -rpcwallet=w getnewaddress | tr -d '\r') || envfail "the throwaway wallet has no address"
./btc -rpcwallet=w generatetoaddress 3 "$ADDR" >/dev/null || envfail "cannot mine on the throwaway node"
./chain.sh snapshot s1 >/dev/null 2>&1 || envfail "cannot snapshot the throwaway chain"
./btc -rpcwallet=w generatetoaddress 2 "$ADDR" >/dev/null || envfail "cannot mine on the throwaway node"
H5=$(./btc getblockcount | tr -d '\r')
[ "$H5" = 5 ] || envfail "the throwaway chain is at $H5, not the 5 blocks this check needs"

# "Untouched" has to be a measurement, and the whole datadir cannot be one: bitcoind rewrites its
# own bookkeeping on every start and stop (leveldb logs, mempool.dat, peers.dat, wallet dbs), so a
# digest of the tree changes when nothing was restored. What a restore actually replaces is asserted
# instead, three ways that are each stable across a start/stop cycle: the block files byte for byte
# (measured stable above, which is why they are the ones used), the chain's tip, and every wallet's
# name and balance. The node is stopped to read the block files, because Windows refuses to read what
# it holds open.
digest_blocks() {   # the chain itself, byte for byte
  ( cd data/regtest 2>/dev/null && find . -maxdepth 1 -type f \( -name 'blk*.dat' -o -name 'rev*.dat' \) \
    -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 )
}
chain_view() { printf '%s %s\n' "$(./btc getblockcount | tr -d '\r')" "$(./btc getbestblockhash | tr -d '\r')"; }
wallet_view() {   # what a wrong restore would move: which wallets, and what is in them
  ./btc -rpcwallet= listwallets | tr -d '[]" \r' | tr ',' '\n' | sed '/^$/d' |
    while read -r w; do printf '%s %s\n' "$w" "$(./btc -rpcwallet="$w" getbalance | tr -d '\r')"; done
}
node_stop() { ./stop.sh >/dev/null 2>&1 || envfail "cannot stop the throwaway node"; }
node_start() { ./start.sh >/dev/null 2>&1 || envfail "cannot start the throwaway node"; }
count_snaps() { find .snapshot -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' '; }

########################################
say "1. restore without the word rollback"
snap_sha=$(sha256sum .snapshot/s1/data.tar.gz | cut -d' ' -f1)
node_stop; blk_before=$(digest_blocks); node_start
chain_before=$(chain_view); wallets_before=$(wallet_view)
rc=0
printf 'no\n' | ./chain.sh restore .snapshot/s1 >"$ROOT/restore.out" 2>&1 || rc=$?
chain_after=$(chain_view); wallets_after=$(wallet_view)
node_stop; blk_after=$(digest_blocks); node_start
leftover=$(find . -maxdepth 1 -name 'data.before-restore-*' 2>/dev/null | wc -l | tr -d ' ')
[ "$rc" = 2 ] && ok "restore refused with exit 2" || bad "restore exited $rc, not 2"
[ ! -e .restore.tmp ] && ok "it left no staging directory (.restore.tmp)" ||
  bad ".restore.tmp is on disk after a refusal"
[ "$(sha256sum .snapshot/s1/data.tar.gz | cut -d' ' -f1)" = "$snap_sha" ] &&
  ok "the snapshot it was asked to restore is byte-identical" ||
  bad "the snapshot's archive changed during a refused restore"
[ "$blk_before" = "$blk_after" ] && ok "the block files are byte-identical after the refusal" ||
  bad "block files changed: $blk_before -> $blk_after"
[ "$chain_before" = "$chain_after" ] && ok "the tip is unchanged ($chain_after)" ||
  bad "the tip moved: $chain_before -> $chain_after"
[ "$wallets_before" = "$wallets_after" ] && ok "every wallet's balance is unchanged" ||
  bad "wallets changed: $wallets_before -> $wallets_after"
[ "$leftover" = 0 ] && ok "no data.before-restore-* was created" ||
  bad "$leftover data.before-restore-* left behind by a refusal"


########################################
say "2. prune without the word prune"
./chain.sh snapshot s2 >/dev/null 2>&1 || envfail "cannot snapshot a second time"
./chain.sh snapshot s3 >/dev/null 2>&1 || envfail "cannot snapshot a third time"
n_before=$(count_snaps)
rc=0
printf 'no\n' | ./chain.sh prune --keep 1 >"$ROOT/prune.out" 2>&1 || rc=$?
n_after=$(count_snaps)
[ "$rc" = 2 ] && ok "prune refused with exit 2" || bad "prune exited $rc, not 2"
[ "$n_before" = "$n_after" ] && ok "all $n_after snapshots are still there" ||
  bad "snapshot count went from $n_before to $n_after"
[ "$n_before" = 3 ] || bad "the setup made $n_before snapshots, not 3"

########################################
say "3. rehearse without the word wipe"
node_stop; blk_before=$(digest_blocks); node_start
chain_before=$(chain_view)
n_before=$(count_snaps)
rc=0
printf 'no\n' | ./rehearse.sh >"$ROOT/rehearse.out" 2>&1 || rc=$?
chain_after=$(chain_view)
node_stop; blk_after=$(digest_blocks); node_start
[ "$rc" = 2 ] && ok "rehearse refused with exit 2" || bad "rehearse exited $rc, not 2"
[ "$blk_before" = "$blk_after" ] && ok "the block files are byte-identical after the refusal" ||
  bad "block files changed: $blk_before -> $blk_after"
[ "$chain_before" = "$chain_after" ] && ok "the tip is unchanged ($chain_after)" ||
  bad "the tip moved: $chain_before -> $chain_after"
[ "$(count_snaps)" = "$n_before" ] && ok "it took no snapshot before the word" ||
  bad "a snapshot was taken before the word was given"

########################################
say "4. a corrupted archive"
cp -r .snapshot/s1 .snapshot/bad
printf 'X' | dd of=.snapshot/bad/data.tar.gz bs=1 seek=3000 conv=notrunc 2>/dev/null
rc=0
./chain.sh verify .snapshot/bad >"$ROOT/verify.out" 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "verify exited 1 on an archive that does not match its manifest" ||
  bad "verify exited $rc, not 1"
[ ! -f .snapshot/bad/.verified ] && ok "no .verified marker was written for it" ||
  bad "a .verified marker was written for an archive that failed"
[ ! -d .verify.tmp ] && ok "its scratch datadir was removed" || bad ".verify.tmp is left behind"

########################################
say "5. a lock that is held, and one left by a run that is gone"
# Held by something that is really running: the next run must refuse and do nothing at all.
mkdir -p .lock
sleep 30 & LIVE=$!
printf '%s snapshot\n' "$LIVE" >.lock/owner
rc=0
./chain.sh snapshot s4 >"$ROOT/live.out" 2>&1 || rc=$?
[ "$rc" = 2 ] && ok "a held lock refuses the next run with exit 2" || bad "it exited $rc, not 2"
[ ! -d .snapshot/s4 ] && ok "and nothing was written (no s4)" || bad "s4 exists despite a held lock"
kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null || true
# Now the same lock from a process that is gone: it has to be taken over, not obeyed for ever.
printf '999999 snapshot\n' >.lock/owner
rc=0
./chain.sh snapshot s4 >"$ROOT/lock.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "a lock left by a gone process lets the run through (exit 0)" ||
  bad "the next run exited $rc, not 0"
[ -f .snapshot/s4/manifest.txt ] && ok "that run completed: s4 has a manifest" ||
  bad "s4 has no manifest, so the takeover did not go on"
[ ! -d .lock ] && ok "the lock was released afterwards" || bad ".lock is still there"

########################################
say "6. a swap killed between the two renames"
# The two renames are what a restore is: data/ becomes data.before-restore-<stamp>, then the staged
# copy becomes data/. Between them there is no data/ at all, and the guard exists for exactly that
# window. To test it deterministically the copy is killed *inside* the window rather than raced.
cp chain.sh chain.sh.killed
python - "$SB/chain.sh.killed" <<'PY' || envfail "cannot instrument the copy of chain.sh"
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
# The first of the two renames, whatever surrounds it. Matched on the move itself and not on the
# shape of the line around it: that line has already been rewritten once (the kept datadir grew a
# manifest beside it) and a check that hunts for a whole statement fails for a reason that has
# nothing to do with what it is testing. Exactly one occurrence, or this stops rather than guesses.
needle = 'mv "$DATA" "$before"'
if text.count(needle) != 1:
    sys.exit("the first rename is not where this check expects it (found %d)" % text.count(needle))
line_start = text.rindex("\n", 0, text.index(needle)) + 1
line_end = text.index("\n", text.index(needle)) + 1
line = text[line_start:line_end]
indent = line[:len(line) - len(line.lstrip())]
kill = indent + "kill -TERM $$   # the drill: die in the window where there is no data/ at all\n"
open(path, "w", encoding="utf-8", newline="\n").write(text[:line_end] + kill + text[line_end:])
PY
chmod +x chain.sh.killed
rc=0
printf 'rollback\n' | timeout 120 ./chain.sh.killed restore .snapshot/s1 >"$ROOT/swap.out" 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "the run died mid-swap (exit $rc)" || bad "the run exited 0; it was supposed to be killed"
[ -d data ] && ok "data/ exists afterwards" || bad "there is no data/ after the kill"
kept=$(find . -maxdepth 1 -type d -name 'data.before-restore-*' 2>/dev/null | wc -l | tr -d ' ')
[ "$kept" = 1 ] && ok "the datadir it replaced was kept, exactly once" ||
  bad "$kept kept datadirs, not 1"
[ ! -e .restore.tmp ] && ok "the half-unpacked staging directory is gone" ||
  bad ".restore.tmp survived the kill, which is a copy of a datadir under a name nothing reads"
# Finishing the swap has to mean the restored chain, not just a directory: start it and read it.
./start.sh >/dev/null 2>&1
h=$(./btc getblockcount 2>/dev/null | tr -d '\r' || true)
[ "$h" = 3 ] && ok "that data/ is the snapshot's chain (height 3)" ||
  bad "the chain under data/ is at height '${h:-unreadable}', not 3"
[ ! -d .lock ] && ok "the lock was released by the interrupted run" || bad ".lock survived the kill"

########################################
say "7. status.sh, one snapshot in each state"
# The one case in this file that reads printed text, because the thing under test is which line a
# bad snapshot gets: the exit code is 1 for a missing archive, a mismatched one and an unreadable
# one alike. The regression it guards is a reorder — the newest and older paths once disagreed
# about which condition wins, and a missing file was reported as a manifest that merely predates
# checksums — so each phrase below is the shortest one that names a verdict, quoted from status.sh.
# Reword one and this fails; that is the reminder to re-check the order it was protecting.
rm -rf .snapshot/bad     # case 4 has already had its say about that one
S1TAR=.snapshot/s1/data.tar.gz
FBYTES=$(wc -c <"$S1TAR" | tr -d ' ')
FSHA=$(sha256sum "$S1TAR" | cut -d' ' -f1)
ZERO=$(printf '%064d' 0)
mk_fixture() {   # <name> <tar|none> <manifest ok|nosum|zero> <marker none|match|stale>
  local n=$1 tar=$2 man=$3 mark=$4
  mkdir -p ".snapshot/$n"
  if [ "$tar" = tar ]; then cp "$S1TAR" ".snapshot/$n/data.tar.gz"; fi
  printf 'height 3\ntip %s\n' "$ZERO" >".snapshot/$n/state.txt"
  case $man in
    ok) printf 'created 2026-01-01T00:00:00Z from selftest\narchive %s bytes, sha256 %s\n' \
         "$FBYTES" "$FSHA" >".snapshot/$n/manifest.txt" ;;
    nosum) printf 'created 2026-01-01T00:00:00Z from selftest\n' >".snapshot/$n/manifest.txt" ;;
    zero) printf 'created 2026-01-01T00:00:00Z from selftest\narchive %s bytes, sha256 %s\n' \
         "$FBYTES" "$ZERO" >".snapshot/$n/manifest.txt" ;;
  esac
  case $mark in
    match) printf 'verified 2026-01-02T00:00:00Z\narchive %s\nheight 3\n' "$FSHA" \
           >".snapshot/$n/.verified" ;;
    stale) printf 'verified 2026-01-02T00:00:00Z\narchive %s\nheight 3\n' "$ZERO" \
           >".snapshot/$n/.verified" ;;
  esac
}
mk_fixture z1-missing none ok match
mk_fixture z2-nosum tar nosum none
mk_fixture z3-mismatch tar zero none
mk_fixture z4-stale tar ok stale
mk_fixture z5-unreadable tar ok match
mk_fixture z6-clean tar ok match     # last in sort order, so status.sh calls it the newest
# A regular file that cannot be hashed is the one state no fixture can make by itself: a directory
# in its place is "no file" to -f, and permissions do not stop a hash on this platform. So a
# sha256sum that refuses only for that one name stands in front of the real one, and everything
# else passes straight through.
REAL_SHA=$(command -v sha256sum)
mkdir -p .failbin
printf '#!/bin/sh\ncase "$*" in *z5-unreadable*) exit 1 ;; esac\nexec "%s" "$@"\n' "$REAL_SHA" \
  >.failbin/sha256sum
chmod +x .failbin/sha256sum

rc=0
PATH="$SB/.failbin:$PATH" ./status.sh >"$ROOT/status7.out" 2>&1 || rc=$?
sed -i 's/\x1b\[[0-9;]*m//g' "$ROOT/status7.out"
has() { grep -qF -- "$1" "$ROOT/status7.out"; }
snap_only() { sed -n '/^== snapshot$/,/^== /p' "$ROOT/status7.out" | sed '$d'; }

[ "$rc" = 1 ] && ok "a folder with faults in it exits 1" || bad "status.sh exited $rc, not 1"
# A missing archive: said as missing, not as a manifest that predates checksums, and its marker is
# reported as a proof whose archive is gone rather than as a proof that still stands.
if has "z1-missing: there is no data.tar.gz file"; then
  ok "a missing archive is reported as missing"
else bad "z1-missing was not reported as a missing archive"
fi
if has "z1-missing: its manifest carries no checksum"; then
  bad "z1-missing fell through to the no-checksum branch: the order slipped"
else ok "and not as a manifest that predates checksums"
fi
if has "z1-missing: was proven to restore" && has "but its archive is gone"; then
  ok "its marker is reported as a proof whose archive is gone"
else bad "a marker beside a missing archive was not reported as gone"
fi
# No checksum, and no false claim that one was checked.
if has "z2-nosum: its manifest carries no checksum"; then
  ok "a manifest without a checksum is reported as uncheckable"
else bad "z2-nosum was not reported as carrying no checksum"
fi
if has "z2-nosum: checksum-checked only"; then
  bad "z2-nosum claims a checksum was checked when none was recorded"
else ok "and not as checksum-checked only"
fi
# Bytes that are not the ones the manifest recorded.
if has "z3-mismatch: its archive is not the one the manifest recorded"; then
  ok "an archive that is not the recorded one is a fault"
else bad "z3-mismatch was not reported as a changed archive"
fi
# A live checksum with a marker that no longer matches it: both facts, one per line.
if has "z4-stale: its archive is the one the manifest recorded"; then
  ok "a matching checksum is still reported beside the stale marker"
else bad "z4-stale lost its checksum line"
fi
if has "z4-stale: was proven to restore" && has "has changed since"; then
  ok "a marker older than the file is reported as changed since"
else bad "z4-stale's marker was not reported as stale"
fi
# There but unhashable: its own verdict, not "missing", and not the end of the run.
if has "z5-unreadable: data.tar.gz is there but could not be read"; then
  ok "an archive that cannot be hashed is reported as unreadable"
else bad "z5-unreadable was not reported as unreadable"
fi
if has "z5-unreadable: there is no data.tar.gz file"; then
  bad "z5-unreadable was reported as absent, which is a different fault"
else ok "and not as a missing file"
fi
if has "== kept datadirs"; then
  ok "the run carried on past the unreadable archive"
else bad "the run stopped at the unreadable archive (later sections missing)"
fi
# The clean one, which is also the newest: named, at the chain's height, and proven.
if has "z6-clean: its archive is the one the manifest recorded"; then
  ok "the clean archive is reported at its manifest checksum"
else bad "z6-clean's checksum line is missing"
fi
if has "z6-clean: proven to restore at"; then ok "and proven to restore"
else bad "z6-clean's proof line is missing"
fi
if has "newest snapshot z6-clean is at the chain's height"; then
  ok "the newest check still runs after the archive is judged"
else bad "z6-clean was not compared with the chain's height"
fi
# Exactly the fixtures that are faulty, and no others: a count, so a branch that fires twice or for
# the wrong snapshot is caught as well as one that does not fire at all.
n=$(snap_only | grep -c 'BAD' || true)
[ "$n" = 3 ] && ok "three of the six fixtures are faults, as built" ||
  bad "$n faults in the snapshot section, not 3"
# And with those three removed, nothing in that section is a fault: the counts above were the
# fixtures and not something left behind by an earlier case.
rm -rf .snapshot/z1-missing .snapshot/z3-mismatch .snapshot/z5-unreadable
PATH="$SB/.failbin:$PATH" ./status.sh >"$ROOT/status7b.out" 2>&1 || true
sed -i 's/\x1b\[[0-9;]*m//g' "$ROOT/status7b.out"
n=$(sed -n '/^== snapshot$/,/^== /p' "$ROOT/status7b.out" | sed '$d' | grep -c 'BAD' || true)
[ "$n" = 0 ] && ok "with the faulty three removed, no snapshot is a fault" ||
  bad "$n faults remain with the faulty fixtures deleted"

########################################
say "8. bundle, and what verify makes of one"
# The bundle is the only artifact meant to survive losing this folder, and until now nothing here
# built one. Its ord step requires ord-data/regtest/wallets/ord.redb to be inside the archive, and
# verify now opens that wallet, so the sandbox needs a real one. Only ord's own server can make
# one — the CLI on its own prints a mnemonic and writes nothing — so this starts a server on a port
# of its own, never 8080, which another folder's server may be holding, and creates the wallet
# through it before stopping it again.
# ord.exe is a Windows binary even under Git Bash, so the sandbox's /tmp paths are handed to it as
# Windows paths: given /tmp/x it would read C:\tmp\x and write the wallet where nothing looks.
winpath() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }
OPORT=18683
while netstat -ano 2>/dev/null | grep -q ":$OPORT .*LISTENING"; do OPORT=$((OPORT + 1)); done
"$SB/bin/ord.exe" --chain regtest --bitcoin-rpc-url "http://127.0.0.1:$RPCPORT" \
  --bitcoin-data-dir "$(winpath "$SB/data")" --data-dir "$(winpath "$SB/ord-data")" \
  server --http --http-port "$OPORT" --address 127.0.0.1 >"$ROOT/ord-srv.log" 2>&1 &
OSRV=$!
for _ in $(seq 1 60); do
  curl -s -m 2 -o /dev/null "http://127.0.0.1:$OPORT/status" && break
  sleep 0.5
done
printf 'server_url: http://127.0.0.1:%s\n' "$OPORT" >"$ROOT/ord-cfg.yaml"
timeout 120 "$SB/bin/ord.exe" --config "$(winpath "$ROOT/ord-cfg.yaml")" --chain regtest \
  --bitcoin-rpc-url "http://127.0.0.1:$RPCPORT" --bitcoin-data-dir "$(winpath "$SB/data")" \
  --data-dir "$(winpath "$SB/ord-data")" wallet create >"$ROOT/ord-create.out" 2>&1 ||
  envfail "the sandbox ord server would not create a wallet; see $ROOT/ord-create.out"
# create makes the wallet in the node; ord-data/regtest/wallets/ord.redb, the file the bundle
# carries, is written when the wallet is first read. So it is read here once, and that file is what
# verify later opens out of the archive.
timeout 120 "$SB/bin/ord.exe" --config "$(winpath "$ROOT/ord-cfg.yaml")" --chain regtest \
  --bitcoin-rpc-url "http://127.0.0.1:$RPCPORT" --bitcoin-data-dir "$(winpath "$SB/data")" \
  --data-dir "$(winpath "$SB/ord-data")" wallet dump >"$ROOT/ord-dump.out" 2>&1 ||
  envfail "the sandbox ord wallet would not open; see $ROOT/ord-dump.out"
kill "$OSRV" 2>/dev/null || true
wait "$OSRV" 2>/dev/null || true
[ -f "$SB/ord-data/regtest/wallets/ord.redb" ] ||
  envfail "no ord wallet appeared in $SB/ord-data, which the bundle case needs"
BDIR="$ROOT/out"; mkdir -p "$BDIR"
BUN="$BDIR/regtest-bundle.tar.gz"

# A destination inside the folder is the one thing a backup must never be.
rc=0
./chain.sh bundle "$SB/inside.tar.gz" >"$ROOT/bundle-inside.out" 2>&1 || rc=$?
[ "$rc" = 2 ] && ok "a destination inside the folder is refused with exit 2" ||
  bad "bundle into the folder exited $rc, not 2"
[ ! -e "$SB/inside.tar.gz" ] && ok "and nothing was written there" ||
  bad "inside.tar.gz was created despite the refusal"

rc=0
./chain.sh bundle "$BUN" >"$ROOT/bundle.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "bundle exits 0" || bad "bundle exited $rc, not 0; see $ROOT/bundle.out"
[ -s "$BUN" ] && ok "the archive is there and is not empty" || bad "no bundle at $BUN"
if [ -f "$BUN.sha256" ]; then
  read -r want name <"$BUN.sha256" || true
  got=$(sha256sum "$BUN" | cut -d' ' -f1)
  [ "$want" = "$got" ] && ok "the sha256 written beside it is the archive's own hash" ||
    bad "the .sha256 says ${want:0:12}…, the file hashes to ${got:0:12}…"
  [ "${name:-}" = "$(basename "$BUN")" ] && ok "and names the file it describes" ||
    bad "the .sha256 names '${name:-nothing}'"
else
  bad "no $BUN.sha256 was written beside it"
fi
[ ! -d .bundle.tmp ] && ok "no staging directory was left behind" ||
  bad ".bundle.tmp is on disk after a bundle"

# The manifest is what gets read when the folder is gone and nothing else is left, so its recipes
# are checked against the archive they describe instead of trusted. That is how the recipe that
# named <this>.ord-data.tar.gz — a file beside the bundle that bundle has never written — would
# have been caught: the path it names is not a member of the archive, and this says so. Both halves
# are needed: an archive member list alone passes an empty recipe, so a recipe that names nothing
# is a failure too rather than a check that ran on nothing.
tar -xOf "$BUN" ./manifest.txt >"$ROOT/bundle-manifest.txt" 2>/dev/null ||
  envfail "the bundle carries no ./manifest.txt to check its recipe against"
tar -tzf "$BUN" >"$ROOT/bundle.list" 2>/dev/null ||
  envfail "the bundle does not list its members"
# The second line of the ord recipe is indented, so both shapes are read. A leading ./ is dropped
# before the member comparison, because the archive stores its members that way and a reader may or
# may not write it; dropping it here is what lets either spelling be judged the same.
sed -n '/^restore /p;/^  tar -xzf/p' "$ROOT/bundle-manifest.txt" |
  grep -o '[A-Za-z0-9._/-]*\.tar\.gz' | sed 's|^\./||' |
  sort -u >"$ROOT/bundle-recipe.txt" || true
if [ -s "$ROOT/bundle-recipe.txt" ]; then
  MISSING=""
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    grep -qx "./$m" "$ROOT/bundle.list" || MISSING="$MISSING $m"
  done <"$ROOT/bundle-recipe.txt"
  NAMED=$(tr '\n' ' ' <"$ROOT/bundle-recipe.txt")
  [ -z "$MISSING" ] && ok "every path a restore recipe names is in it: $NAMED" ||
    bad "the manifest's recipe names$MISSING, which the bundle does not contain"
else
  bad "no restore line in the manifest names a file inside the bundle"
fi
grep -q 'ord/ord-data.tar.gz' "$ROOT/bundle-manifest.txt" &&
  ok "the ord recipe points at ord/ord-data.tar.gz, the archive that is there" ||
  bad "the ord recipe does not point at ord/ord-data.tar.gz"

# The ord half can only be judged if its height was taken, and the run that bundles with the server
# down — the normal case, since bundle is run when nothing else is — used to record "unknown".
# The sandbox's ord server is stopped before this point, so this is that case: the height has to
# come out a number, with the chain's height beside it, read from the index itself. The recipe
# checks above cannot see this one — the archive is complete and correct either way, and only the
# record of what it holds is mute.
IDXLINE=$(tar -xOf "$BUN" ./ord/info.txt 2>/dev/null |
  sed -n 's/^ord index height at capture: //p')
case $IDXLINE in
  ''|unknown*) bad "the bundle records no ord index height ('${IDXLINE:-nothing}')" ;;
  *) ok "the bundle records the ord index height with its server down: $IDXLINE" ;;
esac
grep -q '^ord index height at capture: [0-9][0-9]* — ' "$ROOT/bundle-manifest.txt" &&
  ok "and the manifest carries that height and how it compares with the chain's" ||
  bad "the manifest records an ord height with no comparison against the chain"
grep -q 'read from ord-data itself' "$ROOT/bundle-manifest.txt" &&
  ok "and says the height came from opening the index directly" ||
  bad "the manifest does not say how the ord height was read"

# A bundle is for a machine that has only the tar, so it carries the things that make this folder
# usable and cannot be rebuilt from the data: its scripts and conf. Checked by name, and against
# the checksum list rather than the archive listing, because a script that arrived truncated is
# present and useless.
TOOLS="chain.sh btc ord ord.yaml bitcoin.conf ord-server.sh start.sh stop.sh status.sh"
MISSING=""
for f in $TOOLS; do
  grep -qx "./tooling/$f" "$ROOT/bundle.list" || MISSING="$MISSING $f"
done
[ -z "$MISSING" ] && ok "the bundle carries this folder's scripts and conf: tooling/" ||
  bad "tooling/ in the bundle is missing:$MISSING"
tar -xOf "$BUN" ./SHA256SUMS >"$ROOT/bundle.SHA256SUMS" 2>/dev/null ||
  envfail "the bundle has no SHA256SUMS to read"
MISSING=""
for f in $TOOLS; do
  grep -q "^[0-9a-f]* \*tooling/$f\$" "$ROOT/bundle.SHA256SUMS" || MISSING="$MISSING $f"
done
[ -z "$MISSING" ] && ok "and SHA256SUMS covers every one of them" ||
  bad "SHA256SUMS does not cover:$MISSING"

# A good bundle has to restore, not merely exist: that is the claim verify makes.
rc=0
RPCPORT=18653 ./chain.sh verify "$BUN" >"$ROOT/verify-bundle.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "verify restores a good bundle (exit 0)" ||
  bad "verify exited $rc on a good bundle; see $ROOT/verify-bundle.out"

# Then a bundle whose bytes changed after its own checksums were taken: repacked, so the archive
# still unpacks and the outer file is not obviously broken — only SHA256SUMS inside can say so. The
# file changed is chain/manifest.txt, which verify does not otherwise read: damage state.txt and a
# broken checksum check would still be caught later by the state comparison, hiding the very thing
# this assertion is for.
mkdir -p "$ROOT/x"
tar -xzf "$BUN" -C "$ROOT/x"
printf 'X' | dd of="$ROOT/x/chain/manifest.txt" bs=1 seek=0 conv=notrunc 2>/dev/null
tar -czf "$BDIR/damaged.tar.gz" -C "$ROOT/x" .
rc=0
RPCPORT=18653 ./chain.sh verify "$BDIR/damaged.tar.gz" >"$ROOT/verify-damaged.out" 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "a bundle that no longer matches its SHA256SUMS exits 1" ||
  bad "verify exited $rc on a damaged bundle, not 1; see $ROOT/verify-damaged.out"
# And one broken as a file rather than inside: it does not even have to reach the checksums.
head -c 200 "$BUN" >"$BDIR/truncated.tar.gz"
rc=0
RPCPORT=18653 ./chain.sh verify "$BDIR/truncated.tar.gz" >"$ROOT/verify-cut.out" 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "a truncated bundle is refused (exit $rc)" ||
  bad "a truncated bundle was accepted"

# The copies a bundle keeps beside the archive have to open, and only a bundle whose own checksums
# still match can show that: SHA256SUMS is rebuilt after the damage, so the checksum step passes and
# the copy has to be the thing that fails. First a wallet .dat, damaged at its head.
rm -rf "$ROOT/y"; mkdir -p "$ROOT/y"
tar -xzf "$BUN" -C "$ROOT/y"
dwn=$(ls "$ROOT/y/chain/wallets" | sed -n '1s/\.dat$//p')
printf 'X' | dd of="$ROOT/y/chain/wallets/$dwn.dat" bs=1 seek=0 conv=notrunc 2>/dev/null
(
  cd "$ROOT/y" || exit 1
  for f in $(find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort); do sha256sum "$f"; done
) >"$ROOT/y/SHA256SUMS"
tar -czf "$BDIR/dat-damaged.tar.gz" -C "$ROOT/y" .
rc=0
RPCPORT=18653 ./chain.sh verify "$BDIR/dat-damaged.tar.gz" >"$ROOT/verify-dat.out" 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "a bundle whose wallet .dat no longer restores exits 1" ||
  bad "verify exited $rc on a bundle with a damaged .dat, not 1; see $ROOT/verify-dat.out"
grep -q "$dwn.dat does not restore" "$ROOT/verify-dat.out" &&
  ok "and says which wallet copy it could not load" ||
  bad "verify did not say the .dat was the copy it could not load"

# Then the ord wallet, emptied inside its own archive. The word is checked with the exit code so a
# failure elsewhere cannot stand in for this one.
rm -rf "$ROOT/y" "$ROOT/z"; mkdir -p "$ROOT/y" "$ROOT/z"
tar -xzf "$BUN" -C "$ROOT/y"
tar -xzf "$ROOT/y/ord/ord-data.tar.gz" -C "$ROOT/z"
: >"$ROOT/z/ord-data/regtest/wallets/ord.redb"
tar -czf "$ROOT/y/ord/ord-data.tar.gz" -C "$ROOT/z" ord-data
(
  cd "$ROOT/y" || exit 1
  for f in $(find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort); do sha256sum "$f"; done
) >"$ROOT/y/SHA256SUMS"
tar -czf "$BDIR/ord-wallet-damaged.tar.gz" -C "$ROOT/y" .
rc=0
RPCPORT=18653 ./chain.sh verify "$BDIR/ord-wallet-damaged.tar.gz" >"$ROOT/v-ordw.out" 2>&1 ||
  rc=$?
[ "$rc" = 1 ] && ok "a bundle whose ord wallet does not open exits 1" ||
  bad "verify exited $rc on an unusable ord wallet; see $ROOT/v-ordw.out"
grep -q "ord wallet" "$ROOT/v-ordw.out" &&
  ok "and names the ord wallet as what it could not open" ||
  bad "verify did not name the ord wallet in its failure"

# And the copy a snapshot keeps beside its archive. Nothing in the snapshot's checksums covers it —
# the manifest hashes data.tar.gz alone — so verify is the only thing that can notice it broke. The
# whole snapshot is copied out first, so the sandbox's own .snapshot/s1 is not what gets damaged.
rm -rf "$ROOT/s"
cp -r "$SB/.snapshot/s1" "$ROOT/s" 2>/dev/null ||
  envfail "the sandbox has no .snapshot/s1 to copy for the wallets/ check"
grep -q '^wallets/ is a second copy' "$ROOT/s/manifest.txt" 2>/dev/null &&
  ok "the snapshot's manifest says what wallets/ is for" ||
  bad "the snapshot's manifest does not say what wallets/ is for"
SDAT=$(ls "$ROOT/s/wallets" 2>/dev/null | sed -n '1s/\.dat$//p')
[ -n "$SDAT" ] || envfail "the copied snapshot has no wallets/*.dat to damage"
rc=0
RPCPORT=18653 ./chain.sh verify "$ROOT/s" >"$ROOT/v-snap.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "verify loads the snapshot's own wallets/ copy (exit 0)" ||
  bad "verify exited $rc on a whole snapshot; see $ROOT/v-snap.out"
printf 'X' | dd of="$ROOT/s/wallets/$SDAT.dat" bs=1 seek=0 conv=notrunc 2>/dev/null
rc=0
RPCPORT=18653 ./chain.sh verify "$ROOT/s" >"$ROOT/v-snap2.out" 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "a snapshot whose wallets/ copy is damaged exits 1" ||
  bad "verify exited $rc on a damaged wallets/ copy, not 1; see $ROOT/v-snap2.out"
grep -q "snapshot's $SDAT.dat does not restore" "$ROOT/v-snap2.out" &&
  ok "and names the snapshot's copy as what it could not load" ||
  bad "verify did not name the snapshot's wallets/ copy"

# A snapshot that carries no ord data restores ord with a fresh wallet and no rune balance, so a
# snapshot now carries ord-data.tar.gz beside its chain archive. It is taken here, after the sandbox
# has an ord wallet, because a snapshot written before that is a different case — one of them is
# covered by the "predates" note the old .snapshot/s1 runs would print, not by this.
#
# One block is mined first, with the ord server down, so at capture the index is known to stand one
# block behind the chain. That is what makes the height a snapshot records checkable: if it passed
# the chain's height through under another name, the record would say "the same height" here and
# the assertions below would catch it, where an index already level with the chain could not.
./btc -rpcwallet=w generatetoaddress 1 "$ADDR" >/dev/null ||
  envfail "cannot mine the block that leaves the ord index one behind the chain"
rc=0
./chain.sh snapshot ordtmp >"$ROOT/snap-ord.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "a snapshot of a folder with ord data exits 0" ||
  bad "snapshot exited $rc; see $ROOT/snap-ord.out"
[ -f .snapshot/ordtmp/ord-data.tar.gz ] &&
  ok "the snapshot carries ord-data.tar.gz beside its chain archive" ||
  bad "the snapshot has no ord-data.tar.gz, so ord's wallet is not in it"
grep -q '^ord-archive [0-9][0-9]* bytes, sha256 [0-9a-f][0-9a-f]*$' .snapshot/ordtmp/manifest.txt &&
  ok "and its manifest records a checksum for that archive" ||
  bad "the snapshot's manifest records no ord-archive checksum"

# The archive also has to say what height the index in it was at, and how that stood against the
# chain: a snapshot pairing a week-old index with a fresh chain passes every check above and leaves
# a restore with an ord half nobody was warned about. The line is read apart at its em dash, which
# keeps the arithmetic below in ASCII.
SNAP_LINE=$(sed -n 's/^ord index height at capture: //p' .snapshot/ordtmp/manifest.txt)
SNAP_IDX=${SNAP_LINE%% *}
SNAP_GAP=${SNAP_LINE#*— }
SNAP_CH=$(sed -n 's/^height //p' .snapshot/ordtmp/state.txt)
case $SNAP_GAP in
  '1 block(s) behind the chain'*)
    ok "the snapshot says its ord index was one block behind the chain, as it was mined" ;;
  *)
    bad "the snapshot compares no ord index height with the chain ('${SNAP_GAP:-nothing}')" ;;
esac
[ "$SNAP_IDX" = "$((SNAP_CH - 1))" ] &&
  ok "the height it records is the index's ($SNAP_IDX), not the chain's ($SNAP_CH)" ||
  bad "the manifest records '${SNAP_IDX:-nothing}' over a chain at $SNAP_CH"
grep -q "the height was read from ord-data itself, with this folder's RPC port" \
  .snapshot/ordtmp/manifest.txt &&
  ok "and says it came from opening the index directly, with the server down" ||
  bad "the manifest does not say how the ord height was read"
rc=0
RPCPORT=18653 ./chain.sh verify .snapshot/ordtmp >"$ROOT/v-ord-snap.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "verify opens a snapshot's ord wallet (exit 0)" ||
  bad "verify exited $rc on a snapshot with ord data; see $ROOT/v-ord-snap.out"
grep -q 'the ord wallet opens, and gives up its descriptors' "$ROOT/v-ord-snap.out" &&
  ok "and says the snapshot's wallet opened" ||
  bad "verify did not report opening the snapshot's ord wallet"

# The wallet emptied inside the snapshot's own ord archive, with the manifest's checksum for it
# rebuilt so the checksum step passes and the wallet is what fails. Same pairing as the bundle's.
rm -rf "$ROOT/sord" "$ROOT/sordz"; mkdir -p "$ROOT/sordz"
cp -r .snapshot/ordtmp "$ROOT/sord"
tar -xzf "$ROOT/sord/ord-data.tar.gz" -C "$ROOT/sordz"
: >"$ROOT/sordz/ord-data/regtest/wallets/ord.redb"
tar -czf "$ROOT/sord/ord-data.tar.gz" -C "$ROOT/sordz" ord-data
OSHA=$(sha256sum "$ROOT/sord/ord-data.tar.gz" | cut -d' ' -f1)
OBYTES=$(wc -c <"$ROOT/sord/ord-data.tar.gz" | tr -d ' ')
sed -i "s|^ord-archive .*|ord-archive $OBYTES bytes, sha256 $OSHA|" "$ROOT/sord/manifest.txt"
rc=0
RPCPORT=18653 ./chain.sh verify "$ROOT/sord" >"$ROOT/v-ord-snap2.out" 2>&1 || rc=$?
[ "$rc" = 1 ] && ok "a snapshot whose ord wallet is emptied exits 1" ||
  bad "verify exited $rc on a snapshot with an unusable ord wallet; see $ROOT/v-ord-snap2.out"
grep -q 'ord wallet' "$ROOT/v-ord-snap2.out" &&
  ok "and names the ord wallet as what it could not open" ||
  bad "verify did not name the snapshot's ord wallet"

# The restore branch that takes ord-data from the snapshot when the folder has none is what turns
# an empty folder into a working ord folder: without it ord starts with a fresh wallet and the rune
# balance is gone. That was proven by hand until now, so it is proven here — a folder with no
# data/ and no ord-data/ of its own, restored from the snapshot just taken.
rm -rf "$ROOT/snapfresh" "$ROOT/ordref"; mkdir -p "$ROOT/snapfresh/bin" "$ROOT/ordref"
for b in bitcoind.exe bitcoin-cli.exe ord.exe; do
  cp "$SB/bin/$b" "$ROOT/snapfresh/bin/$b" || envfail "cannot copy $b into the restore folder"
done
for f in start.sh stop.sh btc chain.sh status.sh ord ord.yaml bitcoin.conf ord-server.sh; do
  cp "$SB/$f" "$ROOT/snapfresh/$f" || envfail "cannot copy $f into the restore folder"
done
chmod +x "$ROOT/snapfresh"/*.sh "$ROOT/snapfresh/btc" "$ROOT/snapfresh/ord"
# 18663/18664: not the sandbox's node ($RPCPORT), not verify's scratch node or its ord server
# (18653, 18673), so this copy runs while the sandbox node keeps running.
sed -i "s/$RPCPORT/18663/g; s/$P2PPORT/18664/g" "$ROOT/snapfresh/bitcoin.conf"
if [ -e "$ROOT/snapfresh/data" ] || [ -e "$ROOT/snapfresh/ord-data" ]; then
  envfail "the restore folder already holds data/ or ord-data/, so it is not this branch"
fi
rc=0
( cd "$ROOT/snapfresh" && ./chain.sh restore "$SB/.snapshot/ordtmp" ) \
  >"$ROOT/snapfresh-restore.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "a snapshot restores into a folder with no data/ or ord-data/ (exit 0)" ||
  bad "restore into a folder with neither exited $rc; see $ROOT/snapfresh-restore.out"
# "Came back" is made a claim about the archive's own bytes rather than about a directory: one
# unpacked and the other not, or an index rebuilt in place of the one snapshotted, would all pass
# a test that only asked whether ord-data/ exists. A restore that skipped the branch leaves both
# missing, so these two also cover the line the restore prints when it takes the copy.
tar -xzf "$SB/.snapshot/ordtmp/ord-data.tar.gz" -C "$ROOT/ordref" \
  ord-data/regtest/index.redb ord-data/regtest/wallets/ord.redb ||
  envfail "the snapshot's ord archive does not carry index.redb and the wallet"
for f in ord-data/regtest/index.redb ord-data/regtest/wallets/ord.redb; do
  want=$(sha256sum "$ROOT/ordref/$f" | cut -d' ' -f1)
  got=""
  [ -f "$ROOT/snapfresh/$f" ] && got=$(sha256sum "$ROOT/snapfresh/ord-data/regtest/wallets/ord.redb" | cut -d' ' -f1)
  [ "$got" = "$want" ] &&
    ok "the restored $f is the snapshot's, byte for byte" ||
    bad "the restored $f is '${got:-missing}', the snapshot holds $want"
  [ "$got" = "$want" ] && ok "and keeping the wallet the reset must not touch" ||
    bad "the wallet after an ahead-index restore is '${got:-missing}', the snapshot holds $want"
done
[ ! -e "$ROOT/snapfresh/.restore.tmp" ] && ok "and it left no staging directory" ||
  bad ".restore.tmp is on disk after a restore into an empty folder"
# Step 3 reads the index on disk through this folder's rpcport. This copy's node is on 18663, so a
# read through the ./ord wrapper's default 18443 finds no cookie of this copy at all, and an index
# that is not ahead is reset for want of a port. The height in the kept line is what says the read
# reached this index: only opening it can produce $SNAP_IDX, and ord is not running to suggest it.
rc=0
( cd "$ROOT/snapfresh" && ./chain.sh restore "$SB/.snapshot/ordtmp" ) \
  >"$ROOT/snapfresh-kept.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "an index that is not ahead survives a restore in a folder on another port" ||
  bad "restore in the 18663 copy exited $rc; see $ROOT/snapfresh-kept.out"
grep -q "it is at $SNAP_IDX, not ahead of $SNAP_CH, so it was kept" "$ROOT/snapfresh-kept.out" &&
  ok "and was read at the index's own height ($SNAP_IDX) rather than reset as unreadable" ||
  bad "the 18663 copy's own index was not read and kept; see $ROOT/snapfresh-kept.out"
[ -f "$ROOT/snapfresh/ord-data/regtest/index.redb" ] &&
  ok "and is still on disk, since nothing here rebuilds it" ||
  bad "index.redb is gone after a restore in the 18663 copy"
# status.sh makes the same read when no server answers, and used to make it through the ./ord
# wrapper's default 18443 — the original's node, whose cookie this copy does not have — so it
# reported an index that was right here as unreadable. The copy's node is up (the restore started
# it again) and no ord server is, which is the branch status has to answer for.
rc=0
( cd "$ROOT/snapfresh" && ./status.sh ) >"$ROOT/snapfresh-status.out" 2>&1 || rc=$?
[ "$rc" = 0 ] || [ "$rc" = 1 ] ||
  envfail "status.sh exited $rc in the 18663 copy; see $ROOT/snapfresh-status.out"
grep -q "the index is $((SNAP_CH - SNAP_IDX)) block(s) behind (index $SNAP_IDX, node $SNAP_CH)" \
  "$ROOT/snapfresh-status.out" &&
  ok "status reads the 18663 copy's index at its own height ($SNAP_IDX), not as unreadable" ||
  bad "status did not report the copy's index height; see $ROOT/snapfresh-status.out"
grep -q 'ord does not know rune 112:1' "$ROOT/snapfresh-status.out" &&
  bad "a 18663 copy's status must not report rune 112:1 as unknown (runner through the wrapper's default 18443)" ||
  ok "a 18663 copy never reports rune 112:1 as unknown (server-down rune read now uses this folder's rpcport)"
# no wallet in it would therefore drop the snapshot's wallet in silence, and ord would start with a
# fresh one. The folder keeps its own copy; the restore has to say what that cost.
rm -f "$ROOT/snapfresh/ord-data/regtest/wallets/ord.redb"
rc=0
( cd "$ROOT/snapfresh" && ./chain.sh restore "$SB/.snapshot/ordtmp" ) \
  >"$ROOT/snapfresh-keep.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "a folder with an ord-data/ but no wallet restores (exit 0)" ||
  bad "restore into a walletless ord-data/ exited $rc; see $ROOT/snapfresh-keep.out"
grep -q "carries no wallet and is kept" "$ROOT/snapfresh-keep.out" &&
  ok "and says it kept a walletless ord-data/ instead of the snapshot's wallet" ||
  bad "restore did not say it kept a walletless ord-data/"
[ ! -s "$ROOT/snapfresh/ord-data/regtest/wallets/ord.redb" ] &&
  ok "and did not install the snapshot's wallet over it" ||
  bad "restore wrote the snapshot's wallet into the folder's own ord-data/"
# Step 3 asks the index that is already here; an index that arrives inside a snapshot has not been
# asked. A real snapshot cannot show the case — its index is tarred with the node stopped, so it
# is at that chain's height or behind — so the manifest is cooked to claim an index above the
# height being restored, which is the claim the restore has to hold the archive's own index to.
rm -rf "$ROOT/snapord"; cp -r "$SB/.snapshot/ordtmp" "$ROOT/snapord"
SNAP_H=$(sed -n 's/^height //p' "$SB/.snapshot/ordtmp/state.txt")
AHEAD_H=$((SNAP_H + 3))
HI_LINE="ord index height at capture: $AHEAD_H — 3 ahead of the chain"
sed -i "s|^ord index height at capture: .*|$HI_LINE|" "$ROOT/snapord/manifest.txt"
grep -q "^ord index height at capture: $AHEAD_H" "$ROOT/snapord/manifest.txt" ||
  envfail "the cooked snapshot's manifest would not take the higher index height"
rm -rf "$ROOT/snapfresh/ord-data"
rc=0
( cd "$ROOT/snapfresh" && ./chain.sh restore "$ROOT/snapord" ) \
  >"$ROOT/snapfresh-ahead.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "a snapshot whose index was ahead of its chain restores (exit 0)" ||
  bad "restore of an ahead-index snapshot exited $rc; see $ROOT/snapfresh-ahead.out"
grep -q "ahead of the restored $SNAP_H: reset" "$ROOT/snapfresh-ahead.out" &&
  ok "and resets the index it installed, on the manifest's height" ||
  bad "restore kept the index the manifest recorded at $AHEAD_H; the chain is $SNAP_H"
[ ! -f "$ROOT/snapfresh/ord-data/regtest/index.redb" ] &&
  ok "leaving no index.redb to serve blocks the restored chain lacks" ||
  bad "index.redb is still on disk after an ahead-index restore"
want=$(sha256sum "$ROOT/ordref/ord-data/regtest/wallets/ord.redb" | cut -d' ' -f1)
got=""
[ -f "$ROOT/snapfresh/ord-data/regtest/wallets/ord.redb" ] &&
  got=$(sha256sum "$ROOT/snapfresh/ord-data/regtest/wallets/ord.redb" | cut -d' ' -f1)
# The unreadable variant of that fixture: the same cooked snapshot, but the folder's own index is
# not an index at all. Step 3 resets it either way, and what it prints has to carry ord's own
# complaint — "would not say what it held" alone leaves a wrong port or a missing cookie looking
# like a corrupt file. The line pinned is ord's first, which only opening the index can produce.
printf 'not a database\n' >"$ROOT/snapfresh/ord-data/regtest/index.redb"
rc=0
( cd "$ROOT/snapfresh" && ./chain.sh restore "$ROOT/snapord" ) \
  >"$ROOT/snapfresh-unreadable.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "an index that is not an index is reset and the restore still exits 0" ||
  bad "restore over an unreadable index exited $rc; see $ROOT/snapfresh-unreadable.out"
grep -q 'it would not say what it holds, so it cannot be trusted rather than wrong: reset' \
  "$ROOT/snapfresh-unreadable.out" &&
  ok "and says it reset the index for not saying what it held" ||
  bad "restore did not say it reset an index it could not read"
grep -q '^  ord said: error: failed to open index' "$ROOT/snapfresh-unreadable.out" &&
  ok "with ord's own complaint beside it, so a port or cookie fault does not read as corruption" ||
  bad "the reset message did not carry ord's complaint; see $ROOT/snapfresh-unreadable.out"
( cd "$ROOT/snapfresh" && ./stop.sh ) >/dev/null 2>&1 || true

# And the recipe itself, run where nothing of this folder exists: a new directory, the tar, and the
# three binaries the manifest says to put in tooling/bin/. That is the whole point of tooling/ — a
# recipe nobody has run from outside the folder is a paragraph, not a restore. The sandbox node is
# stopped first, because the restored copy starts on the same port; that is the one thing a fresh
# machine does not share.
./stop.sh >/dev/null 2>&1 || true
rm -rf "$ROOT/fresh"; mkdir -p "$ROOT/fresh"
tar -xzf "$BUN" -C "$ROOT/fresh"
for b in bitcoind.exe bitcoin-cli.exe ord.exe; do
  cp "$SB/bin/$b" "$ROOT/fresh/tooling/bin/$b" ||
    envfail "cannot place $b in the restored folder's tooling/bin"
done
rc=0
( cd "$ROOT/fresh/tooling" && ./chain.sh restore ../chain ) >"$ROOT/fresh-restore.out" 2>&1 ||
  rc=$?
[ "$rc" = 0 ] && ok "the documented restore runs in a folder that has only the bundle" ||
  bad "the documented restore exited $rc there; see $ROOT/fresh-restore.out"
WANT_H=$(sed -n 's/^height //p' "$ROOT/fresh/chain/state.txt")
FRESH_CLI="$ROOT/fresh/tooling/bin/bitcoin-cli.exe"
FRESH_DD=$(winpath "$ROOT/fresh/tooling/data")
FRESH_CF=$(winpath "$ROOT/fresh/tooling/bitcoin.conf")
GOT_H=$("$FRESH_CLI" -datadir="$FRESH_DD" -conf="$FRESH_CF" getblockcount 2>/dev/null |
  tr -d '\r') || true
[ -n "$GOT_H" ] && [ "$GOT_H" = "$WANT_H" ] &&
  ok "and the restored copy runs at the height the bundle records ($GOT_H)" ||
  bad "the restored copy is at '${GOT_H:-no answer}', the bundle says '$WANT_H'"
WANT_W=$(ls "$ROOT/fresh/chain/wallets" | grep -c '\.dat$' || true)
GOT_W=$("$FRESH_CLI" -datadir="$FRESH_DD" -conf="$FRESH_CF" listwallets 2>/dev/null |
  grep -c '"' || true)
[ "$GOT_W" = "$WANT_W" ] && ok "and loads the $GOT_W wallet(s) the bundle carries" ||
  bad "$GOT_W wallet(s) are loaded, the bundle carries $WANT_W"
grep -q '^restored: ' "$ROOT/fresh-restore.out" &&
  ok "and its own comparison against state.txt passed" ||
  bad "the restore did not report a compared state"
( cd "$ROOT/fresh/tooling" && ./stop.sh ) >/dev/null 2>&1 || true

########################################
echo
if [ "$FAILED" = 0 ]; then
  echo "all $PASSED checks held"
  exit 0
fi
echo "$FAILED of $((PASSED + FAILED)) checks did not hold"
exit 1
