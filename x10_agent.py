#!/usr/bin/env python3
"""x10_agent - the monitor-only program for web9999 and the mirror.

    python x10_agent.py             # one pass

What it does on every pass:

  1. drift   - compares each build/web/*.php with the deployed copy. A missing
               or different file is reported as a fault; the agent never
               uploads, so a scheduled pass cannot overwrite a live fix.
  2. endpoints - GETs x10_status.php and POSTs web9999_health, expecting "01".
  3. chain   - calls totalSupply() on the mined contract through web9999.php and
               compares it with the recorded rewards.
  4. mirror  - asks web9999_mirror for the supply and compares it with the local
               records.
  5. records - writes the pass to the site database's web9999_agent_log.

This is a rule-based agent, not a language model: every decision is a hash
comparison or an equality check, so it can only report what it finds, never
invent a change. Exit code is 0 when every check passed.

    python x10_agent.py && echo healthy
"""

import argparse
import json
import sys
import time

import pymysql

import x10_deploy
import x10_fuse

MDC = "0x8907169F11a724b01a4FE84CBF6719A635Ab507B"
TOTAL_SUPPLY_SELECTOR = "0x18160ddd"
MIN_CONTACTS = 3


def log(action, detail, ok):
    try:
        conn = pymysql.connect(
            host=x10_fuse.env("X10_DB_HOST"),
            port=int(x10_fuse.env("X10_DB_PORT")),
            user=x10_fuse.env("X10_DB_USER"),
            password=x10_fuse.env("X10_DB_PASSWORD"),
            database=x10_deploy.DB,
            charset="utf8mb4",
            autocommit=True,
        )
    except Exception as exc:
        print(f"  (not recorded: {exc})")
        return
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO web9999_agent_log (action, detail, ok, created_at) VALUES (%s, %s, %s, %s)",
            (action[:48], str(detail)[:255], 1 if ok else 0, int(time.time())),
        )
    conn.close()


def check_drift():
    """Report drift only; never upload from a scheduled maintenance pass."""
    rows = x10_deploy.compare()
    faults = [row for row in rows if row["state"] != "same"]
    if not faults:
        print(f"  drift     : none ({len(rows)} file(s) in step)")
        return True, "no drift"
    names = ", ".join(row["file"] for row in faults)
    print(f"  drift     : FAULT {names}; no upload")
    return False, f"drift {names} (not repaired)"


def check_endpoints():
    ok = True
    status, body = x10_deploy.probe(f"{x10_deploy.LIVE}/x10_status.php")
    good = status == 200 and '"on": "01"' in body
    print(f"  status    : {status} {'01' if good else 'NOT 01'}")
    ok = ok and good

    status, body = x10_deploy.probe(
        f"{x10_deploy.LIVE}/web9999.php",
        {"jsonrpc": "2.0", "id": 1, "method": "web9999_health", "params": []},
    )
    try:
        result = json.loads(body).get("result") or {}
    except ValueError:
        result = {}
    good = status == 200 and result.get("on") == "01" and int(result.get("contacts") or 0) >= MIN_CONTACTS
    print(f"  web9999   : {status} on={result.get('on')} contacts={result.get('contacts')}")
    return ok and good, f"status {'ok' if ok else 'failed'}, web9999 {result.get('on')}"


def check_chain():
    status, body = x10_deploy.probe(
        f"{x10_deploy.LIVE}/web9999.php",
        {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
         "params": [{"to": MDC, "data": TOTAL_SUPPLY_SELECTOR}, "latest"]},
    )
    try:
        raw = json.loads(body).get("result")
        on_chain = int(raw, 16) if isinstance(raw, str) else None
    except (ValueError, TypeError):
        on_chain = None

    deployments, solutions = x10_fuse.mined_rows()
    recorded = sum(int(row["reward"]) for row in solutions)
    good = on_chain == recorded and recorded > 0
    print(f"  chain     : totalSupply {on_chain if on_chain is not None else 'unreadable'} vs recorded {recorded}")
    return good, f"chain {on_chain} recorded {recorded}"


def check_mirror():
    status, body = x10_deploy.probe(
        f"{x10_deploy.LIVE}/web9999.php",
        {"jsonrpc": "2.0", "id": 1, "method": "web9999_mirror", "params": []},
    )
    try:
        rows = json.loads(body).get("result") or []
        mirrored = sum(int(row["minted"]) for row in rows)
    except (ValueError, TypeError, KeyError):
        mirrored = None
    _, solutions = x10_fuse.mined_rows()
    recorded = sum(int(row["reward"]) for row in solutions)
    good = mirrored == recorded and recorded > 0
    print(f"  mirror    : {mirrored if mirrored is not None else 'unreadable'} vs recorded {recorded}")
    return good, f"mirror {mirrored} recorded {recorded}"


def one_pass():
    print(f"pass at {time.strftime('%Y-%m-%d %H:%M:%S')}")
    results = [check_drift()]
    results.append(check_endpoints())
    results.append(check_chain())
    results.append(check_mirror())
    healthy = all(ok for ok, _ in results)
    detail = "; ".join(text for _, text in results)
    print(f"  verdict   : {'healthy' if healthy else 'FAULT'} — {detail[:200]}")
    log("pass", detail, healthy)
    return healthy


def main(argv=None):
    ap = argparse.ArgumentParser(description="Monitor-only checks for web9999 and the mirror.")
    ap.parse_args(argv)
    return 0 if one_pass() else 1


if __name__ == "__main__":
    sys.exit(main())
