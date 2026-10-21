#!/usr/bin/env python3
"""The newsletter's extra sections (sections.json; SECTIONS.md): what runs
under the events in Monday's and Thursday's issues and on the homepage.

Runs on the town's jobs worker (scripts/jobs_worker.py, job "sections")
Sunday and Wednesday evenings, after the collect, and again early Monday
and Thursday (--before-send) to catch a pet that got adopted. Builds:

  pet          the pet of the week, from the town's shelter listing: the
               one who has waited longest, has a real photo and wasn't
               featured in the last PET_REPEAT_WEEKS. The photo is copied
               (resized) into the file, so it never breaks in an inbox.
  new_in_town  places that just opened or are about to, from public
               business data. Readers see "Now open" or "Coming soon",
               never where we found it (the owner's call, Oct 2026).
  good_news    feel-good items from the city or county agenda (a park
               upgrade, the library, a festival, a proclamation). Anything
               about taxes, police, elections, zoning fights, lawsuits or
               bad news is left out: the newsletter is something people
               look forward to opening.
  roundup      Thursday's best reader answers to Monday's question (the
               replies the site saved, handed in by the worker).
  intro        the issue's one-line greeting, above its "In this issue"
               list (the --before-send runs, from the events the issue will
               show); the site checks any event it names is in the issue,
               or uses a plain one.

Then the editor pass: one AI call reads everything as an editor would
(positive, accurate to the source, no politics or bad news, no word of
permits or records, sounds like a person wrote it) and keeps, fixes or
drops each item, and the rules below check its work. Without
OPENAI_API_KEY only the pet runs (with a plain line): New in town, good
news and the roundup need the editor, so they're skipped.

    python3 scripts/sections.py --out sections.json [--previous prev.json]
        [--replies replies.json] [--before-send] [--today 2026-10-18]

Each source fails on its own: a shelter site that's down leaves the pet
out this week (the site shows the last one only while it's fresh), and
the rest still builds.
"""
import argparse
import base64
import hashlib
import html as htmlmod
import io
import json
import os
import re
import subprocess
import sys
import time
import tempfile
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import requests  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

import collect_events as ce  # noqa: E402
from town import TOWN, town_paths  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (compatible; local-newsletter-sections/1.0)"}
TIMEOUT = 30
PET_REPEAT_WEEKS = 8
PHOTO_MAX = 720          # px on the long side; plenty for a 600px email
NEW_DAYS = 60            # a place counts as new this long after it opens
NEW_MAX = 5
GOOD_NEWS_MAX = 4
ROUNDUP_MAX = 4
# The week a question belongs to: weeks since this Monday, mod the town's
# list (server/sections.js questionFor is the twin).
QUESTION_EPOCH = date(2026, 1, 5)

# Words that must never reach a reader: where New in town comes from, and
# shelter or AI tells. The editor is told; this makes sure.
SOURCE_WORDS = re.compile(
    r"\b(permits?|permitted|licen[sc]es?d?|licensing|filings?|filed|registrations?|registered|comptroller|"
    r"records?|data|database|data ?set|secretary of state|sales tax|naics|tenant build-?out|build-?out|certificate of occupancy|"
    r"plans? (?:were |was |have been |has been )?(?:approved|submitted|filed))\b", re.I)
AI_TELLS = re.compile(
    r"\b(furever|pawsome|purrfect|delve|tapestry|vibrant|bustling|nestled|hidden gem|elevate|embark|"
    r"look no further|whether you're|in the heart of|culinary journey|a must-visit|unforgettable|treat yourself|"
    r"something for everyone|jam-packed|don't miss|exciting lineup|plain[- ]english|in a nutshell|dive in|dive into|"
    r"rest assured|seamless|game-?changer|buckle up|without further ado)\b", re.I)
# Agenda words that mean it isn't feel-good news, whatever the AI thinks.
NOT_GOOD_NEWS = re.compile(
    r"\b(tax(es)?|levy|bond election|elect(ion|ions|ed)?|ballots?|vot(e|es|ed|ing|er|ers)|candidates?|campaign\w*|"
    r"republican\w*|democrat\w*|conservative|liberal|partisan|president\w*|governor|senator|congress\w*|legislat\w*|"
    r"abortion|immigra\w*|gun control|protest\w*|police|sheriff|arrest|crime|jail|lawsuit|litigation|settlement|"
    r"rezon\w*|zoning|annex\w*|eminent domain|condemn\w*|executive session|closed session|budget amendment|"
    r"layoffs?|terminat\w*|resign\w*|appeal|violation|fine[sd]?|penalt\w*|fatal\w*|death|died|shooting|fire department|"
    r"contamina\w*|demoli\w*|dilapidated|nuisance|short-term rental|data cent\w*|liquor|alcohol|beer|wine|"
    r"budget\w*|fees?|rate (?:increase|hike)s?|utility rates?|homeless\w*|encampment\w*|ceasefire|gaza|israel\w*|"
    r"palestin\w*|ukrain\w*|russia\w*|war|pride (?:month|parade|flag)|lgbt\w*|dei|diversity, equity)\b", re.I)
# For a pet, a reader's words and the greeting: politics and sad or bad
# news (narrower than NOT_GOOD_NEWS, which also keeps agenda items about
# fees or alcohol out: a reader's favorite patio beer is fine).
HARD_NO = re.compile(
    r"\b(elect(ion|ions|ed)?|ballots?|vot(e|es|ed|ing|er|ers)|candidates?|campaign\w*|republican\w*|democrat\w*|"
    r"conservative|liberal|partisan|president\w*|governor|senator|congress\w*|trump|biden|harris|abortion|immigra\w*|"
    r"gun control|protest\w*|police|sheriff|arrest\w*|crime|jail|lawsuit|shooting|murder\w*|killed|death|died|dead|"
    r"passed away|funeral|cancer|abandon\w*|neglect\w*|abus\w*|injur\w*|hit by|euthan\w*|surrender\w*|hoard\w*|"
    r"ceasefire|gaza|israel\w*|palestin\w*|ukrain\w*|war|homeless\w*)\b", re.I)
# Contact details have no place in print: a reply's signature, a phone.
CONTACT = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+|https?://|www\.|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b")


# ─── Settings ────────────────────────────────────────────────────────────

