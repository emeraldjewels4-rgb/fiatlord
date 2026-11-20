#!/bin/sh
# Daily window-gated top-up, for cron or systemd timers.
#
# One line per run in logs/topup.log: the timestamp, everything tools/topup.mjs printed, and
# the exit code. The exit code is propagated, so a scheduler that watches for failure sees a
# failed mint as a failure.
#
# Secrets are read from an env file, never from this script and never from the crontab:
#
#   RPC_URL=https://...
#   LOVERIVER_TOKEN=0x...
#   OWNER_KEY=0x...
#
# Plain KEY=value lines with no quotes, because the Windows wrapper parses the same file the
# same way. Default location ops/topup.env (gitignored); override with LOVERIVER_ENV.
#
#   crontab:  17 7 * * * LOVERIVER_ENV=/etc/loveriver/topup.env /path/to/loveriver/ops/topup-daily.sh
#
# --within-window gates the FULL stage only: outside a mint window this still restores the
# half floor every day and leaves the top-up to the calendar. That is the intended split, not
# an oversight.
set -u

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 2
ENV_FILE=${LOVERIVER_ENV:-"$APP_DIR/ops/topup.env"}
LOG_DIR=${LOVERIVER_LOG_DIR:-"$APP_DIR/logs"}
LOG="$LOG_DIR/topup.log"
NODE=${NODE:-node}

mkdir -p "$LOG_DIR" || exit 2

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ ! -r "$ENV_FILE" ]; then
  printf '%s no env file at %s\n' "$(stamp)" "$ENV_FILE" >>"$LOG"
  exit 2
fi

# KEY=value lines, sourced rather than parsed: no quoting, no expansion surprises.
set -a
. "$ENV_FILE"
set +a

# The same file is shared with the Windows wrapper, where an editor may have written CRLF.
# sh would carry the \r into the value and the RPC URL would not resolve, so strip it here.
RPC_URL=$(printf '%s' "${RPC_URL:-}" | tr -d '\r')
LOVERIVER_TOKEN=$(printf '%s' "${LOVERIVER_TOKEN:-}" | tr -d '\r')
OWNER_KEY=$(printf '%s' "${OWNER_KEY:-}" | tr -d '\r')

if [ -z "$RPC_URL" ] || [ -z "$LOVERIVER_TOKEN" ] || [ -z "$OWNER_KEY" ]; then
  printf '%s env incomplete: RPC_URL, LOVERIVER_TOKEN and OWNER_KEY are required in %s\n' \
    "$(stamp)" "$ENV_FILE" >>"$LOG"
  exit 2
fi

export LOVERIVER_BROADCAST=yes
# cron gives a minimal PATH; node is usually in one of these and often nowhere else.
PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export PATH

cd "$APP_DIR" || exit 2

{
  printf '===== %s topup --within-window\n' "$(stamp)"
  "$NODE" tools/topup.mjs --within-window --rpc "$RPC_URL" --token "$LOVERIVER_TOKEN" --broadcast
  status=$?
  printf '===== exit %s\n' "$status"
} >>"$LOG" 2>&1

exit "$status"
