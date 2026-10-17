"""Tests for scripts/feed_age.py (the manual stale-feed check)."""
import datetime as dt
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import feed_age  # noqa: E402

NOW = dt.datetime(2026, 10, 7, 17, 0, tzinfo=dt.timezone.utc)


def _feed(tmp_path, payload):
    p = tmp_path / "events.json"
    p.write_text(payload if isinstance(payload, str) else json.dumps(payload))
    return str(p)


def test_z_suffixed_timestamp(tmp_path):
    assert feed_age.age_days(_feed(tmp_path, {"last_updated": "2026-10-04T12:00:00Z"}), NOW) == 3


def test_offset_timestamp(tmp_path):
    # Save & Publish writes Central offsets.
    assert feed_age.age_days(_feed(tmp_path, {"last_updated": "2026-10-07T10:00:00-05:00"}), NOW) == 0
    assert feed_age.age_days(_feed(tmp_path, {"last_updated": "2026-09-30T10:00:00-05:00"}), NOW) == 7


def test_naive_timestamp_is_read_as_utc(tmp_path):
    assert feed_age.age_days(_feed(tmp_path, {"last_updated": "2026-10-05T17:00:00"}), NOW) == 2


def test_fresh_feed_is_zero_days(tmp_path):
    assert feed_age.age_days(_feed(tmp_path, {"last_updated": "2026-10-07T16:59:00Z"}), NOW) == 0


def test_missing_or_bad_values_are_99(tmp_path):
    assert feed_age.age_days(_feed(tmp_path, {"events": []}), NOW) == 99
    assert feed_age.age_days(_feed(tmp_path, {"last_updated": ""}), NOW) == 99
    assert feed_age.age_days(_feed(tmp_path, {"last_updated": "last Tuesday"}), NOW) == 99
    assert feed_age.age_days(_feed(tmp_path, "<html>502 Bad Gateway</html>"), NOW) == 99
    assert feed_age.age_days(str(tmp_path / "missing.json"), NOW) == 99


def test_cli_prints_the_age(tmp_path):
    path = _feed(tmp_path, {"last_updated": dt.datetime.now(dt.timezone.utc).isoformat()})
    script = os.path.join(os.path.dirname(__file__), "scripts", "feed_age.py")
    out = subprocess.run([sys.executable, script, path], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "0"
