# Loveriver (LVR)

An inflationary token with in-token fees, a rotatable fee wallet, and tooling that
generates 1,000 distribution wallets plus 5 administrator wallets.

## Supply: uncapped, and that is the honest description

`mint(to, amount)` has **no maximum**. The owner can issue any quantity at any time.

The original brief asked for a max supply of 699,999,999,999 *and* minting "the top
supply four times" *and* unlimited minting *and* no inflation. Those cannot all hold:
4 × 699,999,999,999 = 2,799,999,999,996 already exceeds the cap, and a supply that can
grow without bound is inflationary by definition. Between the two coherent options,
uncapped minting was chosen, so:

- there is no cap, and no `MAX_SUPPLY` constant to pretend otherwise;
- every mint emits a standard `Transfer` from the zero address (as does a burn, to it),
  so the expansion is visible on-chain even though it is unbounded;
- **this token cannot honestly be marketed as non-inflationary.** If someone asks
  whether supply can grow, the answer is yes, by the owner, without limit.

If a cap is ever wanted, `burnFees()` and `setFeeBps()` stay as they are and only the
mint rule changes — that is a one-line diff, and a decision for the issuer, not
something to infer from the name.

### Zero is refilled to the header supply, hard-coded

The operator, the five administrator slots and the treasury are never observed at zero. The
movement that empties one of them mints `GENESIS_SUPPLY` — 699,999,999,999 LVR, the same
number the deploy mints — straight back into it, in the same transaction. It repeats every
time, with no counter and no cap.

There is no timer, because a contract has none: `0.00001` of a second is not an interval a
block can express. Emptying and refilling in the same transaction is the fastest refill a
chain allows — nothing can read the zero balance in between — and it costs nothing when no
watched wallet is empty. `refillEmpty()` is the keeper call for a watched wallet that was
already zeroed by something other than a movement; it only pays the hard-coded addresses.

Watched means `owner`, `OPERATOR` (the operator's address is also the deployer's) and every
`isAdmin` address — the five admin wallets. The fee wallet is deliberately excluded, for two
reasons: `rotateFeeWallet()` requires it to be empty, so a fee wallet that refilled itself the
moment it emptied could never be rotated away, and it is a separate address from the owner and
the admins, so it is not part of the distribution pool at all.

Every refill is a `Transfer` from the zero address, so the expansion is still visible on
chain as a mint like any other.

The two rules have separate jobs, and `tools/topup.mjs` is the second one. The token owns zero:
a watched wallet there is restored by the contract, and the tool never mints one — it calls
`refillEmpty()` and lets the token pay. The tool owns the band above zero: it mints an admin
still short of the mark back up to it, with `OWNER_KEY` (the operator, the owner, the only mint
authority), in the same two stages as before (below half, ungated; half to the mark, gated by
`--within-window`), and its mark is capped at `GENESIS_SUPPLY`, so no top-up can mint above what
the contract itself would have minted. It never moves tokens between admins and never touches
the fee wallet. A zeroed admin therefore comes back at the header supply, not at the mark, and
everything either rule adds is new supply, not a transfer of tokens that already existed.

## Fees, without a liquidity pool

`feeBps` (basis points, max 500 = 5%) is charged **in LVR on the transfer itself**. No
pool, no oracle, no second asset and no liquidity are required for that, because the
fee is a slice of the token being moved.

- Moving tokens *out of* the fee wallet is free, so it can always be emptied.
- `claimFeeWallet(treasury)` empties it to an address you control.
- `burnFees()` empties it **into nothing**: those tokens leave `totalSupply`. This is
  the only step in the contract that reduces supply, and it is the only honest version
  of "liquidate the fee wallet".
- `rotateFeeWallet(next)` replaces the collector, and **refuses unless the current
  wallet holds zero**. Rotating without burning moves tokens; it does not remove them.

The claim in the brief that emptying and deleting a fee wallet prevents inflation is
not correct as stated: moving tokens between addresses changes no supply. Only the
burn does, and burning an unbounded mint is a smaller effect than the minting itself.

## One mnemonic instead of 1,005 private keys

`tools/gen-wallets.mjs` draws 256 bits of entropy, turns it into a 24-word BIP-39
mnemonic, and derives every address by BIP-32:

