#!/usr/bin/env python3
"""Regression test for the live check's undeployed-commit warning.

    python test_check_live_undeployed.py
    python -m pytest -q test_check_live_undeployed.py

A worker id names a commit, but that is only a harmless "the host is behind"
when the rest of the answer is healthy. A host running an ancestor build *and*
reporting no database binding is a broken deployment, not an undeployed commit,
and it must stay red: exit 3 there would teach everyone to ignore the warning.

The host is a local HTTP server and the check is the real script, so this covers
the branch itself rather than a copy of its logic. Nothing talks to production
and no GitHub call is made. A shallow clone cannot find an ancestor build, so
the test skips instead of pretending to have run.

The version step retries for about 9 s per case, which is where the run time
goes; that retry window is the subject under test, not an accident.
"""
from __future__ import annotations

import http.server
import json
import pathlib
import re
import subprocess
import sys
import threading
import time
from unittest import SkipTest

ROOT = pathlib.Path(__file__).resolve().parent
WORKER_SOURCE = "build/site-fiatlord.worker.js"
STAMP = re.compile(r'const WORKER_ID = "([0-9a-f]{12})"')
PAGE_ID = "112233445566"


def git(*args: str) -> str:
    done = subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True, text=True)
    assert done.returncode == 0, "git %s failed: %s" % (" ".join(args), done.stderr.strip())
    return done.stdout


def ancestor_builds() -> list[tuple[str, str]]:
    """(short sha, worker id) for commits before HEAD that stamped another id."""
    head = STAMP.search((ROOT / WORKER_SOURCE).read_text(encoding="utf-8"))
    assert head, "the worker source carries no stamp"
    found = []
    for sha in git("log", "--format=%H", "--", WORKER_SOURCE).split():
        stamp = STAMP.search(git("show", "%s:%s" % (sha, WORKER_SOURCE)))
        if stamp and stamp.group(1) != head.group(1):
            found.append((sha[:7], stamp.group(1)))
    if not found:
        raise SkipTest("no ancestor build with a different worker id in this history")
    return found


class Host(http.server.BaseHTTPRequestHandler):
    """Answers as the deployed host would; `version` is set per case."""

    version: dict = {}

    def log_message(self, *args) -> None:
        pass

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        now = int(time.time() * 1000)
        if path == "/api/version":
            return self.send_json(200, self.version)
        if path == "/api/coinspot/prices" and "diag=cold" in self.path:
            prices = {"btc": {"last": 1.0, "source": "carried", "carriedAt": now - 20_000}}
            return self.send_json(200, {
                "ok": True, "prices": prices, "diag": "cold", "source": "stored",
                "cleared": True, "ageMs": 20_000, "carriedAt": now - 20_000,
                "stored": {"present": True, "ageMs": 20_000}, "snapshot": {"state": "idle"},
            })
        if path == "/api/coinspot/prices":
            return self.send_json(200, {
                "ok": True, "prices": {"btc": {"last": 1.0}}, "missing": [],
                "fetchedAt": now, "snapshot": {"state": "written"},
            })
        return self.send_json(404, {"ok": False, "error": "not in this test host"})


def run_check(version: dict) -> tuple[int, str]:
    """Run the real check against a local host that reports `version`."""
    Host.version = version
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Host)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = "http://127.0.0.1:%d" % server.server_address[1]
        done = subprocess.run(
            [sys.executable, str(ROOT / "build" / "check_live.py"), "--url", url],
            cwd=str(ROOT), capture_output=True, text=True, timeout=180,
        )
        return done.returncode, done.stdout + done.stderr
    finally:
        server.shutdown()
        server.server_close()


def test_older_build_without_its_binding_stays_a_failure():
    """An ancestor worker id does not excuse a missing database binding."""
    sha, worker = ancestor_builds()[0]
    rc, out = run_check({"ok": True, "worker": worker, "assets": PAGE_ID, "db": "unbound"})
    assert rc == 1, "expected a failure, got exit %d:\n%s" % (rc, out)
    assert "has the database bound" in out, out
    assert "the host is not broken" not in out, "the warning path was taken:\n" + out


def test_older_build_without_a_page_id_stays_a_failure():
    """A healthy-looking older build with no page id is not "behind" either."""
    sha, worker = ancestor_builds()[0]
    rc, out = run_check({"ok": True, "worker": worker, "assets": None, "db": "bound"})
    assert rc == 1, "expected a failure, got exit %d:\n%s" % (rc, out)
    assert "reports a page id" in out, out
    assert "the host is not broken" not in out, "the warning path was taken:\n" + out


def test_older_build_that_is_healthy_is_a_warning_naming_it():
    """The branch still does its job: a healthy older host names its commit."""
    sha, worker = ancestor_builds()[0]
    rc, out = run_check({"ok": True, "worker": worker, "assets": PAGE_ID, "db": "bound"})
    assert rc == 3, "expected the warning exit, got %d:\n%s" % (rc, out)
    assert "the host is not broken" in out, out
    assert sha in out, "the running commit is not named:\n" + out


if __name__ == "__main__":
    try:
        test_older_build_without_its_binding_stays_a_failure()
        test_older_build_without_a_page_id_stays_a_failure()
        test_older_build_that_is_healthy_is_a_warning_naming_it()
    except SkipTest as skipped:
        print("skipped: " + str(skipped))
    else:
        print("ok: an older host is a warning only when it is otherwise healthy")
