"""Which town this run is for (MULTI_CITY_PLAN.md, Phase 1.4).

The Python twin of server/town.js, reading the same settings: TOWN unset
(or "victoria") is The Vic 361 with exactly today's values; any other slug
reads towns/<slug>/town.json, derives what follows from its own domain and
name (never Victoria's), and stops with an error when the file or a field
is missing, rather than posting Victoria's name for another town.

    from town import TOWN            # the town for this process
    TOWN["city"], TOWN["site_url"], TOWN["hashtags"], ...

Scripts in scripts/ import it after putting the repo root on sys.path.
Fields arrive with the step that moves their literals; the collector's
(area ZIPs, other towns, sources, queries) come in a later step.
"""
import json
import os
import re

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None

ROOT = os.path.dirname(os.path.abspath(__file__))

VICTORIA = {
    "id": "victoria",
    # Identity
    "site_name": "The Vic 361",
    "site_name_html": "The Vic <span>361</span>",   # the two-tone wordmark: text, then the badge
    "short_name": "Vic 361",
    "domain": "thevic361.com",
    "site_url": "https://www.thevic361.com",
    "pick_name": "Vic’s Pick",
    "pick_name_plain": "Vic's Pick",
    # Geography
    "city": "Victoria",
    "state": "TX",
    "state_name": "Texas",
    "city_state": "Victoria, TX",
    "city_state_long": "Victoria, Texas",
    "county": "Victoria County",
    "area_code": "361",
    "timezone": "America/Chicago",
    # Social posts
    "hashtags": "#VictoriaTX #ThingsToDoVictoria #VictoriaTexas #361 #TheVic361",
    # Collector (collect_events.py): the area it lists, what it asks sources
    # for, and the place names its checks and AI prompts use.
    "area_name": "Victoria County",     # "anything outside Victoria County"
    "area_zips": ["77901", "77902", "77903", "77904", "77905",
                  "77968", "77976", "77951", "77977", "77988", "77960"],
    # Towns near enough to show up in regional feeds but not ours.
    "other_towns": [
        "cuero", "port lavaca", "goliad", "edna", "yoakum", "hallettsville",
        "shiner", "corpus christi", "houston", "san antonio", "austin",
        "refugio", "ganado", "seadrift", "el campo", "wharton", "beeville",
        "kenedy", "yorktown", "point comfort", "palacios", "rockport",
        "port o'connor", "port oconnor", "gonzales", "bay city",
    ],
    "nearby_examples": "Cuero, Port Lavaca, Goliad, Edna, Yoakum, Corpus Christi, Houston",
    "city_tokens_extra": ["vtx"],       # local shorthand for the city
    "allevents_slug": "victoria-tx",
    # Web sources the collector runs (collect_events.py WEB_SOURCES): all of
    # them, its own city/library/venue scrapers included. Another town
    # without a list gets every source but those local scrapers.
    "enabled_sources": ["city_calendar", "chamber", "library", "moonshine", "vtx_artwalk", "jwelch",
                        "theatre_victoria", "generals", "allevents", "gemini_search", "apify_facebook",
                        "apify_eventbrite", "apify_facebook_posts", "apify_instagram_posts"],
    "google_sheet_id": "1S42hYlrPM516LDTcy3W_8afCkCqc-ZrUfN2J-SmP23I",
    "eventbrite_search": {"searchQuery": "events in Victoria, TX", "location": "Victoria, TX"},
    "fb_search_queries": {"primary": ["Victoria Texas"], "alt": ["Victoria, Texas"]},
    "gemini_categories": [
        "concerts, live music, open mics and karaoke",
        "family and kids events (story times, zoo, museum, school and library programs)",
        "festivals, markets, fairs and community events",
        "arts, theatre, museums, galleries and film screenings",
        "food and drink events, trivia nights, bar and brewery events",
        "sports, runs, rodeos, outdoor and recreation events",
        "Texas A&M University-Victoria and Victoria College events open to the general public "
        "(concerts, plays, lectures, exhibits, games); not student-only, recruiting, orientation or club events",
        "charity fundraisers, galas, benefit concerts and civic events open to the public "
        "(not worship services or church meetings)",
    ],
}

