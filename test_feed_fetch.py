"""Getting past a feed site's bot checks (collect_events.http_get and
feed_get), a JSON feed that answers with a web page saying so, and a
"sparse" feed whose empty weeks don't warn. Network faked."""
import pytest

import collect_events as ce
import town
import town_feeds
from test_town_feeds import CT, END, START


class Resp:
    def __init__(self, status=200, text="", ctype="text/html", data=None):
        self.status_code, self.text, self.headers, self._data = status, text, {"content-type": ctype}, data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise ce.requests.HTTPError(f"{self.status_code}")

    def json(self):
        if self._data is None:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._data


HUMANS = '<script>document.cookie = "humans_21909=1"; document.location.reload(true)</script>'
EMPTY = {"events": [], "total": 0}


def test_the_humans_cookie_check_is_passed(monkeypatch):
    calls = []

    def get(url, headers=None, cookies=None, timeout=None):
        calls.append(cookies)
        return Resp(200, '{"events": []}', "application/json", EMPTY) if cookies else Resp(409, HUMANS)
    monkeypatch.setattr(ce.requests, "get", get)
    assert ce.http_get("https://msnha.example/wp-json/x").status_code == 200
    assert calls == [None, {"humans_21909": "1"}]


def test_a_plain_409_still_fails(monkeypatch):
    monkeypatch.setattr(ce.requests, "get", lambda url, **k: Resp(409, "Conflict"))
    with pytest.raises(ce.requests.HTTPError):
        ce.http_get("https://x.example/")


def test_a_json_feed_that_gets_a_page_asks_again_as_safari(monkeypatch):
    seen = []

    def http_get(url, headers=None, timeout=None, fallback_safari=True):
        seen.append(headers)
        if headers is ce.HEADERS_SAFARI:
            return Resp(200, "{}", "application/json; charset=UTF-8", EMPTY)
        return Resp(200, "<html>checking your browser</html>")
    monkeypatch.setattr(ce, "http_get", http_get)
    assert ce.feed_get("https://arts.example/wp-json/tribe/events/v1/events").json() == EMPTY
    assert seen == [None, ce.HEADERS_SAFARI]
    seen.clear()
    ce.feed_get("https://arts.example/calendar.ics")        # not a JSON API: asked once
    assert seen == [None]


def test_a_json_feed_that_stays_a_page_says_what_came_back():
    get = lambda url: Resp(200, "<html>  <title>403 - Forbidden</title></html>")
    with pytest.raises(ValueError, match=r"not JSON: HTTP 200 text/html: '<html> <title>403 - Forbidden"):
        town_feeds.fetch_feed({"name": "a", "type": "tribe", "url": "https://arts.example"}, get, CT, START, END)


def _feeds_town(monkeypatch, feeds):
    t = town.town_config(town={"id": "bay", "siteName": "The Bay 979", "domain": "thebay979.com", "city": "Bay City",
                               "state": "TX", "stateName": "Texas", "timezone": "America/Chicago", "feeds": feeds})
    monkeypatch.setattr(ce, "TOWN", t)
    monkeypatch.setattr(ce, "_WINDOW_START", START)
    monkeypatch.setattr(ce, "_WINDOW_END", END)
    monkeypatch.setattr(ce, "http_get", lambda url, **k: Resp(200, "{}", "application/json", EMPTY))


def test_a_sparse_feed_doesnt_warn_when_empty(monkeypatch):
    _feeds_town(monkeypatch, [{"name": "parks", "type": "tribe", "url": "https://parks.example", "sparse": True},
                              {"name": "arts", "type": "tribe", "url": "https://arts.example"}])
    warned = []
    monkeypatch.setattr(ce, "_warn", lambda msg, **k: warned.append(msg))
    assert ce.fetch_town_feeds() == []
    assert warned == ["[Feeds] arts returned 0 events"]


def test_sparse_must_be_true_or_false():
    with pytest.raises(ValueError, match="sparse must be true or false"):
        town_feeds.check_feeds([{"name": "p", "type": "tribe", "url": "https://p.example", "sparse": "yes"}])
