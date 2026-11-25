#!/usr/bin/env bash
# preflight.sh — what the mainnet rune etch needs, checked in order, before
# anything is built or signed.
#
# It changes no money. There is no signer here, no `eth`-style send path, and no
# ord command below mutates anything: `getblockchaininfo`, `wallet balance` and
# three HTTP GETs. `ord wallet batch` is not called at all — not even with
# --dry-run — because the dry run is a step of the etch, not of this check.
#
# The order is the point. Each check is cheaper and more fundamental than the
# next, so the first failure is the one worth fixing:
#
#   1  a mainnet node that is reachable and synced
#   2  the ord server the wallet commands need, on 127.0.0.1:8080
#   3  a wallet that exists
#   4  a balance that covers postage plus fees at the worst rate we would accept
#   5  the rune name still free
#   6  today's fee rate, inside that worst rate
#
# Check 4 needs a fee figure before check 6 has run, so it uses the ceiling from
# MAX_FEE_RATE rather than the current rate: the wallet must be able to pay at
# the worst rate this run would accept, and check 6 then refuses if today is
# already worse. That way passing 4 and 6 together means the etch can pay for
# itself, not merely that it could have yesterday.
#
# Exit codes, as everywhere in this folder:
#   0  every check held
#   1  a check failed; the message says which and what to do
#   2  this script could not run at all (a tool is missing, a file is absent)
#
# `--selftest` runs none of the six. It asserts the values this script carries against batch.yaml
# and needs no node, no ord and no network, which is what lets .githooks/pre-commit gate a
# mainnet-only commit with it instead of spending the tool suite on a batch file.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$DIR/ord.yaml"
BATCH="$DIR/batch.yaml"

BITCOIN_CLI="${BITCOIN_CLI:-bitcoin-cli}"
ORD="${ORD:-ord}"
CURL="${CURL:-curl}"

ORD_URL="${ORD_URL:-http://127.0.0.1:8080}"
EXPLORER_RUNE_URL="https://ordinals.com/rune"
FEE_API="${FEE_API:-https://mempool.space/api/v1/fees/recommended}"

# The rune this batch etches. Spacers are cosmetic: WEB•NINE•NINE•NINE•NINE and
# WEBNINENINENINE are the same rune and collide.
RUNE_NAME="${RUNE_NAME:-WEB•NINE•NINE•NINE•NINE}"

# The worst rate this run will pay. Check 4 requires enough for it; check 6
# refuses if the market is already above it.
MAX_FEE_RATE="${MAX_FEE_RATE:-20}"

# Sats that must leave the wallet as outputs rather than fees, and come back to
# it: the premine output (batch.yaml `postage`) plus the throwaway inscription
# that ord requires in the same batch. Both are yours afterwards; neither is a fee.
POSTAGE_SATS="${POSTAGE_SATS:-20000}"

# Virtual bytes for the whole etch (commit + reveal + the ride-along inscription).
# The regtest dry run of this same batch measured 411 vB in total fees at
# 1 sat/vB, so this is that size with room to spare — deliberately an upper
# bound, because a balance that only just covers the real size is a balance that
# fails after the commit is already broadcast.
VSIZE="${VSIZE:-900}"

PASSED=0
fail()   { echo "FAIL: $*" >&2; exit 1; }
envfail(){ echo "FAIL: $*" >&2; exit 2; }
ok()     { PASSED=$((PASSED + 1)); printf '  ok  %s\n' "$*"; }

# --- --selftest: the part that needs no node ---------------------------------
#
# The two ways a commit breaks the run without touching this script are the copies below drifting
# from batch.yaml (a renamed rune checked under its old name, a postage the wallet was never proved
# against) and the batch's own arithmetic stopping adding up. Both are offline facts, so both are
# asserted here rather than discovered at the gate above, where the node has to be up first.

