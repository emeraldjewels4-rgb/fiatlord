#!/usr/bin/env python3
"""x10_ai - the fixer that drafts patches from what the agent observed.

    python x10_ai.py review            # ask the model for a patch, save it, apply nothing
    python x10_ai.py apply build/ai/patch-*.json   # check it, then write it locally
    python x10_ai.py check PATH        # run the safety checks on a patch only

A patch is never applied by `review`. It is written to build/ai/ and printed,
so you can read it, and `apply` only writes the local build/web source. Nothing
in this tool uploads to public_html or auto-restores a failed patch; publish a
reviewed local change separately with `python x10_deploy.py push`.

Works with any OpenAI-compatible chat-completions endpoint, configured in .env:

    AI_API_BASE   default https://api.openai.com/v1
    AI_API_KEY    your key (OPENAI_API_KEY is also accepted)
    AI_MODEL      default gpt-4o-mini

Without a key `review` exits 3 and changes nothing.

The checks in `safe()` are heuristics, not proof: they reject a patch that is
not PHP, is huge, or carries the usual code-execution and exfiltration calls.
They cannot tell you the logic is right. Read the diff.
"""

import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

import pymysql

import x10_deploy
import x10_fuse

AI_DIR = os.path.join(x10_fuse.HERE, "build", "ai")
DB = x10_deploy.DB
MAX_BYTES = 200_000
USER_AGENT = "web9999-agent/1.0"

BANNED = (
    "shell_exec", "passthru", "proc_open", "popen", "pcntl_exec",
    "assert(", "eval(", "create_function", "extract(", "$_ENV",
    "file_put_contents('/etc", "/etc/passwd",
)


def settings():
    return {
        "base": x10_fuse.env("AI_API_BASE", "https://api.openai.com/v1").rstrip("/"),
        "key": x10_fuse.env("AI_API_KEY") or x10_fuse.env("OPENAI_API_KEY"),
        "model": x10_fuse.env("AI_MODEL", "gpt-4o-mini"),
    }


def log(action, model, detail, ok):
    try:
        conn = pymysql.connect(
            host=x10_fuse.env("X10_DB_HOST"), port=int(x10_fuse.env("X10_DB_PORT")),
            user=x10_fuse.env("X10_DB_USER"), password=x10_fuse.env("X10_DB_PASSWORD"),
            database=DB, charset="utf8mb4", autocommit=True,
        )
    except Exception as exc:
        print(f"  (not recorded: {exc})")
        return
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO web9999_ai_log (action, model, detail, ok, created_at) VALUES (%s, %s, %s, %s, %s)",
            (action[:32], (model or "-")[:80], str(detail)[:255], 1 if ok else 0, int(x10_fuse.time.time())
             if hasattr(x10_fuse, "time") else int(__import__("time").time())),
        )
    conn.close()


def recent_context(limit=12):
    rows = []
    try:
        conn = pymysql.connect(
            host=x10_fuse.env("X10_DB_HOST"), port=int(x10_fuse.env("X10_DB_PORT")),
            user=x10_fuse.env("X10_DB_USER"), password=x10_fuse.env("X10_DB_PASSWORD"),
            database=DB, charset="utf8mb4",
        )
        with conn.cursor() as cur:
            cur.execute("SELECT action, detail, ok, created_at FROM web9999_agent_log ORDER BY id DESC LIMIT %s", (limit,))
            rows = [{"action": a, "detail": d, "ok": bool(o), "at": t} for a, d, o, t in cur.fetchall()]
        conn.close()
    except Exception as exc:
        rows = [{"action": "unavailable", "detail": str(exc), "ok": False, "at": 0}]
    return rows


