import re
import urllib.parse

from .base import Platform


class Zepto(Platform):
    name = "zepto"
    home_url = "https://www.zepto.com/"
    product_link_pattern = r"zepto\.com/pn/.+/pvid/"

    def product_id(self, url):
        m = re.search(r"/pvid/([0-9a-f-]{36})", url, re.I)
        return m.group(1) if m else ""

    def search_url(self, query):
        return f"{self.home_url}search?query={urllib.parse.quote(query)}"
