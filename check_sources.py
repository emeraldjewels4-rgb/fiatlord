#!/usr/bin/env python
"""Fail if any .py file in the project has NUL bytes or does not parse.

A half-written file usually surfaces later, at import time, wherever the interpreter happens to
reach it - or not at all, if nothing imports it. This checks every file directly, so an interrupted
write is caught immediately.

    python check_sources.py                 # every .py in the project
    python check_sources.py path\\to\\a.py    # just the files named

Deliberately standalone rather than a --self-test case: a truncated watch_lwc_state.py cannot run
its own self-test, which is exactly the failure this exists to catch.
"""
import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SKIP_DIRS = {".git", ".hg", ".svn", ".venv", "venv", "env", "node_modules", "site-packages",
             "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", "build_tmp"}


def py_files(root: Path) -> list:
    out = []
    for path in sorted(root.rglob("*.py")):
        if SKIP_DIRS & set(path.relative_to(root).parts[:-1]):
            continue
        out.append(path)
    return out


def problems(path: Path) -> list:
    """Everything wrong with one file, as one-line reasons (empty means it is fine)."""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return [f"unreadable: {exc}"]
    nuls = raw.count(b"\0")
    if nuls:
        # NULs first and alone: a truncated or padded write leaves a valid prefix plus zero fill,
        # and the parser can only say "cannot contain null bytes" - far less useful than the count.
        return [f"{nuls:,} NUL byte(s) - a half-written or padded file"]
    try:
        ast.parse(raw, filename=str(path))
    except SyntaxError as exc:
        where = f"line {exc.lineno}" if exc.lineno else "unknown line"
        return [f"does not parse ({where}): {exc.msg}"]
    except (ValueError, UnicodeDecodeError) as exc:
        return [f"does not parse: {type(exc).__name__}: {exc}"]
    return []


def main(argv: list) -> int:
    if argv and argv[0] in ("-h", "--help"):
        print("usage: python check_sources.py [file.py ...]\n\n"
              "Checks every .py in the project, or just the files named, for NUL bytes and parse\n"
              "errors. Exits 1 if any file fails, 2 on a bad option.")
        return 0
    unknown = [a for a in argv if a.startswith("-")]
    if unknown:
        print(f"unknown option {unknown[0]}; usage: python check_sources.py [file.py ...]",
              file=sys.stderr)
        return 2
    targets = [Path(a) for a in argv] or py_files(ROOT)
    bad = 0
    for path in targets:
        try:
            label = path.resolve().relative_to(ROOT)
        except ValueError:
            label = path
        found = problems(path)
        if found:
            bad += 1
            for reason in found:
                print(f"FAIL {label}: {reason}")
    if bad:
        print(f"\n{bad} of {len(targets)} file(s) failed - fix or restore them before running anything")
        return 1
    print(f"ok: {len(targets)} .py file(s) parse, none contain NUL bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