def ask_model(messages):
    """One chat-completions call, tolerant of providers that reject extras.

    The User-Agent is not optional: Groq sits behind Cloudflare, which answers
    the default Python-urllib agent with 403 "error code: 1010" before the API
    ever sees the key. With a real agent the same request gets JSON back.
    """
    cfg = settings()
    optional = {
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "max_completion_tokens": 8000,
    }
    for _ in range(3):
        body = json.dumps({"model": cfg["model"], "messages": messages, **optional}).encode()
        request = urllib.request.Request(
            cfg["base"] + "/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {cfg['key']}",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = json.loads(response.read().decode("utf-8", "replace"))
            return payload["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            dropped = [name for name in ("temperature", "response_format", "max_completion_tokens")
                       if name in optional and name in detail.lower()]
            # Groq's JSON mode validates the reply and rejects the whole call
            # (json_validate_failed) when a long escaped file body comes back
            # malformed. Plain mode plus a tolerant parser handles that.
            if not dropped and "json" in detail.lower() and "failed" in detail.lower():
                dropped = ["response_format"] if "response_format" in optional else []
            if exc.code in (400, 422) and dropped:
                for name in dropped:
                    optional.pop(name)
                print(f"  the provider rejected {', '.join(dropped)}; retrying without it")
                continue
            raise urllib.error.URLError(f"HTTP {exc.code}: {detail}") from exc
    raise ValueError("the provider kept rejecting the request")


def parse_proposal(raw):
    """Accept JSON even when the model wraps it in a fence or a sentence."""
    text = (raw or "").strip()
    text = re.sub(r"^```[A-Za-z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise


def safe(name, content):
    """Heuristic gate. Returns (ok, reason)."""
    if not re.fullmatch(r"[A-Za-z0-9_\-]+\.php", name or ""):
        return False, "only a .php file in build/web may be patched"
    if not content.startswith("<?php"):
        return False, "the patch must start with <?php"
    if len(content.encode("utf-8")) > MAX_BYTES:
        return False, "the patch is too large"
    lowered = content.lower()
    for needle in BANNED:
        if needle.lower() in lowered:
            return False, f"refusing a patch containing {needle!r}"
    return True, "passed the heuristic checks"


def review():
    cfg = settings()
    if not cfg["key"]:
        print("no AI key: set AI_API_KEY (or OPENAI_API_KEY) in .env to enable drafting")
        print("nothing was changed")
        return 3

    drift = x10_deploy.compare()
    context = {
        "service": "web9999",
        "agent_log": recent_context(),
        "files": [{"file": row["file"], "state": row["state"]} for row in drift],
        "sources": {},
    }
    for name, info in x10_deploy.local_files().items():
        context["sources"][name] = info["bytes"].decode("utf-8")

    messages = [
        {"role": "system", "content": (
            "You maintain a small PHP service called web9999 on shared hosting. "
            "You get the recent maintenance log, the drift report and the current source files. "
            "Reply with strict JSON only: either {\"no_change\": true, \"reason\": \"...\"} or "
            "{\"file\": \"<name>.php\", \"content\": \"<the complete new file>\", \"reason\": \"...\"}. "
            "Only propose a change that fixes an observed fault. Keep the file self-contained, "
            "keep every existing public method working, and never add shell execution or network "
            "calls to unfamiliar hosts."
        )},
        {"role": "user", "content": json.dumps(context)[:60000]},
    ]

    try:
        raw = ask_model(messages)
    except (urllib.error.URLError, KeyError, ValueError) as exc:
        print(f"the model call failed: {exc}")
        log("proposal", cfg["model"], f"call failed: {exc}", False)
        return 1

    try:
        proposal = parse_proposal(raw)
    except ValueError:
        print("the model did not return JSON; nothing was changed")
        log("proposal", cfg["model"], "unparseable response", False)
        return 1

    if proposal.get("no_change"):
        print(f"no change proposed: {proposal.get('reason', '')}")
        log("proposal", cfg["model"], f"no change: {proposal.get('reason', '')}", True)
        return 0

    name = proposal.get("file", "")
    content = proposal.get("content", "")
    ok, reason = safe(name, content)
    os.makedirs(AI_DIR, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(AI_DIR, f"patch-{stamp}.json")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump({"file": name, "content": content, "reason": proposal.get("reason", ""),
                   "model": cfg["model"], "safe": ok, "check": reason}, fh, indent=1)
        fh.write("\n")

    print(f"proposal : {name}")
    print(f"reason   : {proposal.get('reason', '')}")
    print(f"checks   : {'ok' if ok else 'REJECTED'} — {reason}")
    print(f"saved    : {os.path.relpath(path)}")
    log("proposal", cfg["model"], f"{name}: {reason}", ok)

    if not ok:
        return 1
    print("\nreview it, then stage it locally: python x10_ai.py apply " + os.path.relpath(path))
    return 0


def apply_patch(path):
    with open(path, encoding="utf-8") as fh:
        patch = json.load(fh)
    name, content = patch.get("file", ""), patch.get("content", "")
    ok, reason = safe(name, content)
    if not ok:
        print(f"refusing to stage: {reason}")
        log("apply-local", patch.get("model", "-"), f"{name}: {reason}", False)
        return 1

    target = os.path.join(x10_deploy.WEB, name)
    os.makedirs(x10_deploy.WEB, exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content if content.endswith("\n") else content + "\n")

    print(f"wrote    : {os.path.relpath(target)}")
    print("local only: nothing was uploaded to public_html")
    print("publish separately with: python x10_deploy.py push")
    log("apply-local", patch.get("model", "-"), f"{name}: staged locally", True)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Draft, check and stage patches for web9999.")
    sub = ap.add_subparsers(dest="command")
    sub.add_parser("review", help="ask the model for a patch; apply nothing")
    apply_cmd = sub.add_parser("apply", help="check and stage a saved patch locally; never uploads")
    apply_cmd.add_argument("patch")
    check_cmd = sub.add_parser("check", help="run the safety checks only")
    check_cmd.add_argument("patch")
    args = ap.parse_args(argv)

    if args.command == "apply":
        return apply_patch(args.patch)
    if args.command == "check":
        with open(args.patch, encoding="utf-8") as fh:
            patch = json.load(fh)
        ok, reason = safe(patch.get("file"), patch.get("content", ""))
        print(("ok: " if ok else "REJECTED: ") + reason)
        return 0 if ok else 1
    return review()


if __name__ == "__main__":
    sys.exit(main())
