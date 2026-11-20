# Wallet backup: where it is, and how to restore it

One 24-word BIP-39 mnemonic controls all 1,005 wallets. The backup is that mnemonic and
nothing else: every address is a derived child of it, so there are no keys to keep in sync.

## Where the copy is

| | |
|---|---|
| File | `D:\loveriver-backup\loveriver-wallets-20261120-171535.json` |
| Contains | the mnemonic **in plain text**, plus the 1,000 + 5 addresses derived from it |
| Size | 51,106 bytes |
| SHA-256 | `a0d120ca431db30673baf07dc87bfda8ad2380e9131a10a0cc9f69fa93629f0d` |
| Address fingerprint | `9473cfa0e757673c0ad49ce8f59ca8dae049fae6281461ba4cba4e89d05c56f6` |

Also in that folder, no secret in either:

- `loveriver-addresses-20261120-171535.txt` — the same 1,005 addresses, addresses only.
- `loveriver-wallets-20261120-171535.sha256` — hash of the JSON, to detect corruption.
- `MANIFEST.txt` — the same facts as this section, written next to the file.

The folder's ACL was cut to a single grant for the local user
(`icacls "D:\loveriver-backup" /inheritance:r /grant:r "<user>:(OI)(CI)F"`), so it does not
inherit access from `D:\`.

**This is not yet an offline copy.** D: is a second physical volume in the same machine, so
it survives losing the project folder, a `git clean`, or a corrupted profile — it does not
survive losing the machine, theft, fire or ransomware. The remaining step, and it is the
user's to take: copy `loveriver-wallets-20261120-171535.json` to a USB stick kept elsewhere,
or into a password-manager entry, and record *that* as the primary copy. Do not put it in
OneDrive, Dropbox, Git, chat or email.

## Restoring

`tools/restore-wallets.mjs` rebuilds the wallet file from a backup and checks every address
on the way. It needs no network and never prints the mnemonic.

```bash
cd loveriver

# 1. Verify only: re-derive all 1,005 addresses from the seed in the backup and compare
#    them with the backup's own lists and with the live wallets.json. Writes nothing.
node tools/restore-wallets.mjs --from "D:\loveriver-backup\loveriver-wallets-20261120-171535.json" --check wallets.json

# 2. Rebuild wallets.json and wallets-addresses.txt in place (refuses to clobber without --force).
node tools/restore-wallets.mjs --from "D:\loveriver-backup\loveriver-wallets-20261120-171535.json" --write

