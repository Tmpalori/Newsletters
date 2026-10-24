"""Local business lead lists for sponsor outreach, from Openmart.

Up to 300 local businesses per town (its own area ZIPs, town.py
area_zips), spread over the categories the site sells (server/town.js
partnerCategories, plus venues, beauty and shops for featured events and the
weekly sponsor), each with an owner or decision-maker email where Openmart
has one. Venues the newsletter already lists (the town's venues.json) are
marked and kept: they are the warmest leads.

Stages, each cached under out/<town>/ so a re-run never pays twice:

    search     POST /api/v1/search, one page per category query    (credits)
    pick       offline: dedupe, drop chains, score, fill the quotas
    contacts   POST /api/v1/task/batch/find_people for the picks   (credits)
    emails     POST /api/v1/task/batch/lookup_business_email for
               picks with no verified person email (info@...)      (credits)
    export     offline: out/<town>/leads-<town>.csv and out/leads-all.csv

Nothing is sent without --go: a dry run prints what it would send. With
--go, the credit balance is printed before and after, and --max-spend
stops a stage once that many credits are gone.

The key: OPENMART_API_KEY in the environment, sent as a Bearer token. When
it isn't set, requests go out without one, for an environment whose network
secret adds it on the way out.

The lists are people's names and emails: out/ is gitignored and the CSVs
go to Tristen's Drive, never the repo. Openmart's API reference:
https://app.openmart.com/api-docs
"""
import argparse
import csv
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, REPO)

from town import town_config, town_paths  # noqa: E402

BASE = os.environ.get("OPENMART_BASE", "https://api.openmart.ai").rstrip("/")
OUT = os.environ.get("LEADS_OUT") or os.path.join(HERE, "out")

TOWNS = ("victoria", "medford", "shoals", "lincoln", "virginiabeach")
TARGET = 300
# Candidates fetched per slot: dedupe, chains and empty domains eat some.
OVERFETCH = 2
# A brand with more locations than this decides its marketing at head office.
MAX_STORES = 10
BATCH = 100   # Openmart's batch limit for the task endpoints

# (id, label, partner category id in server/town.js or None, quota, queries).
# Quotas add up to TARGET; a category that comes up short gives its slots to
# the best of the rest.
CATEGORIES = (
    ("food", "Food & drink", "food", 50,
     ("restaurant", "bar", "coffee shop", "bakery", "brewery", "winery")),
    ("entertainment", "Venues & fun", None, 20,
     ("event venue", "live music venue", "theater", "bowling alley", "escape room", "golf course")),
    ("home", "Home services", "home", 30,
     ("hvac contractor", "plumber", "roofing contractor", "electrician", "landscaping",
      "pest control", "pool service", "remodeling contractor")),
    ("realestate", "Real estate", "realestate", 25,
     ("real estate agency", "home builder", "mortgage lender", "title company", "property management")),
    ("auto", "Auto", "auto", 20,
     ("auto repair shop", "car dealership", "tire shop", "auto detailing", "collision repair")),
    ("insurance", "Insurance & finance", "insurance", 25,
     ("insurance agency", "financial advisor", "credit union", "bank", "accounting firm")),
    ("dental", "Dental", "dental", 20, ("dentist", "orthodontist", "pediatric dentist")),
    ("pets", "Pets", "pets", 20,
     ("veterinarian", "pet groomer", "pet store", "dog boarding", "dog trainer")),
    ("fitness", "Fitness", "fitness", 20,
     ("gym", "yoga studio", "pilates studio", "crossfit gym", "martial arts school")),
    ("family", "Family & kids", "family", 20,
     ("dance studio", "gymnastics", "tutoring center", "kids activity center", "trampoline park",
      "music lessons")),
    ("legal", "Legal", "legal", 15, ("law firm", "attorney")),
    ("beauty", "Beauty & wellness", None, 20,
     ("hair salon", "med spa", "day spa", "barber shop", "chiropractor")),
    ("shops", "Local shops", None, 15,
     ("boutique", "gift shop", "florist", "furniture store", "jewelry store")),
)
CATEGORY = {c[0]: c for c in CATEGORIES}