| Set | Path | Indices |
|---|---|---|
| 1,000 distribution wallets | `m/44'/60'/0'/0` | `0..999` |
| 5 administrator wallets | `m/44'/60'/1'/0` | `0..4` |

Two separate accounts keep the admin keys off the distribution branch, so the two sets
cannot overlap however many wallets are added later. The backup is the mnemonic and
nothing else; any wallet the project understands can rebuild every address from it.

`tools/fund.mjs` does not take addresses on trust: it re-derives all 1,000 from the
mnemonic and compares them with the list in the file, refusing to run if a single one
differs. That check is what makes one seed as trustworthy as 1,000 stored keys.

`--selftest` proves the derivation against known answers, including the standard test
mnemonic that Hardhat and anvil use: indices 0, 1 and 2 must come out as
`0xf39F…2266`, `0x7099…79C8` and `0x3C44…93BC`, which is exactly anvil's first three
accounts. Derivation that passes that matches any other BIP-32 tool as well — checked
against Foundry's `cast wallet address` on the generated seed itself.

The addresses are new. The previous file held 1,000 independently random keys, so no
seed can reproduce those addresses; they were only ever funded on a local anvil chain,
and nothing on a public network refers to them. The old file is kept as
`wallets.json.pre-bip32.bak` (gitignored) purely so you can confirm that, then delete it.

## Distribution to 1,000 wallets

One path, admin-only, charging no fee:

```solidity
distributeRange(address[] to, uint256 perWallet, uint256 start, uint256 end)
```

It is the interval form the brief describes: run `start=0,end=100`, then `100→200`, and
so on. Each wallet in the range ends up with the same `perWallet` amount, paid out of the
sender's own balance — nothing is minted by distribution.

Worth stating plainly, because it is public: 1,000 wallets funded from one source in
identical amounts is visible on-chain as exactly that. It does not create holders or
value, and it is the first pattern an exchange or buyer looks for.

## The first interval, filled once from the pooled admin supply

`tools/fund.mjs` defaults to the interval `0..100` and fills it in a single pass:

1. it re-derives the five admin addresses from the mnemonic and checks them against the
   file, then sums their on-chain balances — that total is the pool;
2. the pool is divided by the number of wallets in the interval, so each of them receives
   an equal share of the whole admin supply rather than a number typed in by hand;
3. each admin contributes its own balance divided by the same number, in **one**
   `distributeRange` call covering the whole interval. One admin holding the supply means
   one call; five admins holding a fifth each means five calls, one pass, no slicing of
   the interval into chunks of 100.

Integer division leaves a remainder that stays in the admin wallets, and the script prints
it as dust instead of pretending the split is exact. Signing keys are never stored and
there is no key flag either: the admin keys are derived at run time from the same mnemonic
the addresses come from, so the wallet file is the only input. `--first 1000` is the same
operation over every wallet — the interval already is a sweep, so there is no second mode.

It is safe to re-run: only empty wallets are filled. A wallet holding less than the share
is treated as the wreck of an interrupted fill and stops the run with the addresses listed,
because filling around it would hand identical wallets different amounts.

## Admin wallets: the token restores zero, the top-up restores short

The five admin wallets are the pool distribution spends from, so the pool is what must not
stay empty, and two rules share that job by never touching the same balance:

| Balance | Restored by | To | Gate |
|---|---|---|---|
| zero | the token, in the transaction that empties it | `GENESIS_SUPPLY` | none — the contract's own rule |
| above zero, below half the mark | `tools/topup.mjs` | the mark | none — the never-drained floor |
| half the mark to the mark | `tools/topup.mjs` | the mark | the mint window, when `--within-window` is on |

The split is the decision, not an accident: the contract cannot be skipped, needs no key and
runs in the same transaction, so zero is its business; a mark-based mint is the only way to
restore a wallet a distribution left with dust rather than at nothing, so the band above zero is
the top-up's. A mark above `GENESIS_SUPPLY` is capped at it, so the tool can never mint past the
amount the contract itself would restore. A wallet the top-up finds at zero is not minted to the
mark — it calls `refillEmpty()` and the token supplies the header amount.

