#!/usr/bin/env python3
"""Check the deployed dashboard: this clone's worker, and a stored row that reads.

Nothing in the repo looks at production. `make_site_fiatlord.py --check` compares
the checkout with a tree built from that same checkout, so a deploy that never
landed, a host that lost its `DB` binding and a stored row that stopped being
readable all pass it. The page hides all three the same way: it keeps serving
prices while the upstream answers, and only shows the simulated feed once the
upstream dies - by which point the carry that was supposed to cover the outage
is the thing that is broken.

So this asks the host instead, in the order that makes each answer mean
something:

1. `GET /api/version` must name the worker that `build/worker-id.mjs` computes
   from this checkout, report a page id, and say the database is bound.
2. An ordinary `GET /api/coinspot/prices` refreshes the stored snapshot.
3. `GET /api/coinspot/prices?diag=cold` must read that row back and carry it,
   with an age inside the five-minute window.

Every step is retried, and for two different reasons. A deploy is not atomic:
for a few seconds old and new isolates answer the same URL, so the first
`/api/version` can report the previous worker id (or, on an older build, no `db`
field) and an old isolate refuses `?diag=cold` as an unknown flag. Separately,
the mirror write runs after the prices answer, so the first cold probe can reach
the host before the row arrives. `/api/version` must match twice in a row, since
a single lucky probe also comes out of a host that is flapping between the two
builds. A rollout therefore ends as a pass with a note saying how long it took;
a deploy that never landed, or one whose answers never settle, still fails after
about 15 s of retries, and the failure says how long it waited.

A host that simply runs an older build is not broken, so it is not reported as
a failure: when the reported worker id is the one stamped by an ancestor commit,
the check names that commit and the worker commits after it that are not
deployed, and exits 3 so the workflow can turn it into a warning. A worker id
that is not in this history at all stays a failure - that is a deployment from
something other than this checkout, not a commit waiting to be shipped.

    python build/check_live.py                      # the production host
    python build/check_live.py --url http://127.0.0.1:8787

Exit codes: 0 every check answered as expected, 1 a check failed, 2 usage,
            3 the host runs an older build of this checkout (warning, not
            failure): the named worker commits are not deployed yet.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_URL = "https://fiatlord-live-crypto-dashboard-9jx1bv.freebuff.site"
# Python's own user agent is refused at the edge, so say what this actually is.
USER_AGENT = "curl/8.0 (fiatlord live check)"
TIMEOUT = 20
WINDOW_MS = 5 * 60 * 1000
HEX12 = "0123456789abcdef"
WORKER_SOURCE = "build/site-fiatlord.worker.js"
STAMP = re.compile(r'const WORKER_ID = "([0-9a-f]{12})"')

# A deploy is not atomic. For a few seconds the old and the new isolate both
# answer the same URL, and the old one reports the previous worker id (and,
# before the `db` field existed, no binding at all) - or refuses `?diag=cold` as
# an unknown flag. Every step is therefore retried until an isolate gives the
# expected answer, so shipping does not turn the scheduled run red.
#
# The tolerance is deliberately short, about 15 s in total: a rollout is measured
# in seconds, and every second of grace here is a second a genuine drift keeps
# answering ok. Longer than this has only been seen on a handful of deploys, and
# the failure names how long it waited so that case is visible rather than
# guessed at.
#
# The version answer must match twice in a row: a host that is flapping between
# old and new isolates answers correctly on any single probe, and one lucky probe
# is not a landed deploy. Two consecutive matches cannot both come from the old
# build, so a flapping host fails instead of passing.
VERSION_TRIES = 4
VERSION_MATCHES = 2
VERSION_WAIT = 3.0
PRICES_TRIES = 2
PRICES_WAIT = 1.0
COLD_TRIES = 4
COLD_WAIT = 1.5

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    """Record one assertion, printing a line either way."""
    if ok:
        print("ok   " + name)
        return
    failures.append(name if not detail else name + ": " + detail)
    print("FAIL " + name + (": " + detail if detail else ""))


def get(url: str) -> tuple[int, str]:
    """One GET, with a user agent the edge accepts; a transport error is not fatal."""
    request = urllib.request.Request(url, headers={"user-agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return int(error.code), error.read().decode("utf-8", "replace")
    except OSError as error:
        return 0, "unreachable: " + str(error)


def parsed(text: str) -> dict | None:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def rollout_note(workers: list, wanted: str, waited: float) -> str:
    """Say whether the misses looked like a deploy in progress or a stale host."""
    seen = ", ".join(dict.fromkeys(workers))
    if workers and workers[-1] == wanted:
        return ("matched only on the last try after %.1fs, never twice in a row: "
                "the host is alternating between %s" % (waited, seen))
    return ("host answered %s after %.1fs of retries, so the deployment is old or "
            "missing" % (seen, waited))


def git(*args: str) -> str:
    """One git command at the repository root; empty output means it failed."""
    try:
        done = subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True,
                              text=True, errors="replace")
    except OSError:
        return ""
    return done.stdout if done.returncode == 0 else ""


def deployed_commit(host_id: str) -> tuple[str, list[str]] | None:
    """The commit whose stamped worker id the host runs, and what came after it.

    Returns (that commit, worker commits after it that are not deployed), or None
    when the host's id is not in this history - which means the deployment is not
    from this checkout, a different thing from a commit waiting to be shipped.
    Walks back over the commits that touched the worker source, so it costs one
    `git show` per change rather than per commit. A shallow clone simply finds
    nothing, and the caller keeps its plain failure.
    """
    if len(host_id) != 12 or any(c not in HEX12 for c in host_id):
        return None
    for sha in git("log", "--format=%H", "--", WORKER_SOURCE).split():
        stamp = STAMP.search(git("show", "%s:%s" % (sha, WORKER_SOURCE)))
        if not stamp or stamp.group(1) != host_id:
            continue
        waiting = [line for line in
                   git("log", "--format=%h %s", "%s..HEAD" % sha, "--", WORKER_SOURCE)
                   .splitlines() if line.strip()]
        return git("log", "-1", "--format=%h %s", sha).strip(), waiting
    return None


def local_worker_id() -> str:
    """The id this checkout's worker stamps, by the same tool the staging check uses."""
    result = subprocess.run(
        ["node", str(ROOT / "build" / "worker-id.mjs")],
        cwd=str(ROOT), capture_output=True, text=True,
    )
    printed = result.stdout.strip().splitlines()
    value = printed[-1].strip() if printed else ""
    if result.returncode != 0:
        raise SystemExit("FAIL build/worker-id.mjs did not run: "
                         + (result.stderr.strip() or "no output"))
    if len(value) != 12 or any(c not in HEX12 for c in value):
        raise SystemExit("FAIL build/worker-id.mjs printed %r, not a 12-hex id" % value)
    return value


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Check the deployed dashboard against this checkout.",
    )
    parser.add_argument("--url", default=DEFAULT_URL,
                        help="host to check (default: the production site)")
    args = parser.parse_args(argv)
    base = args.url.rstrip("/")

    wanted = local_worker_id()
    print("host   " + base)
    print("clone  worker " + wanted)

    # 1. Which code is deployed, and does it have a database at all. Retried for
    #    the rollout window: the previous isolate answers first and is not a
    #    stale deploy.
    status, text, version, workers = 0, "", {}, []
    assets = None
    matches = 0
    started = time.monotonic()
    for attempt in range(1, VERSION_TRIES + 1):
        status, text = get(base + "/api/version")
        version = parsed(text) or {}
        workers.append(str(version.get("worker")))
        assets = version.get("assets")
        matched = (status == 200 and version.get("worker") == wanted
                   and isinstance(assets, str) and len(assets) == 12
                   and version.get("db") == "bound")
        matches = matches + 1 if matched else 0
        if matches >= VERSION_MATCHES:
            break
        if attempt < VERSION_TRIES:
            time.sleep(VERSION_WAIT)
    waited = time.monotonic() - started
    if matches >= VERSION_MATCHES and attempt > matches:
        print("note   version matched twice in a row after %.1fs (try %d); a deploy "
              "was propagating" % (waited, attempt))

    check("version answers 200", status == 200, "status %d" % status)
    check("version is JSON", bool(version), text[:120])
    landed = matches >= VERSION_MATCHES
    shown = version.get("worker")
    if not landed and shown != wanted:
        older = deployed_commit(str(shown))
        if older is not None:
            deployed, waiting = older
            print()
            print("warning  the host is not broken, it is behind: it runs the worker from")
            print("warning    " + deployed)
            if waiting:
                print("warning  %d worker commit(s) after it are not deployed:" % len(waiting))
                for line in waiting:
                    print("warning    " + line)
            else:
                print("warning  no later worker commit is waiting, so the host runs a "
                      "rebuild of that commit")
            print("warning  deploy this checkout to clear this; nothing failed")
            return 3
    which = ("host and clone are both %r" % wanted if shown == wanted
             else "host %r, clone %r" % (shown, wanted))
    check("host runs this checkout's worker twice in a row", landed,
          "%s (%s)" % (which, rollout_note(workers, wanted, waited)))
    check("host reports a page id", isinstance(assets, str) and len(assets) == 12,
          repr(assets))
    check("host has the database bound", version.get("db") == "bound",
          repr(version.get("db")))

    # 2. A live answer writes the row the next cold start would carry. Also
    #    retried: during a rollout the first prices answer can come from an old
    #    isolate while the new one is still starting.
    status, text, prices = 0, "", {}
    started = time.monotonic()
    for attempt in range(1, PRICES_TRIES + 1):
        status, text = get(base + "/api/coinspot/prices")
        prices = parsed(text) or {}
        if (status == 200 and prices.get("ok") is True
                and isinstance(prices.get("prices"), dict) and prices.get("prices")):
            break
        if attempt < PRICES_TRIES:
            time.sleep(PRICES_WAIT)
    check("prices answers 200", status == 200,
          "status %d after %.1fs" % (status, time.monotonic() - started))
    check("prices carries quotes",
          prices.get("ok") is True and isinstance(prices.get("prices"), dict)
          and len(prices.get("prices") or {}) > 0, text[:120])

    # 3. The cold read, retried for two reasons at once: its write is scheduled
    #    after the prices answer, and an isolate that still runs the old worker
    #    refuses `?diag=cold` as an unknown flag.
    status, text, cold = 0, "", {}
    started = time.monotonic()
    for attempt in range(1, COLD_TRIES + 1):
        status, text = get(base + "/api/coinspot/prices?diag=cold")
        cold = parsed(text) or {}
        if status == 200 and cold.get("source") == "stored" and cold.get("prices"):
            break
        if attempt < COLD_TRIES:
            time.sleep(COLD_WAIT)
    waited = time.monotonic() - started
    if attempt > 1 and status == 200:
        print("note   cold read answered after %.1fs (try %d); a deploy or a write was "
              "settling" % (waited, attempt))

    check("cold read answers 200", status == 200,
          "status %d after %.1fs of retries: %s" % (status, waited, text[:160]))
    check("cold read is marked cold", cold.get("diag") == "cold" and cold.get("cleared") is True,
          "diag %r, cleared %r" % (cold.get("diag"), cold.get("cleared")))
    check("cold read came from storage", cold.get("source") == "stored",
          "source %r, error %r" % (cold.get("source"), cold.get("error")))
    age = cold.get("ageMs")
    check("cold read is inside the five-minute window",
          isinstance(age, int) and 0 <= age <= WINDOW_MS, repr(age))
    check("cold read carries the stored prices",
          isinstance(cold.get("prices"), dict) and len(cold.get("prices") or {}) > 0,
          repr(cold.get("prices"))[:120])
    check("cold read found a row", (cold.get("stored") or {}).get("present") is True,
          repr(cold.get("stored")))

    print()
    if failures:
        print("%d check(s) failed" % len(failures))
        for name in failures:
            print("  " + name)
        return 1
    print("all live checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