# Gemini search categories every town gets unless its town.json lists its
# own (Victoria adds its university and college).
SHARED_GEMINI_CATEGORIES = [c for c in VICTORIA["gemini_categories"] if "Victoria" not in c]

# Ceilings on the collector's Apify knobs (collect_events.py
# _resolve_int_env) for a town that sets none: the repo variables are
# Victoria's and the Apify month is shared. Victoria has no limits.
DEFAULT_LIMITS = {"EVENTBRITE_MAX": 20, "FB_EVENTS_MAX": 20, "FB_POSTS_MAX_VENUES": 10, "IG_POSTS_MAX_VENUES": 10}

REQUIRED = ("site_name", "domain", "city", "state", "state_name", "timezone")
_SAFE = re.compile(r'^[^<>&"]+$')

# town.json uses server/town.js's names (siteName, cityState…); these map
# them to this module's. Unknown keys are kept as they are.
_FROM_JSON = {
    "siteName": "site_name", "siteNameHtml": "site_name_html", "shortName": "short_name", "siteUrl": "site_url",
    "pickName": "pick_name", "pickNamePlain": "pick_name_plain", "stateName": "state_name",
    "cityState": "city_state", "cityStateLong": "city_state_long", "areaCode": "area_code",
    "areaName": "area_name", "areaZips": "area_zips", "otherTowns": "other_towns", "nearbyExamples": "nearby_examples",
    "cityTokensExtra": "city_tokens_extra", "allEventsSlug": "allevents_slug", "googleSheetId": "google_sheet_id",
    "eventbriteSearch": "eventbrite_search", "enabledSources": "enabled_sources", "fbSearchQueries": "fb_search_queries", "geminiCategories": "gemini_categories",
}


def _complete(town_id, raw):
    raw = {_FROM_JSON.get(k, k): v for k, v in raw.items() if v is not None}
    missing = [k for k in REQUIRED if not raw.get(k)]
    if missing:
        raise ValueError(f"TOWN={town_id}: town.json is missing {', '.join(missing)}")
    name, domain, city = str(raw["site_name"]), str(raw["domain"]), str(raw["city"])
    pick = str(raw.get("pick_name") or "Local Pick")
    others = raw.get("other_towns") or []
    town = {
        "nearby_examples": ", ".join(t.title() for t in others[:7]),
        "site_name_html": name,
        "short_name": re.sub(r"^the\s+", "", name, flags=re.I),
        "site_url": f"https://www.{domain}",
        "pick_name": pick,
        "pick_name_plain": pick.replace("’", "'").replace("‘", "'"),
        "city_state": f"{city}, {raw['state']}",
        "city_state_long": f"{city}, {raw['state_name']}",
        "county": "",
        "area_code": "",
        "area_name": raw.get("county") or f"the {city} area",
        "area_zips": [],
        "other_towns": [],
        "city_tokens_extra": [],
        "allevents_slug": re.sub(r"[^a-z0-9]+", "-", f"{city} {raw['state']}".lower()).strip("-"),
        "google_sheet_id": "",
        "eventbrite_search": {"searchQuery": f"events in {city}, {raw['state']}", "location": f"{city}, {raw['state']}"},
        "fb_search_queries": {"primary": [f"{city} {raw['state_name']}"], "alt": [f"{city}, {raw['state_name']}"]},
        "gemini_categories": list(SHARED_GEMINI_CATEGORIES),
        # Two place tags plus the site's own name, e.g. "#BayCityTX #BayCityTexas #TheBay979".
        "hashtags": " ".join("#" + re.sub(r"[^A-Za-z0-9]", "", s) for s in (f"{city}{raw['state']}", f"{city}{raw['state_name']}", name)),
        **raw,
        "limits": ({**DEFAULT_LIMITS, **raw["limits"]} if isinstance(raw.get("limits"), dict)
                   else raw.get("limits") or dict(DEFAULT_LIMITS)),   # not a dict: _check says so
        "id": town_id,
    }
    return _check(town)


