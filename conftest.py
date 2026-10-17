"""Shared pytest setup.

collect_events keeps a few run-wide globals (the venue folder, the Apify and
OpenAI kill switches, the date window, the source notes). Some tests set
them, directly or by running ce.main(), and nothing put them back, so a later
test could pass or fail depending on the order. Each test gets them back as
they were before it ran.
"""
import copy
import sys

import pytest

_COLLECTOR_GLOBALS = ("_VENUE_DIR", "_APIFY_LIMIT_TRIPPED", "_OPENAI_DEAD",
                      "_WINDOW_START", "_WINDOW_END", "_SOURCE_NOTES", "_QUIET_PAGES")


@pytest.fixture(autouse=True)
def _restore_collector_globals():
    ce = sys.modules.get("collect_events")
    saved = {k: copy.deepcopy(getattr(ce, k)) for k in _COLLECTOR_GLOBALS if hasattr(ce, k)} if ce else {}
    yield
    for k, v in saved.items():
        setattr(ce, k, v)
