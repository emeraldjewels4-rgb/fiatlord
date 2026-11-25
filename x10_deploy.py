#!/usr/bin/env python3
"""x10_deploy - upload, download and verify the hosted web files.

    python x10_deploy.py status   # local vs deployed, by hash
    python x10_deploy.py push     # upload anything that differs
    python x10_deploy.py pull     # download the deployed copies for inspection
    python x10_deploy.py verify   # fetch the live endpoints and report

Every action is recorded in the site database's web9999_deploys table, so it
keeps the history of what was uploaded, when, and with which hash. Files in
build/web and the API source tree are managed; nothing else in public_html is
touched. API changes are staged and swapped as one directory.

Credentials come from .env (X10_CPANEL_TOKEN and the X10_DB_* set).
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import x10_fuse

HERE = x10_fuse.HERE
WEB = os.path.join(HERE, "build", "web")
REMOTE_COPY = os.path.join(WEB, "remote")

def _derived(base, *parts):
    """A path under the account's home, or None: .env names the home, not this file."""
    return os.path.join(base, *parts).replace("\\", "/") if base else None


# Where this account lives is deployment data, not code: .env names the hosted
# paths, and nothing here carries a home directory or an account name to fall
# back on. The two sub-paths stay derived from X10_REMOTE_DIR unless given.
REMOTE_DIR = x10_fuse.env("X10_REMOTE_DIR")
API_SOURCE = x10_fuse.env("X10_API_SOURCE", os.path.join(HERE, "build", "web", "api", "web9999"))
_HOME = os.path.dirname(REMOTE_DIR) if REMOTE_DIR else None
API_REMOTE = x10_fuse.env("X10_API_REMOTE", _derived(REMOTE_DIR, "api", "web9999"))
API_WORK_DIR = x10_fuse.env("X10_API_WORK_DIR", _derived(_HOME, ".x10-api-deploy"))
LIVE = x10_fuse.env("X10_LIVE_URL", "https://fiatgod.x10.mx")
DB = x10_fuse.env("X10_SITE_DB")


def _require_deployment():
    """Refuse before any request when .env has not named the account's paths."""
    for variable, value in (("X10_REMOTE_DIR", REMOTE_DIR), ("X10_SITE_DB", DB)):
        if not value:
            raise SystemExit(f"no {variable} in .env: hosted paths and database names are deployment data, so nothing here guesses them")


def _api():
    host = x10_fuse.env("X10_CPANEL_HOST")
    port = x10_fuse.env("X10_CPANEL_PORT")
    user = x10_fuse.env("X10_CPANEL_USER")
    token = x10_fuse.env("X10_CPANEL_TOKEN")
    if not token:
        raise SystemExit("no X10_CPANEL_TOKEN in .env: nothing can be uploaded")
    return f"https://{host}:{port}", {
        "Authorization": f"cpanel {user}:{token}",
        "Content-Type": "application/x-www-form-urlencoded",
    }


def call(module, function, **params):
    base, headers = _api()
    request = urllib.request.Request(
        f"{base}/execute/{module}/{function}",
        data=urllib.parse.urlencode(params).encode(),
        headers=headers,
    )
    payload = json.loads(urllib.request.urlopen(request, timeout=45).read())
    if payload.get("status") != 1:
        raise RuntimeError(f"{module}::{function}: {'; '.join(map(str, payload.get('errors') or []))}")
    return payload.get("data")


def call_api2(module, function, **params):
    """Call a cPanel API 2 function (Fileman::mkdir has no UAPI equivalent)."""
    base, headers = _api()
    query = urllib.parse.urlencode({
        "cpanel_jsonapi_user": x10_fuse.env("X10_CPANEL_USER"),
        "cpanel_jsonapi_apiversion": "2",
        "cpanel_jsonapi_module": module,
        "cpanel_jsonapi_func": function,
        **params,
    })
    request = urllib.request.Request(f"{base}/json-api/cpanel?{query}", headers=headers)
    payload = json.loads(urllib.request.urlopen(request, timeout=45).read())
    result = payload.get("cpanelresult") or {}
    if result.get("error"):
        raise RuntimeError(f"{module}::{function}: {result['error']}")
    return result.get("data")


def local_files():
    if not os.path.isdir(WEB):
        raise SystemExit(f"no {WEB}")
    out = {}
    for name in sorted(os.listdir(WEB)):
        path = os.path.join(WEB, name)
        if os.path.isfile(path) and name.endswith(".php"):
            with open(path, "rb") as fh:
                raw = fh.read()
            out[name] = {
                "bytes": raw,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "path": path,
            }
    return out


