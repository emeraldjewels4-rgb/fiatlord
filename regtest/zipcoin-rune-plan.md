# Zipcoin — definition and regtest-only Rune draft

## Status

**Draft/spec for local use only.** No mainnet broadcast, no mainnet etch, no external deployment has been performed. Any mainnet etch requires explicit approval of the exact final parameters, fees, and broadcast command.

## Canonical definition

| Dimension | Definition |
|---|---|
| **PokeMine form** | **Zipcoin Rune** — ticker **ZIP**, symbol **Ƶ**. A virtual in-app PokeMine collectible mined locally through the normal hash-find flow. No on-chain value, no broadcast, no deployment. |
| **Bitcoin Rune candidate** | **ZIP•COIN** (protocol name `ZIPCOIN`) — Rune-compliant name (A–Z only; spacers cosmetic), display symbol **¤**. This is a draft Rune candidate/spec, not an etched rune unless explicitly approved and broadcast. |
| **Identity** | **Both**: Zipcoin is a PokeMine collectible *and* a real Bitcoin Rune candidate draft. The two forms share the Zipcoin brand/theme but must be labeled by their actual scope (virtual app collectible vs. on-chain Rune candidate). |
| **Relation to UNCOMMON•GOODS** | Zipcoin is an **original** concept inspired by the open, collectible spirit of **UNCOMMON•GOODS (Rune #0)**. It has **no affiliation, no endorsement, no on-chain link, no merge/fuse/attachment** to UNCOMMON•GOODS. UNCOMMON•GOODS is immutable and separate. |
| **Deploy meaning** | **Local app:** update/run Zipcoin in the local PokeMine app (virtual only). **Regtest rehearsal:** etch the ZIP•COIN draft on local regtest only using existing tooling; no real sats, no mainnet. **Mainnet etch:** only after explicit approval of exact final parameters (name, divisibility, premine, supply, terms, symbol, offsets, postage, fee rate) and the exact broadcast command; irreversible and costs real BTC. **Website publish:** separate explicit approval; does not create an on-chain rune. |

## Concrete Rune-candidate parameters (draft)

| Parameter | Value | Notes |
|---|---:|---|
| Rune name | `ZIP•COIN` (`ZIPCOIN`) | Rune-compliant: A–Z only, 7 letters; spacers cosmetic. |
| Divisibility | `0` | Whole units. |
| Premine | `1,000,000` | Allocated to etching wallet on reveal; public in indexers. |
| Terms amount | `1,000` | Units per mint. |
| Terms cap | `20,000` | Max mints. |
| Total supply | `21,000,000` | `premine + amount*cap = 1,000,000 + 20,000*1,000`. |
| Symbol | `¤` | One Unicode code point, cosmetic. |
| Turbo | `true` | Opt into future protocol changes. |
| Mint offset | `start: 0`, `end: 52500` | Opens at etch, closes ~1 year later; omit `end` for open mint. |
| Postage | `10,000` sats/output | 20,000 sats total for premine + throwaway inscription outputs; fees separate. |
| Mode | `separate-outputs` | Matches existing regtest/mainnet batch pattern. |

Supply identity check:

```bash
python - <<'PY'
premine, amount, cap, supply = 1_000_000, 1_000, 20_000, 21_000_000
assert premine + amount * cap == supply
print("ok", supply)
PY
```

## Regtest rehearsal (local only)

Run from `regtest/` using the existing local tooling. These commands assume the regtest node/ord environment is already set up as documented in `regtest/README.md`. They are **not** for mainnet.

```bash
# 1. Start regtest environment (existing tooling)
#    Use the repo's normal regtest flow, e.g. ./start.sh / chain.sh as appropriate.

# 2. Confirm ord wallet exists and has regtest funds
./ord --index-runes wallet balance

# 3. Dry-run the draft batch (no broadcast outside local regtest)
./ord --index-runes wallet batch --fee-rate 1 --batch batch-zipcoin.yaml --dry-run

# 4. Etch on regtest only
./ord --index-runes wallet batch --fee-rate 1 --batch batch-zipcoin.yaml

# 5. Verify
./ord --index-runes runes
./ord --index-runes wallet balance
curl -s -H 'Accept: application/json' http://127.0.0.1:8080/rune/ZIPCOIN
```

## Acceptance checks

- Dry-run parses and reports expected outputs/fees.
- Supply identity holds: `1,000,000 + 20,000*1,000 == 21,000,000`.
- Etched rune resolves as `ZIPCOIN` in local ord/regtest index.
- Premine is in the ord wallet; terms/symbol/divisibility match the draft.
- No mainnet RPC, no mainnet config, no mainnet broadcast used.

## Mainnet guardrail

This draft is intentionally regtest-only. A mainnet etch would require: separate mainnet batch/config/preflight updates, live name-availability checks on two independent indexers with UNCOMMON•GOODS as a known-existing control, explicit fee approval, and your explicit approval of the exact final parameters before any broadcast. I will not broadcast without that explicit approval.