def _check(town):
    tid = town["id"]
    for k in ("site_name", "short_name", "pick_name", "pick_name_plain", "city", "state", "state_name", "city_state", "city_state_long"):
        if not _SAFE.match(str(town.get(k) or "")):
            raise ValueError(f"TOWN={tid}: {k} can't be empty or contain < > & \"")
    if not re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", str(town["domain"])):
        raise ValueError(f'TOWN={tid}: domain "{town["domain"]}" doesn\'t look like a domain')
    if not re.match(r"^https://[a-z0-9.-]+$", str(town["site_url"])):
        raise ValueError(f"TOWN={tid}: site_url must be https://host with no path")
    if any(not re.match(r"^\d{5}$", str(z)) for z in town.get("area_zips") or []):
        raise ValueError(f"TOWN={tid}: area_zips must be 5-digit ZIP codes")
    limits = town.get("limits") or {}
    if not isinstance(limits, dict) or any(not isinstance(v, int) or isinstance(v, bool) or v <= 0 for v in limits.values()):
        raise ValueError(f"TOWN={tid}: limits must map names to positive whole numbers")
    if town.get("area_code") and not re.match(r"^\d{3}$", str(town["area_code"])):
        raise ValueError(f"TOWN={tid}: area_code must be 3 digits or empty")
    if ZoneInfo:
        try:
            ZoneInfo(town["timezone"])
        except Exception:
            raise ValueError(f'TOWN={tid}: unknown timezone "{town["timezone"]}"')
    return town


def town_config(env=None, towns_dir=None, town=None):
    """The town for these settings. town (a town.json-shaped dict) wins, for tests."""
    if town is not None:
        return _complete(town.get("id") or "test", dict(town))
    env = os.environ if env is None else env
    tid = str(env.get("TOWN") or "victoria").strip().lower()
    if tid == "victoria":
        return dict(VICTORIA)
    if not re.match(r"^[a-z0-9-]+$", tid):
        raise ValueError(f'TOWN="{env.get("TOWN")}" isn\'t a town slug (lowercase letters, digits, dashes)')
    path = os.path.join(towns_dir or env.get("TOWNS_DIR") or os.path.join(ROOT, "towns"), tid, "town.json")
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise ValueError(f"TOWN={tid}: can't read {os.path.relpath(path, ROOT)} ({e})")
    return _complete(tid, raw)


def site_url(town=None, env=None):
    """SITE_URL when set (workflows pass it), else the town's own. Another
    town on Victoria's SITE_URL stops: until its GitHub Environment exists
    (MULTI_CITY_PLAN.md 3.3) the repo-level SITE_URL is Victoria's, and the
    script would read and write Victoria's site as that town."""
    env = os.environ if env is None else env
    town = town or TOWN
    url = (env.get("SITE_URL", "").strip() or town["site_url"]).rstrip("/")
    host = re.sub(r"^https?://", "", url).split("/")[0].lower()
    vic = VICTORIA["domain"]
    if town["id"] != VICTORIA["id"] and (host == vic or host.endswith("." + vic)):
        raise ValueError(f"TOWN={town['id']}: SITE_URL is Victoria's ({url}); give the town its own (its GitHub Environment)")
    return url


def meta_allowed(town=None, env=None, use="post"):
    """Whether this run may use the Meta (Facebook, Instagram, ads)
    settings it was given. Victoria's are the repo-level ones. Another
    town's count only when its settings say they're its own
    (META_TOWN=<slug>) and the ids match the ones its town.json pins
    ("meta": {"page_id", "ig_user_id", "ad_account_id"}): a GitHub
    Environment missing one of them falls back to Victoria's repo-level
    value, which would post the town's kit on Victoria's page or read her
    ad account. use: "post" (page, Instagram) or "ads" (ad account)."""
    env = os.environ if env is None else env
    town = town or TOWN
    if town["id"] == VICTORIA["id"]:
        return True
    if env.get("META_TOWN", "").strip().lower() != town["id"]:
        return False
    pins = town.get("meta") if isinstance(town.get("meta"), dict) else {}
    pin = lambda k: str(pins.get(k) or "").strip()
    got = lambda k: env.get(k, "").strip()
    if use == "ads":
        account = lambda v: v.removeprefix("act_")
        return bool(pin("ad_account_id")) and account(got("META_AD_ACCOUNT_ID")) == account(pin("ad_account_id"))
    if not pin("page_id") or got("META_PAGE_ID") != pin("page_id"):
        return False
    return not got("IG_USER_ID") or got("IG_USER_ID") == pin("ig_user_id")