# Hosts many businesses share: a domain here says nothing about who owns
# the business, so find_people can't use it.
SHARED_HOSTS = {
    "facebook.com", "instagram.com", "linktr.ee", "google.com", "business.site", "yelp.com",
    "eventbrite.com", "wixsite.com", "godaddysites.com", "square.site", "squarespace.com",
    "weebly.com", "wordpress.com", "blogspot.com", "toasttab.com", "doordash.com",
    "ubereats.com", "grubhub.com", "linkedin.com", "tiktok.com", "x.com", "twitter.com",
    "youtube.com", "sites.google.com", "carrd.co", "myshopify.com", "vagaro.com",
    "booksy.com", "mindbodyonline.com", "statefarm.com", "allstate.com", "edwardjones.com",
    "farmers.com", "kw.com", "remax.com", "century21.com", "coldwellbanker.com",
    "coldwellbankerhomes.com", "exprealty.com", "bhhs.com", "compass.com", "realtor.com",
    "zillow.com", "getbento.com", "squareup.com", "wix.com", "webflow.io", "netlify.app", "github.io",
    "ueniweb.com",
}
# Zones whose subdomains belong to different owners: keep one label more.
SUFFIXES = {"food.coop"}

# Leads that aren't a business with a local owner (Tristen, Oct 2026: "we
# want stuff where the owner lives in that town"): public bodies, churches,
# chains. Ticket-selling arts groups and credit unions stay: they sell to
# locals and buy local promotion. overrides.json holds the calls the rules
# get wrong, by domain.
PUBLIC = re.compile(
    r"\blibrar|\buniversity\b|\bcollege\b|school district|public schools|parks? (and|&) rec|state park|"
    r"national (park|wildlife|heritage|historic|monument)|wildlife refuge|tourism|^visit |"
    r"convention (and|&) visitors|chamber of commerce|\bchamber\b|downtown \w+ association|"
    r"main street program|business district|creative district|arts council|\bnavy\b|campus recreation|"
    r"county fair|super fair|farmers market|growers|wine trail|wine country|^city of |county of |"
    r"\bymca\b|\bywca\b|humane society|animal shelter|\btnr\b|parks foundation")
RELIGIOUS = re.compile(r"church|cathedral|parish|chapel|ministr|synagogue|\btemple\b|mosque|episcopal|"
                       r"baptist|methodist|catholic|lutheran|presbyterian")
# A .org is taken for a nonprofit unless it sells tickets or is a credit union.
TICKETED = re.compile(r"theat(er|re)|museum|symphony|orchestra|ballet|festival|\bzoo\b|aquarium|"
                      r"performing arts|center for the arts|media arts|fine arts|art association|film|"
                      r"music|hall of fame|sound studio|\bfair\b|birthplace|repertory")
CREDIT_UNION = re.compile(r"credit union|\bfcu\b|federal credit")


def pitch(cat):
    """What to offer a business in this category first."""
    c = CATEGORY.get(cat)
    if cat == "listed":
        return "Featured events (already listed)"
    if c and c[2]:
        return f"Category partner: {c[1]}"
    if cat == "entertainment":
        return "Featured events"
    return "Weekly sponsor"


# --- the town ---------------------------------------------------------------

def area(slug):
    """The town's name, state and ZIPs, from town.py (Victoria's own dict,
    every other town's towns/<slug>/town.json)."""
    t = town_config(env={"TOWN": slug})
    return {"slug": slug, "site_name": t["site_name"], "city": t["city"], "state": t["state"],
            "zips": list(t["area_zips"]), "area_name": t["area_name"], "town": t}


def location(a):
    return [{"country": "US", "state": a["state"], "zip_code": a["zips"]}]


