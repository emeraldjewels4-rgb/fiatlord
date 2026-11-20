#!/bin/sh
# Registers the daily Loveriver top-up in crontab - the twin of ops/install-topup-task.ps1.
#
# The Windows installer can afford to be clever about sleep, because Task Scheduler has settings
# for it (wake and catch-up). cron has none: a machine that is off at 07:17 simply misses that
# run. Its answer is redundancy rather than cleverness, so the line below is offered twice -
# once at 07:17 and once at 19:17 - and every run is safe to repeat: tools/topup.mjs only
# refills what is below the mark, and a second run with nothing to do exits 0.
#
#   ops/install-topup-cron.sh              install (or update) the two lines, once
#   ops/install-topup-cron.sh --print      show what would be installed, change nothing
#   ops/install-topup-cron.sh --remove     remove them again
#
# Idempotent: a tag line marks the block, and the block is replaced rather than appended, so
# running the installer twice leaves two lines, not four.
#
# The env file path is baked in as an absolute path because cron has no working directory.
set -u

TAG='# loveriver-topup (ops/install-topup-cron.sh)'
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 2
ENV_FILE=${LOVERIVER_ENV:-"$APP_DIR/ops/topup.env"}
RUNNER="$APP_DIR/ops/topup-daily.sh"

if [ ! -x "$RUNNER" ]; then
  printf '  %s is missing or not executable\n' "$RUNNER" >&2
  exit 2
fi

block() {
  printf '%s\n' "$TAG"
  printf '17 7 * * * LOVERIVER_ENV=%s %s\n' "$ENV_FILE" "$RUNNER"
  printf '17 19 * * * LOVERIVER_ENV=%s %s\n' "$ENV_FILE" "$RUNNER"
}

case "${1:-}" in
  --print)
    block
    exit 0
    ;;
  --remove)
    if ! crontab -l 2>/dev/null | grep -qF "$TAG"; then
      echo '  no top-up block in the crontab; nothing to remove'
      exit 0
    fi
    # Drop the tag and the two lines that follow it, keep everything else byte for byte.
    crontab -l 2>/dev/null | grep -vF "$TAG" | grep -vF "$RUNNER" | crontab -
    echo '  removed the top-up block'
    exit 0
    ;;
  '')
    ;;
  *)
    printf '  unknown option %s (use --print, --remove, or nothing)\n' "$1" >&2
    exit 2
    ;;
esac

# Everything except our own tag, our runner lines, and blank lines that the removal leaves behind.
kept=$(crontab -l 2>/dev/null | grep -vF "$TAG" | grep -vF "$RUNNER" | sed '/^[[:space:]]*$/d')

if [ -z "$kept" ]; then
  block | crontab -
else
  { printf '%s\n' "$kept"; block; } | crontab -
fi

echo '  installed:'
crontab -l | sed -n '/loveriver-topup/,+2p' | sed 's/^/    /'
if [ ! -r "$ENV_FILE" ]; then
  printf '\n  NOTE: %s does not exist yet, so each run logs "no env file" and exits 2.\n' "$ENV_FILE"
  echo '        Copy ops/topup.env.example there and fill in RPC_URL, LOVERIVER_TOKEN and OWNER_KEY.'
fi
