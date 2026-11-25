# Loveriver (LVR) — white paper

**Status: unaudited, local-only, no public deployment.** Every figure below is reproducible
with the commands in *Verification*. Nothing in this document is a promise of value, a
security, or a claim that this token is money.

---

## 1. Summary

Loveriver is an ERC-20-style token with three properties that matter:

1. **Elastic, uncapped supply.** The owner can mint without limit. There is no `MAX_SUPPLY`
   and no code pretends otherwise.
2. **Calendar-paced issuance.** New supply enters through two four-week windows a year, split
   into two stages with different gates: an ungated refill that takes a drained wallet
   straight to its full mark, and a gated top-up from half to the mark that waits for a
   window.
3. **A ten-minute mint ledger.** The local record of each mint exists for ten minutes and is
   then destroyed. This is a privacy choice, and §5 says exactly what it can and cannot do.

It also has fees: a transfer fee in LVR (max 5%), a rotatable fee wallet, and a burn that is
the only operation reducing supply.

`docs/fiat-rules.md` sets the supply rules against sourced central-bank practice; §6
summarises where the analogy holds and where it breaks.

## 2. The token

| Property | Value |
|---|---|
| Standard | ERC-20 interface (`transfer`, `approve`, `transferFrom`, balances, allowances) |
| Supply | uncapped; `mint(to, amount)` is owner-only |
| Fee | `feeBps`, at most 500 (5%), charged in LVR on transfer |
| Fee wallet | one address; transfers *out* of it are free so it can be emptied |
| Fee reduction | `burnFees()` — the only path that lowers `totalSupply` |
| Rotation | `rotateFeeWallet(next)` refuses while the current wallet holds tokens |
| Distribution | `distributeRange(to, perWallet, start, end)`, admin-only, no fee |
| Admins | five addresses fixed at deploy; they are the distribution pool |

16 Foundry tests cover the mint, the fee ceiling, the rotation precondition, the burn, range
fills and the deploy script.

## 3. Supply and issuance

**Uncapped, stated plainly.** 4 × 699,999,999,999 already exceeds a 699,999,999,999 cap, and
an unbounded mint is inflationary by definition. The coherent option was taken: no cap, and
the inflation is disclosed rather than hidden behind a constant.

Issuance is paced by a schedule anchored on Christmas Day at GMT+11 (a fixed offset, so no
server's local time zone can move it):

| Window | Opens | Closes |
|---|---|---|
| 1 | Christmas − 8 weeks | Christmas − 4 weeks |
| 2 | Christmas − 4 weeks | Christmas Day, 00:00 GMT+11 |

Windows are half-open, so a run exactly at a boundary belongs to the later window and never to
both. At the shipped defaults that is two minting periods a year and roughly 1.4 × 10¹² LVR of
projected expansion, all of it visible on chain as `Transfer` events from the zero address.

**Two stages, two gates.** The five admin wallets are the pool that distribution spends from,
so the pool is what must not stay empty:

| Stage | Trigger | Target | Gated? |
|---|---|---|---|
| Floor | balance < mark/2 | the mark | **No** — a rule with a calendar on it is not a floor |
| Full | mark/2 ≤ balance < mark | the mark | Yes — `--within-window` |

A wallet below half therefore goes to the mark immediately, in one ungated mint, because the
pool comes back at full strength. One between half and the mark waits for issuance: what is
poured back below half is safety, what closes the gap above it is issuance, and they are never
the same mint.

**The mark is recorded, never re-inferred.** `fund.mjs` writes it just before draining the
admins; `topup.mjs` reads it. Resolution order is `--target` (a person) → the recorded mark →
the highest balance on chain → refusal. Only `--target` moves it, deliberately: a mark that
drifts with balances is not a mark.

## 4. Fees and distribution

Fees are charged in LVR on the transfer itself — no pool, no oracle, no second asset. The fee
wallet can always be emptied (transfers from it are free), can be burned into nothing, and can
only be rotated while empty. Moving tokens between wallets changes no supply; only the burn
does, and burning shrinks an uncapped mint by a smaller amount than the minting grows it.

1,000 distribution wallets and 5 admin wallets derive from one 24-word BIP-39 mnemonic on two
BIP-32 accounts (`m/44'/60'/0'/0` and `m/44'/60'/1'/0`), so the backup is the mnemonic and
nothing else. `fund.mjs` re-derives all 1,000 addresses and compares them to the stored list
before signing; a single mismatch stops the run. The fill goes through `distributeRange` in
slices of 100 — 10 transactions instead of 1,000 — and is safe to re-run: it fills only what
is still empty and leaves partial balances alone.

## 5. The mint ledger: ten minutes, then destroyed

`tools/mint-ledger.mjs` writes one line per broadcast mint:

| Field | Meaning |
|---|---|
| `at` | the instant the mint was mined, ISO-8601 UTC |
| `rule` | `floor` (never-empty backstop) or `full` (issuance inside a window) |
| `window` | the open window (`window 1 of 2026`), `none` outside one, `ungated` if unchecked |
| `admin` | the wallet minted to |
| `amount` | LVR, decimal |
| `txHash` | the transaction |

**The rule.** Anything ten minutes old or older is destroyed. Not archived, not rotated, not
compressed, not copied: the expired lines are simply not written back, and when nothing is
left the file is removed. There is no `--keep` flag. Entries are purged when `topup.mjs`
starts, again after minting, and by `--show`; for deletion exactly ten minutes after a mint
rather than at the next run, `--purge` belongs on a one-minute timer.

**What this gives.** The running machine does not accumulate a table of who was paid what. If
this directory is copied, or the machine is inspected, there is no mint history in it to hand
over beyond the last ten minutes. Tokens are untouched by any of it: deleting a ledger line
moves nothing and signs nothing.

**What it cannot do.** Two things, and they are not small:

1. **It cannot make a mint untraceable.** Every mint is an owner-signed transaction on a
   public chain; it stays in every block explorer and every full node permanently. Deleting
   the local line deletes a convenience copy. The retention rule buys no on-chain privacy.
2. **It cannot guarantee the bytes are unrecoverable.** Deleting a file removes the name and
   the blocks still pointed at; journals, SSD wear levelling, snapshots and cloud backups may
   hold earlier copies. "Gone from every digital imprint" is not a promise this code can keep,
   and the code does not make it.

**Therefore: this is not an audit trail, by design.** For an audit, read the chain — the
`Transfer` events from the zero address are the complete, permanent, independent record, and
they exist whether or not the local ledger does. What the ten-minute rule removes is the
operator's own easy summary, not the evidence.

Fiat practice is the opposite: regulated transaction records are kept for at least five years
(FATF Recommendation 11), precisely so individual transactions can be reconstructed. LVR
copies fiat's *supply* rules and inverts its *record* rule; `docs/fiat-rules.md` says so
explicitly.

## 6. Fiat rules: where the analogy holds

| Fiat rule (sourced) | LVR |
|---|---|
| Money is created by lending, supply is elastic (BoE 2014) | Uncapped mint; elasticity copied, credit channel absent |
| No fixed supply; policy sets the pace (BoE 2014) | No cap; two windows; mark moved only by a person |
| Direct creation as a backstop (BoE/QE) | Ungated refill of anything below half to the full mark; mechanical where fiat is discretionary |
| Quantity measured and published (Fed H.6) | `totalSupply()` and mint events; fully public |
| Records kept ≥ 5 years (FATF 11) | Ledger destroyed after 10 minutes — **opposite** |

The honest summary: LVR copies **supply discipline** — elastic, calendar-paced, backstopped,
measurable — and none of fiat's institutions (no legal tender, no independent policy
committee, no deposit insurance, no supervisor) and none of its record-keeping.