def listed_venues(a):
    """The venues the newsletter already follows: [{name, domain}]."""
    path = os.path.join(REPO, town_paths(a["town"])["venues"])
    try:
        with open(path) as f:
            rows = json.load(f)
    except (OSError, ValueError):
        return []
    return [{"name": v.get("name") or "", "domain": domain_of(v.get("website") or ""),
             "category": v.get("category") or ""} for v in rows if v.get("name")]


# --- normalizing ------------------------------------------------------------

def domain_of(url):
    """example.com from 'https://www.Example.com/menu'; '' for nothing usable
    (no host, or a host many businesses share)."""
    s = (url or "").strip().lower()
    s = re.sub(r"^[a-z]+:(//)?", "", s).split("/")[0].split("?")[0].split("#")[0].split(":")[0]
    s = s.split("@")[-1]
    if s.startswith("www."):
        s = s[4:]
    if "." not in s or " " in s:
        return ""
    if s in SHARED_HOSTS or any(s.endswith("." + h) for h in SHARED_HOSTS):
        return ""
    return registrable(s)


def registrable(host):
    """The domain one owner holds: florence.singingriverdentistry.com is
    singingriverdentistry.com, so a practice's locations count once."""
    parts = host.split(".")
    keep = 2
    if ".".join(parts[-2:]) in SUFFIXES or (len(parts[-1]) == 2 and parts[-2] in ("co", "com", "org", "net", "gov", "ac", "edu")):
        keep = 3
    return ".".join(parts[-keep:])


def overrides():
    """overrides.json: {"drop": {domain: why}, "keep": {domain: why}}."""
    return read_json(os.path.join(HERE, "overrides.json"), {}) or {}


def not_local(lead, rules=None):
    """Why a lead isn't a local business to sell to, or '' when it is."""
    rules = overrides() if rules is None else rules
    c, dom = lead["content"], lead["domain"]
    if dom in (rules.get("keep") or {}):
        return ""
    if dom in (rules.get("drop") or {}):
        return rules["drop"][dom]
    name = (c.get("business_name") or c.get("store_name") or "").lower()
    if dom.endswith((".gov", ".edu", ".mil")) or PUBLIC.search(name):
        return "public body or civic group"
    if RELIGIOUS.search(name):
        return "church"
    if c.get("ownership_type") == "CHAIN" and (c.get("num_stores") or 0) >= 3:
        return "chain"
    if dom.endswith(".org") and not (TICKETED.search(name) or CREDIT_UNION.search(name)):
        return "nonprofit"
    return ""


def name_key(name):
    """A loose key for matching a business name: lowercase words, no 'the',
    no punctuation, no LLC/Inc."""
    s = re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower().replace("&", " and "))
    words = [w for w in s.split() if w not in ("the", "llc", "inc", "co", "company")]
    return " ".join(words)


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# --- files ------------------------------------------------------------------

def town_dir(slug, *parts):
    p = os.path.join(OUT, slug, *parts)
    os.makedirs(p if not os.path.splitext(p)[1] else os.path.dirname(p), exist_ok=True)
    return p


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


# --- the API ----------------------------------------------------------------

class ApiError(Exception):
    pass


WHY = {401: "the API key is missing or wrong (OPENMART_API_KEY, or the environment's network secret)",
       402: "the account is out of credits",
       403: "this key or plan can't use that endpoint",
       422: "Openmart rejected the request body"}