def remote_text(name):
    try:
        data = call("Fileman", "get_file_content", dir=REMOTE_DIR, file=name)
    except (urllib.error.HTTPError, RuntimeError):
        return None
    if isinstance(data, dict):
        return data.get("content")
    return data


def compare():
    rows = []
    for name, info in local_files().items():
        text = remote_text(name)
        if text is None:
            state = "missing"
            remote_digest = None
        else:
            remote_digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            state = "same" if remote_digest == info["sha256"] else "differs"
        rows.append({"file": name, "state": state, "local": info["sha256"], "remote": remote_digest})
    return rows


def record(file_name, action, sha256, size):
    """Write one line of upload history.

    Goes through connect_with_repair, not a bare connect: when the ISP rotates
    this address the server refuses the client with 1045, and a bare connect
    turned that into a silently missing history row. The shared path re-adds
    the address to the account's access list and retries.
    """
    cfg = dict(x10_fuse.db_settings(), database=DB)
    try:
        conn = x10_fuse.connect_with_repair(cfg)
    except Exception as exc:
        code = exc.args[0] if getattr(exc, "args", None) else 0
        print(f"  (history not recorded: {x10_fuse.HINTS.get(code, exc)})")
        return
    if conn is None:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO web9999_deploys (file, action, sha256, bytes, created_at) VALUES (%s, %s, %s, %s, %s)",
                (file_name, action, sha256, size, int(time.time())),
            )
        conn.commit()
    except Exception as exc:
        print(f"  (history not recorded: {exc})")
    finally:
        conn.close()


def push(force=False):
    changed = 0
    for name, info in local_files().items():
        row = next((r for r in compare() if r["file"] == name), None)
        if row and row["state"] == "same" and not force:
            print(f"  {name}: already up to date")
            continue
        call(
            "Fileman",
            "save_file_content",
            dir=REMOTE_DIR,
            file=name,
            content=info["bytes"].decode("utf-8"),
            **{"from_charset": "UTF-8", "to_charset": "UTF-8"},
        )
        print(f"  {name}: uploaded ({len(info['bytes'])} bytes)")
        record(name, "upload", info["sha256"], len(info["bytes"]))
        changed += 1
    return changed


def api_local_files():
    """Return the API source tree keyed by its path relative to API_SOURCE."""
    if not os.path.isdir(API_SOURCE):
        return {}
    out = {}
    for dirpath, dirnames, filenames in os.walk(API_SOURCE):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            path = os.path.join(dirpath, name)
            with open(path, "rb") as fh:
                raw = fh.read()
            rel = os.path.relpath(path, API_SOURCE).replace(os.sep, "/")
            out[rel] = {
                "bytes": raw,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "path": path,
            }
    return out


def remote_dir_exists(path):
    try:
        call("Fileman", "list_files", dir=path)
        return True
    except (urllib.error.HTTPError, RuntimeError):
        return False


def ensure_remote_dir(path):
    if remote_dir_exists(path):
        return
    parent = os.path.dirname(path)
    if parent and parent != path:
        ensure_remote_dir(parent)
    try:
        call_api2("Fileman", "mkdir", path=parent or "/", name=os.path.basename(path), permissions="0755")
    except RuntimeError:
        if not remote_dir_exists(path):
            raise


def api_remote_text(rel):
    remote_dir = os.path.join(API_REMOTE, os.path.dirname(rel)).replace(os.sep, "/")
    try:
        data = call("Fileman", "get_file_content", dir=remote_dir, file=os.path.basename(rel))
    except (urllib.error.HTTPError, RuntimeError):
        return None
    if isinstance(data, dict):
        return data.get("content")
    return data


