#!/usr/bin/env python3
"""Focused regression tests for x10_ai's draft-only review command.

    python test_x10_ai_review.py
    python -m pytest -q test_x10_ai_review.py

The model, database, drift comparison and source loader are all stubbed. Both
a valid proposal and a no-change response are tested; apply_patch and
x10_deploy.push are patched and must stay untouched in either case.
"""

import json
import os
import tempfile
from unittest import mock

import x10_ai


def _run_stubbed_review(proposal, output_dir):
    """Run review with every model, DB and deploy dependency stubbed."""
    with mock.patch.object(x10_ai, "settings", return_value={
                "base": "http://stub.invalid/v1", "key": "stub-key", "model": "stub-model",
            }), \
            mock.patch.object(x10_ai, "recent_context", return_value=[]), \
            mock.patch.object(x10_ai, "ask_model", return_value=proposal), \
            mock.patch.object(x10_ai, "log"), \
            mock.patch.object(x10_ai, "AI_DIR", output_dir), \
            mock.patch.object(x10_ai.x10_deploy, "compare", return_value=[]), \
            mock.patch.object(x10_ai.x10_deploy, "local_files", return_value={}), \
            mock.patch.object(x10_ai, "apply_patch") as apply_patch, \
            mock.patch.object(x10_ai.x10_deploy, "push") as push:
        result = x10_ai.main(["review"])
        saved = [name for name in os.listdir(output_dir) if name.startswith("patch-")]
    return result, saved, apply_patch, push


def test_review_never_applies_or_pushes():
    """A review may draft a patch, but must never apply or upload it."""
    proposal = json.dumps({
        "file": "web9999.php",
        "content": "<?php echo 1;\n",
        "reason": "regression test proposal",
    })

    with tempfile.TemporaryDirectory() as tmp:
        result, saved, apply_patch, push = _run_stubbed_review(proposal, tmp)

    assert result == 0
    assert len(saved) == 1
    apply_patch.assert_not_called()
    push.assert_not_called()


def test_review_no_change_never_applies_or_pushes():
    """A no-change response must not apply or upload anything either."""
    proposal = json.dumps({"no_change": True, "reason": "nothing to fix"})

    with tempfile.TemporaryDirectory() as tmp:
        result, saved, apply_patch, push = _run_stubbed_review(proposal, tmp)

    assert result == 0
    assert saved == []
    apply_patch.assert_not_called()
    push.assert_not_called()


if __name__ == "__main__":
    test_review_never_applies_or_pushes()
    test_review_no_change_never_applies_or_pushes()
    print("ok: review never applies or pushes, with or without a proposal")
