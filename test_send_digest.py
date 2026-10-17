"""Tests for send_digest.py (weekly-digest.yml's owner email)."""
import json

import pytest

import send_digest as sd

EVENTS = [
    {"date": "2026-10-08", "name": "Trivia Night", "time": "7:00 PM", "venue": "Pub", "icons": ["drinks"]},
    {"date": "2026-10-06", "name": "Farmers Market", "venue": "Square", "free": True, "description": "Fresh food."},
    {"date": "2026-10-08", "name": "Open Mic", "venue": "Cafe"},
]


@pytest.fixture
def candidates(tmp_path):
    p = tmp_path / "candidates.json"
    p.write_text(json.dumps({"events": EVENTS}))
    return str(p)


def test_load_candidates_groups_by_date(candidates):
    events, by_date = sd.load_candidates(candidates, all_days=True)
    assert len(events) == 3
    assert sorted(by_date) == ["2026-10-06", "2026-10-08"]
    assert [e["name"] for e in by_date["2026-10-08"]] == ["Trivia Night", "Open Mic"]


def test_load_candidates_defaults_to_the_last_day(candidates):
    events, by_date = sd.load_candidates(candidates)
    assert list(by_date) == ["2026-10-08"]
    assert len(events) == 2


def test_email_body_lists_every_event_in_date_order(candidates):
    events, by_date = sd.load_candidates(candidates, all_days=True)
    subject, text, html = sd.build_email_body(events, by_date)
    assert "[VIC361-DIGEST " in subject  # inbox filters key on this tag
    assert "3 events found across 2 days" in text
    assert text.index("[1]") < text.index("Farmers Market") < text.index("[2]")
    assert "[3]" in text and "[4]" not in text
    assert "Farmers Market [FREE]" in text
    assert "Trivia Night" in html and "Fresh food." in html


def test_admin_link_uses_www(candidates, monkeypatch):
    # The bare domain's deep links 404 (Squarespace forwards to www//path).
    monkeypatch.delenv("SITE_URL", raising=False)
    _, text, html = sd.build_email_body(*sd.load_candidates(candidates, all_days=True))
    assert "https://www.thevic361.com/admin.html" in text
    assert "https://thevic361.com/" not in text + html


def test_admin_link_follows_site_url(candidates, monkeypatch):
    monkeypatch.setenv("SITE_URL", "https://staging.example.com/")
    _, text, _ = sd.build_email_body(*sd.load_candidates(candidates, all_days=True))
    assert "https://staging.example.com/admin.html" in text


def test_send_email_without_password_does_not_connect(monkeypatch):
    monkeypatch.setenv("SMTP_EMAIL", "me@example.com")
    monkeypatch.delenv("SMTP_PASSWORD", raising=False)
    monkeypatch.setattr(sd.smtplib, "SMTP", lambda *a, **k: pytest.fail("must not connect"))
    assert sd.send_email("s", "t", "<p>h</p>", "to@example.com") is False


def test_send_email_dry_run_does_not_connect(monkeypatch):
    monkeypatch.setattr(sd.smtplib, "SMTP", lambda *a, **k: pytest.fail("must not connect"))
    assert sd.send_email("s", "t", "<p>h</p>", "to@example.com", dry_run=True) is True


class FakeSMTP:
    sent = []

    def __init__(self, host, port):
        self.calls = [("connect", host, port)]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def starttls(self):
        self.calls.append(("starttls",))

    def login(self, user, password):
        self.calls.append(("login", user))

    def send_message(self, msg):
        FakeSMTP.sent.append((self.calls, msg))


def test_send_email_uses_starttls_and_sends_both_parts(monkeypatch):
    FakeSMTP.sent = []
    monkeypatch.setenv("SMTP_EMAIL", "me@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "app-password")
    monkeypatch.delenv("SMTP_HOST", raising=False)
    monkeypatch.delenv("SMTP_PORT", raising=False)
    monkeypatch.setattr(sd.smtplib, "SMTP", FakeSMTP)
    assert sd.send_email("Subject", "plain", "<p>html</p>", "to@example.com") is True
    calls, msg = FakeSMTP.sent[0]
    assert calls == [("connect", "smtp.gmail.com", 587), ("starttls",), ("login", "me@example.com")]
    assert msg["To"] == "to@example.com"
    assert msg["From"] == "The Vic 361 <me@example.com>"
    assert [p.get_content_type() for p in msg.get_payload()] == ["text/plain", "text/html"]


def test_send_email_reports_smtp_errors(monkeypatch):
    monkeypatch.setenv("SMTP_EMAIL", "me@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "app-password")

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(sd.smtplib, "SMTP", boom)
    assert sd.send_email("s", "t", "h", "to@example.com") is False


def test_main_skips_when_there_is_nothing_to_screen(tmp_path, monkeypatch):
    p = tmp_path / "candidates.json"
    p.write_text(json.dumps({"events": []}))
    monkeypatch.setattr("sys.argv", ["send_digest.py", "--candidates", str(p), "--all-days"])
    monkeypatch.setattr(sd, "send_email", lambda *a, **k: pytest.fail("nothing to send"))
    with pytest.raises(SystemExit) as e:
        sd.main()
    assert e.value.code == 0


def test_main_fails_when_candidates_are_missing(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.argv", ["send_digest.py", "--candidates", str(tmp_path / "nope.json")])
    with pytest.raises(SystemExit) as e:
        sd.main()
    assert e.value.code == 1


def test_main_exits_nonzero_when_the_send_fails(tmp_path, monkeypatch):
    # A revoked app password must turn the job red so its Slack alert fires.
    p = tmp_path / "candidates.json"
    p.write_text(json.dumps({"events": [{"date": "2026-01-01", "name": "Bingo", "venue": "Hall"}]}))
    monkeypatch.setattr("sys.argv", ["send_digest.py", "--candidates", str(p), "--all-days"])
    for ok, code in ((False, 1), (True, 0)):
        monkeypatch.setattr(sd, "send_email", lambda *a, ok=ok, **k: ok)
        with pytest.raises(SystemExit) as e:
            sd.main()
        assert e.value.code == code


class FakeResend:
    def __init__(self, status=200):
        self.status, self.calls = status, []

    def post(self, url, **kw):
        self.calls.append((url, kw))
        return type("R", (), {"status_code": self.status})()


def test_send_email_uses_resend_when_only_its_key_is_set(monkeypatch):
    monkeypatch.delenv("SMTP_PASSWORD", raising=False)
    monkeypatch.delenv("NEWSLETTER_FROM", raising=False)
    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    monkeypatch.setattr(sd.smtplib, "SMTP", lambda *a, **k: pytest.fail("must not connect"))
    fake = FakeResend()
    assert sd.send_email("Subject", "plain", "<p>html</p>", "to@example.com", session=fake) is True
    url, kw = fake.calls[0]
    assert url == "https://api.resend.com/emails"
    assert kw["headers"] == {"Authorization": "Bearer re_test"}
    assert kw["json"] == {"from": "The Vic 361 <news@thevic361.com>", "to": ["to@example.com"],
                          "subject": "Subject", "text": "plain", "html": "<p>html</p>"}
    assert sd.send_email("s", "t", "h", "to@example.com", session=FakeResend(422)) is False
