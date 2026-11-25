#!/bin/sh
# Registers the nightly Loveriver record check in crontab - the twin of
# ops/install-record-check-task.ps1.
#
# cron has no catch-up setting, so a machine that is off at the scheduled minute simply misses that
# run. The check is cheap and read-only, so it is offered twice - once at 22:40 and once at 09:40 -
# rather than made clever. Running it repeatedly is harmless: it compares the record with the newest
# broadcast and writes nothing.
#
#   ops/install-record-check-cron.sh              install (or update) the two lines, once
#   ops/install-record-check-cron.sh --print      show what would be installed, change nothing
#   ops/install-record-check-cron.sh --remove     remove them again
#
# Idempotent: a tag line marks the block, and the block is replaced rather than appended, so running
# the installer twice leaves two lines, not four.
set -u

TAG='# loveriver-record-check (ops/install-record-check-cron.sh)'
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 2
RUNNER="$APP_DIR/ops/record-check-nightly.sh"

if [ ! -x "$RUNNER" ]; then
  printf '  %s is missing or not executable\n' "$RUNNER" >&2
  exit 2
fi

block() {
  printf '%s\n' "$TAG"
  printf '40 22 * * * %s\n' "$RUNNER"
  printf '40 9 * * * %s\n' "$RUNNER"
}

case "${1:-}" in
  --print)
    block
    exit 0
    ;;
  --remove)
    if ! crontab -l 2>/dev/null | grep -qF "$TAG"; then
      echo '  no record-check block in the crontab; nothing to remove'
      exit 0
    fi
    crontab -l 2>/dev/null | grep -vF "$TAG" | grep -vF "$RUNNER" | crontab -
    echo '  removed the record-check block'
    exit 0
    ;;
  '')
    ;;
  *)
    printf '  unknown option %s (use --print, --remove, or nothing)\n' "$1" >&2
    exit 2
    ;;
esac

kept=$(crontab -l 2>/dev/null | grep -vF "$TAG" | grep -vF "$RUNNER" | sed '/^[[:space:]]*$/d')

if [ -z "$kept" ]; then
  block | crontab -
else
  { printf '%s\n' "$kept"; block; } | crontab -
fi

echo '  installed:'
crontab -l | sed -n '/loveriver-record-check/,+2p' | sed 's/^/    /'