# 3. Everything downstream then works unchanged, because the seed and the addresses agree.
npm run fund -- --first 100
```

Exit codes are the project's usual ones: `0` the backup re-derives every address it lists,
`1` something did not match, `2` it could not run (missing file, invalid mnemonic).

`node tools/restore-wallets.mjs --selftest` checks the checker against a public, worthless
test mnemonic: it must accept an unmodified list and catch a swapped, a missing and an extra
address.

## What was actually proved on 2026-11-20

Run against the copy on D:, not against the project file, so the backup itself is what was
tested:

| Check | Result |
|---|---|
| 1,000 distribution addresses re-derived from the backup's seed | all match |
| 5 admin addresses re-derived from the backup's seed | all match |
| 1,005 addresses distinct, no overlap between the two paths | yes |
| Backup and live `wallets.json` hold the same seed and the same addresses | yes |
| Full restore (`--write`) against the live file | `wallets.json` and `wallets-addresses.txt` **byte-identical** |
| A copy with one address changed (index 500) | caught: `FAIL wallets: 1 of 1000 disagree, first at index 500`, exit 1 |
| File hash, recomputed with PowerShell's `Get-FileHash` | matches the recorded `.sha256` |

The fingerprint is a SHA-256 of the 1,005 lower-cased addresses, computed from the seed, so
it identifies this seed's wallet set without revealing it. If a future restore prints a
different fingerprint, the seed is wrong before any address comparison even matters.

## Why this is a real backup and not a file copy

A JSON file containing an address list can be copied perfectly and still be useless: if the
seed in it does not reproduce those addresses, there is no key for anything that was funded.
That is why the restore tool derives rather than trusts, and why the tampered-copy check
above matters more than the checksum. The checksum proves the bytes did not decay; the
derivation proves the bytes still mean what they claim.

## Housekeeping

- `wallets.json.pre-bip32.bak` in the project is the *previous* file, whose 1,000 addresses
  came from independent random keys and cannot be reproduced by any seed. It is kept only so
  the old addresses can be confirmed unused; it is not a backup of anything.
- `wallets.json` is gitignored. Keep it that way; the only copy of the seed that leaves this
  machine should be the one that goes to offline media by hand.

# Repository backup: the history as a git bundle

The seed backup above protects the money. It does not protect the code: this repository has no
remote, so the audit tooling and every commit behind it exist only in the project folder.
`tools/repo-backup.mjs` writes the whole committed history to one bundle file that git can clone
from, and then proves the clone carries that history.

| | |
|---|---|
| Where | `D:\loveriver-backup\loveriver-repo-<YYYYMMDD-HHMMSS>.bundle` |
| Size | about 111 KB (13 commits, 38 tracked files) |
| Beside it | the same name `.sha256`, and `MANIFEST-repo.txt` describing the folder |
| Schedule | task `Loveriver repo backup`, daily 08:10, wake-to-run and start-when-available |
| Overwrites | never: every run writes a new timestamped file, pruning is explicit (`--keep N`) |

The folder's ACL is the one already set for the wallet copy, so the bundle does not inherit
access from `D:\`.

**What it does not contain:** uncommitted and untracked files. Every run prints the list, because
a bundle that quietly omits a day's work is the failure this is meant to catch. `node_modules/`
and `wallets.json` are gitignored and so are absent by design.

## Restoring

```powershell
git clone "D:\loveriver-backup\loveriver-repo-20261120-193141.bundle" loveriver-restored
cd loveriver-restored\loveriver
npm install                             # node_modules is gitignored; the tools import ethers
node tools/mint-audit.mjs --selftest    # the restored tooling works, not just the files
```

Checking without writing anything:

```powershell
git bundle verify "D:\loveriver-backup\loveriver-repo-20261120-193141.bundle"
node tools/repo-backup.mjs --verify-only            # adds the sha256 and the clone comparison
node tools/repo-backup.mjs --restore-check <file>   # one specific bundle
```

## Why the clone, and not just `git bundle verify`

Measured, not assumed: a bundle truncated to half its bytes **still passes `git bundle verify`**
(exit 0), because verify parses the header and the ref list without reading the whole pack. The
clone fails on it (`fatal: early EOF`). That is why every run clones its own bundle into a scratch
directory and requires the same HEAD commit, tree hash, commit count, tracked-file count and
branch tips, plus a clean `git fsck` there, before it reports success. `--selftest` asserts both
halves of that: a truncated bundle passes verify, and the clone check catches it.

Exit codes are the project's usual ones: `0` the bundle verifies and restores, `1` a check
failed, `2` it could not run (no git, a bundle name already taken). A scheduled run leaves
`logs\repo-backup-failed.txt` on a non-zero exit and deletes it on a good run, so a failure is
visible without opening Task Scheduler.

## What was actually proved on 2026-11-20

| Check | Result |
|---|---|
| First bundle, `loveriver-repo-20261120-193047.bundle` | 111,083 bytes, sha256 `75ffb609…ef61e93` |
| Clone of a bundle vs this repo | HEAD `6ac625d`, tree `e276000`, 13 commits, 38 files: **all match** |
| `git fsck --strict` inside the clone | clean |
| Branch tips advertised by the bundle | 1, all match |
| Scheduled run through `wscript` -> `.cmd` -> tool | Last Result **0**, log ends `restore check passed` |
| Hand restore of the newest bundle | 13 commits and the full `git log` back, 12 tools present |
| `node tools/mint-audit.mjs --selftest` in the restored copy | `audit selftest PASSED` (exit 0) after `npm install` |
| Same selftest before `npm install` | fails on missing `ethers` - expected, and why the doc says to install |
| `node tools/repo-backup.mjs --selftest` | 6/6: verify catches nothing on a truncated file, the clone does, and a stale bundle is a mismatch |

**This is still not an offline copy**, for the same reason as the wallet JSON: D: is another volume
in this machine. It survives losing the project folder or a bad `git` command, not losing the
laptop. Copy a bundle to a USB stick sometimes, or push to a remote once one exists.