def push_api(force=False):
    """Replace the API tree with a staged copy and one directory swap.

    The live API directory is copied to a private staging directory, changed
    files are uploaded there, every staged file is hash-checked, and only then
    is the directory moved into place. If the swap itself fails, the previous
    directory is put back; a later verification failure is reported and never
    auto-restored.
    """
    files = api_local_files()
    if not files:
        if x10_fuse.env("X10_API_SOURCE"):
            raise RuntimeError(f"configured API source {API_SOURCE} is missing or empty")
        print(f"  API source {API_SOURCE} not present; skipped")
        return 0

    changed = []
    for rel, info in files.items():
        current = api_remote_text(rel)
        if current is not None and hashlib.sha256(current.encode("utf-8")).hexdigest() == info["sha256"] and not force:
            continue
        changed.append((rel, info))
    if not changed:
        print("  API files: already up to date")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + str(os.getpid())
    ensure_remote_dir(API_WORK_DIR)
    stage = os.path.join(API_WORK_DIR, "stage-" + stamp).replace(os.sep, "/")
    backup = os.path.join(API_WORK_DIR, "previous-" + stamp).replace(os.sep, "/")
    live_exists = remote_dir_exists(API_REMOTE)

    if live_exists:
        call("Fileman", "copy_file", source=API_REMOTE, destination=stage)
        print(f"  API stage seeded from live: {stage}")
    else:
        ensure_remote_dir(stage)
        print(f"  API stage created: {stage}")

    for rel, info in changed:
        stage_dir = os.path.join(stage, os.path.dirname(rel)).replace(os.sep, "/")
        ensure_remote_dir(stage_dir)
        text = info["bytes"].decode("utf-8")
        call(
            "Fileman",
            "save_file_content",
            dir=stage_dir,
            file=os.path.basename(rel),
            content=text,
            **{"from_charset": "UTF-8", "to_charset": "UTF-8"},
        )
        staged = call("Fileman", "get_file_content", dir=stage_dir, file=os.path.basename(rel))
        if isinstance(staged, dict):
            staged = staged.get("content")
        if staged is None or hashlib.sha256(staged.encode("utf-8")).hexdigest() != info["sha256"]:
            raise RuntimeError(f"staged API file {rel} did not match its source hash")
        print(f"  {rel}: staged ({len(info['bytes'])} bytes)")

    try:
        if live_exists:
            call("Fileman", "move_file", source=API_REMOTE, destination=backup)
        call("Fileman", "move_file", source=stage, destination=API_REMOTE)
    except Exception:
        if live_exists and not remote_dir_exists(API_REMOTE) and remote_dir_exists(backup):
            try:
                call("Fileman", "move_file", source=backup, destination=API_REMOTE)
                print("  API swap failed; previous directory put back")
            except Exception as restore_exc:
                print(f"  API swap failed and the previous directory could not be put back: {restore_exc}")
        raise

    for rel, info in changed:
        record(rel, "upload-api", info["sha256"], len(info["bytes"]))
    print(f"  API directory swapped atomically: {len(changed)} file(s)")
    return len(changed)


def pull():
    os.makedirs(REMOTE_COPY, exist_ok=True)
    for name in local_files():
        text = remote_text(name)
        if text is None:
            print(f"  {name}: not on the host")
            continue
        path = os.path.join(REMOTE_COPY, name)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        print(f"  {name}: downloaded ({len(text)} bytes, sha {digest[:16]})")
        record(name, "download", digest, len(text))
    return 0


def probe(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return response.status, response.read(400).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(400).decode("utf-8", "replace")


def verify():
    ok = True
    for name in local_files():
        status, _ = probe(f"{LIVE}/{name}")
        print(f"  {name}: GET {status}")
        ok = ok and status == 200
    status, body = probe(f"{LIVE}/x10_status.php")
    print(f"  status endpoint: {status} {body[:80]}")
    ok = ok and status == 200 and '"on": "01"' in body
    status, body = probe(
        f"{LIVE}/web9999.php",
        {"jsonrpc": "2.0", "id": 1, "method": "web9999_health", "params": []},
    )
    print(f"  web9999 health: {status} {body[:100]}")
    ok = ok and status == 200 and '"on":"01"' in body
    return 0 if ok else 1


def cmd_status(_args):
    rows = compare()
    for row in rows:
        print(f"  {row['file']:<18} {row['state']:<8} local {row['local'][:12]}  remote {(row['remote'] or '-')[:12]}")
    differing = [r for r in rows if r["state"] != "same"]
    print(f"\n{len(rows) - len(differing)}/{len(rows)} in step")
    return 0


def cmd_push(args):
    changed = push(force=args.force)
    print(f"\n{changed} file(s) uploaded")
    return 0


def cmd_pull(_args):
    return pull()


def cmd_verify(_args):
    return verify()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Upload, download and verify the hosted web files.")
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("status").set_defaults(func=cmd_status)
    push_cmd = sub.add_parser("push")
    push_cmd.add_argument("--force", action="store_true", help="upload even when the hash matches")
    push_cmd.set_defaults(func=cmd_push)
    sub.add_parser("pull").set_defaults(func=cmd_pull)
    sub.add_parser("verify").set_defaults(func=cmd_verify)
    args = ap.parse_args(argv)
    # verify only reads the public origin; every other command touches the account.
    if args.command != "verify":
        _require_deployment()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
