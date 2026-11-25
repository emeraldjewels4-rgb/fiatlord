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

Step 3 is retried for a few seconds on purpose: the write runs after the prices
answer, so the first probe can reach the host before the row arrives.

    python build/check_live.py                      # the production host
    python build/check_live.py --url http://127.0.0.1:8787

Exit codes: 0 every check answered as expected, 1 a check failed, 2 usage.
"""
from __future__ import annotations

import argparse
import json
import pathlib
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
COLD_TRIES = 5
COLD_WAIT = 2.0
WINDOW_MS = 5 * 60 * 1000
HEX12 = "0123456789abcdef"

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

    # 1. Which code is deployed, and does it have a database at all.
    status, text = get(base + "/api/version")
    version = parsed(text)
    check("version answers 200", status == 200, "status %d" % status)
    check("version is JSON", version is not None, text[:120])
    version = version or {}
    check("host runs this checkout's worker", version.get("worker") == wanted,
          "host %r, clone %r" % (version.get("worker"), wanted))
    assets = version.get("assets")
    check("host reports a page id", isinstance(assets, str) and len(assets) == 12,
          repr(assets))
    check("host has the database bound", version.get("db") == "bound",
          repr(version.get("db")))

    # 2. A live answer writes the row the next cold start would carry.
    status, text = get(base + "/api/coinspot/prices")
    prices = parsed(text) or {}
    check("prices answers 200", status == 200, "status %d" % status)
    check("prices carries quotes",
          prices.get("ok") is True and isinstance(prices.get("prices"), dict)
          and len(prices.get("prices") or {}) > 0, text[:120])

    # 3. The cold read, retried: its write is scheduled after the answer above.
    status, text, cold = 0, "", {}
    for attempt in range(1, COLD_TRIES + 1):
        status, text = get(base + "/api/coinspot/prices?diag=cold")
        cold = parsed(text) or {}
        if status == 200 and cold.get("source") == "stored" and cold.get("prices"):
            break
        if attempt < COLD_TRIES:
            time.sleep(COLD_WAIT)

    check("cold read answers 200", status == 200,
          "status %d after %d tries: %s" % (status, COLD_TRIES, text[:160]))
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