def call(method, path, body=None, timeout=60, tries=3):
    """One Openmart request: JSON in, JSON out. Retries 429 and 5xx."""
    headers = {"Accept": "application/json"}
    key = os.environ.get("OPENMART_API_KEY", "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    for attempt in range(tries):
        req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read()[:500].decode("utf-8", "replace")
            if (e.code == 429 or e.code >= 500) and attempt < tries - 1:
                time.sleep(5 * 2 ** attempt)
                continue
            raise ApiError(f"{method} {path}: HTTP {e.code} ({WHY.get(e.code, 'error')}): {detail}")
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < tries - 1:
                time.sleep(5 * 2 ** attempt)
                continue
            raise ApiError(f"{method} {path}: {e}")


def balance():
    """The credit balance: (number or None, the raw response)."""
    raw = call("GET", "/api/v2/credit-balance")
    return credits_in(raw), raw


def credits_in(raw):
    """The remaining-credit number in a credit-balance response, whatever
    the field is called; None when there isn't an obvious one."""
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return raw
    if not isinstance(raw, dict):
        return None
    for k in ("remaining_credits", "credits_remaining", "remaining", "balance", "credit_balance",
              "credits", "available_credits"):
        v = raw.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return v
    for v in raw.values():
        if isinstance(v, dict):
            n = credits_in(v)
            if n is not None:
                return n
    return None


class Meter:
    """Credit balance before a stage, and a stop once --max-spend is gone."""

    def __init__(self, max_spend=None):
        self.start, raw = balance()
        self.max_spend = max_spend
        print(f"credits before: {self.start if self.start is not None else json.dumps(raw)}")
        if max_spend is not None and self.start is None:
            raise ApiError("--max-spend needs a numeric credit balance, and the response had none: "
                           + json.dumps(raw)[:300])

    def check(self):
        if self.max_spend is None:
            return
        now, _ = balance()
        if now is not None and self.start - now >= self.max_spend:
            raise ApiError(f"stopped: {self.start - now} credits spent, --max-spend {self.max_spend}")

    def done(self):
        now, raw = balance()
        spent = f" (spent {round(self.start - now, 2)})" if now is not None and self.start is not None else ""
        print(f"credits after: {now if now is not None else json.dumps(raw)}{spent}")


# --- search -----------------------------------------------------------------

def per_query(cat, override=None):
    """Results to ask for per query: enough candidates for the quota."""
    if override:
        return override
    _, _, _, quota, queries = CATEGORY[cat]
    return max(10, min(100, math.ceil(quota * OVERFETCH / len(queries))))


def search_plan(a, cats=None, override=None):
    """[(category, query, request body, cache path)] for a town."""
    plan = []
    for cat, *_rest in CATEGORIES:
        if cats and cat not in cats:
            continue
        for q in CATEGORY[cat][4]:
            body = {"query": q, "location": location(a), "has_website": True,
                    "max_locations": MAX_STORES, "limit": per_query(cat, override)}
            plan.append((cat, q, body, os.path.join(OUT, a["slug"], "search", f"{cat}__{slugify(q)}.json")))
    return plan


def cmd_search(a, args):
    plan = search_plan(a, args.category, args.per_query)
    todo = [p for p in plan if args.refresh or not os.path.exists(p[3])]
    rows = sum(p[2]["limit"] for p in todo)
    print(f"{a['site_name']}: {len(plan)} queries over {len(a['zips'])} ZIPs, {len(todo)} not cached, "
          f"up to {rows} records")
    if not args.go:
        for cat, q, body, _ in todo:
            print(f"  would search {cat:13} {q!r} limit {body['limit']}")
        print("dry run: nothing sent (add --go)")
        return
    meter = Meter(args.max_spend)
    try:
        for cat, q, body, path in todo:
            res = call("POST", "/api/v1/search", body)
            res = res.get("data", []) if isinstance(res, dict) else (res or [])
            town_dir(a["slug"], "search")
            write_json(path, {"category": cat, "query": q, "request": body, "results": res})
            print(f"  {cat:13} {q!r}: {len(res)}")
            meter.check()
    finally:
        meter.done()


# --- pick -------------------------------------------------------------------

def searched(slug):
    """Every cached search row for a town, one per business: its best
    (category, match score) and its record."""
    best = {}
    d = os.path.join(OUT, slug, "search")
    for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        page = read_json(os.path.join(d, name), {})
        for r in page.get("results") or []:
            bid = r.get("id")
            if not bid:
                continue
            score = r.get("match_score") or 0
            if bid not in best or score > best[bid]["match_score"]:
                best[bid] = {"id": bid, "category": page.get("category"), "query": page.get("query"),
                             "match_score": score, "content": r.get("content") or {}}
    return list(best.values())


def score(lead):
    """Established, well-reviewed businesses first; listed venues above all."""
    c = lead.get("content") or {}
    reviews = c.get("google_reviews_count") or 0
    rating = c.get("google_rating") or 0
    s = 10 * math.log10(1 + reviews) + (3 if rating >= 4.3 else 0)
    return s + (50 if lead.get("listed") else 0)


def pick(rows, venues, target=TARGET):
    """Up to target leads: no chains, one per domain, listed venues marked
    and kept, each category's quota from its best, then the best of the rest."""
    by_domain = {v["domain"]: v for v in venues if v["domain"]}
    by_name = {name_key(v["name"]): v for v in venues}
    seen, leads = set(), []
    for r in sorted(rows, key=lambda r: -score(r)):
        c = r["content"]
        dom = domain_of(c.get("root_domain") or c.get("website_url") or "")
        if not dom or (c.get("num_stores") or 1) > MAX_STORES or dom in seen:
            continue
        seen.add(dom)
        v = by_domain.get(dom) or by_name.get(name_key(c.get("business_name") or c.get("store_name")))
        leads.append(dict(r, domain=dom, listed=bool(v), source="openmart"))
    rules = overrides()
    # Venues the newsletter follows that the searches didn't turn up.
    found = {name_key(l["content"].get("business_name") or l["content"].get("store_name")) for l in leads}
    for v in venues:
        if v["domain"] and v["domain"] not in seen and name_key(v["name"]) not in found:
            seen.add(v["domain"])
            leads.append({"id": "venue:" + v["domain"], "category": "listed", "match_score": 0,
                          "content": {"business_name": v["name"], "website_url": "https://" + v["domain"]},
                          "domain": v["domain"], "listed": True, "source": "venues.json"})
    leads = [l for l in leads if not not_local(l, rules)]
    leads.sort(key=lambda l: -score(l))
    # Listed venues first; each fills a slot of its own category, and the
    # quotas shrink in step to the room left, so the categories with few
    # reviews (law, insurance, real estate) keep their share.
    chosen = [l for l in leads if l["listed"]][:target]
    quota = {c[0]: c[3] for c in CATEGORIES}
    for l in chosen:
        if quota.get(l["category"], 0) > 0:
            quota[l["category"]] -= 1
    room, wanted = target - len(chosen), sum(quota.values())
    if wanted > room:
        quota = {k: v * room // wanted for k, v in quota.items()}
    rest = []
    for l in leads:
        if l["listed"]:
            continue
        if quota.get(l["category"], 0) > 0:
            quota[l["category"]] -= 1
            chosen.append(l)
        else:
            rest.append(l)
    chosen += rest[:max(0, target - len(chosen))]
    chosen.sort(key=lambda l: -score(l))
    return chosen


def cmd_pick(a, args):
    rows = searched(a["slug"])
    venues = listed_venues(a)
    leads = pick(rows, venues, args.target)
    # What an earlier pick had that isn't a local business, and why.
    path = os.path.join(OUT, a["slug"], "picked.json")
    ids, rules = {l["id"] for l in leads}, overrides()
    left = read_json(os.path.join(OUT, a["slug"], "left_out.json"), []) or []
    known = {l["id"] for l in left}
    for l in read_json(path, []) or []:
        why = not_local(dict(l, domain=domain_of(l["domain"]) or l["domain"]), rules)
        if l["id"] not in ids and l["id"] not in known and why:
            left.append(dict(l, reason=why))
    write_json(town_dir(a["slug"], "left_out.json"), left)
    write_json(town_dir(a["slug"], "picked.json"), leads)
    counts = {}
    for l in leads:
        counts[l["category"]] = counts.get(l["category"], 0) + 1
    print(f"{a['site_name']}: {len(rows)} searched, {len(leads)} picked "
          f"({sum(l['listed'] for l in leads)} already listed, {len(left)} left out as not local): "
          + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])))


