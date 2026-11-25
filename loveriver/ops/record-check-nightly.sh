#!/bin/sh
# Nightly deployments.json check, for cron or systemd timers - the twin of record-check-nightly.cmd.
#
# The pre-commit hook runs tools/record-deployment.mjs --check on every commit, so the record is
# only verified on days somebody commits. A redeploy nobody recorded therefore sits stale until the
# next commit, which may be days. This runs the same check nightly.
#
# What the check reports: exit 0 means deployments.json matches the newest artifact (or there is no
# artifact to be stale against, which it says out loud), 1 the record is stale, 2 the check could
# not run at all - node missing, no node_modules for ethers, or an unreadable artifact. A non-zero
# exit is propagated, so a scheduler watching for failure sees a check that could not run as the
# failure it is, rather than as a quiet pass.
#
# One line per run in logs/record-check.log: the timestamp, everything the tool printed, and the
# exit code. A failing run also leaves logs/record-check-failed.txt behind and a passing run deletes
# it, so a failure is visible without reading the log.
#
#   crontab:  40 22 * * * /path/to/loveriver/ops/record-check-nightly.sh
set -u

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 2
LOG_DIR=${LOVERIVER_LOG_DIR:-"$APP_DIR/logs"}
LOG="$LOG_DIR/record-check.log"
MARKER="$LOG_DIR/record-check-failed.txt"
NODE=${NODE:-node}

mkdir -p "$LOG_DIR" || exit 2

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# cron gives a minimal PATH; node is usually in one of these and often nowhere else.
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH

cd "$APP_DIR" || exit 2

{
  printf '===== %s record-deployment --check\n' "$(stamp)"
  "$NODE" tools/record-deployment.mjs --check
  status=$?
  printf '===== exit %s\n' "$status"
} >>"$LOG" 2>&1

if [ "$status" -ne 0 ]; then
  # The documented contract is 0 current, 1 stale, 2 could not run. Anything that is not "stale"
  # is "could not run" - node missing is 127, for instance - so the raw code stays in the log and
  # the marker while the scheduler sees the code the installer documents.
  code=2
  why='the check could not run; the log says why'
  if [ "$status" -eq 1 ]; then
    code=1
    why='deployments.json is stale against the newest broadcast'
  fi
  printf '%s record check FAILED with exit %s (refused as %s): %s\n' \
    "$(stamp)" "$status" "$code" "$why" >>"$MARKER"
  printf 'See %s; record a fresh deploy with npm run deploy:record in loveriver.\n' "$LOG" >>"$MARKER"
  exit "$code"
fi

rm -f "$MARKER"
exit 0
