#!/usr/bin/env python3
"""x10_fuse - mirror the chain records into the x10hosting MySQL database.

    python x10_fuse.py check          # do the records agree with each other?
    python x10_fuse.py feed           # write build/mirror/feed.json
    python x10_fuse.py sql            # write build/mirror/mining_mirror.sql
    python x10_fuse.py probe          # is the database reachable from here?
    python x10_fuse.py push           # run the SQL against the database directly

WHERE THE DATABASE IS. Deployment data, not code: .env names the server
(X10_DB_HOST), the database (X10_DB_NAME) and the credentials (X10_DB_USER,
X10_DB_PASSWORD), and nothing here carries an account name to fall back on. PHP
on the host reaches the same database as localhost, which is what the site
itself keeps using, so the direct connection is a convenience for the mirror
rather than something the page depends on.

Whether MySQL accepts a connection from outside is a question for the machine
that will open it: run `python x10_fuse.py probe` from your own host before
trusting `push`. If it cannot connect, `sql` writes the same mirror as a file
that cPanel's phpMyAdmin can apply instead.

Two artifacts, either can be applied:

  build/mirror/feed.json         the chain-derived mirror, self-checksummed
  build/mirror/mining_mirror.sql  idempotent DDL + INSERTs, for `push` or phpMyAdmin

`push` runs those statements over the socket and then re-reads the supply back
out of MySQL to prove the database agrees with the records. Re-running is
safe: every row is keyed by its transaction hash and updated in place.

The mirror is a copy for reporting, never the ledger. Nothing here can mint:
supply comes only from mined work, and the chain stays authoritative.
"""

import argparse
import hashlib
import json
import os
import re
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
MIRROR_DIR = os.path.join(BUILD, "mirror")
MINED = os.path.join(BUILD, "mined.json")
MULTI = os.path.join(BUILD, "multichain.json")
PROVENANCE = os.path.join(BUILD, "provenance.json")
FEED = os.path.join(MIRROR_DIR, "feed.json")
SQL = os.path.join(MIRROR_DIR, "mining_mirror.sql")

# Deployment data, not code: .env supplies the server and the database name, and
# nothing here names an account. 3306 is the MySQL port, not this account's.
DEFAULT_PORT = 3306

_DOTENV = {}

MAX_SUPPLY = 21_000_000 * 10 ** 18
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
BARE_HASH = re.compile(r"^[0-9a-f]{64}$")


def bare(value):
    """Hashes are stored bare in these records, but be tolerant of a 0x prefix."""
    text = str(value).strip().lower()
    return text[2:] if text.startswith("0x") else text


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def mined_rows():
    record = load(MINED, {"deployments": {}, "solutions": []})
    deployments = record.get("deployments", {})
    solutions = sorted(record.get("solutions", []), key=lambda row: int(row["block"]))
    return deployments, solutions


def bridged_rows():
    record = load(MULTI, {"deployments": []})
    return record.get("deployments", [])