if [ "${1:-}" = "--selftest" ]; then
  failures=0
  okc() { PASSED=$((PASSED + 1)); printf '  ok  %s\n' "$*"; }
  bad() { failures=$((failures + 1)); printf '  FAIL %s\n' "$*"; }

  # The keys below are flat and unique in this file, so a scan is enough; adding a YAML parser to
  # the gate would mean a dependency that a commit hook cannot install.
  batch_value() {
    { grep -oE "^[[:space:]]*$1:[[:space:]]*[^#]*" "$BATCH" | head -1 |
      sed -E "s/^[[:space:]]*$1:[[:space:]]*//; s/[[:space:]]*$//"; } 2>/dev/null || true
  }
  numeric() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

  et_premine=$(batch_value premine)
  et_supply=$(batch_value supply)
  et_amount=$(batch_value amount)
  et_cap=$(batch_value cap)
  et_rune=$(batch_value rune)
  et_postage=$(batch_value postage)

  echo "preflight selftest: batch.yaml against the copies carried here"

  if numeric "$et_premine" && numeric "$et_supply" && numeric "$et_amount" &&
     numeric "$et_cap" && numeric "$et_postage" && [ -n "$et_rune" ]; then
    okc "batch.yaml yields rune, premine, supply, terms.amount, terms.cap and postage"
  else
    bad "batch.yaml did not yield the six values this script reads (rune='$et_rune' postage='$et_postage')"
  fi

  if numeric "$et_premine" && numeric "$et_supply" && numeric "$et_amount" && numeric "$et_cap" &&
     [ $(( et_premine + et_cap * et_amount )) -eq "$et_supply" ]; then
    okc "supply equals premine + terms.cap * terms.amount ($et_supply)"
  else
    bad "supply does not equal premine + terms.cap * terms.amount, and ord refuses such a batch"
  fi

  if [ "$et_rune" = "$RUNE_NAME" ]; then
    okc "RUNE_NAME here ($RUNE_NAME) is the rune batch.yaml etches"
  else
    bad "RUNE_NAME here is '$RUNE_NAME' but batch.yaml etches '$et_rune' - a rename needs both edited"
  fi

  if numeric "$et_postage" && [ "$POSTAGE_SATS" -eq $(( et_postage * 2 )) ]; then
    okc "POSTAGE_SATS ($POSTAGE_SATS) is the batch postage twice: premine output + ride-along inscription"
  else
    bad "POSTAGE_SATS is $POSTAGE_SATS but batch.yaml's postage $et_postage is paid twice"
  fi

  case "$et_rune" in
    *[!A-Z•]*) bad "the rune '$et_rune' has a character outside A-Z and the spacer";;
    *) okc "the rune is A-Z and spacers only" ;;
  esac

  if [ "$VSIZE" -ge 411 ]; then
    okc "VSIZE ($VSIZE) still covers the 411 vB the regtest dry run measured"
  else
    bad "VSIZE is $VSIZE, below the 411 vB this batch actually measured"
  fi

  echo
  if [ "$failures" -eq 0 ]; then
    echo "preflight selftest PASSED ($PASSED checks)"
    exit 0
  fi
  echo "preflight selftest FAILED ($failures of $(( PASSED + failures )))" >&2
  exit 1
fi

# --- 0. the tools and the files, before any check that needs them ------------

[ -r "$CONFIG" ] || envfail "no $CONFIG, so ord would have no server_url and every wallet command would fail"
[ -r "$BATCH" ] || envfail "no $BATCH, so there is nothing to preflight"
command -v "$CURL" >/dev/null 2>&1 || envfail "$CURL is not on PATH, so no HTTP check can be made"
command -v "$BITCOIN_CLI" >/dev/null 2>&1 ||
  envfail "$BITCOIN_CLI is not on PATH (set BITCOIN_CLI to a mainnet bitcoin-cli)"
command -v "$ORD" >/dev/null 2>&1 ||
  envfail "ord is not on PATH (set ORD to the ord binary; 0.29.1 is in regtest/bin/ord.exe)"

