# Sweep runbook

Moving POL and ERC-20 tokens off old Polygon wallets into one destination.
README-level: `transfer.py` (sweep + reports), `newwallet.py` (keys), `balances.py`
(quick native check), `test_tool.py` (regression suite).

Use this interpreter — the `python3` on PATH is a broken Windows Store stub:

```
PY="/c/Users/suzig/AppData/Local/Programs/Python/Python312/python"
```

## 0. Before anything moves

| Step | Command | Why |
|---|---|---|
| Back up the destination key | copy `wallet/` to a USB stick or password manager | without it the swept funds are unrecoverable |
| Encrypt the destination key | `$PY newwallet.py --encrypt wallet/polygon-safe-1.key` | prompts twice, writes `…keystore.json`, deletes the plaintext |
| Confirm the destination address | `$PY newwallet.py --verify wallet/polygon-safe-1.keystore.json` | prints `0x0638d742…8Ed9e1` |
| (optional) explorer key for token discovery | `printf '%s' 'KEY' > .explorer.key` | must be an **Etherscan V2** key; the old PolygonScan V1 API is retired |

Do not paste a private key or password into a chat, a shell argument or a commit —
anything that lands in a transcript must be treated as burnt.

## 1. See what you have

```
$PY transfer.py --holdings 0xOLD1 0xOLD2          # addresses only, no keys, no risk
$PY transfer.py --read-addresses                  # every wallet/*.key, no pasting
$PY transfer.py --holdings 0xOLD1 --discover-tokens --api-key-file .explorer.key
```

Per wallet this prints native POL, every known/listed token, and a USD value per
line from a keyless price feed.

| Line | Meaning |
|---|---|
| `native : 12.5 POL ($1.12)` | balance and spot value |
| `120.44 USDC  $120.40  0x3c49…` | amount, value, contract |
| `no quote` | no price feed entry — the token is not valued, not necessarily worthless |
| `SKIP: ERC-721 contract…` | an NFT, not a fungible token; the sweeper will not touch it |
| `SKIP: symbol advertises a link/claim` | airdrop spam |
| `SKIP: … holds 60% of supply - typical airdrop pattern` | unlisted token you own most of |
| `note: odd symbol` | advisory only, still sweepable |
| `value  : $1,234.56` | native + priced tokens for that wallet |
| `sweep gas: n/a - nothing to move here` | the wallet is empty; nothing to sweep and no gas needed |
| `total value: …` | across all wallets, with `(excludes N unpriced position(s))` when applicable |
| `2 skipped as NFT/spam` | footer count of contracts the sweeper will refuse to touch |

## 2. Rehearse (default — nothing is signed for real)

```
$PY transfer.py --to 0x0638d742492272379aae34FC5607fEd98b8Ed9e1 \
                --keys wallet/old1.key wallet/old2.key
```

Add `--discover-tokens --api-key-file .explorer.key` to include tokens found in
each wallet's history, or `--tokens 0x…,0x…` for specific contracts.

Source keys can be plaintext (`wallet/old.key`) or encrypted
(`wallet/old.keystore.json`); `--key-dir` picks up both. The first keystore
prompts at a hidden prompt (`Password for old.keystore.json:`); later ones try
that password first and only prompt again if it does not decrypt, saying
`unlocked with the password from earlier in this run`. The password is never
read from a pipe, an argument or a file, so this has to be a real terminal.
Encrypting the old wallets before the sweep means the keys are never on disk in
the clear, not even while the sweep runs.

| Line | Meaning |
|---|---|
| `sources   : N wallet(s)` | wallets being swept |
| `native balance : 592.7 POL` | as read at plan time |
| `token holdings : 7` | flagged tokens are listed separately as `x … SKIP: …` |
| `would sweep : 592.5 POL native + 7 token(s)` | what will actually move |
| `! not enough POL for gas` | this wallet is skipped entirely — top it up or sweep it manually |
| `dry run: 8 transaction(s) signed and verified, none broadcast` | signatures were produced and sender-checked, then discarded |
| `would send token … / native …` | the exact transfers, in order (tokens first, POL last) |
| `summary written to sweep-….json` | the plan, for later diffing |

Check the destination address on every line before continuing.

## 3. Send

```
$PY transfer.py --to 0x0638d742492272379aae34FC5607fEd98b8Ed9e1 \
                --keys wallet/old1.key wallet/old2.key --broadcast
```

Watch for these first two lines — the gate is the tool refusing to send money
from a build whose own tests fail:

```
checks    : running test_tool.py before touching any funds ...
checks    : passed (N checks, N passed, 0 failed)
```

