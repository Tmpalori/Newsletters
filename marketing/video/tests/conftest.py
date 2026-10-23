"""Pin the suite to the October 2026 scripts.

The tests name real videos (victoria-1, lincoln-2...) and their exact words,
but scripts.json is rewritten for every new batch of videos. So the suite
reads a frozen copy through VIDEO_SCRIPTS (set here, before any test module
loads a script list), and test_scripts.py checks the live scripts.json.
"""
import os

FROZEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "scripts-2026-10.json")
os.environ["VIDEO_SCRIPTS"] = FROZEN