echo "preflight: mainnet rune etch"
echo "  config $CONFIG"
echo "  batch  $BATCH"
echo "  rune   $RUNE_NAME"
echo "  caps   postage ${POSTAGE_SATS} sats + up to ${MAX_FEE_RATE} sat/vB over ${VSIZE} vB"
echo

# --- 1. a mainnet node, reachable and synced --------------------------------

BLOCKCHAIN_INFO="$("$BITCOIN_CLI" -chain=mainnet getblockchaininfo 2>&1)" ||
  fail "bitcoin-cli -chain=mainnet getblockchaininfo failed, so there is no mainnet node to etch from:
      $(printf '%s' "$BLOCKCHAIN_INFO" | head -2 | tr '\n' ' ')
      Start the node and let it sync. Nothing was built, signed or sent."

field() { printf '%s' "$BLOCKCHAIN_INFO" | grep -oE "\"$1\": *[^,}]+" | head -1 | sed -E "s/\"$1\": *//; s/\"//g"; }

CHAIN="$(field chain)"
[ "$CHAIN" = "mainnet" ] ||
  fail "the node answers for chain '$CHAIN', not mainnet. Check bitcoin.conf; etching the wrong chain claims nothing."

IBD="$(field initialblockdownload)"
[ "$IBD" = "false" ] ||
  fail "the node is still in initial block download, so its height is not the chain's. Let it finish; a commit built now could be spent by a reorg."

BLOCKS="$(field blocks)"
HEADERS="$(field headers)"
PROGRESS="$(field verificationprogress)"
case "$BLOCKS$HEADERS" in
  ''|*[!0-9]*) fail "the node did not report usable block counts (blocks='$BLOCKS' headers='$HEADERS'), so sync cannot be judged." ;;
esac
LAG=$(( HEADERS - BLOCKS ))
[ "$LAG" -le 2 ] ||
  fail "the node is $LAG blocks behind its own headers ($BLOCKS of $HEADERS). Wait for it to catch up: the etch's commit and reveal are $LAG blocks apart in time, and the reveal matures 6 blocks after the commit lands."
ok "mainnet node reachable and synced: block $BLOCKS of $HEADERS, verificationprogress $PROGRESS"

# --- 2. the ord server the wallet commands talk to ---------------------------

# Same probe regtest/ord-server.sh and status.sh use: the count of blocks the
# server has indexed. A number means the server is up; nothing else does.
ORD_BLOCKCOUNT="$("$CURL" -s -m 5 "$ORD_URL/blockcount" 2>/dev/null || true)"
case "$ORD_BLOCKCOUNT" in
  ''|*[!0-9]*)
    fail "no ord server answering at $ORD_URL/blockcount (got '${ORD_BLOCKCOUNT:-nothing}').
      Start it with: ord --chain mainnet --config $CONFIG --index-runes server --http --http-port 8080 --address 127.0.0.1
      Without it every wallet command fails against http://127.0.0.1/blockcount." ;;
esac
ok "ord server answering on $ORD_URL, indexed to block $ORD_BLOCKCOUNT"

# --- 3. a wallet that exists ------------------------------------------------

ORD_ARGS=(--chain mainnet --config "$CONFIG" --index-runes)
BALANCE_JSON="$("$ORD" "${ORD_ARGS[@]}" wallet balance 2>&1)" || {
  printf '%s\n' "$BALANCE_JSON" | head -3 | sed 's/^/      /' >&2
  fail "ord could not read a wallet balance, so there is no wallet to etch from.
      Create and fund one first (mainnet/README.md step 2); this script does not create wallets."
}
ok "ord wallet exists and answers wallet balance"

# Spendable, not total: runes and inscriptions in the wallet cannot pay a fee.
SPENDABLE="$(printf '%s' "$BALANCE_JSON" | grep -oE '"spendable": *[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
[ -n "$SPENDABLE" ] || SPENDABLE="$(printf '%s' "$BALANCE_JSON" | grep -oE '"cardinal": *[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
case "$SPENDABLE" in
  ''|*[!0-9]*)
    printf '%s\n' "$BALANCE_JSON" | head -5 | sed 's/^/      /' >&2
    envfail "the wallet balance could not be read from ord's output, so the funds check cannot be made.
      Refusing rather than assuming a balance: this is a check that must not pass by accident." ;;