Then, per transaction: `tx 0x…  status=0x1`. `status` anything other than `0x1`
means the transaction reverted — its line is reported but the funds did not move,
and verification will say so.

## 4. Read the verification block

Every broadcast ends by re-reading the chain:

```
verification: destination received all 8 transfer(s); source is empty
```

or

```
verification: 3 problem(s) after 8 transaction(s)
  ! shortfall on token 12.5 USDC -> dest: expected +12.5 USDC, destination gained 0 USDC
  ! source still holds 592.71986715 POL
  ! source still holds 9.885164 USDC (0x3c49…)
```

| Message | What it means | What to do |
|---|---|---|
| `destination received all N transfer(s)` | every signed amount arrived | done |
| `shortfall on …` | the destination gained less than was signed | check that hash on Polygonscan. `status=0x1` for a token means the token's transfer logic did nothing (frozen, fee-on-transfer, blacklist). Nothing to retry until the cause is known |
| `source still holds X POL` | the POL leg was smaller than the balance, or skipped | normal when it equals one transfer's gas (~0.0065 POL). Larger: run `--holdings` again and re-sweep |
| `source still holds N TOKEN` | that token was not swept (blocked, or balance re-read failed) | sweep it explicitly with `--tokens 0x…` if it is real |
| `verification` absent | the run was a dry run, or nothing needed moving | none |

Arrival is checked as `gained >= expected`, so a surplus (someone else sent to
the same address mid-sweep) is not an error.

## 5. After the sweep

1. `$PY transfer.py --holdings 0x0638d742492272379aae34FC5607fEd98b8Ed9e1`
   — confirm the funds are there and readable.
2. Re-sweep leftovers if the amount is worth more than the gas.
3. Retire the old keys: delete `wallet/old*.key` once their wallets are empty and
   the transaction history no longer matters. Empty ≠ useless: an old key can still
   be used to sign messages.
4. Keep `sweep-….json` — it is the record of what was sent, with hashes.

## 6. Paying many people from one wallet

A sweep empties *one* wallet into *one* destination. Paying 169 people a fixed
amount each is the other shape, and it has its own tool.

1. Put the recipients in [recipients.csv](recipients.csv), one per line:
   `address,amount,label`. You need **their** addresses — the addresses of the
   wallets the recipients control.
2. Dry run (signs and checks every transfer, sends nothing):
   `$PY payout.py --from wallet/operator.key --file recipients.csv`
3. Read the totals: `recipients`, `total`, and `gas`. At ~310 gwei a transfer
   costs ~0.0065 POL, so 169 payouts cost ~1.1 POL in fees on top of the money
   itself. The dry run is a signing rehearsal, so it takes ~50 s for 169 rows.
4. Fund the payer with `total` + gas, then `--broadcast`. The suite must pass
   first, the balance is re-read and the nonce taken from the chain immediately
   before signing, and every recipient is re-checked afterwards for a shortfall.
5. Keep `payout-….csv` — one row per recipient with the transaction hash. That
   file is your receipt log; hand it to anyone who asks where the money went.

If every recipient gets the same amount, skip the amount column and pass the
total instead: `$PY payout.py --from wallet/operator.key --file recipients.csv --split 2112.5`
The total is divided evenly; any leftover wei go one each to the first recipients,
so the amounts add up to exactly the total.

If a payout is interrupted, rerun it with `--resume` pointing at the receipt CSV
from the interrupted run: `$PY payout.py --from wallet/operator.key --file recipients.csv --resume payout-….csv --broadcast`.
Recipients already marked `0x1` (mined successfully) are skipped. If any row is
marked `unknown`, the tool refuses to continue: check that transfer on-chain
first, because it may already have arrived.

Rules the tool enforces, all of them before anything is signed: a bad address or
amount stops the whole run, a duplicate recipient is refused (`--allow-duplicates`
if you really mean it), and paying the payer itself is refused.

## 7. Preflight a contract verification

`deploy_series_base.py` (Base) and `qdt_polygon.py` (Polygon) submit a deployment's
source to Basescan / Polygonscan. `verify --check-only` makes every decision that
submission would make and then stops, so a pipeline can ask "would this submit
cleanly?" without a record write, an explorer call or a transaction.

```
$PY deploy_series_base.py verify --check-only           # Base
$PY deploy_series_base.py verify --check-only --json    # one object, for CI
$PY qdt_polygon.py verify --check-only                  # Polygon
```

It needs an RPC and the Etherscan v2 key (`--api-key-file` or `ETHERSCAN_API_KEY`).
It does not read the operator keystore, so a preflight runs where the signing key
is not present.

The first failure stops the run, and the exit code says which check that was.

