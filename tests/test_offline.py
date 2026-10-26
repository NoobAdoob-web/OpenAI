"""Runs the checker against a small fake shop on this computer (no internet needed).

    python -m pytest tests
"""

import http.server
import json
import os
import threading

import pytest

from stockwatch import config, detect, report
from stockwatch.browser import launch, new_shopper
from stockwatch.platforms.base import Platform

PID_IN = "11111111-1111-1111-1111-111111111111"
PID_OUT = "22222222-2222-2222-2222-222222222222"
PID_JSON_OUT = "33333333-3333-3333-3333-333333333333"
PID_OTHER = "44444444-4444-4444-4444-444444444444"

HOME = """<html><body><header><span id=loc>Select Location</span></header>
<div id=modal><button onclick="navigator.geolocation.getCurrentPosition(p => {
  document.getElementById('loc').innerText = 'Delivering to ' + p.coords.latitude.toFixed(2);
  document.getElementById('modal').remove(); })">Use my current location</button></div></body></html>"""

RECO_ADD = "<section><h3>Similar</h3><div>Other masala</div><button>ADD</button><div>Add to cart</div></section>"
RECO_NOTIFY = "<section><h3>Similar</h3><div>Other masala</div><button>Notify Me</button></section>"

PAGES = {
    f"/pn/in/pvid/{PID_IN}": f"<main><div><h1>Turmeric 100g</h1><p>₹40</p><button>Add to Cart</button></div>{RECO_NOTIFY}</main>",
    f"/pn/out/pvid/{PID_OUT}": f"<main><div><h1>Hing 50g</h1><p>₹90</p><button>Notify Me</button></div>{RECO_ADD}</main>",
    # Page text gives no signal; only the data the page downloads says out of stock.
    f"/pn/json/pvid/{PID_JSON_OUT}": """<main><div><h1>Chilli 100g</h1><button>Buy</button></div></main>
        <script>fetch('/api/detail').then(r => r.json())</script>""",
    "/api/detail": json.dumps({"storeProducts": [
        {"productVariant": {"id": PID_OTHER}, "outOfStock": False, "availableQuantity": 9},
        {"productVariant": {"id": PID_JSON_OUT}, "outOfStock": True, "availableQuantity": 0}]}),
    "/search": "<div>" + "".join(
        f"<a href='/pn/x/pvid/{pid}'><div>Catch {n}</div><div>100 g</div><div>₹{p}</div><div>{b}</div></a>"
        for pid, n, p, b in [(PID_IN, "Turmeric Powder", 40, "ADD"), (PID_OUT, "Compounded Hing", 90, "Notify Me"),
                             (PID_OTHER, "Everest Turmeric", 38, "ADD")]) + "</div>",
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        body = HOME if path == "/" else PAGES.get(path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        ctype = "application/json" if path.startswith("/api") else "text/html; charset=utf-8"
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def shop():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"

    class FakeShop(Platform):
        name = "fakeshop"
        home_url = base + "/"
        product_link_pattern = r"/pn/.+/pvid/"

        def product_id(self, url):
            return url.rsplit("/", 1)[-1]

        def search_url(self, query):
            return base + "/search"

    yield base, FakeShop(log=lambda *a: None)
    server.shutdown()


@pytest.fixture(scope="module")
def page(shop):
    with launch() as browser:
        context = new_shopper(browser, 28.495, 77.089)
        yield context.new_page()
        context.close()


LOC = config.Location("Gurgaon", "122002", "Cyber City", 28.495, 77.089)


def test_sets_location_with_gps(shop, page):
    _, platform = shop
    _, label = platform.set_location(page, LOC)
    assert "Delivering to 28.50" in label


@pytest.mark.parametrize("pid,expected", [(PID_IN, detect.IN_STOCK), (PID_OUT, detect.OUT_OF_STOCK),
                                          (PID_JSON_OUT, detect.OUT_OF_STOCK)])
def test_reads_stock(shop, page, pid, expected):
    base, platform = shop
    slug = {PID_IN: "in", PID_OUT: "out", PID_JSON_OUT: "json"}[pid]
    product = config.Product("fakeshop", slug, "Gurgaon", f"{base}/pn/{slug}/pvid/{pid}")
    status, note, title = platform.check(page, product)
    assert status == expected, note


def test_discover_lists_products(shop, page):
    _, platform = shop
    items = platform.discover(page, "catch", max_scrolls=2)
    names = {i["name"]: i for i in items}
    assert len(items) == 3
    assert names["Catch Compounded Hing"]["out_of_stock"] is True
    assert names["Catch Turmeric Powder"]["price"] == "₹40"


def test_json_matching_ignores_other_products():
    payload = {"items": [{"productVariant": {"id": PID_OTHER}, "outOfStock": True}]}
    assert detect.stock_from_json(payload, PID_IN) is None
    assert detect.stock_from_json(payload, PID_OTHER) == detect.OUT_OF_STOCK


def test_problem_pages():
    assert detect.page_problem("Sorry, we are not delivering to this area yet") == detect.NOT_SERVICEABLE
    assert detect.page_problem("Access Denied - reference #18") == detect.BLOCKED
    assert detect.page_problem("Turmeric 100g Add to cart") is None


def test_email_report():
    rows = [
        {"date": "1 Jan", "platform": "zepto", "product": "Hing", "city": "Gurgaon", "pincode": p, "area": "",
         "status": s, "note": "", "title_on_page": "", "url": "https://x/hing"}
        for p, s in [("122001", detect.OUT_OF_STOCK), ("122002", detect.IN_STOCK), ("122011", detect.UNKNOWN)]
    ]
    assert report.subject(rows, "1 Jan") == "Stock check 1 Jan (Gurgaon): 1 out of stock, 1 unclear"
    body = report.build_email(rows, "1 Jan", {"Zepto 122001": "Sector 14"})
    assert "1 of 3" in body and "122001" in body and "Needs attention" in body


def test_loads_repo_data_files():
    products = config.load_products()
    locations = config.load_locations()
    assert products and all(p.platform == "zepto" for p in products)
    assert {l.city for l in locations} >= {p.city for p in products}