esac

# --- 4. enough sats for postage plus fees at the worst rate we accept --------

FEE_CEILING=$(( MAX_FEE_RATE * VSIZE ))
REQUIRED=$(( POSTAGE_SATS + FEE_CEILING ))
if [ "$SPENDABLE" -lt "$REQUIRED" ]; then
  fail "the wallet cannot pay for this etch: it has $SPENDABLE spendable sats and the etch needs $REQUIRED
      ($POSTAGE_SATS postage + $FEE_CEILING fee at the ${MAX_FEE_RATE} sat/vB ceiling over $VSIZE vB).
      Short by $(( REQUIRED - SPENDABLE )) sats. Fund the ord wallet, then run this again."
fi
ok "wallet holds $SPENDABLE spendable sats, enough for $REQUIRED (postage + fees at the ceiling)"

# --- 5. the rune name is still free -----------------------------------------

# The bullets are part of the rune's identity, so they are percent-encoded
# rather than dropped: /rune/WEB-NINE-... is a 400, not a "taken".
RUNE_PATH="$(printf '%s' "$RUNE_NAME" | sed 's/•/%E2%80%A2/g')"
CODE="$("$CURL" -s -m 10 -o /dev/null -w '%{http_code}' "$EXPLORER_RUNE_URL/$RUNE_PATH" || echo 000)"

# A 404 only means "free" if the endpoint is answering. This control is a rune
# that is known to be etched, so a broken or blocking endpoint cannot read as an
# available name.
CONTROL="$("$CURL" -s -m 10 -o /dev/null -w '%{http_code}' "$EXPLORER_RUNE_URL/UNCOMMON%E2%80%A2GOODS" || echo 000)"
[ "$CONTROL" = "200" ] ||
  fail "the explorer cannot confirm anything right now: a known-etched rune answered $CONTROL.
      A 404 for our own name would be indistinguishable from an outage, so this check refuses."

case "$CODE" in
  404) ok "rune name $RUNE_NAME is free (404, and the control rune answers 200)" ;;
  200) fail "rune $RUNE_NAME is already etched. Pick a different name in batch.yaml:
      mainnet/batch.yaml line with 'rune:' — and check it with the same explorer URL." ;;
  *)
    fail "the explorer answered $CODE for $RUNE_NAME, which is neither free (404) nor taken (200).
      Retry, or check by hand: $EXPLORER_RUNE_URL/$RUNE_NAME" ;;
esac

# --- 6. today's fee rate, inside the ceiling ---------------------------------

FEES="$("$CURL" -s -m 10 "$FEE_API" 2>/dev/null || true)"
RATE="$(printf '%s' "$FEES" | grep -oE '"halfHourFee": *[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
case "$RATE" in
  ''|*[!0-9]*)
    fail "no fee rate could be read from $FEE_API.
      Pass --fee-rate by hand at etch time, but understand that this check did not run." ;;
esac
if [ "$RATE" -gt "$MAX_FEE_RATE" ]; then
  fail "the half-hour fee rate is $RATE sat/vB, above this run's ${MAX_FEE_RATE} sat/vB ceiling.
      The balance was only proved against the ceiling, so either wait for the mempool to clear
      or re-run with MAX_FEE_RATE=$RATE and enough funds to match."
fi
ok "half-hour fee rate is $RATE sat/vB, inside the ${MAX_FEE_RATE} sat/vB ceiling"

echo
echo "every check held ($PASSED of 6). Nothing was signed and nothing was broadcast."
echo "next, with nothing at risk: the dry run"
echo "  $ORD --chain mainnet --config $CONFIG --index-runes wallet batch --fee-rate $RATE --batch $BATCH --dry-run"
exit 0