| Exit | State | What it means for a preflight | What to do |
|---|---|---|---|
| 0 | `ready` | record, chain, inputs, key and claim all agree — `verify` would submit | run `verify` |
| 0 | `already` | the record is already verified; nothing would be submitted | nothing |
| 1 | `no-record` | no record names what to verify | `plan` |
| 1 | `unreadable` | the RPC did not answer the chain read | `plan` shows which RPC answers |
| 1 | `mismatch` | record and chain disagree (chainId, code, owner/bridge or admin) | `plan`, then fix the record |
| 1 | `inputs` | the rebuilt inputs no longer hash to the record's pins: the source moved since the deploy | restore the source revision the record pins |
| 2 | — | usage: `--check-only` on a command other than `verify`, or another bad flag | fix the command |
| 3 | `no-key` | no explorer key, so the submission could not be attempted | set `ETHERSCAN_API_KEY` or `--api-key-file` |
| 6 | `inflight` | a submission for this address was started and never answered | look at the explorer before submitting again |
| 7 | `busy` | another run holds the claim | wait for that run to finish |

`pending` (5) and `unreached` (6) cannot come out of a preflight — nothing is polled
and nothing is sent — but `inflight` still exits 6: something was already sent by an
earlier run, and this one will not add to it.

### Why it writes nothing

- **The record.** No `verificationAttempt`, no `verificationGuid`, no
  `verifiedOnBasescan`: the file is byte-identical after the run. That is the point —
  a marker left by a preflight would make the next real `verify` exit 6 as `inflight`,
  and a guid would make it poll a submission that never happened.
- **The explorer.** No POST and no "is this already verified" lookup: the run sends no
  request at all.
- **The claim.** Taken only to prove nothing is mid-flight (the `busy` refusal) and
  released on exit, so a preflight cannot leave a lock behind.
- It does rewrite `build/basescan-standard-json.json` and
  `build/basescan-constructor-args.txt` (`build/qdt/polygonscan-*.json|txt` on
  Polygon): those are the exact bytes the hash check compares with the record's pins,
  and they are what `verify` would have written anyway.
- `--assume-not-sent` is an action, not a check: it clears a recorded marker before the
  preflight and therefore does write the record. A plain preflight never needs it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `refusing to broadcast: the regression suite failed` | fix the code, or run `$PY test_tool.py` to see the failure. There is deliberately no bypass |
| `refusing to broadcast: the regression suite is missing` | `test_tool.py` was moved or deleted; restore it |
| `refusing to broadcast: could not run the regression suite` | Python could not start `test_tool.py`; check the interpreter path |
| `wrong password for … (nothing was signed)` | that keystore's password was wrong and the run stopped before signing; re-run it |
| `… is encrypted: the password must be typed at an interactive terminal` | run it in a real shell window — a piped or scripted password is refused |
| `… holds neither a 32-byte hex key nor a V3 keystore` | the file is not a key; check you pointed at the right path |
| `explorer refused the request … Invalid API Key (#err2)` | the key is not an Etherscan V2 key, or it does not cover Polygon |
| `token discovery needs an explorer API key` | set `POLYGONSCAN_API_KEY` / `ETHERSCAN_API_KEY` or pass `--api-key-file .explorer.key` |
| `! nonce moved 0 -> 2 since planning` | another transaction went out from that wallet; the tool used the current nonce and carried on |
| `! <token>: balance moved since planning, sending …` | the amount changed while planning; the fresh amount was signed |
| `- native: not enough left to cover its own gas, POL sweep skipped` | gas ate the remainder; sweep again after the token transfers settle |
| `! not enough POL for gas - nothing will be sent` | the wallet cannot pay for its own sweep; send it ~0.02 POL first |
| `all Polygon RPCs failed` | try again; the tool rotates three public endpoints |
| password prompt refuses to run | it needs an interactive terminal — not a pipe, not a script, not a chat |

## Known limits

- **Broadcast has not been run against mainnet by the author.** The signing, gas
  model, drift handling and verification are covered by the suite, but the first
  real send is yours. Start with the smallest wallet.
- **NFTs cannot be enumerated** without an indexer (Blockscout returns 403); the
  report only flags NFT-like contracts among those it examines.
- **Verification proves arrival, not accounting** — see the surplus note in §4.
- Gas moves: at ~310 gwei a plain transfer costs ~0.0065 POL and a token transfer ~0.020 POL (~3× that).

## web9999 maintenance pipeline

The scheduled web9999 maintenance is separate from the sweep above. The task
names are `x10_agent`, `x10_ai_review`, `x10_autoip` and `x10_mirror_push`.

### What the pipeline reads from .env