def picked(slug):
    leads = read_json(os.path.join(OUT, slug, "picked.json"))
    if leads is None:
        raise SystemExit(f"{slug}: no picked.json yet; run pick first")
    return leads


# --- async tasks (find_people, lookup_business_email) -------------------------

def find_people_task(lead, a, title, max_k, phone):
    c = lead["content"]
    return {"domain": lead["domain"], "company_name": c.get("business_name") or c.get("store_name") or "",
            "title": title, "max_k": max_k, "info_access": ["EMAIL", "PHONE"] if phone else ["EMAIL"],
            "city": c.get("city") or a["city"], "state": a["state"], "country": "US",
            "tracking_id": lead["id"]}


def business_email_task(lead, a):
    c = lead["content"]
    return {"domain": lead["domain"], "company_name": c.get("business_name") or c.get("store_name") or lead["domain"],
            "city": c.get("city") or a["city"], "state": a["state"], "country": "US",
            "tracking_id": lead["id"]}


def batches_file(slug, kind):
    return town_dir(slug, kind, "batches.json")


def submitted(slug, kind):
    """tracking ids already sent in a batch of this kind (paid for or on the way)."""
    return {t for b in read_json(batches_file(slug, kind), []) for t in b.get("tracking_ids", [])}


def chunks(items, n=BATCH):
    return [items[i:i + n] for i in range(0, len(items), n)]


