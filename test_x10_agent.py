#!/usr/bin/env python3
"""Focused regression test for x10_agent drift reporting.

    python test_x10_agent.py
    python -m pytest -q test_x10_agent.py

The drift row is forced locally, and push is replaced by a mock. No cPanel
request, database connection, or live file is touched.
"""

from unittest import mock

import x10_agent


def test_check_drift_reports_fault_without_push():
    """A drifted file is a fault, and check_drift must never upload it."""
    drift = [{"file": "web9999.php", "state": "different"}]

    with mock.patch.object(x10_agent.x10_deploy, "compare", return_value=drift), \
            mock.patch.object(x10_agent.x10_deploy, "push") as push:
        ok, detail = x10_agent.check_drift()

    assert ok is False
    assert "web9999.php" in detail
    assert "not repaired" in detail
    push.assert_not_called()


if __name__ == "__main__":
    test_check_drift_reports_fault_without_push()
    print("ok: check_drift reports drift without uploading")