def tz(town=None):
    """The town's timezone (None without zoneinfo)."""
    return ZoneInfo((town or TOWN)["timezone"]) if ZoneInfo else None


def town_paths(town=None):
    """Where the town's data lives, relative to the repo root (server/town.js
    townPaths() is the twin): Victoria's at the root and in docs/, another
    town's under towns/<slug>/ with its public files in towns/<slug>/public/."""
    t = town or TOWN
    own = "" if t["id"] == "victoria" else f"towns/{t['id']}/"
    pub = "docs/" if t["id"] == "victoria" else f"towns/{t['id']}/public/"
    return {
        "dir": own.rstrip("/") or ".",
        "candidates": f"{own}candidates.json",
        "collection_metadata": f"{own}collection_metadata.json",
        "enrichment_cache": f"{own}enrichment_cache.json",
        "venues": f"{own}venues.json",
        "local_events": f"{own}local_events.yaml",
        "extras": f"{own}extras.yaml",
        "events": f"{pub}events.json",
        "social": f"{pub}social/latest/",
    }


def repo_path(key, town=None):
    """An absolute path to one of the town's files (town_paths key)."""
    return os.path.join(ROOT, town_paths(town)[key])


# The process's town.
TOWN = town_config()


def scheduled_towns(towns_dir=None, warn=None):
    """The towns the scheduled workflow runs cover (MULTI_CITY_PLAN.md 3.4):
    Victoria first, always, then each town in towns/index.json whose
    town.json says "workflows": true. That flag goes in with the town's
    GitHub Environment (3.3); until then its scheduled runs would use
    Victoria's repo-level settings. A missing or broken index or town.json
    is skipped (with a warning), never a reason to drop Victoria's run."""
    warn = warn or (lambda msg: None)
    base = towns_dir or os.path.join(ROOT, "towns")
    out = [VICTORIA["id"]]
    try:
        with open(os.path.join(base, "index.json"), encoding="utf-8") as f:
            listed = json.load(f).get("towns", [])
    except FileNotFoundError:
        return out
    except (OSError, ValueError, AttributeError) as e:
        warn(f"towns/index.json unreadable ({e}); running Victoria only")
        return out
    for slug in listed if isinstance(listed, list) else []:
        if not isinstance(slug, str) or slug in out or not re.match(r"^[a-z0-9-]+$", slug):
            continue
        try:
            with open(os.path.join(base, slug, "town.json"), encoding="utf-8") as f:
                raw = json.load(f)
            if raw.get("workflows") is not True:
                continue
            _complete(slug, dict(raw))
        except (OSError, ValueError, AttributeError) as e:
            warn(f"towns/{slug}/town.json skipped ({e})")
            continue
        out.append(slug)
    return out


if __name__ == "__main__":
    # `python3 town.py paths >> "$GITHUB_ENV"`: the workflows' file paths for
    # TOWN (TOWN_DIR, TOWN_CANDIDATES, TOWN_EVENTS, TOWN_SOCIAL…).
    # `python3 town.py scheduled`: the scheduled runs' towns as a JSON list.
    import sys
    if sys.argv[1:] == ["scheduled"]:
        print(json.dumps(scheduled_towns(warn=lambda m: print(f"::warning::{m}", file=sys.stderr))))
        sys.exit(0)
    if sys.argv[1:] != ["paths"]:
        sys.exit("usage: python3 town.py paths | scheduled")
    raw = os.environ.get("TOWN", "")
    if raw and raw != raw.strip().lower():
        # The workflows' concurrency groups and cache keys use the input as
        # typed: "Victoria" would run beside Victoria's own runs.
        sys.exit(f'TOWN="{raw}": use the lowercase slug, e.g. "{raw.strip().lower()}"')
    for k, v in town_paths().items():
        print(f"TOWN_{k.upper()}={v}")