def check():
    """Cross-check the records. Returns a list of (ok, message) findings."""
    findings = []

    def note(ok, message):
        findings.append((ok, message))

    deployments, solutions = mined_rows()
    if not deployments:
        note(False, "build/mined.json has no deployments")
    for chain, row in sorted(deployments.items()):
        note(ADDRESS.match(row.get("address", "")) is not None,
             f"{chain}: address {row.get('address')}")
        try:
            target = int(row["target"])
        except (KeyError, TypeError, ValueError):
            note(False, f"{chain}: genesis target missing or not a number")
            continue
        note(target > 0, f"{chain}: genesis target {target:,}")
        note(int(row.get("halvingInterval") or 0) > 0,
             f"{chain}: halving interval {row.get('halvingInterval')}")
        note(int(row.get("retargetEvery") or 0) > 0,
             f"{chain}: retarget every {row.get('retargetEvery')}")

    seen_hash, seen_tx = set(), set()
    supply = 0
    per_chain = {}
    for index, row in enumerate(solutions, start=1):
        chain = row.get("chain")
        tx = bare(row.get("tx", ""))
        digest = bare(row.get("hash", ""))
        prev = bare(row.get("prevHash", ""))
        label = f"solution {index} ({chain} block {row.get('block')})"

        note(chain in deployments, f"{label}: chain is a known deployment")
        note(BARE_HASH.match(digest) is not None, f"{label}: digest is 32 bytes")
        note(BARE_HASH.match(tx) is not None, f"{label}: tx hash is 32 bytes")
        note(ADDRESS.match(str(row.get("miner", ""))) is not None,
             f"{label}: miner {row.get('miner')}")
        note(digest not in seen_hash, f"{label}: digest not reused")
        note(tx not in seen_tx, f"{label}: tx not reused")
        seen_hash.add(digest)
        seen_tx.add(tx)

        reward = int(row.get("reward") or 0)
        note(reward > 0, f"{label}: reward {reward / 10 ** 18:g}")
        supply += reward
        per_chain[chain] = per_chain.get(chain, 0) + reward

        target = int(deployments.get(chain, {}).get("target") or 0)
        work = int(digest, 16)
        note(work <= target, f"{label}: work at or under target {target:,}")

        previous = per_chain.get(f"{chain}:prev")
        if previous is not None:
            note(prev == previous, f"{label}: prevHash links to the solution before it")
        per_chain[f"{chain}:prev"] = digest

    note(supply <= MAX_SUPPLY,
         f"supply {supply / 10 ** 18:g} within cap {MAX_SUPPLY / 10 ** 18:g}")
    note(supply == sum(int(row.get("reward") or 0) for row in solutions),
         f"supply equals the sum of {len(solutions)} recorded rewards")

    for row in bridged_rows():
        chain = row.get("chain")
        note(ADDRESS.match(str(row.get("predicted") or "")) is not None,
             f"bridged {chain}: address {row.get('predicted')}")
        note(int(row.get("chainId") or 0) > 0, f"bridged {chain}: chain id {row.get('chainId')}")
        mints = row.get("mints") or []
        note(all(BARE_HASH.match(bare(m)) for m in mints),
             f"bridged {chain}: {len(mints)} mint transactions")
        note(int(row.get("mintedPerChain") or 0) > 0,
             f"bridged {chain}: minted {int(row.get('mintedPerChain') or 0) / 10 ** 18:g}")
    return findings


def build_feed():
    deployments, solutions = mined_rows()
    payload = {
        "format": "x10-fuse/1",
        "source": "chain records (build/mined.json, build/multichain.json)",
        "generatedAt": int(time.time()),
        "note": "read-only mirror; the chain is the ledger and nothing here can mint",
        "mined": {
            "cap": str(MAX_SUPPLY),
            "deployments": deployments,
            "solutions": [
                {
                    "chain": row["chain"],
                    "tx": bare(row["tx"]),
                    "block": int(row["block"]),
                    "miner": row["miner"],
                    "nonce": str(row["nonce"]),
                    "digest": bare(row["hash"]),
                    "prevHash": bare(row["prevHash"]),
                    "reward": str(row["reward"]),
                    "gasUsed": int(row.get("gasUsed") or 0),
                    "minedAt": int(row.get("at") or 0),
                }
                for row in solutions
            ],
        },
        "bridged": [
            {
                "chain": row.get("chain"),
                "chainId": int(row.get("chainId") or 0),
                "contract": row.get("predicted"),
                "contractName": row.get("contract"),
                "mintedPerChain": str(row.get("mintedPerChain") or "0"),
                "block": row.get("block"),
                "tx": bare(row.get("txHash") or ""),
                "mints": [bare(m) for m in (row.get("mints") or [])],
            }
            for row in bridged_rows()
        ],
    }
    provenance = load(PROVENANCE)
    if provenance is not None:
        payload["provenance"] = provenance
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    payload["sha256"] = hashlib.sha256(body).hexdigest()
    return payload


def q(value):
    """Quote a validated string for SQL. Everything reaches here from our own
    records, but a malformed record must fail loudly, not become SQL."""
    text = str(value)
    if '"' in text or "\\" in text or "\n" in text or "\r" in text or "\x00" in text:
        raise ValueError(f"refusing to quote suspicious value: {text!r}")
    return f'"{text}"'


def num(value):
    return str(int(value))


