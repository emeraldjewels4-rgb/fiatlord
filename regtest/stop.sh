#!/usr/bin/env bash
# Stop the local regtest node cleanly.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$DIR/data"
CLI="$DIR/bin/bitcoin-cli.exe"

if "$CLI" -datadir="$DATA" -conf="$DIR/bitcoin.conf" stop 2>/dev/null; then
  for _ in $(seq 1 40); do
    "$CLI" -datadir="$DATA" -conf="$DIR/bitcoin.conf" getblockchaininfo >/dev/null 2>&1 || { echo "stopped"; exit 0; }
    sleep 0.5
  done
  echo "stop requested but RPC still answering after 20s" >&2
  exit 1
fi

echo "not running"
