"""Decides whether a product page shows the product as in stock or out of stock.

Two independent signals are used:
1. The data the website itself downloads (JSON) - most reliable when present.
2. The text on the page next to the product title ("Add to Cart" vs "Notify Me").
"""

import json
import re

IN_STOCK = "IN_STOCK"
OUT_OF_STOCK = "OUT_OF_STOCK"
NOT_SERVICEABLE = "NOT_DELIVERING_HERE"
BLOCKED = "BLOCKED_BY_SITE"
UNKNOWN = "COULD_NOT_TELL"

LABELS = {
    IN_STOCK: "In stock",
    OUT_OF_STOCK: "Out of stock",
    NOT_SERVICEABLE: "Platform not delivering to this pincode",
    BLOCKED: "Site blocked the checker",
    UNKNOWN: "Could not tell",
}

OOS_PATTERN = r"out of stock|notify me|sold out|currently unavailable|not available right now|temporarily unavailable"
IN_STOCK_PATTERN = r"add to cart|add to bag|\bbuy now\b"
NOT_SERVICEABLE_PATTERN = (
    r"not serviceable|we are not (here|there|delivering)|coming soon to your|"
    r"does(n't| not) deliver|unserviceable|not deliver(ing)? (to|in|at) (this|your)"
)
BLOCKED_PATTERN = r"access denied|verify you are (a )?human|are you a robot|unusual traffic|captcha|request blocked"


def stock_from_json(payload, product_id):
    """Finds the product inside JSON downloaded by the site and reads its stock flags.

    Returns IN_STOCK / OUT_OF_STOCK, or None if this JSON doesn't describe the product.
    """
    if not product_id:
        return None
    best = None  # the smallest matching block is the one about this exact product

    def walk(node):
        nonlocal best
        if isinstance(node, dict):
            if "outOfStock" in node or "availableQuantity" in node or "isSoldOut" in node:
                text = json.dumps(node)
                if product_id in text and (best is None or len(text) < len(best[0])):
                    best = (text, node)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(payload)
    if best is None:
        return None
    node = best[1]
    if node.get("outOfStock") is True or node.get("isSoldOut") is True:
        return OUT_OF_STOCK
    if node.get("availableQuantity") == 0:
        return OUT_OF_STOCK
    if node.get("outOfStock") is False or node.get("isSoldOut") is False:
        return IN_STOCK
    qty = node.get("availableQuantity")
    if isinstance(qty, (int, float)) and qty > 0:
        return IN_STOCK
    return None


# Runs inside the browser. Starts at the product title and walks outwards until it
# reaches the block holding the buy button, so "Notify me" buttons on *other*
# products further down the page (recommendations) are ignored.
PAGE_SCAN_JS = """
([oosSrc, inSrc]) => {
  const oos = new RegExp(oosSrc, 'i');
  const ins = new RegExp(inSrc, 'i');
  const title = document.querySelector('h1');
  const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const verdict = text => {
    const o = text.search(oos), i = text.search(ins);
    if (o === -1 && i === -1) return null;
    if (o !== -1 && i === -1) return 'OUT';
    if (i !== -1 && o === -1) return 'IN';
    return 'BOTH';
  };
  if (title) {
    let el = title;
    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      if (!visible(el)) continue;
      const v = verdict(el.innerText || '');
      if (v && v !== 'BOTH') return {verdict: v, title: title.innerText.trim(), depth};
      if (v === 'BOTH') return {verdict: 'BOTH', title: title.innerText.trim(), depth};
    }
  }
  const body = document.body ? document.body.innerText : '';
  return {verdict: verdict(body.slice(0, 4000)) || 'NONE', title: title ? title.innerText.trim() : '', depth: -1};
}
"""


def stock_from_page_scan(scan):
    v = (scan or {}).get("verdict")
    if v == "OUT":
        return OUT_OF_STOCK
    if v == "IN":
        return IN_STOCK
    return None


def page_problem(text):
    """Spots pages that aren't a product page at all: blocked, or no delivery here."""
    text = text or ""
    if re.search(BLOCKED_PATTERN, text, re.I):
        return BLOCKED
    if re.search(NOT_SERVICEABLE_PATTERN, text, re.I):
        return NOT_SERVICEABLE
    return None
