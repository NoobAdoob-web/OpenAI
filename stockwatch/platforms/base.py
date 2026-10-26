"""Shared steps for any shopping site: set the delivery location, open a product, read stock."""

import json
import os
import re
import time

from .. import detect

DEBUG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "debug")

USE_GPS = r"use (my )?current location|detect (my )?(current )?location|enable location|locate me|use gps"
OPEN_PICKER = r"select (your )?location|select address|enter (your )?(delivery )?location|change location|delivery (in|to)|deliver to"
CONFIRM = r"^\s*(confirm( (&|and) (continue|proceed)| location)?|save( address)?|continue|proceed|done|start shopping)\s*$"
SEARCH_BOX = r"search.*(area|location|street|address|society|locality|pincode)|enter.*(area|location|pincode|address)|pincode"


class Platform:
    name = "generic"
    home_url = ""

    def __init__(self, log=print):
        self.log = log

    # ---- helpers -------------------------------------------------------------
    def product_id(self, url):
        return ""

    def _click(self, page, pattern, timeout=2500):
        rx = re.compile(pattern, re.I)
        for locator in (page.get_by_role("button", name=rx), page.get_by_text(rx)):
            try:
                target = locator.first
                target.wait_for(state="visible", timeout=timeout)
                target.click(timeout=timeout)
                return True
            except Exception:
                continue
        return False

    def _settle(self, page, seconds=2.0):
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        time.sleep(seconds)

    def screenshot(self, page, label):
        try:
            os.makedirs(DEBUG_DIR, exist_ok=True)
            safe = re.sub(r"[^A-Za-z0-9_-]+", "_", label)[:80]
            path = os.path.join(DEBUG_DIR, f"{self.name}_{safe}.png")
            page.screenshot(path=path, full_page=False)
            return path
        except Exception:
            return ""

    def header_text(self, page):
        for sel in ("header", "nav", "body"):
            try:
                text = page.locator(sel).first.inner_text(timeout=2000)
                if text.strip():
                    return " ".join(text.split())[:160]
            except Exception:
                continue
        return ""

    # ---- location ------------------------------------------------------------
    def set_location(self, page, loc):
        """Makes the site deliver to `loc`. Returns (serviceable: bool|None, label: str)."""
        serviceable = {"value": None}

        def on_response(resp):
            if "serviceab" not in resp.url.lower():
                return
            try:
                text = json.dumps(resp.json())
            except Exception:
                return
            m = re.search(r'"(is_?)?serviceable"\s*:\s*(true|false)', text, re.I)
            if m:
                serviceable["value"] = m.group(2).lower() == "true"

        page.on("response", on_response)
        page.goto(self.home_url, wait_until="domcontentloaded", timeout=45000)
        self._settle(page, 3)
        self.log(f"    page title: {page.title()!r}")
        self.log(f"    top of page before: {self.header_text(page)!r}")

        problem = detect.page_problem(self._body(page))
        if problem == detect.BLOCKED:
            self.screenshot(page, f"blocked_{loc.pincode}")
            return None, "BLOCKED"

        # 1) "Use my current location" - the browser's GPS is already set to this pincode.
        done = self._click(page, USE_GPS)
        if not done and self._click(page, OPEN_PICKER):
            self._settle(page, 1.5)
            done = self._click(page, USE_GPS)
        if done:
            self.log("    location: used GPS position")
            self._settle(page, 2.5)
        else:
            # 2) Type the pincode into the location search box and pick the first suggestion.
            done = self._type_pincode(page, loc.pincode)
            self.log(f"    location: typed pincode -> {'ok' if done else 'FAILED'}")

        if self._click(page, CONFIRM, timeout=2000):
            self._settle(page, 2)
        label = self.header_text(page)
        self.log(f"    top of page after:  {label!r}")
        self.screenshot(page, f"location_{loc.pincode}")
        if detect.page_problem(self._body(page)) == detect.NOT_SERVICEABLE:
            serviceable["value"] = False
        page.remove_listener("response", on_response)
        return serviceable["value"], label

    def _type_pincode(self, page, pincode):
        rx = re.compile(SEARCH_BOX, re.I)
        for box in (page.get_by_placeholder(rx), page.get_by_role("textbox"), page.get_by_role("searchbox")):
            try:
                field = box.first
                field.wait_for(state="visible", timeout=2500)
                field.click()
                field.fill("")
                field.type(pincode, delay=80)
                time.sleep(2.5)
                # Suggestions usually mention the pincode; fall back to the first list option.
                for option in (page.get_by_text(re.compile(pincode)).nth(1), page.get_by_role("option").first,
                               page.locator("li").filter(has_text=re.compile(pincode)).first):
                    try:
                        option.click(timeout=2500)
                        self._settle(page, 2)
                        return True
                    except Exception:
                        continue
            except Exception:
                continue
        return False

    def _body(self, page):
        try:
            return page.locator("body").inner_text(timeout=3000)
        except Exception:
            return ""

    # ---- stock ---------------------------------------------------------------
    def check(self, page, product):
        """Returns (status, note, title_seen_on_page)."""
        pid = self.product_id(product.url)
        payloads = []

        def on_response(resp):
            try:
                if "json" in (resp.headers.get("content-type") or "") and resp.status == 200:
                    payloads.append(resp.json())
            except Exception:
                pass

        page.on("response", on_response)
        try:
            page.goto(product.url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.locator("h1").first.wait_for(state="visible", timeout=12000)
            except Exception:
                pass
            self._settle(page, 2.5)
        except Exception as e:
            page.remove_listener("response", on_response)
            return detect.UNKNOWN, f"page did not load ({type(e).__name__})", ""
        page.remove_listener("response", on_response)

        scan = {}
        try:
            scan = page.evaluate(detect.PAGE_SCAN_JS, [detect.OOS_PATTERN, detect.IN_STOCK_PATTERN])
        except Exception:
            pass
        title = (scan or {}).get("title", "")

        from_json = None
        for payload in payloads:
            from_json = detect.stock_from_json(payload, pid) or from_json
        from_page = detect.stock_from_page_scan(scan)

        if from_json and from_page and from_json != from_page:
            self.log(f"      note: site data says {from_json}, page text says {from_page}; trusting site data")
        status = from_json or from_page
        if status:
            source = "site data" if from_json else "page text"
            return status, f"read from {source}", title

        problem = detect.page_problem(self._body(page))
        shot = self.screenshot(page, f"unclear_{product.name}")
        if problem:
            return problem, "", title
        return detect.UNKNOWN, f"no stock signal found (verdict={scan.get('verdict') if scan else None}); screenshot {os.path.basename(shot)}", title

    # ---- discovery -----------------------------------------------------------
    def search_url(self, query):
        raise NotImplementedError

    def discover(self, page, query, max_scrolls=25):
        """Lists every product the site shows when you search for `query`."""
        page.goto(self.search_url(query), wait_until="domcontentloaded", timeout=45000)
        self._settle(page, 3)
        found, stale = {}, 0
        for _ in range(max_scrolls):
            cards = page.evaluate(DISCOVER_JS, [self.product_link_pattern, detect.OOS_PATTERN])
            before = len(found)
            for c in cards:
                found.setdefault(c["url"], c)
            stale = stale + 1 if len(found) == before else 0
            if stale >= 3:
                break
            page.mouse.wheel(0, 2500)
            time.sleep(1.5)
        return list(found.values())

    product_link_pattern = r"$^"


DISCOVER_JS = """
([linkSrc, oosSrc]) => {
  const link = new RegExp(linkSrc, 'i'), oos = new RegExp(oosSrc, 'i');
  return [...document.querySelectorAll('a[href]')]
    .filter(a => link.test(a.href))
    .map(a => {
      const text = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const price = text.find(t => /₹\\s?\\d/.test(t)) || '';
      const size = text.find(t => /\\d\\s?(g|gm|kg|ml|l|pcs?|pack)\\b/i.test(t)) || '';
      const name = text.filter(t => t.length > 3 && !/₹|^add$|notify|^\\d+\\s?min/i.test(t))
                       .sort((x, y) => y.length - x.length)[0] || '';
      return {url: a.href.split('#')[0], name, size, price,
              out_of_stock: oos.test(a.innerText || '')};
    });
}
"""