There is also a difference that undercuts the strongest version of the claim: a central bank
acts on a committee's authority with published minutes, while the schedule here is enforced by
tooling, not by the contract. The owner key can call `mint()` at any time for any amount and
the token will accept it. The calendar is the operator's stated policy, not a constraint on
the token, and anyone reading this should treat it as exactly that.

## 7. Operations

`ops/topup-daily.sh` (cron) and `ops/topup-daily.cmd` (Task Scheduler) run the gated top-up
daily, load `RPC_URL` and `OWNER_KEY` from a gitignored env file so the mint authority never sits
in a task definition, and log to `logs/topup.log` with `===== exit N`. The token address is not in
that file: it comes from `deployments.json`, keyed by the chain id. `OWNER_KEY` is the operator's
key — `LVR_OPERATOR`, the token's owner and only mint authority; the five admins and the fee
wallet are separate fixed addresses, so no admin key belongs on that machine — and a run that
finds it is not the current owner exits 1 before signing anything.

| Exit | Meaning |
|---|---|
| 0 | minted, or had nothing to do (including "floor only, window closed") |
| 1 | refused or failed a check — the block was not touched or the mint reverted |
| 2 | misconfigured: missing key, wrong token, bad argument, owner mismatch |

Dry run is the default; sending needs `--broadcast` **and** `LOVERIVER_BROADCAST=yes`. Rehearsed
against local anvil only; no public network was used at any point.

## 8. Risks

- **The owner can mint without limit, at any time.** The two-window schedule is tooling, not
  consensus. The operator key (`OWNER_KEY`) can inflate the supply arbitrarily, including past the
  mark, outside a window, and in a single transaction.
- **Deleting the ledger weakens the operator's own accountability.** After ten minutes the
  local record of what was minted, to whom, under which rule is gone. The chain still shows
  it, but only to someone who thinks to look at the chain.
- **A single mnemonic controls 1,005 wallets.** Whoever holds the 24 words holds every admin
  and distribution key. It is gitignored; a leaked copy or an unignored backup is total loss.
- **The operator key (`OWNER_KEY`) is plaintext** in the process environment of the scheduled
  job. A keystore or hardware signer would be better and is not implemented.
- **No market, no liquidity, no value.** Price comes from demand, and nothing here creates
  demand. The token is not legal tender and confers no claim on anything.
- **Unaudited code, no deployment.** Reviewed by its authors and the test suite only. Smart
  contract bugs, tooling bugs and operator error are all live risks.
- **The fee is taken in a token that can be minted without limit**, so fee revenue is only
  worth what the token is worth.

## 9. Verification

Every claim above is checkable:

```bash
forge test                                     # 16 tests: contract + deploy
node tools/mint-window.mjs --selftest          # 30 checks: window boundaries
node tools/mint-ledger.mjs --selftest          # 11 checks: append, purge, ten-minute boundary
node tools/mint-clock.mjs                      # read-only: is a window open now
node tools/topup.mjs --rpc ... --token ...     # dry run; add --within-window to gate stage 2
```

Rehearsed on local anvil (chain id 31337) across this project: deploy with five admins, interval
fill of 1,000 wallets in 10 transactions, five emptied admins refilled 0 → mark in one ungated
mint each with the window closed, a quarter-full admin refilled to the mark in the same ungated
mint, a half-to-full one left waiting for the window, a closed gate exiting 1 with the block
unchanged, ledger entries written per mint and destroyed at the ten-minute boundary, and both
scheduler wrappers propagating a dead RPC as exit 1.

## 10. Status

Local only. No public deployment, no audit, no market. The contract and tooling are the
deliverable; using them on a live network is the issuer's decision and risk.
