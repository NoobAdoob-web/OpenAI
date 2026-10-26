"""Opens a standard automated (invisible) Chrome browser with an Indian delivery location."""

import os
from contextlib import contextmanager

from playwright.sync_api import sync_playwright


@contextmanager
def launch():
    with sync_playwright() as pw:
        kwargs = {"headless": os.environ.get("HEADFUL") != "1"}
        if os.environ.get("CHROMIUM_PATH"):
            kwargs["executable_path"] = os.environ["CHROMIUM_PATH"]
        browser = pw.chromium.launch(**kwargs)
        try:
            yield browser
        finally:
            browser.close()


def new_shopper(browser, lat, lon):
    """A fresh browser profile whose GPS position is the given pincode."""
    context = browser.new_context(
        locale="en-IN",
        timezone_id="Asia/Kolkata",
        viewport={"width": 1366, "height": 900},
        geolocation={"latitude": lat, "longitude": lon},
        permissions=["geolocation"],
    )
    context.set_default_timeout(15000)
    return context
