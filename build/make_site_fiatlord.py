#!/usr/bin/env python3
"""Stage the public dashboard: build/web -> build/site-fiatlord.

build/site-fiatlord.deploy.json publishes build/site-fiatlord, so that directory
has to be a copy of the sources, not a hand-maintained snapshot. A file left
behind there is uploaded without complaint, and that is how the live page drifts
from the page in the repo. This rebuilds the staged tree from build/web on
every run.

What gets staged is what the page serves, not everything in build/web. The set
starts at index.html and follows its same-origin references (/ads.html, /ads.js,
/assets/...), including the references in those pages, so only reachable files
are copied. The PHP sources, the htaccess drafts and the .bak/.preburn copies
that share build/web stay out; a page that points at one is reported as a fault
rather than smuggled into the published tree.

Anything in the staged tree outside that set is deleted and bytes are copied
verbatim, so a deploy publishes exactly what build/web holds now.

Nothing here touches the network. It only reads project files.

Usage:
    python build/make_site_fiatlord.py             # rebuild the staged tree
    python build/make_site_fiatlord.py --check     # drift, plus the worker checks

--check also runs build/check_site_worker.mjs, the behavioural checks for the
worker this manifest deploys: the prices route, the 501 JSON the other /api
paths answer, the immutable /assets/ headers and the revalidated HTML. The
staged tree says nothing about the worker, so without that a regression in it
would pass a staging check and ship.

It first confirms the manifest still names that worker as its entrypoint, since
only then does /api/coinspot/prices reach it at all: an assets-only deploy
answers the same URL with the SPA shell, which the page cannot parse as prices.
The staged tree is identical either way, so this is the only place that sees it.

Exit codes: 0 the staged tree matches build/web and the worker passes; 1 staged
but incomplete (a reference with no file behind it, a refused file, or a
leftover in the staged tree), the price request no longer routed to the worker,
or the worker checks failed; 2 usage.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build" / "web"
DEST = ROOT / "build" / "site-fiatlord"
MANIFEST = ROOT / "build" / "site-fiatlord.deploy.json"
WORKER = ROOT / "build" / "site-fiatlord.worker.js"
WORKER_CHECK = ROOT / "build" / "check_site_worker.mjs"
ENTRY = "index.html"
PRICES_ROUTE = "/api/coinspot/prices"

# Extensions allowed into a published static tree. Anything else a page points at
# is refused rather than copied.
PUBLISHABLE = {
    ".html", ".htm", ".js", ".mjs", ".css", ".json", ".txt",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
    ".woff", ".woff2", ".ttf", ".otf",
}

REF = re.compile(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", re.IGNORECASE)


def leaky(rel: str) -> bool:
    """A file that must never reach the published tree, whatever its suffix."""
    name = rel.rsplit("/", 1)[-1].lower()
    return ".php" in name or name.startswith("htaccess") or name.endswith(
        (".bak", ".preburn", ".orig", ".dist")
    )


def reference_target(ref: str) -> str | None:
    """The build/web-relative path a reference points at, or None if it is not ours."""
    ref = ref.strip()
    if not ref or ref.startswith(("#", "data:", "mailto:", "tel:", "javascript:")):
        return None
    if ref.startswith("//") or "://" in ref:
        return None                      # someone else's host
    ref = ref.split("#", 1)[0].split("?", 1)[0].lstrip("/")
    return ref or None                   # "/" is the directory, not a file


def wanted_files() -> tuple[dict[str, pathlib.Path], list[str], list[str]]:
    """The staged set, plus the references that could not be satisfied or published."""
    problems: list[str] = []
    refused: list[str] = []
    wanted: dict[str, pathlib.Path] = {}
    base = SOURCE.resolve()
    queue: list[str] = []

    def add(rel: str, frm: str | None = None) -> None:
        path = (base / rel).resolve()
        try:
            key = path.relative_to(base).as_posix()
        except ValueError:
            problems.append(f"{frm or ENTRY} -> {rel}: resolves outside build/web")
            return
        if not path.exists():
            problems.append(f"{frm or ENTRY} -> {rel}: not found in build/web")
            return
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file():
                    add(child.relative_to(base).as_posix(), frm)
            return
        if leaky(key):
            refused.append(f"{frm or ENTRY} -> {key}: server-side source, not publishable")
            return
        if path.suffix.lower() not in PUBLISHABLE:
            refused.append(f"{frm or ENTRY} -> {key}: {path.suffix or 'no extension'} is not publishable")
            return
        if key in wanted:
            return
        wanted[key] = path
        if path.suffix.lower() in (".html", ".htm"):
            queue.append(key)

    if not (base / ENTRY).is_file():
        problems.append(f"{ENTRY}: the page to publish is missing")
        return {}, problems, refused

    add(ENTRY)
    while queue:
        rel = queue.pop(0)
        text = wanted[rel].read_text(encoding="utf-8", errors="replace")
        for ref in REF.findall(text):
            target = reference_target(ref)
            if target is not None:
                add(target, rel)
    return wanted, problems, refused


def staged() -> dict[str, pathlib.Path]:
    if not DEST.is_dir():
        return {}
    return {p.relative_to(DEST).as_posix(): p for p in DEST.rglob("*") if p.is_file()}


def prune(stale: list[str]) -> None:
    """Delete staged files the page does not serve, then any directory they emptied."""
    for rel in stale:
        (DEST / rel).unlink()
    for directory in sorted((p for p in DEST.rglob("*") if p.is_dir()),
                            key=lambda p: len(p.parts), reverse=True):
        try:
            directory.rmdir()
        except OSError:
            pass


def route_faults() -> list[str]:
    """The manifest must still put the worker in front of the staged tree.

    The dashboard polls PRICES_ROUTE. That request reaches the worker only while
    the manifest names the worker as its entrypoint module; without it the host
    answers from assets, which for an unknown path means the SPA shell and a 200.
    The page cannot parse the shell as prices, so it falls back to its simulated
    feed and the quotes stop being live without anything looking wrong. The
    staged tree is byte-identical either way, which is why only this sees it.
    """
    why = f"{PRICES_ROUTE} would be answered by the staged tree, not the worker"
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except OSError as bad:
        return [f"{MANIFEST.name}: unreadable ({bad}); {why}"]
    except ValueError as bad:
        return [f"{MANIFEST.name}: not JSON ({bad}); {why}"]
    if not isinstance(manifest, dict):
        return [f"{MANIFEST.name}: not an object; {why}"]

    entry = manifest.get("entrypoint")
    modules = manifest.get("modules")
    if not isinstance(modules, list) or not modules:
        return [f"{MANIFEST.name}: names no modules; {why}"]
    named = [m for m in modules if isinstance(m, dict) and m.get("name") == entry]
    if len(named) != 1:
        return [f"{MANIFEST.name}: entrypoint {entry!r} names no single module; {why}"]
    module = named[0]
    if module.get("type") != "esm":
        return [f"{MANIFEST.name}: {entry} is {module.get('type')!r}, not esm; {why}"]
    deployed = (MANIFEST.parent / str(module.get("path", ""))).resolve()
    if deployed != WORKER.resolve():
        return [f"{MANIFEST.name}: {entry} deploys {module.get('path')!r}, not "
                f"{WORKER.name}; {why}"]
    return []


def check_route() -> list[str]:
    """Report where the price route is served from, and any fault in that."""
    print(f"route    {PRICES_ROUTE}  ({MANIFEST.name})")
    faults = route_faults()
    # A fault is reported once, by the grouped block at the end, exactly as the
    # worker checks report theirs.
    if not faults:
        print("    the manifest still deploys the worker, so quotes come from CoinSpot")
    return faults


def check_worker() -> list[str]:
    """Run the behavioural checks for the worker the manifest deploys."""
    runner = shutil.which("node") or shutil.which("bun")
    print(f"worker   {WORKER.name}  ({WORKER_CHECK.name})")
    if runner is None:
        print("    the worker checks need node or bun, and neither is on PATH")
        return [f"worker: {WORKER_CHECK.name} could not run without node or bun"]

    done = subprocess.run([runner, str(WORKER_CHECK)], cwd=ROOT,
                          capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    output = [line for line in (done.stdout + done.stderr).splitlines() if line.strip()]
    if done.returncode == 0:
        for line in output:
            print(f"    {line}")
        return []
    # A failing run either reports its own assertions or dies before it can
    # assert anything, and the two need different reading.
    #
    # Assertions come under a "N of M checks failed:" header with each fault
    # indented beneath it, so only those indented lines are the report. Without
    # that header the run crashed -- a global the host does not have (a
    # caches.default regression throws at import), an unparseable worker -- and
    # then the message is the whole output except the stack frames and the caret
    # under the echoed source line. Reporting the caret alone, as an earlier
    # version did, prints "worker: ^" and says nothing about the cause.
    if any("checks failed:" in line for line in output):
        faults = [line.strip() for line in output if line.startswith("  ")]
    else:
        faults = [line.strip() for line in output
                  if not line.strip().startswith("at ")]
        faults = [line for line in faults if not re.fullmatch(r"\^+", line)]
        # Node's version footer is printed after any crash; it is not a fault.
        faults = [line for line in faults if not re.fullmatch(r"Node\.js v\S+", line)]
    return [f"worker: {line}" for line in faults] or [
        f"worker: the checks exited {done.returncode} without a message"
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description="Stage build/web into build/site-fiatlord.")
    ap.add_argument("--check", action="store_true",
                    help="report what a run would change and write nothing")
    args = ap.parse_args()

    wanted, problems, refused = wanted_files()
    if not wanted:
        # No page to stage: leave whatever is there untouched rather than prune it
        # away on a source that is only temporarily missing.
        for line in problems:
            print(f"    {line}")
        print("nothing staged; the tree was left as it is")
        return 1

    have = staged()
    stale = sorted(set(have) - set(wanted))
    changed = sorted(rel for rel, src in wanted.items()
                     if rel not in have or src.read_bytes() != have[rel].read_bytes())
    size = sum(path.stat().st_size for path in wanted.values())

    print(f"source   {SOURCE}")
    print(f"staged   {DEST}")
    print(f"manifest {MANIFEST.name}  ({len(wanted)} files, {size:,} bytes)")
    for rel in sorted(wanted):
        mark = "*" if rel in changed else " "
        print(f" {mark} {rel:<30} {wanted[rel].stat().st_size:>8,} bytes")

    if not args.check:
        prune(stale)
        for rel in changed:
            out = DEST / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(wanted[rel].read_bytes())

    verb = "would remove" if args.check else "removed"
    if stale:
        print(f"{verb} {len(stale)} staged file(s) the page does not serve:")
        for rel in stale:
            print(f"    {rel}")
    else:
        print("staged tree held nothing outside the set")

    left = sorted(rel for rel in staged() if leaky(rel))
    for rel in left:
        problems.append(f"{rel}: server-side source left in the staged tree")

    route: list[str] = []
    worker_faults: list[str] = []
    if args.check:
        print(f"{len(changed)} file(s) would change, {len(stale)} would be removed; nothing written")
        route = check_route()
        worker_faults = check_worker()
    elif changed or stale:
        print(f"staged tree updated: {len(changed)} written, {len(stale)} removed")
    else:
        print("staged tree already matched build/web")

    for label, lines in (("missing", problems), ("refused", refused),
                         ("route", route), ("worker", worker_faults)):
        if lines:
            print(f"{label} {len(lines)}:")
            for line in lines:
                print(f"    {line}")

    if problems or refused:
        print("the page cannot be served as it stands; fix the sources above")
        return 1
    if route:
        print("the price route would stop reaching the worker; live quotes would "
              "silently become simulated ones")
        return 1
    if worker_faults:
        print("the worker no longer behaves as the page expects; fix it before shipping")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