Every deployment detail lives in `.env` at the repository root, which is
git-ignored; no tracked script names this account. A variable that has no
default below is **required**, and its absence is a refusal that names it rather
than a guess: `x10_deploy.py status` without `.env` prints
`no X10_REMOTE_DIR in .env: hosted paths and database names are deployment data,
so nothing here guesses them`. The process environment wins over the file; a
missing file is simply an empty set.

| Variable | Required | What it is |
|---|---|---|
| `X10_REMOTE_DIR` | yes | the account's `public_html` path on the host, e.g. `/home/<user>/public_html`. `X10_API_REMOTE` and `X10_API_WORK_DIR` derive from it |
| `X10_SITE_DB` | yes | the site database: `x10_deploy.py` records uploads in its `web9999_deploys` table, and `x10_agent`/`x10_ai` read it |
| `X10_DB_HOST` | yes | MySQL server `x10_fuse` connects to |
| `X10_DB_NAME` | yes | the mirror database `x10_fuse` writes (`x10_fuse.py push`) |
| `X10_DB_USER` | yes | MySQL user, granted to `X10_DB_NAME` and `X10_SITE_DB` |
| `X10_DB_PASSWORD` | yes | that user's password |
| `X10_DB_PORT` | no, `3306` | MySQL port |
| `X10_CPANEL_HOST` | yes for `x10_deploy` | cPanel server host or URL; the API is called at `https://<host>:<port>` |
| `X10_CPANEL_PORT` | yes for `x10_deploy` | cPanel API port, normally `2083` |
| `X10_CPANEL_USER` | yes for `x10_deploy` | cPanel account user |
| `X10_CPANEL_TOKEN` | yes for `x10_deploy` | cPanel API token; `push`/`pull` refuse without it |
| `X10_API_SOURCE` | no, `build/web/api/web9999` | the local API tree that `push_api` uploads |
| `X10_API_REMOTE` | no, `$X10_REMOTE_DIR/api/web9999` | where that tree is deployed on the host |
| `X10_API_WORK_DIR` | no, the parent of `X10_REMOTE_DIR` + `/.x10-api-deploy` | staging and backup directory used while the API directory is swapped |
| `X10_LIVE_URL` | no, the published page | origin `x10_deploy.py verify` fetches |
| `AI_API_KEY` (or `OPENAI_API_KEY`) | only for `x10_ai.py review` | key for the drafting endpoint; without it `review` exits 3 and changes nothing |
| `AI_API_BASE` | no, `https://api.openai.com/v1` | any OpenAI-compatible chat-completions endpoint |
| `AI_MODEL` | no, `gpt-4o-mini` | model `review` asks for a patch |

The values are credentials and account identity: keep them in `.env`, never in a
command line, a chat or a commit. `README.md` covers what each tool does with
them; this table is only what a fresh checkout has to set before any of them can
run.

### Published host: FiatLord dashboard

**Production is the live dashboard**:
<https://fiatlord-live-crypto-dashboard-9jx1bv.freebuff.site> (site
`fae2424c-44d4-41e2-8a33-01a01800735c`, environment `8eeb1769-…`). That is the
only URL that serves the page.

The preview environment is **unpublished**:
`…-9jx1bv-preview.freebuff.site` answers 404, so do not quote it as a preview of
what is live. Deploying does not publish: a new build can be uploaded to an
environment and still be offline, so check the environment's `published` flag
before saying a URL is live, not the fact that a deployment succeeded.

The site counts **once** against the six-published-site allowance, even though
it has two environments, because a site is counted once while either one is
published. Unpublishing preview does not free the slot while production stays
published; both environments have to be unpublished to free it.

### Public copy: build/make_site_fiatlord.py

The dashboard published through `build/site-fiatlord.deploy.json` is staged, not
hand-copied. `build/site-fiatlord` is disposable output: rebuild it from the
sources rather than editing it, or a stale file will be uploaded silently.

```
$PY build/make_site_fiatlord.py --check   # what would change; writes nothing
$PY build/make_site_fiatlord.py           # rebuild the staged tree
```

The set comes from `build/web/index.html` and the same-origin files it
references, so the PHP sources, htaccess drafts and `.bak`/`.preburn` copies
sharing `build/web` never enter the published tree, and a page that points at
one is refused. Files outside the set are removed from the staged directory and
bytes are copied verbatim, so the deploy publishes exactly what `build/web`
holds now. Exit 1 means the page cannot be served as it stands - a referenced
file is missing - and the tree should not be published until it resolves.

#### Deploying from a clone: wrangler.jsonc

`build/site-fiatlord.deploy.json` targets Freebuff Sites and names a site and a
database that belong to this account. `wrangler.jsonc` is the same deployment
for any Cloudflare account: the worker as `main`, `build/site-fiatlord` as its
assets with the SPA fallback behind the worker, and D1 bound as `DB`. Only the
database id needs editing.