def build_sql(feed):
    deployments = feed["mined"]["deployments"]
    solutions = feed["mined"]["solutions"]
    lines = [
        "-- x10_fuse mirror: the LWC/AUD chain records as MySQL rows.",
        "-- Generated from build/mined.json and build/multichain.json; re-importing is safe.",
        "--",
        "-- Import: cPanel -> phpMyAdmin -> select the database -> Import -> choose this file.",
        "-- The mirror is a copy for reporting. It can never mint: supply is mined work only.",
        "",
        "CREATE TABLE IF NOT EXISTS x10_mined_deployments (",
        "  chain VARCHAR(32) NOT NULL PRIMARY KEY,",
        "  contract_address CHAR(42) NOT NULL,",
        "  tx_hash CHAR(64) NOT NULL,",
        "  block_number BIGINT UNSIGNED NULL,",
        "  genesis_target VARCHAR(78) NOT NULL,",
        "  halving_interval BIGINT UNSIGNED NOT NULL,",
        "  retarget_every BIGINT UNSIGNED NOT NULL,",
        "  target_seconds INT UNSIGNED NOT NULL,",
        "  deployed_at BIGINT UNSIGNED NOT NULL,",
        "  UNIQUE KEY uq_mined_deploy_tx (tx_hash)",
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
        "",
        "CREATE TABLE IF NOT EXISTS x10_mined_solutions (",
        "  tx_hash CHAR(64) NOT NULL PRIMARY KEY,",
        "  chain VARCHAR(32) NOT NULL,",
        "  block_number BIGINT UNSIGNED NOT NULL,",
        "  miner CHAR(42) NOT NULL,",
        "  nonce VARCHAR(78) NOT NULL,",
        "  digest CHAR(64) NOT NULL,",
        "  prev_hash CHAR(64) NOT NULL,",
        "  reward DECIMAL(65,0) NOT NULL,",
        "  gas_used BIGINT UNSIGNED NOT NULL,",
        "  mined_at BIGINT UNSIGNED NOT NULL,",
        "  UNIQUE KEY uq_mined_solution_digest (digest),",
        "  KEY idx_mined_solution_chain_block (chain, block_number)",
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
        "",
        "CREATE TABLE IF NOT EXISTS x10_bridged_deployments (",
        "  chain VARCHAR(32) NOT NULL PRIMARY KEY,",
        "  chain_id INT UNSIGNED NOT NULL,",
        "  contract_address CHAR(42) NOT NULL,",
        "  contract_name VARCHAR(64) NOT NULL,",
        "  minted_per_chain DECIMAL(65,0) NOT NULL,",
        "  block_number BIGINT UNSIGNED NULL,",
        "  deploy_tx CHAR(64) NULL,",
        "  mint_count INT UNSIGNED NOT NULL,",
        "  series VARCHAR(32) NOT NULL DEFAULT 'LWCBridged'",
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
        "",
        "CREATE TABLE IF NOT EXISTS x10_mirror_runs (",
        "  feed_sha256 CHAR(64) NOT NULL PRIMARY KEY,",
        "  generated_at BIGINT UNSIGNED NOT NULL,",
        "  solution_count INT UNSIGNED NOT NULL,",
        "  note VARCHAR(255) NOT NULL",
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
        "",
        "CREATE OR REPLACE VIEW x10_mined_supply AS",
        "  SELECT chain, COUNT(*) AS solutions, SUM(reward) AS minted",
        "  FROM x10_mined_solutions GROUP BY chain;",
        "",
        "-- bridge escrow surplus is a property of the chain, not of this table:",
        "-- selecting from here can never move a token or unlock a lock.",
        "",
    ]

    for chain, row in sorted(deployments.items()):
        values = [
            q(chain),
            q(row["address"]),
            q(bare(row["tx"])),
            num(row.get("block") or 0),
            q(str(int(row["target"]))),
            num(row.get("halvingInterval") or 0),
            num(row.get("retargetEvery") or 0),
            num(row.get("targetSeconds") or 0),
            num(row.get("deployedAt") or 0),
        ]
        lines.append(
            "INSERT INTO x10_mined_deployments (chain, contract_address, tx_hash, block_number, "
            "genesis_target, halving_interval, retarget_every, target_seconds, deployed_at) "
            f"VALUES ({', '.join(values)}) "
            "ON DUPLICATE KEY UPDATE contract_address=VALUES(contract_address), "
            "block_number=VALUES(block_number), genesis_target=VALUES(genesis_target), "
            "halving_interval=VALUES(halving_interval), retarget_every=VALUES(retarget_every), "
            "target_seconds=VALUES(target_seconds), deployed_at=VALUES(deployed_at);"
        )

    for row in solutions:
        values = [
            q(row["tx"]),
            q(row["chain"]),
            num(row["block"]),
            q(row["miner"]),
            q(row["nonce"]),
            q(row["digest"]),
            q(row["prevHash"]),
            num(row["reward"]),
            num(row["gasUsed"]),
            num(row["minedAt"]),
        ]
        lines.append(
            "INSERT INTO x10_mined_solutions (tx_hash, chain, block_number, miner, nonce, "
            "digest, prev_hash, reward, gas_used, mined_at) "
            f"VALUES ({', '.join(values)}) "
            "ON DUPLICATE KEY UPDATE chain=VALUES(chain), block_number=VALUES(block_number), "
            "miner=VALUES(miner), nonce=VALUES(nonce), digest=VALUES(digest), "
            "prev_hash=VALUES(prev_hash), reward=VALUES(reward), gas_used=VALUES(gas_used), "
            "mined_at=VALUES(mined_at);"
        )

    for row in feed["bridged"]:
        values = [
            q(row["chain"]),
            num(row["chainId"]),
            q(row["contract"]),
            q(row["contractName"] or "LWCBridgedSeries"),
            num(row["mintedPerChain"]),
            num(row["block"]) if row["block"] is not None else "NULL",
            q(row["tx"]) if row["tx"] else "NULL",
            num(len(row["mints"])),
        ]
        lines.append(
            "INSERT INTO x10_bridged_deployments (chain, chain_id, contract_address, "
            "contract_name, minted_per_chain, block_number, deploy_tx, mint_count) "
            f"VALUES ({', '.join(values)}) "
            "ON DUPLICATE KEY UPDATE chain_id=VALUES(chain_id), "
            "contract_address=VALUES(contract_address), contract_name=VALUES(contract_name), "
            "minted_per_chain=VALUES(minted_per_chain), block_number=VALUES(block_number), "
            "deploy_tx=VALUES(deploy_tx), mint_count=VALUES(mint_count);"
        )

    lines.append(
        "INSERT INTO x10_mirror_runs (feed_sha256, generated_at, solution_count, note) "
        f"VALUES ({q(feed['sha256'])}, {num(feed['generatedAt'])}, {num(len(solutions))}, "
        f"{q('chromium-free mirror of chain records; read-only')}) "
        "ON DUPLICATE KEY UPDATE generated_at=VALUES(generated_at), "
        "solution_count=VALUES(solution_count);"
    )
    lines.append("")
    return "\n".join(lines)


