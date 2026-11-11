/* Product detection: which product line is a post actually about?
 *
 * A brand like Samsung runs many lines at once - S26, S26 FE, Z Fold8,
 * refrigerators, TVs, washing machines - and users want one line's posts, not
 * the whole feed.
 *
 * Three signals, strongest first:
 *   1. hashtags, which are an explicit product tag written by the brand
 *   2. model tokens in running text (Galaxy S26 Ultra, Book5, A36)
 *   3. a category lexicon for lines that have no model number (refrigerator)
 *
 * A trailing qualifier is part of the product, not noise: "Galaxy S26" and
 * "Galaxy S26 FE" are different products and must never be merged.
 */
(function (root) {
  'use strict';

  // Qualifiers that make a DISTINCT product rather than a variant to fold in.
  var QUALIFIERS = ['FE', 'Ultra', 'Plus', 'Pro', 'Max', 'Lite', 'Edge', 'Mini', 'Flip', 'Fold'];
  var QUAL_RE = new RegExp('^(' + QUALIFIERS.join('|') + ')$', 'i');

  // Families whose model numbers we recognise in running text.
  var FAMILIES = [
    'Galaxy', 'Odyssey', 'Neo QLED', 'QLED', 'OLED', 'Bespoke', 'Book',
    'Watch', 'Buds', 'Tab', 'SmartThings', 'Knox', 'Frame', 'Music Frame',
  ];

  /* Named lines that carry no model number but ARE products, and the
   * features/sub-brands that are NOT - "Galaxy AI" is a capability that
   * appears across every device, so counting it as a product buries the
   * real ones. */
  var NAMED_LINES = [
    'Galaxy A Series', 'Galaxy M Series', 'Galaxy S Series', 'Galaxy Z Series',
    'SmartThings Pro', 'SmartThings', 'Samsung VXT', 'Odyssey', 'The Frame',
    'Music Frame', 'Bespoke AI', 'Knox',
  ];
  var NOT_PRODUCTS = /^(galaxy ai|galaxy store|galaxy themes|samsung galaxy|galaxy|samsung|with galaxy|galaxy s|galaxy a|galaxy z|galaxy m)$/i;

  // Lines with no model number. Order matters: longer phrases first.
  var CATEGORIES = [
    ['Washing machine', /\bwashing machine|\bwashers?\b|\bfront load\b|\btop load\b/i],
    ['Air conditioner', /\bair conditioner|\bair-conditioner|\bwindcool\b|\bsplit AC\b|\bAC\b(?!\w)/i],
    ['Refrigerator', /\brefrigerator|\bfridge\b|\bside by side\b|\bfrench door\b/i],
    ['Television', /\bTV\b|\btelevision\b|\bQLED\b|\bOLED\b|\bthe frame\b/i],
    ['Soundbar', /\bsound ?bar\b/i],
    ['Microwave', /\bmicrowave\b|\boven\b/i],
    ['Dishwasher', /\bdishwasher\b/i],
    ['Vacuum', /\bvacuum\b|\bjet bot\b/i],
    ['Monitor', /\bmonitor\b|\bgaming monitor\b/i],
    ['Laptop', /\blaptop\b|\bnotebook\b/i],
    ['Tablet', /\btablet\b/i],
    ['Earbuds', /\bearbuds?\b|\bheadphones?\b/i],
    ['Smartwatch', /\bsmart ?watch\b/i],
    ['Smartphone', /\bsmartphone\b|\bphone\b/i],
  ];

  /* "#GalaxyZFold8Ultra" -> "Galaxy Z Fold8 Ultra".
   * Splits on case changes and on letter/digit boundaries, but keeps a model
   * number glued to its letters ("Fold8", "S26", "A36"). */
  function splitCamel(s) {
    return String(s)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/(\d)([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var SKIP_TAGS = /^(samsung|india|samsungindia|ad|sponsored|reels?|trending|viral|explore|foryou|fyp|shorts|love|life|tech|technology|innovation|new|now|today)$/i;

  function fromHashtags(text) {
    var out = [];
    var re = /#([A-Za-z][A-Za-z0-9]{2,40})/g, m;
    while ((m = re.exec(String(text || '')))) {
      var tag = m[1];
      if (SKIP_TAGS.test(tag)) continue;
      var words = splitCamel(tag);
      // A product tag names a model (S26, Fold8) or matches a known line.
      // Requiring that keeps slogans out: "#WelcomeToGalaxyS" mentions the
      // family but names no product.
      var hasModel = /[A-Za-z]\d/.test(words);
      var isLine = NAMED_LINES.some(n => new RegExp('^' + n.replace(/ /g, '\\s+') + '$', 'i').test(words));
      if (!hasModel && !isLine) continue;
      out.push(words);
    }
    return out;
  }

  /* "Galaxy S26 Ultra", "Galaxy Book5 Pro", "Galaxy Watch Ultra2" */
  function fromModels(text) {
    var t = String(text || '');
    var out = [];
    var fam = '(?:' + FAMILIES.map(f => f.replace(/ /g, '\\s+')).join('|') + ')';
    // family, then up to three short tokens, at least one carrying a digit
    var re = new RegExp(fam + '((?:\\s+[A-Za-z]{1,10}\\d{0,3}){1,3})', 'gi');
    var m;
    while ((m = re.exec(t))) {
      var head = m[0].slice(0, m[0].length - m[1].length).trim();
      var tail = m[1].trim().split(/\s+/);
      var kept = [];
      for (var i = 0; i < tail.length; i++) {
        var w = tail[i];
        // a lone capital is a series marker (Galaxy *Z* Flip8) and carries on
        if (/\d/.test(w) || QUAL_RE.test(w) || /^[A-Z]$/.test(w)) { kept.push(w); continue; }
        break;   // a plain word ends the product name
      }
      // a lone capital is only a series marker when a model follows it, so a
      // trailing one is sentence text ("Galaxy S26 FE I love...") - drop it
      while (kept.length && /^[A-Za-z]$/.test(kept[kept.length - 1])) kept.pop();
      if (!kept.length) continue;
      // a model token is a letter-plus-digits form (S26, Fold8, A37), never a
      // lone letter - otherwise "Welcome to Galaxy S..." becomes a product
      if (!kept.some(w => /[A-Za-z]\d|^\d{2,}$/.test(w))) continue;
      out.push(titleCase(head + ' ' + kept.join(' ')));
    }
    // bare model tokens that stand alone in marketing copy: "A36 5G"
    var bare = t.match(/\b([A-Z]\d{2,3}(?:\s+(?:FE|Ultra|Plus|Pro|Max|Lite))?)\b/g) || [];
    bare.forEach(b => out.push(titleCase(b)));
    return out;
  }

  function titleCase(s) {
    return String(s).replace(/\s+/g, ' ').trim()
      .split(' ')
      .map(w => QUAL_RE.test(w) ? w.toUpperCase().replace(/^(ULTRA|PLUS|PRO|MAX|LITE|EDGE|MINI|FLIP|FOLD)$/,
        (x) => x[0] + x.slice(1).toLowerCase()) : w)
      .join(' ');
  }

  function fromNamedLines(text) {
    var t = String(text || '');
    var out = [];
    NAMED_LINES.forEach(function (n) {
      var re = new RegExp('\\b' + n.replace(/ /g, '\\s+') + '\\b', 'i');
      if (re.test(t)) out.push(n);
    });
    return out;
  }

  function fromCategories(text) {
    var t = String(text || '');
    var out = [];
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i][1].test(t)) out.push(CATEGORIES[i][0]);
    }
    return out;
  }

  /* Normalise for comparison WITHOUT collapsing distinct products: case and
   * spacing are ignored, qualifiers are not. */
  function key(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /* All products a single post mentions, most specific first. A longer name
   * that contains a shorter one wins ("Galaxy S26 FE" beats "S26"), so a post
   * about the FE is not also counted against the plain S26. */
  function detectProducts(text) {
    var all = fromHashtags(text).concat(fromModels(text)).concat(fromNamedLines(text))
      .filter(function (n) { return !NOT_PRODUCTS.test(String(n).trim()); });
    var named = [];
    var seen = Object.create(null);
    all.forEach(function (n) {
      var k = key(n);
      if (!k || seen[k]) return;
      seen[k] = true;
      named.push(n);
    });
    /* Within one post, "S26 FE" and "Galaxy S26 FE" are the same product
     * written twice, so drop the shorter SUFFIX spelling - otherwise the post
     * is counted against both. Deliberately not done for prefixes: "Galaxy
     * S26" is a prefix of "Galaxy S26 FE" but a different product, and a post
     * mentioning both must count for both. */
    named = named.filter(function (n) {
      var k = key(n);
      return !named.some(function (o) {
        var ok2 = key(o);
        return o !== n && ok2.length > k.length && ok2.slice(ok2.length - k.length) === k;
      });
    });
    if (named.length) return named;
    return fromCategories(text);   // fall back to the category only if no model
  }

  /* Across a whole scrape: what products are present, and how many posts each.
   * Rows that matched nothing are counted separately and shown to the user -
   * a filter that silently drops what it could not read is worse than none. */
  function discoverProducts(rows, textOf) {
    var get = textOf || function (r) {
      return [r.Caption, r.Headline, r['Image Text'], r.Description].filter(Boolean).join(' ');
    };
    var counts = new Map();
    var unmatched = 0;
    rows.forEach(function (r) {
      var found = detectProducts(get(r));
      if (!found.length) { unmatched++; return; }
      found.forEach(function (n) {
        var k = key(n);
        var cur = counts.get(k) || { name: n, count: 0 };
        // keep the longest spelling seen, e.g. "Galaxy S26 FE" over "S26 FE"
        if (n.length > cur.name.length) cur.name = n;
        cur.count++;
        counts.set(k, cur);
      });
    });
    /* "S26 FE" and "Galaxy S26 FE" are the same product written two ways, so
     * fold the shorter into the longer when one is a suffix of the other.
     * A PREFIX relationship is left alone on purpose: "Galaxy S26" and
     * "Galaxy S26 FE" are genuinely different products. */
    var entries = [...counts.values()];
    entries.sort(function (a, b) { return key(b.name).length - key(a.name).length; });
    var merged = [];
    entries.forEach(function (e) {
      var k = key(e.name);
      var host = merged.find(function (m) {
        var mk = key(m.name);
        return mk.length > k.length && mk.slice(mk.length - k.length) === k;
      });
      if (host) { host.count += e.count; host.aliases = (host.aliases || []).concat(e.name); }
      else merged.push(e);
    });
    var list = merged.sort(function (a, b) {
      return b.count - a.count || a.name.localeCompare(b.name);
    });
    return { products: list, unmatched: unmatched, total: rows.length };
  }

  var API = {
    detectProducts: detectProducts,
    discoverProducts: discoverProducts,
    splitCamel: splitCamel,
    key: key,
    QUALIFIERS: QUALIFIERS,
  };
  root.ScrapeSuiteProducts = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