def submit(slug, kind, endpoint, tasks, meter):
    """Send tasks in batches, recording each batch id the moment it's back."""
    path = batches_file(slug, kind)
    for chunk in chunks(tasks):
        res = call("POST", endpoint, chunk, timeout=120, tries=1)
        bid = (res or {}).get("batch_id")
        if not bid:
            raise ApiError(f"{endpoint}: no batch_id in {json.dumps(res)[:300]}")
        batches = read_json(path, [])
        batches.append({"batch_id": bid, "tracking_ids": [t["tracking_id"] for t in chunk],
                        "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "done": False})
        write_json(path, batches)
        print(f"  batch {bid}: {len(chunk)} tasks")
        meter.check()


def collect(slug, kind, wait=480):
    """Wait for this kind's open batches and save each completed task's
    result under out/<town>/<kind>/tasks/."""
    path = batches_file(slug, kind)
    batches = read_json(path, [])
    for b in batches:
        if b.get("done"):
            continue
        deadline = time.time() + wait
        while True:
            st = call("GET", f"/api/v1/task/batch/{b['batch_id']}/status") or {}
            if isinstance(st.get("status"), dict):   # shaped like the submit response
                st = st["status"]
            if st.get("batch_ready"):
                break
            if time.time() > deadline:
                print(f"  batch {b['batch_id']} still running ({st}); run the stage again later")
                break
            time.sleep(10)
        if not st.get("batch_ready"):
            continue
        ids = call("GET", f"/api/v1/task/batch/{b['batch_id']}/task_ids?status=COMPLETED") or []
        tdir = town_dir(slug, kind, "tasks")
        for tid in ids:
            tpath = os.path.join(tdir, f"{tid}.json")
            if not os.path.exists(tpath):
                write_json(tpath, call("GET", f"/api/v1/task/{tid}"))
        b["done"], b["completed"], b["errored"] = True, len(ids), st.get("errored", 0)
        write_json(path, batches)
        print(f"  batch {b['batch_id']}: {len(ids)} completed, {st.get('errored', 0)} errored")


def task_results(slug, kind):
    """{tracking id: data list} from the saved task results."""
    out = {}
    d = os.path.join(OUT, slug, kind, "tasks")
    for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        t = read_json(os.path.join(d, name), {}) or {}
        if t.get("tracking_id"):
            out.setdefault(t["tracking_id"], []).extend(t.get("data") or [])
    return out


def cmd_contacts(a, args):
    leads = picked(a["slug"])
    sent = submitted(a["slug"], "people")
    tasks = [find_people_task(l, a, args.title, args.max_k, args.phone) for l in leads if l["id"] not in sent]
    if args.limit is not None:
        tasks = tasks[:args.limit]   # picks are best-first
    print(f"{a['site_name']}: {len(leads)} picked, {len(sent)} already sent, {len(tasks)} to send "
          f"(max {args.max_k} per business, {'email + phone' if args.phone else 'email only'})")
    if not args.go:
        print("dry run: nothing sent (add --go)")
        return
    meter = Meter(args.max_spend)
    try:
        submit(a["slug"], "people", "/api/v1/task/batch/find_people", tasks, meter)
        collect(a["slug"], "people")
    finally:
        meter.done()


def best_email(people):
    """The person to write to: verified email first, then any email."""
    with_email = [p for p in people if (p.get("email") or {}).get("email")]
    with_email.sort(key=lambda p: not (p.get("email") or {}).get("verified"))
    return with_email


def cmd_emails(a, args):
    leads = picked(a["slug"])
    people = task_results(a["slug"], "people")
    sent = submitted(a["slug"], "business_emails")
    need = [l for l in leads if l["id"] not in sent and not free_emails(l["content"])
            and not any((p.get("email") or {}).get("verified") for p in people.get(l["id"], []))]
    if args.limit is not None:
        need = need[:args.limit]   # picks are best-first
    print(f"{a['site_name']}: {len(need)} picks with no verified person email and no email in the search to look up")
    if not args.go:
        print("dry run: nothing sent (add --go)")
        return
    meter = Meter(args.max_spend)
    try:
        submit(a["slug"], "business_emails", "/api/v1/task/batch/lookup_business_email",
               [business_email_task(l, a) for l in need], meter)
        collect(a["slug"], "business_emails")
    finally:
        meter.done()


# --- export -----------------------------------------------------------------

COLUMNS = ("town", "newsletter", "category", "pitch", "business", "website", "domain", "address", "city",
           "zip", "business_phone", "business_email", "google_rating", "google_reviews", "already_listed",
           "contact_name", "contact_title", "contact_email", "email_verified", "contact_phone",
           "contact_linkedin", "other_contacts", "staff_on_website", "facebook", "instagram",
           "openmart_id", "status", "notes")


def free_emails(c):
    """The emails a search record already carries (business_emails,
    store_emails): no lookup needed for these."""
    return [e for k in ("business_emails", "store_emails") for e in c.get(k) or [] if isinstance(e, str) and "@" in e]


def social(c, network):
    links = (c.get("social_media_links") or {}).get(network) or []
    return links[0] if links else ""


def rows_for(a, leads, people, shared):
    out = []
    for l in leads:
        c = l["content"]
        found = people.get(l["id"], [])
        ppl = best_email(found)
        # No email: still the person's name, title and LinkedIn, to write to info@ by name.
        top = ppl[0] if ppl else (found[0] if found else {})
        phones = [p.get("phone_number") for p in top.get("phones") or [] if p.get("valid") is not False]
        mail = [e.get("email") for e in shared.get(l["id"], []) if e.get("email")]
        mail += free_emails(c)
        cat = CATEGORY.get(l["category"])
        out.append({
            "town": a["slug"], "newsletter": a["site_name"],
            "category": cat[1] if cat else "Already in the newsletter", "pitch": pitch(l["category"]),
            "business": c.get("business_name") or c.get("store_name") or "",
            "website": c.get("website_url") or "", "domain": l["domain"],
            "address": c.get("street_address") or "", "city": c.get("city") or "", "zip": c.get("zipcode") or "",
            "business_phone": ", ".join(c.get("store_phones") or c.get("business_phones") or []),
            "business_email": ", ".join(dict.fromkeys(mail)),
            "google_rating": c.get("google_rating") or "", "google_reviews": c.get("google_reviews_count") or "",
            "already_listed": "yes" if l.get("listed") else "",
            "contact_name": " ".join(x for x in (top.get("first_name"), top.get("last_name")) if x),
            "contact_title": top.get("title") or "",
            "contact_email": (top.get("email") or {}).get("email") or "",
            "email_verified": "yes" if (top.get("email") or {}).get("verified") else ("no" if ppl else ""),
            "contact_phone": ", ".join(p for p in phones if p),
            "contact_linkedin": top.get("linkedin_url") or "",
            "other_contacts": "; ".join(
                f"{' '.join(x for x in (p.get('first_name'), p.get('last_name')) if x)} <{p['email']['email']}>"
                for p in ppl[1:]),
            "staff_on_website": "; ".join(
                f"{s['name']} ({s['role']})" if s.get("role") else s["name"]
                for s in c.get("staffs") or [] if isinstance(s, dict) and s.get("name")),
            "facebook": social(c, "FACEBOOK"), "instagram": social(c, "INSTAGRAM"),
            "openmart_id": "" if str(l["id"]).startswith("venue:") else l["id"],
            "status": "", "notes": "",
        })
    return out


def cmd_export(towns):
    every = []
    for slug in towns:
        a = area(slug)
        path = os.path.join(OUT, slug, "picked.json")
        if not os.path.exists(path):
            print(f"{slug}: nothing picked yet")
            continue
        rows = rows_for(a, read_json(path, []), task_results(slug, "people"), task_results(slug, "business_emails"))
        write_csv(os.path.join(OUT, slug, f"leads-{slug}.csv"), rows)
        every += rows
        named = sum(1 for r in rows if r["contact_email"])
        some = sum(1 for r in rows if r["contact_email"] or r["business_email"])
        print(f"{a['site_name']}: {len(rows)} leads, {named} with a person's email "
              f"({sum(r['email_verified'] == 'yes' for r in rows)} verified), {some} with any email")
    if every:
        write_csv(os.path.join(OUT, "leads-all.csv"), every)
        print(f"wrote {os.path.relpath(OUT, REPO)}/leads-all.csv ({len(every)} rows)")


def write_csv(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)


# --- CLI ----------------------------------------------------------------------

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("stage", choices=("balance", "search", "pick", "contacts", "emails", "export"))
    p.add_argument("--town", action="append", choices=TOWNS, help="repeatable; default every town")
    p.add_argument("--category", action="append", choices=[c[0] for c in CATEGORIES],
                   help="search only these (repeatable)")
    p.add_argument("--per-query", type=int, help="results per search query (default: from the quota)")
    p.add_argument("--target", type=int, default=TARGET, help=f"leads per town (default {TARGET})")
    p.add_argument("--title", default="Owner or decision maker", help="the role find_people looks for")
    p.add_argument("--max-k", type=int, default=1, help="contacts per business, 1-8 (default 1)")
    p.add_argument("--phone", action="store_true", help="ask for phones too (costs more)")
    p.add_argument("--limit", type=int, help="contacts, emails: send at most this many new lookups (best picks first)")
    p.add_argument("--max-spend", type=float, help="stop a stage once this many credits are spent")
    p.add_argument("--refresh", action="store_true", help="search again even when cached")
    p.add_argument("--go", action="store_true", help="really send (spends credits)")
    args = p.parse_args(argv)
    towns = args.town or list(TOWNS)
    if not 1 <= args.max_k <= 8:
        p.error("--max-k must be 1 to 8")
    sends = args.stage == "balance" or (args.go and args.stage in ("search", "contacts", "emails"))
    if sends and not os.environ.get("OPENMART_API_KEY"):
        print("note: OPENMART_API_KEY isn't set; sending without a key (an environment network "
              "secret for api.openmart.ai adds it)", file=sys.stderr)
    try:
        if args.stage == "balance":
            n, raw = balance()
            print(json.dumps(raw, indent=1))
        elif args.stage == "export":
            cmd_export(towns)
        else:
            for slug in towns:
                {"search": cmd_search, "pick": cmd_pick, "contacts": cmd_contacts,
                 "emails": cmd_emails}[args.stage](area(slug), args)
    except ApiError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
