"""Quick-commerce stock checker.

  python run.py check                          # check every product in every pincode, email the report
  python run.py discover --query "catch" --pincode 122002   # list every product a search shows
"""

import argparse
import csv
import datetime as dt
import html
import os
import sys
from collections import defaultdict

from stockwatch import config, detect, report
from stockwatch.browser import launch, new_shopper
from stockwatch.platforms import get_platform

RESULTS_DIR = os.path.join(config.ROOT, "results")


def today():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).strftime("%d %b %Y")


def run_check(args):
    products = config.load_products(args.products)
    locations = config.load_locations(args.locations)
    if args.limit:
        products = products[: args.limit]
    print(f"Checking {len(products)} products across {len(locations)} pincodes\n")

    rows, locations_seen = [], {}
    date = today()
    with launch() as browser:
        for loc in locations:
            for platform_name in sorted({p.platform for p in products if p.city.lower() == loc.city.lower()}):
                platform = get_platform(platform_name)
                todo = [p for p in products if p.platform == platform_name and p.city.lower() == loc.city.lower()]
                print(f"== {platform_name.title()} @ {loc.pincode} {loc.area} ({len(todo)} products)")
                if platform is None:
                    rows += [_row(date, p, loc, detect.UNKNOWN, f"{platform_name} is not supported yet") for p in todo]
                    continue
                context = new_shopper(browser, loc.lat, loc.lon)
                page = context.new_page()
                try:
                    serviceable, label = platform.set_location(page, loc)
                except Exception as e:
                    serviceable, label = None, f"location step failed: {type(e).__name__}: {e}"[:160]
                    print(f"    ! {label}")
                locations_seen[f"{platform_name.title()} {loc.pincode}"] = label
                for p in todo:
                    if label == "BLOCKED":
                        status, note, title = detect.BLOCKED, "blocked on home page", ""
                    elif serviceable is False:
                        status, note, title = detect.NOT_SERVICEABLE, "", ""
                    else:
                        try:
                            status, note, title = platform.check(page, p)
                        except Exception as e:
                            status, note, title = detect.UNKNOWN, f"error: {type(e).__name__}", ""
                    print(f"    {report.ICON[status]} {p.name}: {detect.LABELS[status]}  [{note}] title={title[:60]!r}")
                    rows.append(_row(date, p, loc, status, note, title))
                context.close()

    report.write_csvs(rows, RESULTS_DIR)
    subject = report.subject(rows, date)
    print(f"\n{subject}")
    report.send_email(subject, report.build_email(rows, date, locations_seen),
                      os.environ.get("ALERT_TO", "").split(","))

    # Team members listed in an optional owner_email column get only their own products.
    owners = defaultdict(list)
    for p in products:
        for email in filter(None, (e.strip() for e in p.owner_email.split(";"))):
            owners[email].append(p.url)
    for email, urls in owners.items():
        mine = [r for r in rows if r["url"] in urls]
        if any(r["status"] == detect.OUT_OF_STOCK for r in mine) or args.always_email_owners:
            report.send_email(report.subject(mine, date), report.build_email(mine, date, {}), [email])
    return 0


def _row(date, product, loc, status, note="", title=""):
    return {"date": date, "platform": product.platform, "product": product.name, "city": loc.city,
            "pincode": loc.pincode, "area": loc.area, "status": status, "note": note,
            "title_on_page": title, "url": product.url}


def run_discover(args):
    platform = get_platform(args.platform)
    if platform is None:
        print(f"{args.platform} is not supported yet")
        return 1
    loc = next((l for l in config.load_locations(args.locations) if l.pincode == args.pincode), None)
    if loc is None:
        lat, lon = config.geocode_pincode(args.pincode)
        if lat is None:
            print(f"Pincode {args.pincode} is not in data/locations.csv and could not be looked up")
            return 1
        loc = config.Location(city=args.city, pincode=args.pincode, area="", lat=lat, lon=lon)

    with launch() as browser:
        context = new_shopper(browser, loc.lat, loc.lon)
        page = context.new_page()
        _, label = platform.set_location(page, loc)
        items = platform.discover(page, args.query)
        context.close()

    words = [w for w in args.query.lower().split() if w]
    if not args.include_other_brands:
        items = [i for i in items if all(w in (i["name"] + " " + i["url"]).lower() for w in words)]
    print(f"\nFound {len(items)} products for {args.query!r} on {platform.name.title()} @ {loc.pincode} ({label})")

    os.makedirs(RESULTS_DIR, exist_ok=True)
    slug = "".join(c if c.isalnum() else "-" for c in args.query.lower())
    path = os.path.join(RESULTS_DIR, f"discover_{platform.name}_{slug}_{loc.pincode}.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        # Same columns as data/products.csv, so rows can be pasted straight in.
        w.writerow(["platform", "product", "city", "url", "pack_size", "price", "out_of_stock_now"])
        for i in items:
            w.writerow([platform.name, i["name"], loc.city or args.city, i["url"], i["size"], i["price"],
                        "yes" if i["out_of_stock"] else "no"])
            print(f"  {'❌' if i['out_of_stock'] else '✅'} {i['name']} | {i['size']} | {i['price']} | {i['url']}")
    print(f"\nSaved to {os.path.relpath(path, config.ROOT)}")

    esc = html.escape
    rows = "".join(f"<tr><td><a href='{esc(i['url'])}'>{esc(i['name'])}</a></td><td>{esc(i['size'])}</td><td>{esc(i['price'])}</td>"
                   f"<td>{'❌ out of stock' if i['out_of_stock'] else '✅'}</td></tr>" for i in items)
    body = (f"<p>{len(items)} products found for <b>{esc(args.query)}</b> on {platform.name.title()} "
            f"at pincode {loc.pincode}.</p><table border='1' cellpadding='6' cellspacing='0' "
            f"style='border-collapse:collapse;font-family:Arial'><tr><th>Product</th><th>Size</th><th>Price</th>"
            f"<th>Stock</th></tr>{rows}</table>")
    report.send_email(f"{platform.name.title()} product list for '{args.query}' ({len(items)} found)", body,
                      os.environ.get("ALERT_TO", "").split(","))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="check stock for every product in every pincode")
    c.add_argument("--products")
    c.add_argument("--locations")
    c.add_argument("--limit", type=int, default=0, help="only check the first N products (for testing)")
    c.add_argument("--always-email-owners", action="store_true")
    d = sub.add_parser("discover", help="list every product a platform shows for a search")
    d.add_argument("--query", required=True)
    d.add_argument("--pincode", required=True)
    d.add_argument("--platform", default="zepto")
    d.add_argument("--city", default="")
    d.add_argument("--locations")
    d.add_argument("--include-other-brands", action="store_true")
    args = ap.parse_args()
    return run_check(args) if args.cmd == "check" else run_discover(args)


if __name__ == "__main__":
    sys.exit(main())
