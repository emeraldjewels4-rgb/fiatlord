#!/usr/bin/env python3
"""Fail if a checked-out file is not the byte stream the live site serves.

`.gitattributes` marks every path `-text` so a checkout is byte-exact, and
`build/web/index.html` is the one tracked text file that is CRLF. That attribute
is one edit away from `text=auto`: after it, a Windows clone with
`core.autocrlf=true` rewrites the shell to LF and the page ships 3,303 bytes
instead of 3,368.

`build/make_site_fiatlord.py --check` cannot catch that on its own. It compares
the checkout in `build/web` with a staged copy built from that same checkout, so
both sides move together and it reports no drift. These pins compare against the
bytes that are actually published, which is the only fixed point available.

Run it from the repository root:

    python .github/check_shell_bytes.py

Exit 0 when everything matches, 1 otherwise.
"""
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

# What production serves today, and what build/make_site_fiatlord.py stages from
# build/web. An intended change to the page means new bytes here as well - that
# is the point: the hash cannot drift without someone saying so.
PINNED = {
    "build/web/index.html": "3cf4bdcd06c015fbf10b6c23d34bdac1421fddc45c028878b297b85f88daf435",
    "build/web/ads.html": "b084a4ec91d0fbb3bf47d4ea5450fb289ccce30a253d1354a86d6affbe929922",
    "build/web/ads.js": "977d35b73e215bb4955e8c5655f05264cf471bca13d9579dc8e7389b868174dd",
    "build/web/assets/index-6o21nwvo.css":
        "7aad3033abdbff501f4224f4e3431a2a1b2b83630310ec49814b35da70b087a0",
    "build/web/assets/index-87a7946b18f5.js":
        "87a7946b18f59404ff97c7cb594b66fffa9d9f34c763afa6056fb7e0bea3de7f",
}


def main() -> int:
    bad = 0
    for rel, want in sorted(PINNED.items()):
        path = ROOT / rel
        try:
            raw = path.read_bytes()
        except OSError as exc:
            print(f"FAIL {rel}: unreadable ({exc})")
            bad += 1
            continue
        got = hashlib.sha256(raw).hexdigest()
        if got == want:
            print(f"ok   {rel}  {len(raw):,} bytes  {got[:16]}")
            continue
        bad += 1
        note = ""
        # The classic case: the file is text and lost its CRs.
        if raw.count(b"\r\n") == 0 and raw.count(b"\n") and not rel.endswith((".js", ".css")):
            note = "  - no CRLF left: the checkout rewrote line endings"
        print(f"FAIL {rel}: expected {want[:16]}, got {got[:16]} "
              f"({len(raw):,} bytes){note}")
    if bad:
        print(f"\n{bad} file(s) are not the published bytes. If the page changed on purpose, "
              "stage it, redeploy, and update the pins in this file.")
        return 1
    print("\nall pinned files match the published bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