1. Create the database, then paste the id it prints into `wrangler.jsonc`:

```
npx wrangler login
npx wrangler d1 create fiatlord-prices
```

2. Stage the assets, then apply the schema:

```
python build/make_site_fiatlord.py
npx wrangler d1 execute fiatlord-prices --remote --file build/site-fiatlord.schema.sql
```

   Step 2 is optional - the worker creates the table on its first successful
   write - but doing it now means a wrong binding shows up immediately instead of
   as a carry-over that silently never appears.

3. Deploy, then let a real quote seed the row:

```
npx wrangler deploy
curl -sS https://fiatlord-dashboard.<you>.workers.dev/api/coinspot/prices
curl -sS 'https://fiatlord-dashboard.<you>.workers.dev/api/coinspot/prices?diag=stored'
```

   The probe should answer `"source":"stored"` with `"stored":{"present":true}`.
   There is deliberately no SQL seed: a hand-written row would be served as a
   carried price for five minutes, so the only honest way to fill the table is a
   fetch the worker itself made. Until one succeeds, the probe answers
   `present:false` with `no stored row`, which is the true state of a fresh
   account.

Locally the same binding works offline: `npx wrangler dev`, and once
`npx wrangler d1 execute fiatlord-prices --local --file build/site-fiatlord.schema.sql`.

Two things about running that locally on Windows:

- **Give the local database a short `--persist-to`.** Miniflare stores it at
  `<persist>/v3/d1/miniflare-D1DatabaseObject/<64 hex>.sqlite-wal`; under a deep
  workspace path that exceeds the 260-character Windows limit, so the directory
  is never created and every D1 call fails with `internal error; reference =
  <id>` while the rest of the worker answers normally. `npx wrangler dev
  --persist-to C:/wrstate` avoids it. Pass the same `--persist-to` to
  `wrangler d1 execute --local`, or the two commands use different databases and
  a row written by one is invisible to the other.
- **A `.env` in the directory you run from becomes the local worker's secrets.**
  Starting at the repository root prints `Using secrets defined in .env` and
  binds those variables to `env` for the local run. That is normal and it does
  not affect D1 - a root-config probe with `.env` loaded answers
  `?diag=stored` with `"source":"stored"` and `"stored":{"present":true}`, the
  same as a config placed outside the root. Run from a clone with no `.env` if
  the local worker should see no real credentials.

A dev server left running against the same `--persist-to` can make the next one
fail with that same `internal error`; stop the old process (its `node.exe`,
`esbuild.exe` and `workerd.exe` children) before starting another.

#### Prices: live from CoinSpot, not simulated

The Worker serves `GET /api/coinspot/prices` from CoinSpot's public ticker
(`www.coinspot.com.au/pubapi/v2/latest`, falling back to `/pubapi/latest`), so
the published page runs on real quotes. It is not the dead `fiatgod.x10.mx` PHP
host and not the SPA fallback; the dashboard polls the route every 15 s (60 s
while hidden) and labels the chip `CoinSpot live · Ns ago`, and the simulated
feed only appears when the route itself fails.

If the ticker cannot be reached, the last good snapshot is replayed with every
entry marked `source: "carried"` and `carriedAt`, so the page shows
stale-but-real prices rather than turning simulated.

The snapshot is kept in module scope for a warm isolate and written through to
the site's D1 database (binding `DB`, table `price_snapshot`, one row) so a cold
isolate can read it back; the default cache binding is not permitted on this
host. Storage is a fallback and never the primary: every D1 call is wrapped, so
a missing binding or a failed write costs the carry-over and not the feed, and
the module copy is consulted first so a warm isolate never pays a query.

The write and its table creation run after the answer, scheduled through
`ctx.waitUntil` -- never awaited inside the price route, so a slow or failing
database cannot delay a quote. Only the cold-start read touches D1 before an
answer, and it does not create the table. A stored row is honoured for five
minutes (`STORED_MAX_AGE_MS`) and ignored after that: an isolate revived after a
long outage must not present last week's prices as this minute's. An old row is
left in place rather than deleted -- the next good fetch overwrites it. The
route answers 502 JSON -- and the page falls back to simulated prices -- only
when there is no snapshot in memory and none recent in storage.