What the mark no longer is is a second refill target. It is still recorded (a person, or the
balance `tools/fund.mjs` saw just before it spent it down) and it still decides what the tool's
own mints aim at, but the amount that arrives when a wallet reaches zero is the contract's
`GENESIS_SUPPLY`, and the tool caps itself at that same number so the two can never disagree.

### The full mark is recorded, not re-inferred

The target is a stored number, because the balances it would be read from are gone the
moment a distribution drains the admins. `tools/fund.mjs` writes it in the one moment it
is visible — just before the interval fill spends those balances down — into
`admin-full-mark.json` (gitignored, wei as a decimal string so nothing is rounded), and
`tools/topup.mjs` resolves the mark in this order:

| Order | Source | Behaviour |
|---|---|---|
| 1 | `--target <LVR>` | explicit, and recorded for later runs (capped at `GENESIS_SUPPLY`) |
| 2 | the recorded mark | written by a previous fill or top-up |
| 3 | the highest balance on chain | only when nothing has been recorded yet |

The mark is fixed until a person moves it: only `--target` raises or lowers it, so a
spend never quietly changes the number refills are measured against and a new mint does not
silently redefine "full" either. With nothing recorded and every admin at zero there is no
"full" to refill to, so the script asks for `--target` instead of inventing a number — that
is exactly the state a successful interval fill leaves behind, which is why the recorded
mark is what makes a top-up work straight afterwards.

Minting is owner-only, and the owner is the operator hard-coded in the token, so it signs with
`OWNER_KEY` — that operator's key, not one of the admin keys from `wallets.json`, because there
is no second authority to hand it. It also pays the gas for the `refillEmpty()` call it makes for
a zeroed admin, though that call needs no authority of its own — anyone may trigger the token's
restore. Before the first mint it compares the signing address with
`owner()` and exits `1` without sending anything if they differ, which is exactly what a file
still holding the key that was the owner before a `transferOwnership()` looks like. It never
moves tokens between admins and never touches the fee wallet. Dry run is the default; sending
needs `--broadcast` and `LOVERIVER_BROADCAST=yes`.

The mark is a target, not a promise about the amount that arrives. If a mark is set above
`GENESIS_SUPPLY` the run says so and refills to the header supply instead: the contract's own
amount is the ceiling, because two rules for "full" is how a pool gets minted past what its
restore rule would ever have paid. The capped number is the one recorded, with a line saying it
was capped, so the file holds the target the tool will actually use — storing the uncapped value
would reprint the same notice on every later run and record a number nothing ever aims at.

## The year-end mint clock (GMT+11)

`tools/mint-clock.mjs` is the calendar, and it is read-only — it never mints or signs.
Christmas Day at GMT+11 is the anchor, and each year has two four-week windows before it:

| Window | Opens | Closes |
|---|---|---|
| 1 | Christmas − 8 weeks | Christmas − 4 weeks |
| 2 | Christmas − 4 weeks | Christmas Day |

That is two mints a year, both before Christmas, at intervals of a negative four weeks
from Christmas Day, which is the version of the brief a calendar can execute: the last
window closes exactly on Christmas Day. Windows are half-open, so a boundary moment is in
the later window only. Exit code `0` means a window is open, `1` means none is, `2` means
the arguments could not be read — so a scheduler can gate `topup.mjs` on it.

GMT+11 is applied as a fixed offset, not a time-zone name, so no machine's daylight saving
changes the answer. `--now 2026-11-28T10:00:00+11:00` rehearses a date; `--supply` splits
one window's mint across the five admins as a plan (the split is printed, never sent).

### Enforcing it

`tools/topup.mjs --within-window` puts the **full** stage on the same calendar: outside both
windows it mints only the ungated refill — every wallet below half back to the mark — and
leaves the rest waiting. The flag is opt-in,
because a refill is not the annual issuance — but the annual issuance is what you do not
want guessing, so turning the gate on is one argument. The floor is deliberately not gated:
a never-empty rule with a calendar on it is not a floor. Zero is outside the calendar entirely —
the contract restores it whenever it happens, window or not.

