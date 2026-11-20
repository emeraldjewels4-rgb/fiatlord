#!/bin/sh
# Daily chain audit, for cron or systemd timers - the twin of ops/mint-audit-daily.cmd.
#
# One line per run in logs/mint-audit.log: the timestamp, everything tools/mint-audit.mjs
# printed, and the exit code. The exit code is propagated, so a scheduler that watches for
# failure sees an unsigned mint, or a supply that does not add up, as a failure.
#
# It needs NO signing key: the audit only reads. That is the point of running it on a
# schedule - the check that catches a stolen owner key must not itself hold one.
#
# Configuration is the env file the top-up already uses, ops/topup.env (gitignored), read
# from LOVERIVER_AUDIT_ENV when that is set. Only RPC_URL is read from it; the token address
# is not in the file either, because deployments.json holds it keyed by the chain id the RPC
# reports - so the cron job, the Windows task and a shell run cannot each name a token.
#
#   crontab:  50 7 * * * LOVERIVER_AUDIT_ENV=/etc/loveriver/topup.env /path/to/loveriver/ops/mint-audit-daily.sh
#
# A failing run leaves logs/audit-failed.txt behind, so a failure is visible without reading
# the log or the scheduler. A passing run deletes it. Same marker file as the Windows
# wrapper, so a host that runs either - or someone reading both - sees one answer.
set -u

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 2
ENV_FILE=${LOVERIVER_AUDIT_ENV:-"$APP_DIR/ops/topup.env"}
LOG_DIR=${LOVERIVER_LOG_DIR:-"$APP_DIR/logs"}
LOG="$LOG_DIR/mint-audit.log"
MARKER="$LOG_DIR/audit-failed.txt"
NODE=${NODE:-node}

mkdir -p "$LOG_DIR" || exit 2

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ ! -r "$ENV_FILE" ]; then
  printf '%s no env file at %s\n' "$(stamp)" "$ENV_FILE" >>"$LOG"
  printf '%s mint-audit could not run: no env file at %s\n' "$(stamp)" "$ENV_FILE" >>"$MARKER"
  exit 2
fi

# KEY=value lines, sourced rather than parsed: no quoting, no expansion surprises. The same
# file is shared with the Windows wrappers, where an editor may have written CRLF; sh would
# carry the \r into the URL and the RPC would not resolve, so strip it here.
set -a
. "$ENV_FILE"
set +a
RPC_URL=$(printf '%s' "${RPC_URL:-}" | tr -d '\r')

if [ -z "$RPC_URL" ]; then
  printf '%s env incomplete: RPC_URL is required in %s\n' "$(stamp)" "$ENV_FILE" >>"$LOG"
  printf '%s mint-audit could not run: RPC_URL missing in %s\n' "$(stamp)" "$ENV_FILE" >>"$MARKER"
  exit 2
fi

# cron gives a minimal PATH; node is usually in one of these and often nowhere else.
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH

cd "$APP_DIR" || exit 2

{
  printf '===== %s mint-audit --invariant\n' "$(stamp)"
  "$NODE" tools/mint-audit.mjs --invariant --rpc "$RPC_URL"
  status=$?
  printf '===== exit %s\n' "$status"
} >>"$LOG" 2>&1

if [ "$status" -eq 0 ]; then
  rm -f "$MARKER"
else
  printf '%s mint-audit failed with exit %s. See logs/mint-audit.log\n' \
    "$(stamp)" "$status" >>"$MARKER"
fi

exit "$status"
