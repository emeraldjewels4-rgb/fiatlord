#!/bin/sh
# One-minute mint-ledger expiry, for cron or a systemd timer.
#
# The Windows twin (ops/ledger-purge.cmd) is the one that matters on the machine this was
# built on; this file exists so a server deployment gets the same guarantee rather than the
# weaker "expires when something reads it".
#
#   crontab:  */1 * * * * /path/to/loveriver/ops/ledger-purge.sh
#
# Nothing is logged on success: the tool is silent when there was nothing to destroy, and a
# line per minute would be noise, while a line recording what was destroyed would be a record
# of the deletions themselves. Failures are logged with their exit code.
set -u

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 2
LOG_DIR=${LOVERIVER_LOG_DIR:-"$APP_DIR/logs"}
LOG="$LOG_DIR/ledger-purge.log"
NODE=${NODE:-node}

mkdir -p "$LOG_DIR" || exit 2
# cron gives a minimal PATH; node is often in one of these and nowhere else.
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH

cd "$APP_DIR" || exit 2

output=$("$NODE" tools/mint-ledger.mjs --purge --file "$APP_DIR/mint-ledger.jsonl" 2>&1)
status=$?

if [ "$status" -ne 0 ] || [ -n "$output" ]; then
  printf '===== %s exit %s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" "$output" >>"$LOG"
fi

exit "$status"