def _load_dotenv():
    """Read the project's .env once. Values are secrets: never printed."""
    if _DOTENV:
        return _DOTENV
    path = os.path.join(HERE, ".env")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, raw = line.partition("=")
                _DOTENV[key.strip()] = raw.strip().strip('"').strip("'")
    return _DOTENV


def env(name, default=None):
    """The process environment wins; .env is the fallback."""
    _load_dotenv()
    value = os.environ.get(name)
    if value:
        return value
    return _DOTENV.get(name, default)


def db_settings():
    """The database .env names. A missing server or name is a refusal, not a guess."""
    settings = {
        "host": env("X10_DB_HOST"),
        "port": int(env("X10_DB_PORT", str(DEFAULT_PORT))),
        "database": env("X10_DB_NAME"),
        "user": env("X10_DB_USER"),
        "password": env("X10_DB_PASSWORD"),
    }
    for variable, key in (("X10_DB_HOST", "host"), ("X10_DB_NAME", "database")):
        if not settings[key]:
            raise SystemExit(f"no {variable} in .env: the database is deployment data, so nothing here guesses it")
    return settings


def tcp_probe(host, port, timeout=8.0):
    """Open a socket and read the greeting. Returns (ok, why, seconds, banner)."""
    started = time.time()
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError as exc:
        return False, f"{type(exc).__name__}: {exc}", time.time() - started, b""
    elapsed = time.time() - started
    banner = b""
    try:
        sock.settimeout(6.0)
        banner = sock.recv(64)
    except OSError:
        pass
    finally:
        sock.close()
    return True, "open", elapsed, banner


def banner_version(raw):
    """The server version sits after the packet header and the protocol byte."""
    if len(raw) < 5:
        return ""
    body = raw[4:]
    if body[0] != 0x0A:
        return ""
    end = body.find(b"\x00", 1)
    return body[1:end].decode("latin-1", "replace") if end > 0 else ""


