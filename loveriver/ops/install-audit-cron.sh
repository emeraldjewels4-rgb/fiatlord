#!/bin/sh
# Registers the daily Loveriver chain audit in crontab - the twin of ops/install-audit-task.ps1.
#
# The Windows installer can be clever about sleep, because Task Scheduler has settings for it
# (wake, catch-up). cron has none: a host that is off at the scheduled minute misses that run.
# Its answer is redundancy rather than cleverness, so the line is offered twice - once at 07:50
# and once at 19:50, after each top-up window - and a second run costs nothing because the
# audit only reads and never signs.
#
#   ops/install-audit-cron.sh              install (or update) the two lines, once
#   ops/install-audit-cron.sh --print      show what would be installed, change nothing
#   ops/install-audit-cron.sh --remove     remove them again
#
# Idempotent: a tag line marks the block, and the block is replaced rather than appended, so
# running the installer twice leaves two lines, not four. The env file path is baked in as an
# absolute path because cron has no working directory.
#
# The token address is not on the command line: deployments.json holds it, keyed by the chain
# id the RPC reports. Only RPC_URL comes from the env file, and it needs no signing key.
set -u

TAG='# loveriver-audit (ops/install-audit-cron.sh)'
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 2
ENV_FILE=${LOVERIVER_AUDIT_ENV:-"$APP_DIR/ops/topup.env"}
RUNNER="$APP_DIR/ops/mint-audit-daily.sh"

if [ ! -x "$RUNNER" ]; then
  printf '  %s is missing or not executable\n' "$RUNNER" >&2
  exit 2
fi

block() {
  printf '%s\n' "$TAG"
  printf '50 7 * * * LOVERIVER_AUDIT_ENV=%s %s\n' "$ENV_FILE" "$RUNNER"
  printf '50 19 * * * LOVERIVER_AUDIT_ENV=%s %s\n' "$ENV_FILE" "$RUNNER"
}

case "${1:-}" in
  --print)
    block
    exit 0
    ;;
  --remove)
    if ! command -v crontab >/dev/null 2>&1; then
      echo '  no crontab command on this host, so there is nothing to remove'
      exit 0
    fi
    if ! crontab -l 2>/dev/null | grep -qF "$TAG"; then
      echo '  no audit block in the crontab; nothing to remove'
      exit 0
    fi
    # Drop the tag and our runner lines, keep everything else byte for byte.
    crontab -l 2>/dev/null | grep -vF "$TAG" | grep -vF "$RUNNER" | crontab -
    echo '  removed the audit block'
    exit 0
    ;;
  '')
    ;;
  *)
    printf '  unknown option %s (use --print, --remove, or nothing)\n' "$1" >&2
    exit 2
    ;;
esac

if ! command -v crontab >/dev/null 2>&1; then
  echo '  no crontab command on this host, so there is no cron to install into' >&2
  echo '  on a systemd host, use a timer instead: OnCalendar=*-*-* 07,19:50:00' >&2
  exit 2
fi

# Everything except our own tag, our runner lines, and the blank lines removal can leave behind.
kept=$(crontab -l 2>/dev/null | grep -vF "$TAG" | grep -vF "$RUNNER" | sed '/^[[:space:]]*$/d')

if [ -z "$kept" ]; then
  block | crontab -
else
  { printf '%s\n' "$kept"; block; } | crontab -
fi

echo '  installed:'
crontab -l | sed -n '/loveriver-audit/,+2p' | sed 's/^/    /'
if [ ! -r "$ENV_FILE" ]; then
  printf '\n  NOTE: %s does not exist yet, so each run logs "no env file" and exits 2.\n' "$ENV_FILE"
  echo '        Copy ops/topup.env.example there and fill in RPC_URL (the token is in deployments.json).'
fi
