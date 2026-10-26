"""Reads the product list and the delivery locations (pincodes) to check."""

import csv
import json
import os
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")


@dataclass
class Product:
    platform: str
    name: str
    city: str
    url: str
    owner_email: str = ""


@dataclass
class Location:
    city: str
    pincode: str
    area: str
    lat: float
    lon: float


def _read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [
            {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
            for row in csv.DictReader(f)
        ]


def load_products(path=None):
    path = path or os.path.join(DATA_DIR, "products.csv")
    products = []
    for row in _read_csv(path):
        if not row.get("url") or row.get("url", "").startswith("#"):
            continue
        products.append(Product(
            platform=row.get("platform", "").lower() or guess_platform(row["url"]),
            name=row.get("product") or row["url"],
            city=row.get("city", ""),
            url=row["url"],
            owner_email=row.get("owner_email", ""),
        ))
    return products


def load_locations(path=None):
    path = path or os.path.join(DATA_DIR, "locations.csv")
    locations = []
    for row in _read_csv(path):
        if not row.get("pincode"):
            continue
        lat, lon = row.get("lat"), row.get("lon")
        if not (lat and lon):
            lat, lon = geocode_pincode(row["pincode"])
            if lat is None:
                print(f"! Could not find map coordinates for pincode {row['pincode']}, skipping it")
                continue
        locations.append(Location(
            city=row.get("city", ""),
            pincode=row["pincode"],
            area=row.get("area", ""),
            lat=float(lat),
            lon=float(lon),
        ))
    return locations


def guess_platform(url):
    host = urllib.parse.urlparse(url).netloc.lower()
    for name in ("zepto", "blinkit", "swiggy", "flipkart", "amazon", "bigbasket"):
        if name in host:
            return name
    return host


def geocode_pincode(pincode):
    """Looks up a pincode's map position on OpenStreetMap (free, 1 request/second)."""
    query = urllib.parse.urlencode({"postalcode": pincode, "country": "India", "format": "json", "limit": 1})
    req = urllib.request.Request(
        f"https://nominatim.openstreetmap.org/search?{query}",
        headers={"User-Agent": "qc-stock-watch/1.0"},
    )
    try:
        time.sleep(1.1)
        with urllib.request.urlopen(req, timeout=20) as resp:
            hits = json.load(resp)
        if hits:
            return float(hits[0]["lat"]), float(hits[0]["lon"])
    except Exception as e:  # network trouble shouldn't stop the whole run
        print(f"! Geocoding {pincode} failed: {e}")
    return None, None