def split_statements(text):
    """Split our SQL into statements, ignoring comments and quoted semicolons."""
    body = "\n".join(
        line for line in text.splitlines() if not line.strip().startswith("--")
    )
    statements, buffer, quote = [], [], None
    index = 0
    while index < len(body):
        ch = body[index]
        if quote:
            buffer.append(ch)
            if ch == quote:
                if index + 1 < len(body) and body[index + 1] == quote:
                    buffer.append(body[index + 1])
                    index += 1
                else:
                    quote = None
        elif ch in "'\"`":
            quote = ch
            buffer.append(ch)
        elif ch == ";":
            statement = "".join(buffer).strip()
            if statement:
                statements.append(statement)
            buffer = []
        else:
            buffer.append(ch)
        index += 1
    tail = "".join(buffer).strip()
    if tail:
        statements.append(tail)
    return statements


def connect(cfg):
    """Import pymysql late so check/feed/sql never need the driver."""
    try:
        import pymysql
    except ImportError:
        print("pymysql is not installed: python -m pip install pymysql")
        return None
    return pymysql.connect(
        host=cfg["host"],
        port=cfg["port"],
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        connect_timeout=10,
        read_timeout=30,
        charset="utf8mb4",
    )


HINTS = {
    1045: "access denied: wrong password, or this user is not granted to this client host",
    1130: "the server refuses this client host: add it in cPanel -> Remote Database Access",
    1049: "that database does not exist on this account",
    2003: "no route to the port: blocked or the host is down",
}


def connect_with_repair(cfg):
    """Connect, and if this address is not allowed, re-authorise it and retry.

    This is what stops the mirror dropping out when the public address rotates.
    This server reports a refused client as 1045, exactly like a wrong password,
    so the access list is checked first: if the address is missing it is added
    and the connection retried, and if the address was already allowed the
    failure is a credential problem and is reported as one.
    """
    try:
        return connect(cfg)
    except ImportError:
        raise
    except Exception as exc:
        code = exc.args[0] if getattr(exc, "args", None) else 0
        if code not in (1045, 1130, 2003, 2013):
            raise
        print(f"mysql refused this client ({code}); checking the access list")
        try:
            import x10_autoip
            changed, hosts, ips = x10_autoip.ensure_allowed()
        except Exception as repair:  # no token, no network, cPanel unhappy
            print(f"could not repair the access list: {repair}")
            raise exc
        missing = [ip for ip in ips if ip not in hosts]
        if missing:
            print(f"still not allowed after the repair: {', '.join(missing)}")
            raise exc
        print(f"address allowed ({', '.join(ips)}); {changed} change(s); retrying")
        try:
            return connect(cfg)
        except Exception as again:
            again_code = again.args[0] if getattr(again, "args", None) else 0
            if again_code == 1045:
                print("refused while the address is allowed: check X10_DB_USER and X10_DB_PASSWORD")
            raise


def cmd_probe(_args):
    cfg = db_settings()
    print(f"host     : {cfg['host']}")
    print(f"port     : {cfg['port']}")
    print(f"database : {cfg['database']}")
    print(f"user     : {cfg['user'] or '(unset: X10_DB_USER)'}")
    print(f"password : {'set' if cfg['password'] else '(unset: X10_DB_PASSWORD)'}")

    ok, why, elapsed, banner = tcp_probe(cfg["host"], cfg["port"])
    if not ok:
        print(f"\nconnect FAILED after {elapsed:.2f}s: {why}")
        return 1
    version = banner_version(banner)
    print(f"\nport open in {elapsed * 1000:.0f} ms; greeting: {version or '(unreadable)'}")

    if not cfg["user"] or not cfg["password"]:
        print("stopping before authentication: no credentials are set, so nothing was tried")
        return 0

    try:
        conn = connect_with_repair(cfg)
    except ImportError:
        return 1
    except Exception as exc:  # pymysql raises OperationalError subclasses
        code = exc.args[0] if getattr(exc, "args", None) else 0
        print(f"\nmysql FAILED ({code}): {HINTS.get(code, str(exc))}")
        return 1
    if conn is None:
        return 1
    with conn:
        with conn.cursor() as cur:
            cur.execute("SELECT VERSION(), DATABASE(), CURRENT_USER()")
            print("authenticated:", cur.fetchone())
            cur.execute("SHOW TABLES LIKE 'x10\\_%'")
            tables = [row[0] for row in cur.fetchall()]
            print(f"x10 tables present: {len(tables)}", tables)
    return 0