The schedule itself lives in `tools/mint-window.mjs` and both scripts import it, so the
clock and the gate cannot drift apart into two different opinions about when minting is
allowed. `node tools/mint-window.mjs --selftest` pins it: the anchor, both windows for
several years, a leap year, the half-open boundaries, the GMT+11 offset and the fact that
`--now` must carry its own — every expected value a literal date rather than one
recomputed from the same arithmetic, so a change in the schedule fails a test instead of
agreeing with itself. A run that finds nothing below half still exits `0` with a closed window, since
it would not mint anyway; `--now` rehearses the gate's decision without waiting for the
date.

### Running it on a schedule

The gate only helps if something runs it, and it has to run when nothing else is: a floor that
stops when the laptop sleeps is not a floor. `ops/topup-daily.sh` (cron) and
`ops/topup-daily.cmd` (Task Scheduler) both load `ops/topup.env`, run
`tools/topup.mjs --within-window --broadcast`, append the tool's output and the exit code to
`logs/topup.log`, and exit with that same code so a scheduler that watches for failure sees
one.

Both have an installer, because the settings that make sleep not matter are not the ones a
one-line schedule gives you:

```bat
rem Windows: daily 07:20, wakes the machine, runs a missed start on resume
powershell -ExecutionPolicy Bypass -File ops\install-topup-task.ps1
powershell -ExecutionPolicy Bypass -File ops\install-topup-task.ps1 -Time 07:20 -NoWake
powershell -ExecutionPolicy Bypass -File ops\install-topup-task.ps1 -Uninstall
```

The Windows task runs `wscript.exe ops\topup-daily.vbs` — no console window — and is
registered with **StartWhenAvailable**, so a start missed while the machine was off or asleep
runs as soon as it can instead of being skipped until tomorrow, and **WakeToRun**, so a closed
lid does not miss it either. The wrapper exits with the top-up's code, so Task Scheduler's
*Last Result* reads `0` (minted, or nothing to do), `1` (a check failed) or `2` (misconfigured)
rather than `0` for everything.

```sh
# cron twin: 07:17 and 19:17, idempotent, secrets read from ops/topup.env
ops/install-topup-cron.sh
ops/install-topup-cron.sh --print
ops/install-topup-cron.sh --remove
```

cron has no wake or catch-up setting, so the twin offers two runs a day instead: a machine off
at 07:17 still gets the 19:17 one. Repeating is free — a run only fills what is below the mark,
and with nothing to do it exits `0`.

Verified on this machine against a local anvil chain: the registered task minted four short
admins up to the full mark, wrote four ledger lines and exited `0`;
a second run logged `nothing to do` and exited `0`; and a trigger set three minutes in the past
started on its own, which is the catch-up a slept-through day relies on.