Because the write runs after the answer, its outcome would otherwise be
invisible. Every prices answer therefore carries a `snapshot` field describing
the isolate's last mirror attempt: `state` is `idle` (no attempt yet), `pending`
(one is running), `written`, `fresh` (the row was recent enough to leave alone,
with the row's `storedAt` and `ageMs`), `failed` (with a short `error`) or
`unbound` (this host has no `DB`). `written` means the row was read back with the timestamp that
was just written -- a resolved `run()` alone is not evidence of a stored row --
and `changes` is what D1 reported. To confirm storage on the live host, poll the
route and look for `"state":"written"`:

```
for i in 1 2 3 4 5; do
  curl -sS https://fiatlord-live-crypto-dashboard-9jx1bv.freebuff.site/api/coinspot/prices \
    | grep -o '"snapshot":{[^}]*}'
  sleep 3
done
```

The first answer of a fresh isolate says `pending`; the next one, from the same
isolate, says `written`. A `failed` state here is the signal the old code
swallowed.

A write is skipped, and reported as `fresh`, when the stored row is younger than
`MIRROR_MIN_INTERVAL_MS` (one minute). Polling must not spend the database's
write allowance: a dashboard open all day polls every 15 s, which would be about
172k writes a month against a 100k limit, whereas the row only has to be recent
enough to carry, not as new as the answer. The threshold is the row's age, so a
row another isolate wrote counts too, and the carry window (five minutes) is
unaffected. Expect `fresh` on most polls and `written` about once a minute.

The read side cannot be observed the same way: a host that already holds a price
answers from module scope and never touches the row, so an ordinary 200 says
nothing about storage. `GET /api/coinspot/prices?diag=stored` forces exactly the
cold-start steps -- read the stored row, carry it -- and nothing else: no ticker
call, no module snapshot, no write. It answers the body a just-booted isolate
would serve, plus:

- `diag: "stored"` -- this is the probe, not an ordinary answer.
- `source: "stored"` (200) or `"none"` (502, with `error` naming the reason).
- `stored: {present, ageMs}` -- always present, used or not: whether the table
  holds a row at all and how old it is. `present: true` with an `ageMs` past the
  five-minute window is the expired-and-ignored case; `present: false` means the
  table is empty. Without this a stale row and an empty table both answered 502.
- `isolate: "cold"` or `"warm"` -- whether this host already held a price when
  it answered, so a forced read on a warm host is not mistaken for a cold start.
  `?diag=cold` always reports `"cold"` because it drops that snapshot first.
- `cleared: true` or `false` -- whether this request let go of the host's module
  snapshot before reading (`true` only on `?diag=cold`).
- `ageMs`, and the usual carried body (`prices` with `source: "carried"`,
  `carriedAt`, `snapshot`) on the 200. The 502 carries no `prices`.

The 502 `error` is one of: `stored row is older than 5 minutes` (row there, too
old), `no stored row` (table empty), `no DB binding`, `stored row is unreadable`,
or `stored row read failed: ...`.

```
curl -sS 'https://fiatlord-live-crypto-dashboard-9jx1bv.freebuff.site/api/coinspot/prices?diag=stored'
```

A 200 with `"source":"stored"` proves the row is readable and that the carried
answer the cold path builds from it works in production. Right after a deploy
the probe reports `isolate: "cold"`, which is a genuine cold-start read from D1.
A 502 with `"stored":{"present":true,...}` proves the row survived and was only
ignored for its age, so the window is the reason no prices came back; the probe
never deletes or rewrites the row (it only selects).

`isolate` describes the host that answered, not the probe: once a live fetch has
run in an isolate, every later probe served there reports `isolate: "warm"`, and
which host answers a request is routing's choice, not something a caller can ask
for. So do not read `"warm"` as a failure -- it only means the request landed on
a host that had already fetched.

For a repeatable cold read use `?diag=cold`. It lets go of the isolate's module
snapshot and then runs exactly the cold-start branch -- read the row, carry it
-- so one request always takes the path a newly booted isolate takes. It answers
the same body as `?diag=stored` with `"isolate":"cold"`, `"cleared":true` and
the row's `ageMs`. Nothing is deleted from storage and nothing is written; only
memory is dropped, and the next ordinary request refetches as it would on a host
that had never answered, so the prices path is untouched.

```
curl -sS 'https://fiatlord-live-crypto-dashboard-9jx1bv.freebuff.site/api/coinspot/prices?diag=cold'
```

Run it within five minutes of a good fetch, because the carry is refused outside
that window (`STORED_MAX_AGE_MS`): later than that the same request answers 502
`stored row is older than 5 minutes`, which still proves the row is present but
carries no prices. An eviction can also leave `?diag=stored` reporting `cold` on
its own, but only while the row is fresh and only as routing luck; `?diag=cold`
is the one to quote in a check.

Any other `diag` value is refused with 400 rather than served as a live answer,
so a typo cannot look like a successful probe.

`build/check_site_worker.mjs` covers these paths under `--check`: live fetch,
snapshot reuse, carried replay, the scheduled write-through, a cold start served
from storage, the 502 when storage is empty or unreachable, a store that blocks
forever without delaying the answer, the reported mirror outcome (pending,
written, fresh, unbound, a failing store, and a write the read-back does not
confirm), the stored-row probe (cold, warm, no row, no binding, stale row, no
write, no ticker call, the presence and age it reports for both a stale row and
an empty table, and the refusal of an unknown flag), the expired `?diag=cold`
502 body pinned byte for byte (`stored.present` true, `ageMs` just past the
window, `cleared`, no prices, SELECT only), and the build-identity answer (the
worker id matching the source, the shell hash, the `db` binding, the per-isolate
read, and the method refusal).

#### Build identity: which code and which page a host serves

`?diag=stored` answers where the prices came from and says nothing about which
build answered. `GET /api/version` does:

```
{"ok":true,"worker":"6c6268d1010a","assets":"3cf4bdcd06c0","db":"bound"}
```

- `worker` is sha256 of `build/site-fiatlord.worker.js` with that value zeroed
  out, so it moves with any edit to the worker and can be recomputed from a
  clone: `node build/worker-id.mjs`. It is stamped by
  `node build/worker-id.mjs --write`, and the harness fails when the stamp is
  stale, so a worker edit without a restamp cannot ship a host that misreports
  which code it runs.
- `assets` is the same kind of hash over the shell the host serves. The shell
  names the bundles by content hash, so rebuilding the staged tree moves it even
  when the worker is untouched; `null` means the assets binding could not
  answer.
- `db` is `bound` or `unbound`: whether the `DB` binding exists at all. A deploy
  that lost the binding and a deploy that is merely old look identical from the
  prices route until the upstream dies and there is nothing to carry, and one
  call distinguishes them. It says nothing about whether the row is readable
  -- that is what `?diag=stored` and `?diag=cold` answer.

A deployment that is this clone answers the same two values the clone computes,
which is what makes "is production what I just built" a single request instead
of an inference. Neither value says anything about a commit hash: a deploy
uploads the file verbatim, so there is nothing to inject one at.

#### Scheduled live check: is the host still the clone, with working storage?

Everything above says what a host should answer; nothing in the repo looked at
whether it does. `build/check_live.py` asks, and the `live-check` workflow runs
it every 30 minutes, so a stale deploy or a broken carry is noticed instead of
discovered by hand during an outage.

```
python build/check_live.py                        # the production host
python build/check_live.py --url http://127.0.0.1:8787
```

- `GET /api/version` must name the worker that `node build/worker-id.mjs`
  computes from this checkout, report a 12-hex page id, and say
  `db: "bound"`.
- An ordinary prices GET must answer quotes; that is what writes the row.
- `GET /api/coinspot/prices?diag=cold` must then read the row back and carry it
  inside the five-minute window. It is retried for a few seconds because the
  write is scheduled after the prices answer, so the first probe can arrive
  before the row does.

Every step is retried because a deploy is not atomic: for a few seconds the old
and the new isolate both answer, and the old one reports the previous worker id,
omits `db`, and refuses `?diag=cold` as an unknown flag. The tolerance is short
on purpose, about 15 s in total (`/api/version` 4 tries 3 s apart, the cold read
4 tries 1.5 s apart), because a rollout is measured in seconds and every second
here is a second a stale deploy keeps answering ok. `/api/version` must match
twice in a row, because a single lucky probe also comes out of a host flapping
between the two builds. A rollout ends as a pass with a note saying how long it
took (`version matched twice in a row after 6.1s (try 3); a deploy was
propagating`); a deploy that never landed fails and says how long it waited:
`host answered <id> after 9.1s of retries, so the deployment is old or missing`,
and a host that never settles fails as `matched only on the last try after
9.0s, never twice in a row: the host is alternating between <old>, <new>`.

There are two outcomes for a worker id that does not match, and they are no
longer the same colour. If the id is the stamp of an ancestor commit, the host
is healthy and simply runs an older build: the check names that commit, lists
the worker commits after it that are not deployed, and exits 3, which the
workflow turns into a `::warning::` annotation and a green run with the reason
in the summary. If the id is in no commit in the history - a deployment from
somewhere other than this checkout, or a clone too shallow to walk the worker's
commits - it stays exit 1. Deploying from uncommitted work therefore still shows
as a failure, because there is no commit to name.

Exit 1 lists every failed check, and the reason narrows the cause: an unknown
worker id is a deploy that is not this checkout, `db: "unbound"` is a deploy
that lost its binding, and a 502 from the cold read is storage that is present
but too old, unreadable, or empty.

#### Caching contract: build/site-fiatlord.worker.js

The worker sets two cache policies, plus one rule that keeps them from
colliding. All of it depends on names telling the truth about bytes:

- **`/assets/*` is immutable for a year** (`public, max-age=31536000,
  immutable`). This is only safe because the names are content hashed: a new
  bundle gets a new name, so a URL is served the same bytes forever.
- **The HTML shell is `no-cache`**, checked by content type before path, so every
  navigation revalidates and a new deploy is picked up without a purge.
- **A missing `/assets/` path must never be pinned.** The live host answers an
  unknown path, including one under `assets/`, with the shell and a 200. If the
  header rewrite looked at the path first, the shell would be cached as immutable
  for a year under a bundle name and that URL would stay broken for everyone who
  saw it.

Renaming a bundle without changing its bytes breaks this contract. The new name
is immutable for a year too, so those same old bytes are pinned under a name
that claims to be a different build, and anyone who cached that URL keeps them
regardless of what is uploaded later. Worse, the fallback above means a rename
to a file that is not staged serves the shell as the script. Rename only
together with the bytes, then recompute the hash in the name.

`build/check_site_worker.mjs` asserts all of this and runs from `--check`, so a
later edit to the worker that drops the immutable header, pins the shell, or
answers an `/api` path with something other than JSON fails staging instead of
shipping.

#### Where build/web/assets came from

The two bundles in `build/web/assets` are a saved copy of the live site put
aside on 4 Nov 2026, not output of a build run in this repo -- there are no page
sources here to build from. The JS arrived as build **Euyfrw0y**, one build
behind the `index-BoSs10Hc.js` that the shell used to request: that file was
never recovered (`fiatgod.x10.mx` is unreachable and no archive snapshot
exists), so the shell's `src` was repointed at the build that was actually
here.

That bundle has since been patched by hand, because the one thing the page could
not say was whether its prices were live or carried: the feed chip read
`CoinSpot live` after any successful poll, a replay of the stored snapshot
included. The patch is three expressions and nothing else:

- `yk()` returns `carriedAll`, true when every price in the answer carries
  `source: "carried"`.
- The poll sets the feed to `carried` in that case instead of `coinspot`.
- The chip renders a third state, `Carried prices`, with the row's age and `not
  live`, in sky where live is emerald and simulated is amber.

That is the whole UI change; no other bytes differ. The patched file is
`assets/index-87a7946b18f5.js`, named by the first 12 hex of the sha256 of its
own bytes rather than by Vite's hash -- the file is not a build output, so the
name says what it is and still matches the bytes. `.github/check_shell_bytes.py`
and `build/check_site_worker.mjs` name the current bundle: an intended change to
the page means new bytes, a new name, and updated pins, which is the point of
both checks.

| file | bytes | sha256 |
| --- | --- | --- |
| `assets/index-87a7946b18f5.js` | 974,646 | `87a7946b18f59404ff97c7cb594b66fffa9d9f34c763afa6056fb7e0bea3de7f` |
| `assets/index-6o21nwvo.css` | 77,158 | `7aad3033abdbff501f4224f4e3431a2a1b2b83630310ec49814b35da70b087a0` |

The CSS name is the one the shell asked for; the JS name is not. Treat both as
a pinned snapshot: they are not rebuilt from `build/web/*.php`, so a PHP change
published through `x10_deploy.py push` does not reach this page until a newer
bundle can be fetched and staged.

### Drift reporting: x10_agent

`x10_agent` **reports drift and never repairs it**. On each scheduled pass its
`check_drift()` compares each local `build/web/*.php` file with the deployed
copy. A missing or changed file is a fault: the output says `FAULT ...; no
upload`, the check returns `False`, and the task exits non-zero.

It does not call `x10_deploy.push()`, does not write to `public_html`, and does
not restore a previous page, API file, or root PHP file. Publishing stays a
deliberate manual action after reviewing the drift:

```
$PY x10_deploy.py status
$PY x10_deploy.py push
```

### Patch drafting: x10_ai_review

`x10_ai_review` **only drafts patches**. The nightly task runs
`build/x10_autoupgrade.cmd`, which invokes `x10_ai.py review`; that writes a
proposal to `build/ai/patch-*.json` and logs the result in
`build/ai/upgrade.log`. It applies nothing and uploads nothing.

The manual `x10_ai.py apply` path is local-only: it validates a saved patch and
writes it under `build/web`, with no `public_html` upload, live verification, or
automatic restore. After reviewing the local diff, publish deliberately with
`$PY x10_deploy.py push`. `$PY x10_broadcast.py --fix` also drafts only; the scheduled
`web9999 broadcast` task remains disabled.
