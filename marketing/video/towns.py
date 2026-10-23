"""The five towns the subscribe videos run in, with what the editor and the
poster need: brand colors, logo, domain, Facebook Page and time zone.

Kearney (The Crane 308) and Tupelo (Tupelo Current) are left out on purpose:
neither has a Facebook Page pinned in its town.json "meta", so there is
nowhere to post their videos yet.

The palettes are copied from each town's towns/<slug>/BRAND.md (Victoria's
from docs/style.css), and the Page ids from town.json / town.py VICTORIA;
test_towns.py checks both against those files, so a rebrand there fails the
test instead of quietly shipping old colors.
"""
import os

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# Both issues go out in the morning, town time: the week on Monday, the
# weekend on Thursday (server/scheduler.js "newsletter" / "newsletter-weekend").
ISSUE_DAYS = "Mon & Thu"

TOWNS = {
    "victoria": {
        "name": "The Vic 361",
        "city": "Victoria",
        "domain": "thevic361.com",
        "site_url": "https://www.thevic361.com",
        "page_id": "1388965530960534",
        "timezone": "America/Chicago",
        "hashtags": "#VictoriaTX #ThingsToDoVictoria #VictoriaTexas #361 #TheVic361",
        "logo": "docs/logo.png",
        # docs/style.css: --color-primary, --color-accent, --color-bg, --ink, --sun
        "palette": {"primary": "#4B3FD1", "accent": "#FF7A3D", "paper": "#FFF4D6",
                    "ink": "#1F1A3D", "highlight": "#FFC93C"},
    },
    "lincoln": {
        "name": "The Star 402",
        "city": "Lincoln",
        "domain": "thestar402.com",
        "site_url": "https://www.thestar402.com",
        "page_id": "1436967576160283",
        "timezone": "America/Chicago",
        "hashtags": "#LincolnNE #LNK #StarCity #TheStar402",
        "logo": "towns/lincoln/public/logo.png",
        "palette": {"primary": "#2F3B73", "accent": "#B04E32", "paper": "#FAF5E8",
                    "ink": "#1F2433", "highlight": "#F5BE3C"},
    },
    "medford": {
        "name": "The Rogue 541",
        "city": "Medford",
        "domain": "therogue541.com",
        "site_url": "https://www.therogue541.com",
        "page_id": "1444476842072503",
        "timezone": "America/Los_Angeles",
        "hashtags": "#RogueValley #MedfordOregon #SouthernOregon #TheRogue541",
        "logo": "towns/medford/public/logo.png",
        "palette": {"primary": "#137A77", "accent": "#7A2E66", "paper": "#F8F4E6",
                    "ink": "#1D2633", "highlight": "#EBC74A"},
    },
    "shoals": {
        "name": "Shoals Setlist",
        "city": "the Shoals",
        "domain": "shoalssetlist.com",
        "site_url": "https://www.shoalssetlist.com",
        "page_id": "1457474927438610",
        "timezone": "America/Chicago",
        "hashtags": "#TheShoals #MuscleShoals #FlorenceAL #ShoalsSetlist",
        "logo": "towns/shoals/public/logo.png",
        "palette": {"primary": "#3D5C78", "accent": "#B04A20", "paper": "#F7EDD6",
                    "ink": "#2A1E17", "highlight": "#E5A82E"},
    },
    "virginiabeach": {
        "name": "The Tide 757",
        "city": "Virginia Beach",
        "domain": "thetide757.com",
        "site_url": "https://www.thetide757.com",
        "page_id": "1420636331128750",
        "timezone": "America/New_York",
        "hashtags": "#VirginiaBeach #VB #757 #TheTide757",
        "logo": "towns/virginiabeach/public/logo.png",
        "palette": {"primary": "#0F5C8C", "accent": "#CC4A3C", "paper": "#FAF1DE",
                    "ink": "#13263A", "highlight": "#F6B93B"},
    },
}


def town(slug):
    if slug not in TOWNS:
        raise KeyError(f"unknown town {slug!r}; one of {', '.join(TOWNS)}")
    t = dict(TOWNS[slug], slug=slug)
    t["subscribe_url"] = t["site_url"] + "/subscribe"
    t["logo_path"] = os.path.join(REPO, t["logo"])
    return t