`ops/topup.env` is gitignored and holds `RPC_URL` and `OWNER_KEY` (plus an optional `NODE` path
when Task Scheduler's `PATH` cannot find node). That key is the operator's — the address in
`Loveriver.OPERATOR`, which is the owner and the only mint authority; the five admins and the
fee wallet are separate addresses fixed in the token, so no admin key from `wallets.json` belongs
in this file — and a run whose key is not the current owner exits `1` before it mints, so a stale
key cannot mint quietly. Copy `ops/topup.env.example` and `chmod 600` it.
The token address is deliberately not in it -- it comes from `deployments.json`. The exit code
in the log is what to alert on: `0`
meant it minted or had nothing to do, `1` refused or failed, `2` was misconfigured. Outside a
mint window a scheduled run still restores the ungated part — any wallet below half back to
the mark — and exits `0`; the calendar gates the full stage, not the floor.

## The mint ledger: ten minutes, then destroyed

Every mint `tools/topup.mjs` broadcasts is written to `mint-ledger.jsonl` — window, rule,
admin, amount, transaction hash and instant — and `tools/mint-ledger.mjs` destroys each line
once it is **ten minutes old or older**. Not archived, not rotated, not copied: expired lines
are simply not written back, and when nothing is left the file is removed. There is no
`--keep`.

```bash
node tools/mint-ledger.mjs --show              # what is still inside the ten minutes
node tools/mint-ledger.mjs --purge             # destroy everything expired, now
node tools/mint-ledger.mjs --forget            # destroy the whole file now
node tools/mint-ledger.mjs --selftest          # append, purge, the ten-minute boundary
```

This is a privacy rule, and it is worth being exact about what it buys. It means **the machine
does not accumulate a table of who was paid what** — copying this directory or inspecting the
box hands over at most the last ten minutes. Tokens are untouched by any of it: deleting a
ledger line moves nothing and signs nothing.

It does **not** buy privacy on chain. Every mint is an owner-signed transaction in a public
block and stays in every explorer and full node forever; the local line is a convenience copy.
Nor can deleting a file guarantee the bytes are unrecoverable — journals, SSD wear levelling,
snapshots and cloud backups may hold earlier copies. So this is **not an audit trail, by
design**: for an audit, read the chain, where the mint `Transfer` events are complete,
permanent and independent of this file.

`tools/mint-audit.mjs` is that read. Given a token and a date range it lists every mint from
`Transfer(0x0 -> to, amount)` events — recipient, amount, block, timestamp, tx hash — plus the
burns, which are the only thing that removes supply, and reports both totals. It also checks
what the header used to only assert: each mint's transaction sender must equal the token's
`owner()` at that block, and a mint that fails that exits 1 rather than reading as a clean
audit.

```bash
node tools/mint-audit.mjs --rpc ... --from 2026-11-20 --to 2026-11-20
node tools/mint-audit.mjs --rpc ... --json > mints.json
node tools/mint-audit.mjs --rpc ... --invariant    # whole life of the token, plus the supply check
```

None of the audit, the top-up or the funder takes a token address on the command line:
`deployments.json`, committed, holds one entry per chain id -- `token`, `deployBlock`, `owner`
-- and all three look the address up by the chain id the RPC reports. The entry is written by
`node tools/record-deployment.mjs` from the broadcast Forge produced: chain id, token address,
deploy block and the signing account are read from `broadcast/Deploy.s.sol/<chain>/` rather than
copied out of a terminal. A redeploy leaves the record stale until that command runs, which is
what `--check` reports (exit 1) and what the pre-commit hook refuses to let past; `--dry-run`
shows what it would write. `--token` still overrides it for a one-off,
but nothing that runs on a schedule needs one. `--invariant` audits from the recorded
`deployBlock` to the head (not block 0, which would be thousands of `getLogs` calls on a public
chain) and requires `issued - burned` to equal `totalSupply()`, exiting 1 on a mismatch or a
mint whose sender is not the owner, and 2 if the supply cannot be read. It also fails when
`owner()` has drifted from the owner recorded in the file, because a stale record is how an
audit quietly checks the wrong thing. `ops/install-audit-task.ps1` registers it daily at 07:50.

On a Linux host `ops/install-audit-cron.sh` is the twin: it installs `ops/mint-audit-daily.sh`
at 07:50 and 19:50, after each top-up window, because cron has no catch-up setting and the
audit only reads, so a second run costs nothing. It takes no signing key - only `RPC_URL` from
the same `ops/topup.env` - and writes the same `logs/mint-audit.log` and `logs/audit-failed.txt`
as the Windows wrapper, so a failure looks the same whichever host ran it.

```sh
ops/install-audit-cron.sh            # install (or update) the two lines, once
ops/install-audit-cron.sh --print    # show what would be installed
ops/install-audit-cron.sh --remove
```

It needs no ledger, and it recovers more than the ledger ever held: a mint that happened before
the ledger existed, or after it was deleted, is still there. What it cannot recover is which
rule fired and which window was open — that context lived only in the ten-minute file, by
design. A re-run against an anvil chain whose ledger had been destroyed rebuilt 8 of 8 mints by
tx hash, recipient and amount, and the event totals equalled `totalSupply` to the wei. Real fiat does the opposite with records — FATF
Recommendation 11 requires transaction records be kept at least five years — which is why
`docs/fiat-rules.md` lists LVR as copying fiat's *supply* rules and inverting its *record* rule.

### Expiry runs on its own

The rule is that a line lives ten minutes. That is not left to the next person who happens to
read the ledger — three things expire it, and the first is the one that survives a reboot:

1. **A one-minute scheduled job** (`ops/ledger-purge.cmd` + `.vbs` on Windows, `ops/ledger-purge.sh`
   on a server). It lives outside any process, so it still fires after a crash, a reboot or a
   machine that was asleep at the ten-minute mark. On Windows it runs through `wscript` with a
   hidden window, because a console flashing every minute is unusable on a desktop.
2. **A detached one-shot** spawned by the run that minted, firing just past the retention. This
   is exact even where no scheduler was ever installed.
3. **Purge-on-touch** in `topup.mjs` and `--show` — a backstop, no longer the mechanism.

```bat
rem install (Windows), and remove
schtasks /Create /TN "Loveriver ledger purge" /SC MINUTE /MO 1 /F ^
  /TR "wscript.exe \"C:\path\to\loveriver\ops\ledger-purge.vbs\""
schtasks /Delete /TN "Loveriver ledger purge" /F
```

```sh
# cron (server)
*/1 * * * * /path/to/loveriver/ops/ledger-purge.sh
```

A scheduled job that stops — a deleted task, a moved directory, a scheduler that no longer
fires — raises no error anywhere: the ledger just stops being emptied. So both wrappers write
`logs/ledger-purge.heartbeat` after every successful purge (one small file, rewritten, not the
per-minute log line they deliberately avoid), and `tools/topup.mjs` checks on every run that the
job is still registered and that the heartbeat is fresh. If either has failed it prints a loud
`!!` warning with the number of entries sitting on disk and how old they are. The same check by
hand, exiting `1` when the scheduler looks dead:

```bash
node tools/purge-watch.mjs --status
```

**Two runs at once cannot corrupt it.** Appends and purges take an exclusive `<file>.lock`, and
the purge re-reads and renames inside that lock, so a line written by another process is either
kept by the purge or lands after it — never dropped by the rewrite. A lock left by a killed run
is reclaimed after 30 s instead of wedging the ledger. Reads take no lock: renames are atomic and
an unparsable line is skipped.

A successful run logs nothing and prints nothing: a line every minute saying "destroyed
nothing" is noise, and one saying "destroyed two" would be a record of the deletions
themselves. Only failures reach `logs/ledger-purge.log`.

**The one gap that remains:** nothing runs while the machine is off. Entries written before a
shutdown are destroyed at the first tick after it boots — later than ten minutes, unavoidably.
The tool closes that with `topup.mjs`'s deferred purge and the purge-on-touch fallback, but it
is the fallback that catches it, not the clock.

## The life binary: a space is 000000, never 0x20

`tools/life-binary.mjs` writes `life.bin`, the runtime code the chain runs, as a spaced hex
dump in which **every space is written as the six characters `000000`** — the encoded code
holds no space character at all (only the `# ` comment lines, which are prose, keep ordinary
spaces). It is derived, never typed: from
`out/Loveriver.sol/Loveriver.json` after a build, or from `eth_getCode` with `--rpc` and
`--token`, so the file can describe what is actually deployed rather than what is checked out.

The header records where the bytes came from and the sha256 of the hex before encoding, which
makes the file checkable instead of trusted:

```bash
node tools/life-binary.mjs                              # write life.bin from the build
node tools/life-binary.mjs --rpc ... --token ...        # write it from the chain
node tools/life-binary.mjs --check --rpc ... --token ...  # does life.bin match the chain?
node tools/life-binary.mjs --decode                     # the dump, spaces restored
node tools/life-binary.mjs --selftest                   # 10 checks: the encoding, the hash
```

`--check` exits `1` when the body no longer hashes to its own header (a hand-edited file) or
when the header disagrees with the current build or the chain (a stale file), so an encoded
dump cannot silently read as code. It is not compression — six characters per space is larger
than one — and it does not replace the artifact; it is one fixed shape for the bytes so a diff
between two builds is a diff between their code.

## Documents

- `docs/WHITEPAPER.md` — the token, the issuance rules, the ledger, the risks, and how to
  check every claim.
- `docs/fiat-rules.md` — fiat issuance rules with their sources (BoE, Fed H.6, FATF, UK MLR),
  each next to what LVR actually does, including the two places it does the opposite.

## Layout

```
src/Loveriver.sol        the token
script/Deploy.s.sol      forge script: deploy with the operator as owner, admins and fee wallet
test/Loveriver.t.sol     forge tests: uncapped mint, fees, rotation rules, range fills
tools/gen-wallets.mjs    derives wallets.json (1,000 + 5 admins) from one mnemonic
tools/fund.mjs           dry-run-by-default funder; interval fill from the pooled admins
tools/topup.mjs          refills any admin below half straight to the full mark
tools/full-mark.mjs      the stored full mark both scripts write and read
tools/mint-clock.mjs     read-only GMT+11 clock: the two year-end mint windows
tools/mint-window.mjs    the schedule the clock reports and the top-up gate enforces
tools/mint-ledger.mjs    the ten-minute mint journal: append, purge, forget
tools/life-binary.mjs    the runtime code as life.bin, where a space is 000000
tools/selftest.mjs       the guard and check printer both selftests share
docs/WHITEPAPER.md       the white paper
docs/fiat-rules.md       fiat issuance rules, sourced, and where LVR differs
foundry.toml             lib/forge-std is vendored locally; no network fetch needed
```

## Running it

```bash
forge test                                    # compile + 22 tests
node tools/gen-wallets.mjs --selftest         # checks the BIP-32 vectors
node tools/gen-wallets.mjs                    # writes wallets.json (mode 0600)
node tools/mint-window.mjs --selftest         # pins the mint-window boundaries
node tools/mint-ledger.mjs --selftest         # append, purge, the ten-minute boundary
node tools/fund.mjs --selftest               # the deployment lookup and the --token refusal, offline
node tools/fund.mjs --rpc http://127.0.0.1:8545                    # dry run; token from deployments.json
```

### The commit gate

`.githooks/pre-commit` refuses a commit in two cases: `tools/record-deployment.mjs --check` finds
`deployments.json` disagreeing with the newest broadcast, or any `selftest*` script in `package.json`
fails. The record check runs on every commit, scoped or not — a redeploy writes only to
`broadcast/`, which git ignores, so the commit that follows one stages nothing under `loveriver/`
and would otherwise never look — and skips cleanly on a machine with no broadcast to be stale
against. The selftests run only when the commit stages something under `loveriver/` or `.githooks/`,
and print `SKIPPED` with the paths they saw otherwise: a regtest- or threads-only commit costs half
a second instead of half a minute, without the gate ever going quiet unexplained.

`core.hooksPath` is per-clone configuration and no commit can carry it, so a clone has no gate at
all until it is set there:

```sh
git config core.hooksPath .githooks
```

`npm install` does exactly that through the `prepare` script; a clone where that was skipped
commits with no checks at all.

## Deploying

`script/Deploy.s.sol` deploys the token with the five admins and mints the initial supply
in a single broadcast. Authority is not configured at deploy time, and it is not one address
any more — the roles are three separate sets of keys, all constants in the token's source:

| Role | Address | What it can do |
|---|---|---|
| owner | `Loveriver.OPERATOR` (`0x4EEA…61a5`) | `mint()`, `transferOwnership()`, `setAdmin()` |
| fee wallet | `Loveriver.FEE_WALLET` (`0x0772…87E2`) | collects the transfer fee; can always be emptied |
| admins | `LVR_ADMIN_1..5` (`0x1BAa…`, `0x7A2A…`, `0x871f…`, `0xD618…`, `0xB61F…`) | distribution, fee settings, rotation |

The five admins are the real admin wallets from `wallets.json` (`m/44'/60'/1'/0/0..4`), so the
"five administrators" of the design are actual keys rather than five empty slots. The fee wallet
is index 5 on the same account — a sixth key, deliberately not one of the five — so rotating the
collector never changes who can distribute. A leaked admin key can spend its own balance, not the
operator's mint authority, and not the fees.

The deploy must be signed by the operator key — `mint()` is owner-only and the initial supply is
minted in the same broadcast — and the roles can still be re-delegated afterwards with
`transferOwnership()` and `setAdmin()`.

The deploy logic is a plain library function, `Deployer.deploy(owner, admins, feeWallet,
feeBps, supply)` (plus an optional destination wallet), and `run()` only reads the
environment and calls it. Internal is essential rather than incidental: an internal call
runs in the caller's frame, so `mint()` is sent by the caller — the signing account during
a broadcast, the test contract in a test. On a contract instead, `msg.sender` for the mint
becomes the script's own address and the owner check reverts. Because the function takes
its values as arguments, tests call it directly and never touch process-wide environment
variables; one small test covers the env wiring in `run()`.

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url http://127.0.0.1:8545 --private-key $OPERATOR_KEY --broadcast
```

| Variable | Required | Meaning |
|---|---|---|
| `MINT_TO` | no | where the initial supply lands, default the operator; set it to the distributing admin to run the funder straight after the deploy |
| `FEE_BPS` | no | fee in basis points, default `100` (1%) |
| `INITIAL_SUPPLY` | no | whole LVR minted, default `699999999999` |
| `OWNER`, `FEE_WALLET`, `ADMIN_1`..`ADMIN_5` | no | refused unless each names the address the token fixes for that role (`LVR_OPERATOR`, `LVR_FEE_WALLET`, `LVR_ADMIN_1..5`): the roles live in the token, so setting `ADMIN_1` to the operator is a mistake the script stops on |

`test/Deploy.t.sol` runs this script with `forge test`, covering the roles it grants, that they
are three separate addresses (the operator is not an admin and the fee wallet is neither), and
the rejection of each role variable that names a foreign address — so a regression fails the
suite instead of waiting for a manual deploy.

Omit `--broadcast` and nothing is sent: the script runs against a fork of the given RPC
and reports what it would do. Rehearsed against a local anvil chain (id 31337) only:
the deploy plus mint cost 2 blocks, and the resulting token reported owner, fee wallet,
fee basis points, `totalSupply` and all five admins correctly. No public network was used.

`wallets.json` holds **one 24-word mnemonic** and the addresses derived from it — no
private keys. It is gitignored. Back the mnemonic up before funding anything; anyone
holding it holds every wallet below it. Where that backup lives, how to restore from it,
and the run that proved it re-derives all 1,005 addresses: `docs/BACKUP-RESTORE.md`.
`tools/restore-wallets.mjs` rebuilds the file from a backup and refuses to trust the
address list it is handed.

The code needs a backup too. There is no remote, so `tools/repo-backup.mjs` writes the whole
committed history to a timestamped git bundle in `D:\loveriver-backup` (task `Loveriver repo
backup`, daily 08:10), verifies it, and then clones it to prove the history comes back. What
is inside, what is deliberately not, and the restore that was actually run: the same
`docs/BACKUP-RESTORE.md`.

The funder sends nothing unless `--broadcast` **and** `LOVERIVER_BROADCAST=yes` are both
present, and it refuses to start without `--rpc` and the mnemonic in `wallets.json`; the
token address comes from `deployments.json`. The fill
itself goes through `distributeRange()` in slices of 100: 1,000 wallets cost 10
transactions instead of 1,000, and no fee is charged, so each wallet receives exactly
the per-wallet amount.

**It is safe to re-run.** Before sending anything it reads every wallet's balance on
chain and fills only the ones that are still empty, reporting how many are already
filled, how many are empty and how many hold some but less than the target. A run that
crashed halfway is resumed by running the same command again; nobody is funded twice,
and the admin balance check covers only the wallets still to do. Wallets holding a
partial amount are deliberately left alone, because `distributeRange` pays a flat amount
and would push them over the target. Add `--rpc` to a dry run to see the
same breakdown without sending anything.

Verified against a local anvil chain: 1,000 wallets filled in 10 transactions, sampled
balances exact, fee wallet 0, distributing admin's balance drained to exactly 0.

## What this does not do, and cannot do here

- **No new blockchain.** x10hosting is Apache + PHP 8.1 shared hosting: no root, no
  long-running processes, no inbound P2P, no node. A chain with its own consensus cannot
  run there. `toolkit/chain.php` on that host is a *proxy* to a real chain's RPC, which
  is the only honest architecture available on that account.
- **No value.** A token's price comes from demand and liquidity, not from its mint
  function or its fee design. Nothing in this repository creates a market.
- **No erasure.** The ten-minute ledger destroys the local record and nothing else. The mint
  transactions remain public on chain forever, and file deletion is not a guarantee about
  copies the filesystem, a backup or a snapshot already took.
- **No byte mining.** A byte is 8 bits, not 2. Hashing files or hex tables produces a
  hash, not consensus, scarcity or a currency.
- **No deployment.** This repository has been compiled and tested locally only. Deploying
  or minting on any live network needs a funded key and the issuer's explicit decision.
