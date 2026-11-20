#!/usr/bin/env bash
# Start the local regtest node and wait until RPC answers.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$DIR/data"
CONF="$DIR/bitcoin.conf"
CLI="$DIR/bin/bitcoin-cli.exe"
D="$DIR/bin/bitcoind.exe"

mkdir -p "$DATA"

# v32 does not auto-load wallets, so after a restart every wallet in the datadir
# is unloaded and getbalance fails until it is loaded again.
load_wallets() {
  # `|| true` matters: on a fresh datadir there are no names to grep, and with
  # pipefail that non-match would otherwise kill the script (exit 1).
  local names w
  names="$("$CLI" -datadir="$DATA" -conf="$CONF" listwalletdir 2>/dev/null \
    | grep -o '"name": "[^"]*"' | cut -d'"' -f4 || true)"
  [ -n "$names" ] || return 0
  while IFS= read -r w; do
    if [ -n "$w" ]; then
      "$CLI" -datadir="$DATA" -conf="$CONF" loadwallet "$w" >/dev/null 2>&1 || true
    fi
  done <<< "$names"
  return 0
}

if "$CLI" -datadir="$DATA" -conf="$CONF" getblockchaininfo >/dev/null 2>&1; then
  load_wallets
  echo "regtest already running"
  "$CLI" -datadir="$DATA" -conf="$CONF" getblockchaininfo | grep -E '"(chain|blocks|initialblockdownload)"'
  exit 0
fi

# Windows has no -daemon, so detach with Start-Process. Elsewhere use nohup.
if command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
  powershell.exe -NoProfile -Command \
    "Start-Process -FilePath '$(cygpath -w "$D")' -ArgumentList '-datadir=$(cygpath -w "$DATA")','-conf=$(cygpath -w "$CONF")' -WindowStyle Hidden" >/dev/null
else
  nohup "$D" -datadir="$DATA" -conf="$CONF" >"$DATA/bitcoind.out" 2>&1 &
fi

for _ in $(seq 1 60); do
  if "$CLI" -datadir="$DATA" -conf="$CONF" getblockchaininfo >/dev/null 2>&1; then
    load_wallets
    echo "regtest up"
    "$CLI" -datadir="$DATA" -conf="$CONF" getblockchaininfo | grep -E '"(chain|blocks|initialblockdownload)"'
    exit 0
  fi
  sleep 0.5
done

echo "bitcoind did not answer RPC within 30s. See $DATA/regtest/debug.log" >&2
exit 1