def cmd_push(args):
    cfg = db_settings()
    feed = build_feed()
    statements = split_statements(build_sql(feed))
    if not statements:
        print("nothing to push")
        return 1
    print(f"statements: {len(statements)} -> {cfg['host']}:{cfg['port']}/{cfg['database']}")
    if args.dry_run:
        for index, statement in enumerate(statements, start=1):
            print(f"  {index:2d}. {statement.splitlines()[0][:70]}")
        return 0

    if not cfg["user"] or not cfg["password"]:
        print("set X10_DB_USER and X10_DB_PASSWORD (or put them in .env) first; run `probe` to test")
        return 1

    try:
        conn = connect_with_repair(cfg)
    except ImportError:
        return 1
    except Exception as exc:
        code = exc.args[0] if getattr(exc, "args", None) else 0
        print(f"mysql FAILED ({code}): {HINTS.get(code, str(exc))}")
        return 1
    if conn is None:
        return 1

    with conn:
        with conn.cursor() as cur:
            for statement in statements:
                cur.execute(statement)
        conn.commit()
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*), COALESCE(SUM(reward), 0) FROM x10_mined_solutions")
            count, total = cur.fetchone()
            cur.execute("SELECT chain, solutions, minted FROM x10_mined_supply")
            per_chain = cur.fetchall()

    local_rows = feed["mined"]["solutions"]
    local_total = sum(int(row["reward"]) for row in local_rows)
    print(f"\nmysql: {count} solutions, supply {int(total) / 10 ** 18:g}")
    print(f"local: {len(local_rows)} solutions, supply {local_total / 10 ** 18:g}")
    for chain, solutions, minted in per_chain:
        print(f"  {chain}: {solutions} solutions, {int(minted) / 10 ** 18:g} minted")
    if int(count) != len(local_rows) or int(total) != local_total:
        print("\nMISMATCH: the database does not agree with the records")
        return 1
    print("\nmirror agrees with the records")
    return 0


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def cmd_check(_args):
    findings = check()
    bad = [message for ok, message in findings if not ok]
    for ok, message in findings:
        print(f"  {'ok  ' if ok else 'FAIL'} {message}")
    print(f"\n{len(findings) - len(bad)}/{len(findings)} checks pass")
    if bad:
        print("\nthe records disagree; fix them before mirroring, because the SQL would carry the error")
        return 1
    return 0


def cmd_feed(_args):
    feed = build_feed()
    write(FEED, json.dumps(feed, indent=1) + "\n")
    print(f"feed    : {os.path.relpath(FEED)}")
    print(f"sha256  : {feed['sha256']}")
    print(f"solutions: {len(feed['mined']['solutions'])}, bridged: {len(feed['bridged'])}")
    return 0


def cmd_sql(_args):
    feed = build_feed()
    text = build_sql(feed)
    write(SQL, text)
    write(FEED, json.dumps(feed, indent=1) + "\n")
    statements = len(split_statements(text))
    print(f"sql     : {os.path.relpath(SQL)}")
    print(f"feed    : {os.path.relpath(FEED)} (sha256 {feed['sha256']})")
    print(f"statements: {statements}")
    print("\nnext: put the MySQL password in .env as X10_DB_PASSWORD (or export it), then")
    print("  python x10_fuse.py probe     # port + login")
    print("  python x10_fuse.py push      # import, then read the supply back out and compare")
    print("without a password the SQL still imports via cPanel -> phpMyAdmin -> Import")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Mirror the chain records into the x10hosting database.")
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="cross-check the records").set_defaults(func=cmd_check)
    sub.add_parser("feed", help="write build/mirror/feed.json").set_defaults(func=cmd_feed)
    sub.add_parser("sql", help="write the importable SQL").set_defaults(func=cmd_sql)
    sub.add_parser("probe", help="test reachability and credentials").set_defaults(func=cmd_probe)
    push = sub.add_parser("push", help="run the SQL against MySQL directly")
    push.add_argument("--dry-run", action="store_true", help="list the statements only")
    push.set_defaults(func=cmd_push)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