def load_config(town=None):
    """The town's sections settings: sections.json in its data folder
    (Victoria's at the repo root), or {} when it has none."""
    t = town or TOWN
    path = os.path.join(ROOT, town_paths(t)["dir"], "sections.json")
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def question_for(config, monday):
    qs = [q for q in (config.get("questions") or []) if isinstance(q, str) and q.strip()]
    if not qs:
        return None
    return qs[((monday - QUESTION_EPOCH).days // 7) % len(qs)]


def monday_of(d):
    return d - timedelta(days=d.weekday())


# ─── Small helpers ───────────────────────────────────────────────────────

def get(url, **kw):
    r = requests.get(url, headers={**UA, **kw.pop("headers", {})}, timeout=kw.pop("timeout", TIMEOUT), **kw)
    r.raise_for_status()
    return r


def clean(text):
    return re.sub(r"\s+", " ", htmlmod.unescape(str(text or ""))).strip()


SMALL = {"a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "de", "la", "del", "y"}
KEEP_UPPER = {"bbq", "llc", "usa", "ii", "iii", "iv", "atm", "tv", "diy", "ymca", "vfw"}


def title_case(name):
    """THE PIZZA PLACE → The Pizza Place (data comes in all caps); a name
    that already has lower case is left alone."""
    name = clean(name)
    if not name or any(c.islower() for c in name):
        return name
    words = []
    for i, w in enumerate(name.lower().split(" ")):
        if w in KEEP_UPPER:
            words.append(w.upper())
        elif i and w in SMALL:
            words.append(w)
        else:
            words.append("-".join(p[:1].upper() + p[1:] for p in w.split("-")))
    out = " ".join(words)
    return re.sub(r"(\w)'S\b", r"\1's", re.sub(r"\bMc(\w)", lambda m: "Mc" + m.group(1).upper(), out))


def business_name(name):
    """Petco #2464 → Petco; Jojo & Coco, LLC → Jojo & Coco."""
    n = title_case(name)
    n = re.sub(r"\s*#\s*\d+\s*$|\s+(store|unit|location)\s+\d+\s*$", "", n, flags=re.I)
    n = re.sub(r",?\s+(llc|l\.l\.c\.|inc\.?|corp\.?|co\.|ltd\.?|pllc|lp|llp)\s*$", "", n, flags=re.I)
    return n.strip(" ,.-")


DIRECTIONS = re.compile(r"\b(Ne|Nw|Se|Sw|N|S|E|W)\b(?=\s)")


def street_of(address):
    """1102 S MOODY ST → S Moody St: the street, not the number, so a
    reader can place it without it reading like a records lookup."""
    a = title_case(re.sub(r"\s+(ste|suite|unit|#)\s*\S+$", "", clean(address), flags=re.I))
    a = DIRECTIONS.sub(lambda m: m.group(1).upper(), a)
    return re.sub(r"^\d+[A-Za-z]?\s+", "", a)


def strip_dashes(text):
    # Em and en dashes read as AI to a lot of people; the house style is commas.
    return re.sub(r"\s*[—–]\s*", ", ", str(text or "")).strip(" ,")


def resize_photo(raw):
    """JPEG bytes, at most PHOTO_MAX px on the long side, as base64; None
    when the image can't be read (a shelter's broken link)."""
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(raw))
        im = im.convert("RGB")
        if min(im.size) < 160:
            return None   # a thumbnail or a placeholder icon
        # The email shows it full width: a tall phone photo would fill the
        # whole screen. Tall → a square from near the top (where the face
        # usually is); very wide → 3:2 from the middle.
        w, h = im.size
        if h > w:
            top = int((h - w) * 0.2)
            im = im.crop((0, top, w, top + w))
        elif w > h * 1.5:
            cut = (w - int(h * 1.5)) // 2
            im = im.crop((cut, 0, cut + int(h * 1.5), h))
        im.thumbnail((PHOTO_MAX, PHOTO_MAX))
        out = io.BytesIO()
        im.save(out, "JPEG", quality=82, optimize=True)
        return base64.b64encode(out.getvalue()).decode()
    except Exception as e:  # noqa: BLE001
        print(f"photo unreadable: {e}")
        return None


PLACEHOLDER_PHOTO = re.compile(r"photo-not-available|no_pic|nophoto|no-photo|placeholder|coming-soon|default", re.I)


# ─── Pets ────────────────────────────────────────────────────────────────
# Each reader returns [{id, name, species, breed, sex, age, photo_url, url,
# since (ISO date or None), bio (the shelter's own words or "")}], longest
# waiting first when the source says.

def pets_petpoint(src):
    """PetPoint's adoptable-search embed (Victoria County Animal Services)."""
    base = "https://ws.petango.com/webservices/adoptablesearch/"
    r = get(f"{base}wsAdoptableAnimals.aspx", params={
        "species": "All", "gender": "A", "agegroup": "All", "onhold": "A", "orderby": "ID", "colnum": "3",
        "authkey": src["authkey"]})
    soup = BeautifulSoup(r.text, "lxml")
    out = []
    for cell in soup.select("td.list-item"):
        name = cell.select_one(".list-animal-name")
        img = cell.select_one("img.list-animal-photo")
        if not name or not img:
            continue
        link = name.find("a")
        pid = clean((cell.select_one(".list-animal-id") or name).get_text())
        out.append({
            "id": f"pp-{pid}", "name": clean(name.get_text()),
            "species": clean((cell.select_one(".list-animal-species") or {}).get_text() if cell.select_one(".list-animal-species") else ""),
            "breed": clean(cell.select_one(".list-animal-breed").get_text()) if cell.select_one(".list-animal-breed") else "",
            "sex": clean(cell.select_one(".list-animal-sexSN").get_text()) if cell.select_one(".list-animal-sexSN") else "",
            "age": clean(cell.select_one(".list-animal-age").get_text()) if cell.select_one(".list-animal-age") else "",
            "photo_url": img.get("src") or "",
            "url": base + link["href"] if link and link.get("href") else src.get("url", ""),
            "since": None, "bio": "",
        })
    # Lower PetPoint ids came in earlier: longest waiting first.
    out.sort(key=lambda p: int(re.sub(r"\D", "", p["id"]) or 0))
    return out


def pets_shelterluv(src):
    """Shelterluv's public list (Southern Oregon Humane Society)."""
    d = get(f"https://new.shelterluv.com/api/v3/available-animals/{src['gid']}").json()
    out = []
    for a in d.get("animals") or []:
        # Photos come as objects (cover first) or, for some animals, bare URLs.
        raw = [p if isinstance(p, dict) else {"url": p} for p in a.get("photos") or [] if p]
        photos = [p.get("url") for p in sorted(raw, key=lambda p: (not p.get("isCover"), p.get("order_column") or 0)) if p.get("url")]
        since = None
        try:
            since = datetime.fromtimestamp(int(a.get("intake_date")), timezone.utc).date().isoformat()
        except (TypeError, ValueError):
            pass
        group = (a.get("age_group") or {}).get("name") or ""
        # "Bre - 042101U": a kennel code after the name isn't part of it.
        out.append({"id": f"sl-{a.get('uniqueId') or a.get('nid')}", "name": re.sub(r"\s+-\s+\w*\d\w*$", "", clean(a.get("name"))), "species": clean(a.get("species")),
                    "breed": clean(a.get("breed")), "sex": clean(a.get("sex")), "age": clean(group),
                    "photo_url": photos[0] if photos else "", "url": a.get("public_url") or src.get("url", ""),
                    "since": since, "bio": ""})
    out.sort(key=lambda p: p["since"] or "9999")
    return out


def pets_24petconnect(src):
    """24PetConnect (PetPoint's public site: Florence-Lauderdale, Jackson County OR)."""
    out = []
    for kind in src.get("types") or ["DOG", "CAT"]:
        r = get(f"https://24petconnect.com/{src['code']}", params={"at": kind})
        soup = BeautifulSoup(r.text, "lxml")
        for card in soup.select("div.gridResult"):
            def text(cls):
                el = card.select_one(f".text_{cls}")
                return clean(el.get_text()) if el else ""
            img = card.find("img")
            m = re.search(r"Result_(\w+)", card.get("id") or "")
            if not m:
                continue
            aid = m.group(1)
            since = None
            brought = text("Broughttotheshelter") or text("Intakedate")
            for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
                try:
                    since = datetime.strptime(brought, fmt).date().isoformat()
                    break
                except ValueError:
                    pass
            out.append({"id": f"24-{aid}", "name": title_case(re.sub(r"\s*\(\w+\)\s*$", "", text("Name"))), "species": text("Animaltype"),
                        "breed": text("Breed"), "sex": text("Gender"), "age": text("Age"),
                        "photo_url": requests.compat.urljoin("https://24petconnect.com/", (img.get("src") if img else "") or ""),
                        "url": f"https://24petconnect.com/{src['code']}/Details/{src.get('detail_code', src['code'])}/{aid}",
                        "since": since, "bio": ""})
    out.sort(key=lambda p: p["since"] or "9999")
    return out


def pets_capital_humane(src):
    """Capital Humane Society's own adoption app (Lincoln), with staff-written bios."""
    base = "https://webapps.capitalhumanesociety.org"
    soup = BeautifulSoup(get(f"{base}/adopt/").text, "lxml")
    out = []
    for card in soup.select("div.card[data-pet-id]"):
        pid = card.get("data-pet-id")
        name = card.select_one(".card-title")
        img = card.find("img")
        if not pid or not name:
            continue
        out.append({"id": f"chs-{pid}", "name": re.split(r"\s+-\s+", clean(name.get_text()))[0], "species": "", "breed": "",
                    "sex": "", "age": "", "photo_url": (img.get("src") or img.get("data-src") or "") if img else "",
                    "url": f"{base}/adopt/pet/{pid}/", "since": None, "bio": ""})
    # The detail page has the facts and the bio; only read a few (oldest ids first).
    out.sort(key=lambda p: int(re.sub(r"\D", "", p["id"]) or 0))
    for p in out[:12]:
        try:
            page = BeautifulSoup(get(p["url"]).text, "lxml")
        except requests.RequestException:
            continue
        body = clean(page.get_text(" "))
        for label, key in (("Breed", "breed"), ("Sex", "sex"), ("Age", "age"), ("Species", "species")):
            m = re.search(rf"\b{label}:?\s+([A-Za-z0-9 ,/()'-]{{2,40}}?)(?=\s+[A-Z][a-z]+:|\s{{2}}|$)", body)
            if m:
                p[key] = m.group(1).strip()
        m = re.search(r"Available since:?\s+([A-Z][a-z]+\.? \d{1,2},? \d{4})", body)
        if m:
            for fmt in ("%B %d, %Y", "%b. %d, %Y", "%b %d, %Y", "%B %d %Y"):
                try:
                    p["since"] = datetime.strptime(m.group(1).replace("Sept.", "Sep."), fmt).date().isoformat()
                    break
                except ValueError:
                    pass
        desc = page.select_one(".pet-description, .description, #description")
        if desc:
            p["bio"] = clean(desc.get_text(" "))[:900]
    return out


ADOPETS_API = "https://service.api.prd.adopets.app"


def pets_adopets(src):
    """Adopets (Virginia Beach Animal Care & Adoption Center): the session the
    shelter's own page opens, then its pet list."""
    s = requests.Session()
    s.headers.update(UA)
    r = s.post(f"{ADOPETS_API}/adopter/auth/session-request",
               json={"system_api_key": src["api_key"], "fingerprint": "local-newsletter", "json": {}}, timeout=TIMEOUT)
    r.raise_for_status()
    token = (r.json().get("data") or {}).get("access_key")
    r = s.post(f"{ADOPETS_API}/adopter/pet/find", headers={"Authorization": f"Bearer {token}"},
               json={"limit": 48, "organization_pet": {}, "shelter_uuid": src["shelter_uuid"], "origin_key": "IFRAME"}, timeout=TIMEOUT)
    r.raise_for_status()
    data = r.json().get("data") or {}
    rows = data.get("result") or data.get("pets") or (data if isinstance(data, list) else [])
    out = []
    today = date.today()
    for a in rows:
        pet = a.get("organization_pet") or a
        info = pet.get("pet") or pet
        stay = info.get("length_of_stay_days") or pet.get("length_of_stay_days")
        since = (today - timedelta(days=int(stay))).isoformat() if isinstance(stay, int) else None
        photo = info.get("picture") or pet.get("picture") or ""
        out.append({"id": f"ad-{info.get('code') or info.get('uuid') or pet.get('uuid')}", "name": title_case(info.get("name") or ""),
                    "species": clean(info.get("specie_name") or ""), "breed": clean(info.get("breed_primary_name") or ""),
                    "sex": {"MALE": "Male", "FEMALE": "Female"}.get(str(info.get("sex_key") or "").upper(), ""),
                    "age": str(info.get("age_key") or "").replace("_", " ").title(), "photo_url": photo,
                    "url": src.get("url", ""), "since": since, "bio": ""})
    out.sort(key=lambda p: p["since"] or "9999")
    return out


PETFINDER_QUERY = """query SearchAnimal($pagination: PaginationInfoInput!, $filters: AnimalSearchFiltersInput!) {
  searchAnimal(pagination: $pagination, sort: { field: "animal_type", order: "desc" }, filters: $filters) {
    totalCount
    animals { animalId animalName animalType primaryPhotoId meta { publishTime }
      physical { sex species breed { primary secondary mixed } age { value } } publicUrl { url } }
  }
}"""


def pets_petfinder(src):
    """Petfinder's public search, the one a shelter's own site embeds
    (Kearney Area Animal Shelter): the shelter's organization_id."""
    r = requests.post("https://psl.petfinder.com/graphql", timeout=TIMEOUT, headers={**UA, "Content-Type": "application/json"},
                      json={"query": PETFINDER_QUERY, "variables": {"isConsumer": True, "filters": {
                          "adoption_status": "adoptable", "organization_id": [src["organization_id"]]},
                          "pagination": {"fromPage": 0, "pageSize": 100}}})
    r.raise_for_status()
    out = []
    for a in (((r.json().get("data") or {}).get("searchAnimal") or {}).get("animals")) or []:
        phys = a.get("physical") or {}
        breed = phys.get("breed") or {}
        photo = a.get("primaryPhotoId")
        out.append({"id": f"pf-{a.get('animalId')}", "name": clean(a.get("animalName")), "species": clean(phys.get("species") or a.get("animalType")),
                    "breed": clean(" / ".join(b for b in (breed.get("primary"), breed.get("secondary")) if b) + (" mix" if breed.get("mixed") else "")),
                    "sex": clean(phys.get("sex")), "age": clean((phys.get("age") or {}).get("value")),
                    "photo_url": f"https://dbw3zep4prcju.cloudfront.net/{photo}" if photo else "",
                    "url": f"https://www.petfinder.com{(a.get('publicUrl') or {}).get('url')}/details" if (a.get("publicUrl") or {}).get("url") else src.get("url", ""),
                    "since": str((a.get("meta") or {}).get("publishTime") or "")[:10] or None, "bio": ""})
    out.sort(key=lambda p: p["since"] or "9999")
    return out


PET_READERS = {"petpoint": pets_petpoint, "shelterluv": pets_shelterluv, "24petconnect": pets_24petconnect,
               "capital_humane": pets_capital_humane, "adopets": pets_adopets, "petfinder": pets_petfinder}


def pick_pet(config, previous, today):
    """This week's pet, rotating between the town's shelters by week."""
    shelters = [s for s in (config.get("pets") or []) if s.get("source") in PET_READERS]
    if not shelters:
        return None
    recent = {p.get("id") for p in (previous.get("pet_history") or [])
              if p.get("date", "") >= (today - timedelta(weeks=PET_REPEAT_WEEKS)).isoformat()}
    week = (monday_of(today) - QUESTION_EPOCH).days // 7
    order = shelters[week % len(shelters):] + shelters[:week % len(shelters)]
    for shelter in order:
        try:
            pets = PET_READERS[shelter["source"]](shelter)
        except Exception as e:  # noqa: BLE001 - the next shelter, or no pet this week
            print(f"pets: {shelter.get('name')}: {e}")
            continue
        print(f"pets: {shelter.get('name')}: {len(pets)} listed")
        for p in pets:
            if p["id"] in recent or not p["name"] or not p["photo_url"] or PLACEHOLDER_PHOTO.search(p["photo_url"]):
                continue
            if re.search(r"\b(pending|adopted|on hold|hold)\b", p["name"], re.I):
                continue
            try:
                photo = resize_photo(get(p["photo_url"]).content)
            except requests.RequestException:
                photo = None
            if not photo:
                continue
            return {**p, "photo": photo, "shelter": shelter.get("name", ""), "shelter_address": shelter.get("address", ""),
                    "shelter_url": shelter.get("url", "")}
    return None


def pet_still_listed(pet, config):
    """Before the issue: is this week's pet still up for adoption?"""
    shelter = next((s for s in config.get("pets") or [] if s.get("name") == pet.get("shelter")), None)
    if not shelter:
        return True
    try:
        return any(p["id"] == pet["id"] for p in PET_READERS[shelter["source"]](shelter))
    except Exception as e:  # noqa: BLE001 - can't tell: keep it
        print(f"pets: recheck failed: {e}")
        return True


def pet_facts(p):
    bits = [b for b in (p.get("breed"), p.get("age"), p.get("sex")) if b and b.lower() not in ("unknown", "")]
    return " · ".join(bits)


def pet_plain_blurb(p):
    """The no-AI fallback, in the house voice."""
    kind = (p.get("species") or "pet").lower()
    kind = {"dog": "dog", "cat": "cat"}.get(kind, kind if kind in ("rabbit", "bird") else "pet")
    where = p.get("shelter") or "the shelter"
    return f"{p['name']} is waiting for a home at {where}. Stop by and say hi, or see more photos online."


# ─── New in town ─────────────────────────────────────────────────────────
# Each reader returns [{key, name, what, street, status ("open"|"soon"),
# raw (what the editor sees, never readers)}].

# Storefronts people want to hear about (NAICS prefixes): restaurants and
# cafes, food and drink shops, retail, salons and spas, gyms, fun.
NAICS_KEEP = ("7225", "7224", "4451", "4452", "4453", "4455", "4481", "4482", "4483", "4491", "4492",
              "4495", "4511", "4512", "4531", "4532", "4533", "4539", "4551", "4552", "4561", "4581",
              "4582", "4583", "4591", "4592", "4593", "4594", "4595", "4599", "8121", "7139", "7131", "7111", "7121")
NAICS_WHAT = {"722511": "restaurant", "722513": "restaurant", "722514": "buffet", "722515": "cafe and treats",
              "722410": "bar", "4451": "grocery", "4452": "specialty food shop", "4453": "liquor store",
              "4481": "clothing shop", "4482": "shoe store", "4483": "jewelry store", "4511": "hobby and sporting goods",
              "4512": "book and music shop", "4532": "gift shop", "4533": "resale shop", "4539": "shop",
              "4581": "clothing shop", "4582": "shoe store", "4583": "jewelry store", "4591": "sporting goods and hobby shop",
              "4592": "book store", "4593": "florist", "4594": "gift and novelty shop", "4595": "resale shop",
              "8121": "salon and spa", "71394": "gym", "7139": "fun spot", "7131": "family fun spot"}
RESIDENTIAL = re.compile(r"\b(apt|apartment|lot|trlr|trailer|#\s*\d+[a-z]?$)\b", re.I)


def what_of(naics):
    for n in (naics[:6], naics[:5], naics[:4]):
        if n in NAICS_WHAT:
            return NAICS_WHAT[n]
    return ""


def new_tx_comptroller(src, today):
    """Texas new sales-tax outlets (Victoria): open in the last NEW_DAYS."""
    since = (today - timedelta(days=NEW_DAYS)).isoformat()
    rows = get("https://data.texas.gov/resource/jrea-zgmq.json", params={
        "$where": f"outlet_county_code='{src['county_code']}' AND outlet_first_sales_date > '{since}'",
        "$order": "outlet_first_sales_date DESC", "$limit": "400"}).json()
    out, seen = [], set()
    for r in rows:
        naics = str(r.get("outlet_naics_code") or "")
        name, owner = clean(r.get("outlet_name")), clean(r.get("taxpayer_name"))
        addr = clean(r.get("outlet_address"))
        if not naics.startswith(NAICS_KEEP) or naics.startswith("722330"):
            continue
        # A person's own name as the "business" is a home seller.
        if r.get("taxpayer_organization_type") == "IS" and name.upper() == owner.upper():
            continue
        if RESIDENTIAL.search(addr) or (src.get("cities") and clean(r.get("outlet_city")).upper() not in src["cities"]):
            continue
        key = re.sub(r"\W", "", name.lower())
        if key in seen:
            continue
        seen.add(key)
        first = str(r.get("outlet_first_sales_date") or "")[:10]
        opened = first <= today.isoformat()
        # Its first day of sales: about when it opened (or plans to).
        when = {"opened": first} if opened else {"opens": first}
        out.append({"key": f"tx-{r.get('taxpayer_number')}-{r.get('outlet_number')}", "name": business_name(name),
                    "what": what_of(naics), "street": street_of(addr), "status": "open" if opened else "soon",
                    **(when if re.match(r"^\d{4}-\d{2}-\d{2}$", first) else {}),
                    "raw": f"{name} at {addr}, {clean(r.get('outlet_city'))}; NAICS {naics}; first sales {first}"})
    return out


def new_arcgis_permits(src, today):
    """Virginia Beach: commercial tenant build-outs that name the business."""
    since = (today - timedelta(days=NEW_DAYS)).strftime("%Y/%m/%d")
    d = get(src["url"], params={
        "where": f"ConstructionType='Commercial' AND PermitType='Building' AND ApplicationDate >= '{since}'",
        "outFields": "PermitNumber,WorkDesc,StreetAddress,ApplicationDate,IssueDate", "returnGeometry": "false",
        "orderByFields": "ApplicationDate DESC", "resultRecordCount": "300", "f": "json"}).json()
    out = []
    for f in d.get("features") or []:
        a = f.get("attributes") or {}
        desc = clean(a.get("WorkDesc"))
        m = re.search(r"NEW TENANT BUILD[- ]?OUT\s*[-:]\s*(?:FOR\s+)?[\"']?(.+?)[\"']?\s*(?:/|-\s*USE GROUP|USE GROUP|$)", desc, re.I)
        if not m:
            continue
        name = re.sub(r"\s*\(.*?\)\s*$", "", m.group(1)).strip(" \"'-")
        group = re.search(r"USE GROUP\s*([A-Z]-?\d?)", desc, re.I)
        g = (group.group(1).upper() if group else "")
        what = {"A-2": "restaurant", "M": "shop", "A-3": "fun spot", "B": ""}.get(g.replace("A2", "A-2"), "")
        if g.startswith("B") and not src.get("offices"):
            continue  # offices and clinics
        if len(name) < 3:
            continue
        out.append({"key": f"vb-{a.get('PermitNumber')}", "name": business_name(name), "what": what,
                    "street": street_of(a.get("StreetAddress")), "status": "soon", "raw": f"{desc} at {a.get('StreetAddress')}"})
    return out


RIBBON_AHEAD_DAYS = 21


def new_growthzone_ribbons(src, today):
    """A chamber's GrowthZone calendar (Shoals): last month's and this
    month's ribbon cuttings, and the next three weeks' (a grand opening
    coming up), each with its date."""
    out = []
    first = today.replace(day=1)
    months = {first, (first - timedelta(days=1)).replace(day=1), (first + timedelta(days=32)).replace(day=1)}
    ahead = (today + timedelta(days=RIBBON_AHEAD_DAYS)).isoformat()
    for m in sorted(months):
        # The month goes in the path (?calendarMonth= is ignored: always this month).
        page = get(f"{src['base']}/events/calendar/{m.isoformat()}").text
        # Each day's cell: its date link, then that day's events.
        for day, cell in re.findall(r'/events/index/(\d{4}-\d{2}-\d{2})"[^>]*>\s*\d+\s*</a>\s*<ul>(.*?)</ul>', page, re.S):
            if day > ahead:
                continue
            # Chambers name them "Ribbon Cutting ..." or, like Kearney's, "RC - ...".
            slug = src.get("slug") or "ribbon-cutting"
            for href, label in re.findall(rf'href="([^"]*/events/details/(?:{slug})-[^"]+)"[^>]*>(.*?)</a>', cell, re.I | re.S):
                name = clean(htmlmod.unescape(re.sub(r"<[^>]+>", " ", label)))
                name = re.sub(r"^(?:ribbon[- ]cutting(?:\s*ceremony)?|rc)\b(?:\s*(?:&|and)\s*[\w ]+?\s*[-–—:])?\s*[:\-–—]?\s*(?:for|at)?\s*",
                              "", name, flags=re.I)
                if not name:
                    continue
                out.append({"key": f"gz-{href.split('?')[0].rsplit('-', 1)[-1]}", "name": business_name(name), "what": "", "street": "",
                            "status": "open" if day <= today.isoformat() else "soon", "grand_opening": day,
                            "raw": f"ribbon cutting {day}: {name} ({href})"})
    seen, uniq = set(), []
    for x in out:
        if x["key"] not in seen:
            seen.add(x["key"])
            uniq.append(x)
    return uniq


def new_city_pdf(src, today):
    """Medford's monthly new business license list (a PDF linked from the
    city's page): commercial, food and liquor only."""
    page = get(src["index"]).text
    links = re.findall(r'href="([^"]+new-business-license[^"]*\.pdf)"', page, re.I)
    if not links:
        return []
    url = requests.compat.urljoin(src["index"], links[0])
    text = pdf_text(get(url).content)
    out = []
    for line in text.splitlines():
        m = re.match(r"\s*\S+\s{2,}(.+?)\s{2,}(\d+.+?)\s{2,}([A-Z .]+?)\s{2,}OR\s+\d{5}.*?(COMMERCIAL|FOOD VENDOR|LIQUOR)\s*$", line)
        if not m:
            continue
        name, addr, city, kind = (clean(x) for x in m.groups())
        if src.get("cities") and city.upper() not in src["cities"]:
            continue
        slug = re.sub(r"\W", "", name.lower())[:40]
        out.append({"key": f"md-{slug}", "name": business_name(name),
                    "what": "restaurant" if kind == "FOOD VENDOR" else "", "street": street_of(addr), "status": "open",
                    "raw": line.strip()})
    return out


def new_news_rss(src, today):
    """Local news headlines about openings (Lincoln): candidates only; the
    editor keeps the ones that really name a new place."""
    out = []
    for n, feed in enumerate(src["feeds"]):
        if n:
            import time
            time.sleep(3)   # the paper's feeds answer 429 to quick repeats
        try:
            xml = get(feed).text
        except requests.RequestException as e:
            print(f"new in town: feed failed: {e}")
            continue
        for item in re.findall(r"<item>(.*?)</item>", xml, re.S):
            title = clean(re.sub(r"<!\[CDATA\[|\]\]>", "", (re.search(r"<title>(.*?)</title>", item, re.S) or [None, ""])[1]))
            descr = clean(re.sub(r"<[^>]+>", " ", re.sub(r"<!\[CDATA\[|\]\]>", "", (re.search(r"<description>(.*?)</description>", item, re.S) or [None, ""])[1])))
            when = (re.search(r"<pubDate>(.*?)</pubDate>", item) or [None, ""])[1]
            try:
                if datetime.strptime(when[:16], "%a, %d %b %Y").date() < today - timedelta(days=30):
                    continue
            except ValueError:
                pass
            if not re.search(r"\b(open(s|ing|ed)?|coming|new|debut|grand opening|moves? to)\b", title, re.I):
                continue
            if re.search(r"\b(clos(e|es|ed|ing)|shut|layoffs?|bankrupt|fire|crash|police|arrest)\b", title, re.I):
                continue
            slug = re.sub(r"\W", "", title.lower())[:50]
            out.append({"key": f"rss-{slug}", "name": "", "what": "", "street": "",
                        "status": "", "raw": f"headline: {title} | {descr[:300]}"})
    return out


def new_oregon_sos(src, today):
    """Oregon's new registrations last month (Medford area): assumed business
    names and companies at a principal place of business in the area."""
    cities = "', '".join(c.upper() for c in src["cities"])
    rows = get("https://data.oregon.gov/resource/esjy-u4fc.json", params={
        "$where": f"upper(city) in ('{cities}') AND associated_name_type='PRINCIPAL PLACE OF BUSINESS'",
        "$limit": "1000"}).json()
    out, seen = [], set()
    for r in rows:
        name, addr = clean(r.get("business_name")), clean(r.get("address_"))
        key = re.sub(r"\W", "", business_name(name).lower())
        if not key or key in seen or RESIDENTIAL.search(addr) or re.search(r"\b(po box|p\.o\.)", addr, re.I):
            continue
        # Holding companies named for an address, and trades nobody walks into.
        if re.match(r"^\d", name) or re.search(r"\b(holdings?|properties|investments?|capital|consulting|construction|roofing|"
                                              r"plumbing|electric|trucking|transport|cleaning|clean|lawn|landscap\w*|painting|"
                                              r"handyman|remodel\w*|services?|solutions|enterprises?|group|trust|ventures?)\b", name, re.I):
            continue
        seen.add(key)
        out.append({"key": f"or-{r.get('registry_number')}", "name": business_name(name), "what": "", "street": street_of(addr),
                    "status": "", "raw": f"{name} at {addr}, {clean(r.get('city'))}; {clean(r.get('entity_type'))}"})
    return out


NEW_READERS = {"oregon_sos": new_oregon_sos, "tx_comptroller": new_tx_comptroller, "arcgis_permits": new_arcgis_permits,
               "growthzone_ribbons": new_growthzone_ribbons, "city_pdf": new_city_pdf, "news_rss": new_news_rss}


def build_new_in_town(config, previous, today):
    src = config.get("new_in_town") or {}
    reader = NEW_READERS.get(src.get("source"))
    if not reader:
        return []
    try:
        items = reader(src, today)
    except Exception as e:  # noqa: BLE001
        print(f"new in town: {e}")
        return []
    # Shown before: not again for NEW_DAYS (a place is only "new" once).
    shown = {k for k, d in (previous.get("new_shown") or {}).items() if d >= (today - timedelta(days=NEW_DAYS)).isoformat()}
    items = [x for x in items if x["key"] not in shown]
    print(f"new in town: {len(items)} candidates")
    # The editor reads them all at once; a big month (Oregon) is cut to the newest.
    return items[:40]


# ─── Good news from city hall ────────────────────────────────────────────

def pdf_text(raw, pages=6):
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(raw)
        f.flush()
        try:
            return subprocess.run(["pdftotext", "-layout", "-l", str(pages), f.name, "-"], capture_output=True,
                                  text=True, timeout=60).stdout
        except (OSError, subprocess.TimeoutExpired) as e:
            print(f"pdftotext: {e}")
            return ""


def agenda_civicclerk(src, today):
    """CivicClerk's public API (Victoria County Commissioners Court)."""
    api = f"https://{src['client']}.api.civicclerk.com/v1"
    start = (today - timedelta(days=4)).isoformat()
    end = (today + timedelta(days=10)).isoformat()
    events = get(f"{api}/Events", params={"$filter": f"startDateTime gt {start}T00:00:00Z and startDateTime lt {end}T00:00:00Z",
                                           "$orderby": "startDateTime"}).json().get("value") or []
    out = []
    for ev in events:
        aid = ev.get("agendaId")
        if not aid:
            continue
        try:
            m = get(f"{api}/Meetings/{aid}").json()
        except requests.RequestException:
            continue
        items = []

        def walk(nodes):
            for n in nodes or []:
                t = clean(n.get("agendaObjectItemName") or n.get("name") or "")
                if t:
                    items.append(t)
                walk(n.get("childItems") or n.get("items"))
        walk(m.get("items") or m.get("agendaItems"))
        when = str(ev.get("startDateTime") or "")[:10]
        out.append({"body": src.get("body", "County"), "date": when, "items": items[:80],
                    "url": f"https://{src['client']}.portal.civicclerk.com/event/{ev.get('id')}/overview"})
    return out


def agenda_pdf_url(src, today):
    """An agenda PDF at a fixed address, replaced before each meeting (Virginia Beach)."""
    r = get(src["url"])
    text = pdf_text(r.content)
    return [{"body": src.get("body", "City Council"), "date": src.get("date") or "", "text": text[:12000], "url": src["url"]}]


def agenda_granicus(src, today):
    """Granicus agenda RSS → the newest upcoming agenda's PDF (Florence)."""
    xml = get(f"https://{src['client']}.granicus.com/ViewPublisherRSS.php", params={"view_id": src.get("view_id", 1), "mode": "agendas"}).text
    out = []
    for item in re.findall(r"<item>(.*?)</item>", xml, re.S)[:3]:
        title = clean((re.search(r"<title>(.*?)</title>", item, re.S) or [None, ""])[1])
        link = clean((re.search(r"<link>(.*?)</link>", item, re.S) or [None, ""])[1])
        if not link or not re.search(src.get("match", "Council"), title, re.I):
            continue
        r = get(link, allow_redirects=False)
        hops = 0
        while (r.is_redirect or r.status_code in (301, 302, 303, 307, 308)) and hops < 5:
            hops += 1
            nxt = requests.compat.urljoin(link, r.headers.get("Location", ""))
            nxt = re.sub(r"^https://([a-z0-9_]+_[a-z0-9_]+)\.s3\.amazonaws\.com/", r"https://s3.amazonaws.com/\1/", nxt)
            link, r = nxt, get(nxt, allow_redirects=False)
        text = pdf_text(r.content) if r.content[:4] == b"%PDF" else clean(BeautifulSoup(r.text, "lxml").get_text(" "))
        out.append({"body": src.get("body", "City Council"), "date": "", "title": title, "text": text[:12000], "url": link})
        break
    return out


def agenda_municode(src, today):
    """Municode Meetings (Tupelo): the newest council agenda PDF on the
    city's publish page, from the last week or ahead."""
    page = get("https://meetings.municode.com/PublishPage/index", params={"cid": src["cid"], "ppid": src["ppid"], "p": 1}).text
    best = None
    for url, title, when in re.findall(r'u=(https://[^&"]+/MEET-Agenda-[^&"]+\.pdf)&n=Agenda-([^"]*?)-([A-Z][a-z]+ \d{1,2}, \d{4})', page):
        title = clean(htmlmod.unescape(requests.utils.unquote(title)))
        if not re.search(src.get("match", "City Council"), title, re.I):
            continue
        try:
            day = datetime.strptime(when, "%B %d, %Y").date()
        except ValueError:
            continue
        if day >= today - timedelta(days=7) and (best is None or day > best[0]):
            best = (day, url, title)
    if not best:
        return []
    day, url, title = best
    r = get(url)
    text = pdf_text(r.content) if r.content[:4] == b"%PDF" else ""
    return [{"body": src.get("body", "City Council"), "date": day.isoformat(), "title": title, "text": text[:12000], "url": url}] if text else []


def agenda_cablecast(src, today):
    """LNKTV's caption text of the last council meeting (Lincoln)."""
    shows = get(f"{src['api']}/shows", params={"search": src.get("search", "council"), "page_size": 3, "include": "vod"}).json()
    vods = {v.get("id"): v for v in shows.get("vods") or []}
    out = []
    for sh in shows.get("shows") or []:
        title = clean(sh.get("title") or sh.get("cgTitle"))
        if not re.search(src.get("match", "City Council"), title, re.I):
            continue
        for vid in sh.get("vods") or []:
            v = vods.get(vid) or {}
            url = (v.get("url") or "").rstrip("/")
            if not url:
                continue
            slug = url.split("/vod/")[-1].split("/")[0]
            try:
                text = get(f"{src['transcripts']}/vod/{slug}/transcript.en.txt").text
            except requests.RequestException:
                continue
            out.append({"body": src.get("body", "City Council"), "date": "", "title": title,
                        "text": re.sub(r"\d\d:\d\d:\d\d[.,]\d+\s*-->\s*\S+|\[\d\d:\d\d:\d\d\]", " ", text)[:20000],
                        "url": src.get("page", "")})
            return out
    return out


AGENDA_READERS = {"civicclerk": agenda_civicclerk, "pdf_url": agenda_pdf_url, "granicus": agenda_granicus,
                  "cablecast": agenda_cablecast, "municode": agenda_municode}


def build_agendas(config, today):
    out = []
    for src in (config.get("good_news") or {}).get("sources") or []:
        reader = AGENDA_READERS.get(src.get("source"))
        if not reader:
            continue
        try:
            got = reader(src, today)
            print(f"good news: {src.get('body')}: {len(got)} agenda(s), {sum(len(a.get('items') or []) or len(a.get('text') or '') // 400 for a in got)} items/pages")
            out += got
        except Exception as e:  # noqa: BLE001
            print(f"good news: {src.get('body')}: {e}")
    return out


# ─── The AI writer and editor ────────────────────────────────────────────

VOICE = """House voice: a friendly local who knows the town, writing a short note to neighbors. Plain words, short sentences, warm but not gushing. No em dashes or en dashes (use commas or periods). At most one exclamation point in a whole section. Never use: furever, pawsome, purrfect, delve, tapestry, vibrant, bustling, nestled, hidden gem, elevate, embark, look no further, whether you're, in the heart of, culinary journey, must-visit, unforgettable, treat yourself, plain English, in a nutshell, dive in, rest assured, seamless, game changer, buckle up. Don't start with "Meet". Don't invent anything that isn't in the facts given (no personality traits, menus, hours or prices that aren't there)."""

WRITE_PROMPT = """You write three small sections of <<SITE>>, a free local newsletter for <<PLACE>> that people look forward to opening. Everything you write must make readers feel good about their town.

<<VOICE>>

You get JSON with:
- "pet": a shelter animal (facts and maybe the shelter's own bio). Write "blurb": two short sentences, 30 words at most. Use only the facts and the bio. If the bio has a real detail (loves fetch, shy at first), use it in your own words. Never say how long the pet has waited.
- "new_places": candidate businesses that just opened or are coming soon, with raw notes. For each one that is a real place a local would walk into (a restaurant, cafe, shop, salon, gym, fun spot), return {"key", "name" (the business name as people would say it, proper capitalization, no LLC/Inc), "line" (one short sentence, 14 words at most, about what it is and roughly where, e.g. "Filipino food, now open on Zac Lentz Parkway.")}. Skip anything that looks like a home business, an office, a contractor, a holding company, a gas station, a chain store's ordinary new register, a liquor or vape shop, a person's name, or anything you can't tell. The raw notes are private: NEVER mention permits, licenses, filings, registrations, records, data, taxes, build-outs or where the information came from. Use "now open" or "coming soon" only as the notes support (status "open" or "soon"; a headline that says it opened means open).
- "agendas": the city or county's upcoming meeting agendas. Pick at most <<GOOD_MAX>> items that are plainly good news for residents: a park, trail, pool, playground or library improvement, a festival or event the city is backing, a grant for something people will enjoy, a proclamation honoring someone or celebrating a week or group, a new public amenity. NEVER pick anything about taxes, budgets, fees, police, sheriff, jail, courts, elections, voting, zoning, rezoning, annexation, apartments or housing fights, short-term rentals, data centers, lawsuits, settlements, personnel, contracts for routine services, utilities rates, alcohol licenses, or anything that could start an argument. Each item is {"title" (2 to 4 words), "line" (one sentence, 22 words at most: what is on the agenda and what it means for residents, in plain words, as a neutral update; don't call it good news or great news; say "is on the agenda" or "would", never claim it passed)}. Return an empty list when nothing qualifies; that's fine and common.
- "replies": every email readers sent us this week; "question" is this week's question. Readers reply for all kinds of reasons (event tips, corrections, questions for us, thanks), so use only replies that actually answer the question. One with "answer": true was sent with the issue's answer button, so it is meant as an answer; a plain reply counts only if its words clearly answer the question. Pick at most <<ROUNDUP_MAX>> answers that are fun, kind and specific. Skip anything negative about a business or person, anything political, rude, a sales pitch, or that shares private details. Lightly trim each to 25 words at most, keep the reader's own words and voice, fix only obvious typos, never add words. Return {"i" (the reply's index), "quote", "name" (their first name only, or "" if unknown)}.

Return only JSON: {"pet": {"blurb": "..."} or null, "new_places": [...], "good_news": [...], "roundup": [...]}"""

EDIT_PROMPT = """You are the editor of <<SITE>>, a free local newsletter for <<PLACE>>. Before anything is published, you read it the way a careful human editor would. The newsletter's rules:
1. Every item must make readers feel good about their town. No politics, no crime, no bad news, nothing that could start an argument, nothing negative about any business or person.
2. New in town items must never hint at where we learned about them: no mention of permits, licenses, filings, registrations, records, data, taxes or construction paperwork.
3. Facts must match the source notes exactly. Nothing invented (no menus, hours, prices, traits or claims that aren't in the notes).
4. It must sound like a friendly local person wrote it, not AI. <<VOICE>>
5. Names spelled and capitalized the way the business or pet would write them. No "LLC", "Inc" or all caps.
6. Nothing a reader could mistake for an ad we were paid for (no "best", "#1", "don't miss" about a business).

You get the drafted items with their source notes. For each item return {"id", "verdict": "keep" | "fix" | "drop", "text" (the corrected text when "fix"), "why" (a few words)}. Use "drop" for anything that breaks rule 1, 2 or 3 and can't be fixed by rewording, or that a reader wouldn't care about. Return only a JSON array."""


def _fill(prompt):
    place = TOWN.get("city_state_long") or TOWN.get("city_state") or TOWN["city"]
    return (prompt.replace("<<SITE>>", TOWN["site_name"]).replace("<<PLACE>>", place).replace("<<VOICE>>", VOICE)
            .replace("<<GOOD_MAX>>", str(GOOD_NEWS_MAX)).replace("<<ROUNDUP_MAX>>", str(ROUNDUP_MAX)))


AI_TIMEOUT = 120
AI_BUDGET = 7 * 60     # past this, no new AI call (the worker stops the job at 10 minutes)
_STARTED = time.monotonic()
AI_PROBLEMS = []       # what went wrong with the AI this run (the Slack note says so)


def ai_json(api_key, system, user, max_tokens=6000):
    if time.monotonic() - _STARTED > AI_BUDGET:
        AI_PROBLEMS.append("out of time for the AI")
        print("AI: out of time this run; skipping the call")
        return None
    try:
        content = ce._openai_chat(api_key, [{"role": "system", "content": system}, {"role": "user", "content": user}],
                                  max_tokens=max_tokens, timeout=AI_TIMEOUT)
    except Exception as e:  # noqa: BLE001
        AI_PROBLEMS.append(f"the AI call failed ({type(e).__name__})")
        print(f"AI call failed: {e}")
        return None
    text = content.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1)
    # The one that opens first is the outer one: a one-item array
    # ([{...}]) must come back as a list, not its inner dict.
    pairs = sorted((("{", "}"), ("[", "]")), key=lambda p: (text.find(p[0]) == -1, text.find(p[0])))
    for opener, closer in pairs:
        i, j = text.find(opener), text.rfind(closer)
        if i != -1 and j > i:
            try:
                return json.loads(text[i:j + 1])
            except json.JSONDecodeError:
                continue
    AI_PROBLEMS.append("the AI answered with something unreadable")
    print(f"AI: unreadable answer: {content[:300]!r}")
    return None


def _dicts(x):
    """The dict items of a list the AI wrote; anything else is ignored."""
    return [v for v in x if isinstance(v, dict)] if isinstance(x, list) else []


def _key(text):
    return hashlib.sha1(str(text).encode()).hexdigest()[:8]


# The issue's "Send my answer" button sets this subject (server/newsletter.js ANSWER_SUBJECT).
ANSWER_SUBJECT = re.compile(r"^\s*((re|fwd?):\s*)*my answer:", re.I)


def is_answer(reply):
    return bool(ANSWER_SUBJECT.match(str(reply.get("subject") or "")))


def draft(api_key, pet, places, agendas, replies, question):
    """The AI's drafts, or the plain templates without a key."""
    ask = {
        "pet": {k: pet[k] for k in ("name", "species", "breed", "sex", "age", "bio", "shelter")} if pet else None,
        "new_places": [{k: x[k] for k in ("key", "name", "what", "street", "status", "raw")} for x in places],
        "agendas": [{"body": a["body"], "date": a.get("date", ""), "items": a.get("items"), "text": (a.get("text") or "")[:9000]} for a in agendas],
        "question": question or "",
        "replies": [{"i": i, "from": r.get("name", ""), "answer": is_answer(r), "text": (r.get("text") or "")[:600]} for i, r in enumerate(replies)],
    }
    if not api_key:
        return {"pet": {"blurb": pet_plain_blurb(pet)} if pet else None,
                "new_places": [], "good_news": [], "roundup": []}
    got = ai_json(api_key, _fill(WRITE_PROMPT), json.dumps(ask, ensure_ascii=False))
    if not isinstance(got, dict):
        return {"pet": {"blurb": pet_plain_blurb(pet)} if pet else None, "new_places": [], "good_news": [], "roundup": []}
    # Whatever shape the AI sent back, only the parts we expect go on.
    return {"pet": got.get("pet") if isinstance(got.get("pet"), dict) else None,
            "new_places": _dicts(got.get("new_places")), "good_news": _dicts(got.get("good_news")),
            "roundup": _dicts(got.get("roundup"))}


def rule_problems(text, kind):
    """What the rules won't let through, whatever the editor said."""
    t = str(text or "")
    probs = []
    if kind in ("place", "good") and SOURCE_WORDS.search(t):
        probs.append("mentions where it came from")
    if AI_TELLS.search(t):
        probs.append("sounds like AI")
    if kind in ("good", "question") and NOT_GOOD_NEWS.search(t):
        probs.append("not good news")
    if kind in ("pet", "reply", "intro", "place", "name") and HARD_NO.search(t):
        probs.append("politics or sad news")
    if kind in ("reply", "place", "good", "pet", "intro", "question", "name") and CONTACT.search(t):
        probs.append("contact details")
    if kind == "question" and (not t.rstrip().endswith("?") or len(t) > 120):
        probs.append("not a short question")
    if len(t) > 320:
        probs.append("too long")
    return probs


def edit(api_key, items):
    """The editor's verdicts: {id: (verdict, text, why)}. Without a key,
    or when the call fails, nothing the AI wrote is kept."""
    if not items:
        return {}
    if not api_key:
        return {it["id"]: ("keep" if it.get("plain") else "drop", it["text"], "no editor") for it in items}
    got = ai_json(api_key, _fill(EDIT_PROMPT), json.dumps(items, ensure_ascii=False))
    if isinstance(got, dict):
        # One verdict on its own, or the list under some key.
        lists = [v for v in got.values() if isinstance(v, list)]
        got = [got] if "id" in got else (lists[0] if len(lists) == 1 else None)
    if not isinstance(got, list):
        return {it["id"]: ("keep" if it.get("plain") else "drop", it["text"], "editor unavailable") for it in items}
    out = {}
    for v in got:
        if isinstance(v, dict) and isinstance(v.get("id"), str) and v["id"] in {it["id"] for it in items}:
            out[v["id"]] = (str(v.get("verdict") or "drop"), str(v.get("text") or ""), str(v.get("why") or "")[:80])
    # An item the editor skipped is dropped, not waved through.
    for it in items:
        out.setdefault(it["id"], ("drop", it["text"], "editor didn't answer"))
    return out


def finalize(text, kind):
    t = strip_dashes(clean(text))
    if t.count("!") > 1:
        t = t.replace("!", ".", t.count("!") - 1)
    return t


# ─── Putting it together ─────────────────────────────────────────────────

def issue_monday(today):
    """The Monday of the issues this build is for: Sunday evening's build
    is for tomorrow's."""
    return today + timedelta(days=1) if today.weekday() == 6 else monday_of(today)


def build(config, previous, replies, today, api_key, before_send=False, issue=None):
    monday = issue_monday(today)
    out = {"town": TOWN["id"], "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "week": monday.isoformat(), "pet": None, "new_in_town": [], "good_news": None, "roundup": None,
           "review": [], "pet_history": list(previous.get("pet_history") or [])[-30:],
           "new_shown": dict(previous.get("new_shown") or {})}
    # The question of the week: the AI's new ones first, the town's own
    # list when there are none (plan_questions).
    if previous.get("week") == monday.isoformat() and previous.get("question"):
        question = previous["question"]
        out.update({k: previous.get(k) for k in ("question", "question_bank", "questions_asked", "questions_generated")})
        out["questions_added"] = []
    else:
        question = plan_questions(config, previous, monday, api_key if not before_send else "", out)

    # Before an issue only the pet is checked again (adopted since Sunday?);
    # everything else is what the editor already passed.
    if before_send and previous.get("week") == monday.isoformat():
        out.update({k: previous.get(k) for k in ("pet", "good_news", "roundup")})
        out.update({"new_in_town": list(previous.get("new_in_town") or []), "review": list(previous.get("review") or [])})
        pet = previous.get("pet")
        if pet and not pet_still_listed(pet, config):
            print(f"before send: {pet['name']} is no longer listed; picking another")
            out["pet"] = None
            new_pet = pick_pet(config, {"pet_history": out["pet_history"] + [{"id": pet["id"], "date": today.isoformat()}]}, today)
            drafts = draft(api_key, new_pet, [], [], [], None) if new_pet else {}
            if new_pet:
                out["pet"] = _reviewed_pet(api_key, new_pet, drafts, out, today)
        else:
            print("before send: the pet is still listed")
        # The opening paragraph, from what this very issue shows (the event
        # check has run by now).
        if issue:
            out["intro"] = write_intro(api_key, issue, out, config, monday, out["review"])
        return out

    # Wednesday's run is for Thursday: the pet and the new places stay what
    # Monday's issue showed (the pages and the homepage keep them); only
    # City Hall and the readers' answers are built again.
    midweek = previous.get("week") == monday.isoformat() and today.weekday() in (1, 2, 3)
    if midweek:
        out.update({"pet": previous.get("pet"), "new_in_town": list(previous.get("new_in_town") or [])})
        out["review"] = [r for r in previous.get("review") or [] if isinstance(r, dict) and str(r.get("id", "")).split(":")[0] in ("pet", "place")]
        pet, places = None, []
    else:
        pet = pick_pet(config, previous, today)
        places = build_new_in_town(config, previous, today)
    agendas = build_agendas(config, today) if config.get("good_news") else []
    # The roundup is Thursday's: replies since Monday's issue went out.
    use_replies = [r for r in replies if str(r.get("at") or "") >= monday.isoformat()] if today.weekday() >= 2 else []
    drafts = draft(api_key, pet, places, agendas, use_replies, question)

    if pet:
        out["pet"] = _reviewed_pet(api_key, pet, drafts, out, today)

    by_key = {x["key"]: x for x in places}
    items = []
    for d in drafts.get("new_places") or []:
        x = by_key.get(d.get("key"))
        if x and isinstance(d.get("line"), str) and d.get("line"):
            items.append({"id": f"place:{x['key']}", "kind": "place", "text": f"{d.get('name') or x['name']}: {d['line']}",
                          "source": x["raw"], "plain": not api_key})
    for i, g in enumerate(drafts.get("good_news") or []):
        if isinstance(g.get("line"), str) and g.get("line"):
            items.append({"id": f"good:{i}", "kind": "good", "text": f"{g.get('title', '')}: {g['line']}",
                          "source": "the meeting agenda", "plain": False})
    used = set()
    for r in drafts.get("roundup") or []:
        try:
            n = int(r.get("i"))
            src = use_replies[n] if n >= 0 and n not in used else None
        except (TypeError, ValueError, IndexError):
            src = None
        if src is None or not isinstance(r.get("quote"), str) or not r.get("quote"):
            continue
        used.add(n)
        # The name is the reader's own first name from their email, never
        # one the writer made up.
        items.append({"id": f"reply:{n}", "kind": "reply", "text": r["quote"], "source": src.get("text", ""),
                      "name": str(src.get("name") or ""), "plain": False})
    verdicts = edit(api_key, [{k: it[k] for k in ("id", "kind", "text", "source")} | {"plain": it["plain"]} for it in items])

    places_out, good_out, quotes = [], [], []
    for it in items:
        verdict, text, why = verdicts.get(it["id"], ("drop", "", ""))
        text = finalize(text if verdict == "fix" and text else it["text"], it["kind"])
        probs = rule_problems(text, it["kind"])
        if it["kind"] in ("place", "good") and ": " not in text:
            probs.append("lost its name")
        if it["kind"] == "reply":
            probs += rule_problems(it.get("name"), "name")
        kept = verdict in ("keep", "fix") and not probs
        out["review"].append({"id": it["id"], "verdict": "keep" if kept else "drop", "why": "; ".join(probs) or why})
        if not kept:
            continue
        if it["kind"] == "place":
            name, _, line = text.partition(": ")
            key = it["id"].split(":", 1)[1]
            x = by_key[key]
            # Its street (the map link) and when it opened or opens, as
            # the source has it (server/sections.js placeWhen words it).
            places_out.append({"key": key, "name": clean(name), "line": clean(line), "status": x["status"],
                               **{k: x[k] for k in ("street", "opened", "opens", "grand_opening") if x.get(k)}})
        elif it["kind"] == "good":
            title, _, line = text.partition(": ")
            good_out.append({"key": _key(text), "title": clean(title), "line": clean(line)})
        else:
            q = text.strip('"“” ')
            quotes.append({"key": _key(q), "quote": q, "name": (it.get("name") or "").split(" ")[0][:20]})

    if not midweek:
        out["new_in_town"] = places_out[:NEW_MAX]
        for x in out["new_in_town"]:
            out["new_shown"][x["key"]] = today.isoformat()
    if good_out:
        meeting = agendas[0] if agendas else {}
        out["good_news"] = {"items": good_out[:GOOD_NEWS_MAX], "url": meeting.get("url", ""), "body": meeting.get("body", "")}
    if len(quotes) >= 2:
        out["roundup"] = {"question": question, "answers": quotes[:ROUNDUP_MAX]}
    return out


def build_safely(config, previous, replies, today, api_key, before_send=False, issue=None):
    """build(), and what the AI's trouble was this run (the site's Slack
    note says so, so a dead key or a down AI doesn't go unnoticed)."""
    del AI_PROBLEMS[:]
    out = build(config, previous, replies, today, api_key, before_send=before_send, issue=issue)
    if api_key and AI_PROBLEMS:
        out["ai_problems"] = sorted(set(AI_PROBLEMS))
    elif not api_key and (config.get("enabled") is True or os.environ.get("SECTIONS", "").strip() == "1"):
        out["ai_problems"] = ["no OPENAI_API_KEY on the jobs service: only the pet runs, with a plain line"]
    return out


INTRO_PROMPT = """You write the one-line greeting at the top of <<SITE>>, a free local newsletter for <<PLACE>> that people look forward to opening. Under it is an "In this issue" list, so don't list what's inside: just say hello to the town in a way that makes people want to read on.

<<VOICE>>

You get JSON: "edition" ("weekly" is Monday's issue about the rest of the week, "weekend" is Thursday's about Friday to Sunday), "total" (how many things to do), "top" (the issue's best events: name, day, venue) and "inside" (the other sections). Write one sentence, 25 words at most. You may name one event from "top", with its exact "name" as given; never any other event. Greet the town naturally and differently each week (the season, the weekend, a nod to one event). Don't use "Don't miss", "jam-packed", "exciting lineup" or "something for everyone".

Return only JSON: {"intro": "..."}"""


def write_intro(api_key, issue, out, config, monday, review):
    """The AI's opening paragraph for this issue, after the editor and the
    rules; None (the site writes a plain one) without a key or if it fails."""
    if not api_key or not (issue or {}).get("top"):
        return None
    weekend = issue.get("edition") == "weekend"
    inside = []
    if not weekend:
        if out.get("pet"):
            inside.append(f"pet of the week: {out['pet']['name']}")
        if out.get("new_in_town"):
            inside.append(f"new in town: {', '.join(x['name'] for x in out['new_in_town'])}")
        q = out.get("question") or question_for(config, monday)
        if q:
            inside.append(f"question of the week: {q}")
    else:
        if out.get("roundup"):
            inside.append("readers' answers to Monday's question")
        if out.get("good_news"):
            inside.append("updates from City Hall")
    got = ai_json(api_key, _fill(INTRO_PROMPT), json.dumps({"edition": issue.get("edition"), "total": issue.get("total"),
                                                             "top": issue["top"], "inside": inside}, ensure_ascii=False), max_tokens=2000)
    text = str((got or {}).get("intro") or "").strip() if isinstance(got, dict) else ""
    if not text:
        return None
    v = edit(api_key, [{"id": "intro", "kind": "intro", "text": text, "source": json.dumps({"top": issue["top"], "inside": inside})}])
    verdict, fixed, why = v.get("intro", ("drop", "", ""))
    text = finalize(fixed if verdict == "fix" and fixed else text, "intro")
    names = [e["name"] for e in issue["top"] if e.get("name") and e["name"] in text]
    probs = rule_problems(text, "intro") + (["too long"] if len(text) > 220 else [])
    ok = verdict in ("keep", "fix") and not probs
    review.append({"id": "intro", "verdict": "keep" if ok else "drop", "why": "; ".join(probs) or why})
    if not ok:
        return None
    return {"edition": issue.get("edition"), "week": issue.get("week"), "text": text, "mentions": names}


QUESTION_REPEAT_WEEKS = 26
QUESTION_LOW = 4      # fewer unused than this: write more
QUESTIONS_PER_BATCH = 6

QUESTION_PROMPT = """You write the "question of the week" for <<SITE>>, a free local newsletter for <<PLACE>>. Readers answer by replying to the email, and the best answers run in Thursday's issue with first names. The point is fun, local, easy-to-answer questions that make people want to hit reply.

<<VOICE>>

You get JSON: "month" (when they'll run), "examples" (questions the owner wrote, for the style), and "recent" (asked lately: never repeat these or ask the same thing in other words). Write <<N>> new questions. Each one: one sentence ending in "?", 15 words at most, about this town and its people: favorite local spots, food, traditions, seasons, memories, small businesses, the outdoors. Make about half fit the month (the season, holidays, local events that happen then). Never about politics, elections, government, schools' policies, crime, religion, money troubles, or anything people argue about. Never ask readers to rank or criticize a business by name. Use real local places only if you're sure they exist (the examples name some).

Return only JSON: {"questions": ["...", "..."]}"""


def _qkey(q):
    return re.sub(r"[^a-z0-9 ]", "", str(q).lower()).strip()


def generate_questions(api_key, config, monday, recent):
    """New questions from the AI, each through the editor and the rules."""
    got = ai_json(api_key, _fill(QUESTION_PROMPT).replace("<<N>>", str(QUESTIONS_PER_BATCH)),
                  json.dumps({"month": monday.strftime("%B %Y"), "examples": (config.get("questions") or [])[:8],
                              "recent": recent[-40:]}, ensure_ascii=False), max_tokens=3000)
    qs = [str(q).strip() for q in ((got or {}).get("questions") or []) if isinstance(q, str)] if isinstance(got, dict) else []
    seen = {_qkey(r) for r in recent} | {_qkey(q) for q in config.get("questions") or []}
    qs = [q for q in qs if q and _qkey(q) not in seen]
    if not qs:
        return [], []
    items = [{"id": f"q:{i}", "kind": "question", "text": q, "source": "a reader question for the newsletter"} for i, q in enumerate(qs)]
    verdicts = edit(api_key, items)
    kept, review = [], []
    for it in items:
        verdict, fixed, why = verdicts.get(it["id"], ("drop", "", ""))
        text = finalize(fixed if verdict == "fix" and fixed else it["text"], "question")
        probs = rule_problems(text, "question")
        ok = verdict in ("keep", "fix") and not probs
        review.append({"id": f"new {it['id']}", "verdict": "keep" if ok else "drop", "why": "; ".join(probs) or why})
        if ok:
            kept.append(text)
    return kept, review


def plan_questions(config, previous, monday, api_key, out):
    """This Monday's question, and the bank of the AI's questions for the
    weeks after. Writes more once a month, or when fewer than QUESTION_LOW
    are left. → the question (None: the town has none)."""
    bank = [b for b in previous.get("question_bank") or [] if isinstance(b, dict) and b.get("q")]
    asked = [a for a in previous.get("questions_asked") or [] if isinstance(a, dict) and a.get("q")][-60:]
    cutoff = (monday - timedelta(weeks=QUESTION_REPEAT_WEEKS)).isoformat()
    recent = {_qkey(a["q"]) for a in asked if a.get("week", "") >= cutoff}
    unused = [b for b in bank if _qkey(b["q"]) not in recent]
    month = monday.strftime("%Y-%m")
    generated = previous.get("questions_generated") or ""
    added = []
    if api_key and (len(unused) < QUESTION_LOW or generated != month):
        new, review = generate_questions(api_key, config, monday, [a["q"] for a in asked])
        out["review"] += review
        for q in new:
            b = {"id": hashlib.sha1(q.encode()).hexdigest()[:10], "q": q, "added": monday.isoformat()}
            bank.append(b)
            unused.append(b)
            added.append(q)
        generated = month
    pick = unused[0] if unused else None
    if pick:
        question = pick["q"]
        bank = [b for b in bank if b is not pick]
    else:
        question = question_for(config, monday)
    if question:
        asked.append({"week": monday.isoformat(), "q": question})
    out.update({"question": question, "question_bank": bank[-24:], "questions_asked": asked[-60:],
                "questions_generated": generated, "questions_added": added})
    return question


def _reviewed_pet(api_key, pet, drafts, out, today):
    d = drafts.get("pet") if isinstance(drafts.get("pet"), dict) else {}
    blurb = str(d.get("blurb") or "").strip() or pet_plain_blurb(pet)
    plain = blurb == pet_plain_blurb(pet)
    # Only the plain line runs without the editor's yes; the AI's blurb
    # needs it (a missing or unreadable answer means the plain line).
    v = edit(api_key, [{"id": "pet", "kind": "pet", "text": blurb, "source": json.dumps({k: pet[k] for k in ("name", "breed", "age", "sex", "bio")}), "plain": plain}])
    verdict, text, why = v.get("pet", ("drop", blurb, ""))
    text = finalize(text if verdict == "fix" and text else blurb, "pet")
    if verdict == "drop" or rule_problems(text, "pet"):
        # The pet still runs, with the plain line: the photo and facts are the point.
        text, why = pet_plain_blurb(pet), (why or "; ".join(rule_problems(text, "pet")))
    out["review"].append({"id": "pet", "verdict": "keep", "why": why or ("plain" if plain else "")})
    out["pet_history"].append({"id": pet["id"], "date": today.isoformat()})
    return {k: pet[k] for k in ("id", "name", "species", "url", "shelter", "shelter_address", "shelter_url", "photo")} | {
        "facts": pet_facts(pet), "blurb": text}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--previous", help="the last sections.json (no repeats)")
    ap.add_argument("--replies", help="readers' replies since Monday (from the site)")
    ap.add_argument("--before-send", action="store_true")
    ap.add_argument("--issue", help="the next issue's top events (from the site), for its opening paragraph")
    ap.add_argument("--today")
    args = ap.parse_args(argv)
    config = load_config()
    if not config:
        print(f"{TOWN['id']}: no sections.json; nothing to build.")
        return 0
    # Off for the town (its sections.json, or SECTIONS=0): no AI calls, no
    # file. SECTIONS=1 builds anyway (a test run before turning it on).
    flag = os.environ.get("SECTIONS", "").strip()
    if not (flag == "1" or (flag != "0" and config.get("enabled") is True)):
        print(f"{TOWN['id']}: sections are off; nothing to build.")
        return 0
    today = date.fromisoformat(args.today) if args.today else datetime.now(timezone.utc).date()

    def read(path, default):
        try:
            with open(path) as f:
                return json.load(f)
        except (TypeError, FileNotFoundError, json.JSONDecodeError):
            return default
    previous = read(args.previous, {}) or {}
    replies = read(args.replies, []) or []
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    issue = read(args.issue, None)
    out = build_safely(config, previous, replies, today, key, before_send=args.before_send, issue=issue)
    with open(args.out, "w") as f:
        json.dump(out, f, ensure_ascii=False)
    pet = out.get("pet")
    print(f"pet: {pet['name'] if pet else 'none'} · new in town: {len(out['new_in_town'])} · "
          f"good news: {len((out.get('good_news') or {}).get('items') or [])} · roundup: {len((out.get('roundup') or {}).get('answers') or [])}")
    for r in out["review"]:
        print(f"  editor: {r['id']} → {r['verdict']} {r['why']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
