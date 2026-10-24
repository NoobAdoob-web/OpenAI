/* Derived columns and cross-ad aggregates for the ad-library export.
 *
 * One analysis pass feeds three outputs so they can never disagree: the
 * Executive Summary sheet, the per-ad derived columns (Type of creative /
 * Campaign Signals / Creative Language), and the HTML insights report.
 *
 * Everything here is a pure function of text already collected on-device.
 */

// ── Offer signals ──────────────────────────────────────────────────────────
// Ordered: the first matching campaign rule wins, so keep the specific ones up top.
const OFFER_RULES = [
  ['Percentage discount', /\b\d{1,2}\s?%\s*(off|discount|less)\b|\bflat\s*\d{1,2}\s?%|\bupto\s*\d{1,2}\s?%/i],
  ['Price mentioned', /(?:₹|Rs\.?\s?|INR\s?|\$|£|€)\s?\d[\d,]*(?:\.\d+)?/i],
  ['EMI / financing', /\bEMI\b|no[- ]cost emi|installments?|\bfinanc(?:e|ing)\b/i],
  ['Cashback', /\bcash\s?back\b/i],
  ['Bank offer', /\bbank offer\b|\bcard offer\b|\b(?:HDFC|ICICI|SBI|Axis|Kotak)\b/i],
  ['Exchange offer', /\bexchange (?:offer|bonus|value)\b|\btrade[- ]in\b/i],
  ['Free delivery', /\bfree (?:delivery|shipping)\b/i],
  ['Buy one get one', /\bbuy\s*1\s*get\s*1\b|\bBOGO\b|\bbuy one,? get one\b/i],
  ['Urgency/scarcity', /\b(?:hurry|last (?:day|chance)|limited (?:time|period|stock)|ends? (?:today|soon|tonight)|while stocks last|only \d+ left|don'?t miss)\b/i],
  ['Festive/seasonal', /\b(?:diwali|dussehra|navratri|holi|eid|christmas|new year|festive|black friday|republic day|independence day|big billion|great indian)\b/i],
];

function detectOfferSignals(text) {
  const t = String(text || '');
  return OFFER_RULES.filter(([, re]) => re.test(t)).map(([name]) => name);
}

// ── Campaign signal ────────────────────────────────────────────────────────
const LAUNCH_RE = /\b(?:introducing|launching|now available|new(?:ly)? launched|pre[- ]?book|pre[- ]?order|coming soon|unveil|meet the)\b/i;
const PERF_RE = /\b(?:shop now|buy now|order now|book now|sign up|download|get the app|register|apply now|claim)\b/i;

/* Returns one of:
 *   Offer/Discount-led · Launch/Announcement · Direct Response
 *   General Product Ad · Brand Awareness (unconfirmed — no strong text signal)
 * The last is deliberately hedged: with no usable text we are guessing, and
 * the column should say so rather than assert a category. */
function classifyCampaign(text, cta) {
  const t = String(text || '');
  const sig = detectOfferSignals(t);
  const discounty = sig.some(s => s !== 'Price mentioned' && s !== 'Festive/seasonal');
  if (discounty || (sig.includes('Percentage discount'))) return 'Offer/Discount-led';
  if (LAUNCH_RE.test(t)) return 'Launch/Announcement';
  if (sig.includes('Price mentioned')) return 'Offer/Discount-led';
  if (PERF_RE.test(t) || PERF_RE.test(String(cta || ''))) return 'Direct Response';
  if (t.replace(/[\s#@]/g, '').length >= 25) return 'General Product Ad';
  return 'Brand Awareness (unconfirmed — no strong text signal)';
}

// ── Product vertical ───────────────────────────────────────────────────────
const VERTICALS = [
  ['Electronics & Gadgets', /\b(?:phone|smartphone|galaxy|iphone|laptop|tablet|tv|television|headphone|earbud|smartwatch|camera|console|ssd|processor|5g|android|refrigerator|washing machine|air ?conditioner|\bAC\b)\b/i],
  ['Fashion & Apparel', /\b(?:shirt|t-?shirt|dress|jeans|kurta|saree|footwear|sneaker|shoes|apparel|clothing|wardrobe|outfit|denim)\b/i],
  ['Beauty & Personal Care', /\b(?:skincare|serum|moisturis|shampoo|lipstick|fragrance|perfume|makeup|cosmetic|haircare|sunscreen)\b/i],
  ['Food & Beverage', /\b(?:snack|beverage|coffee|tea|chocolate|biscuit|restaurant|delivery in|recipe|flavou?r|protein (?:shake|bar))\b/i],
  ['Travel & Hospitality', /\b(?:flight|hotel|holiday|vacation|booking|resort|getaway|airline|staycation|itinerary)\b/i],
  ['Finance & Insurance', /\b(?:loan|credit card|insurance|mutual fund|investment|savings account|premium|policy|demat|sip)\b/i],
  ['Automotive', /\b(?:car|suv|sedan|bike|motorcycle|scooter|mileage|test drive|showroom|ev\b|electric vehicle)\b/i],
  ['Home & Furniture', /\b(?:sofa|mattress|furniture|interior|decor|kitchen|cookware|bedsheet|curtain)\b/i],
  ['Health & Wellness', /\b(?:supplement|vitamin|fitness|wellness|clinic|doctor|therapy|immunity|diagnostic)\b/i],
  ['Education', /\b(?:course|admission|scholarship|university|college|exam|coaching|certification|upskill)\b/i],
  ['Gaming', /\b(?:gaming|gamer|esports|rummy|fantasy (?:cricket|sports)|play now)\b/i],
  ['Telecom', /\b(?:recharge|prepaid|postpaid|data pack|unlimited calls|broadband|fiber)\b/i],
];

function classifyVertical(text) {
  const t = String(text || '');
  for (const [name, re] of VERTICALS) if (re.test(t)) return name;
  return 'Uncategorised';
}

// ── Language ───────────────────────────────────────────────────────────────
/* We only claim what we can show. If OCR actually read on-screen text we say
 * so; if the copy is Latin-only with no OCR we mark it assumed; for a video
 * with no OCR we say plainly that it was not verified. */
function describeLanguage(row) {
  const ocr = String(row['Image Text'] || '').trim();
  const copy = String(row.Description || '');
  const sample = (ocr + ' ' + copy).trim();
  if (!sample) return 'Unknown — no text found';
  const script =
    /[ऀ-ॿ]/.test(sample) ? 'Devanagari' :
    /[؀-ۿ]/.test(sample) ? 'Arabic' :
    /[一-鿿぀-ヿ]/.test(sample) ? 'CJK' : 'Latin';
  if (script !== 'Latin') return script + ' script detected';
  if (ocr) return 'English (read from creative)';
  if (String(row['Asset type'] || '').toLowerCase() === 'video') {
    return 'Not verified — creative not read; ad copy is English';
  }
  return 'English (assumed)';
}

/* Fill the three derived columns on a row, without overwriting anything an
 * extractor already established. */
function applyDerivedColumns(row) {
  const text = [row.Description, row.Headline, row['Image Text']].filter(Boolean).join(' ');
  if (!row['Type of creative']) row['Type of creative'] = classifyVertical(text);
  if (!row['Campaign Signals']) row['Campaign Signals'] = classifyCampaign(text, row.CTA);
  if (!row['Creative Language']) row['Creative Language'] = describeLanguage(row);
  if (!row['Offer Signals']) row['Offer Signals'] = detectOfferSignals(text).join(', ');
  return row;
}

// ── Aggregates ─────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* The Date column holds the rendered label, e.g. "Started running on 27 Sep
 * 2026". Parse it back out rather than requiring a second field. */
function parseAdDate(v) {
  const m = String(v || '').match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].slice(0, 3));
  if (mi < 0) return null;
  return { y: +m[3], m: mi, d: +m[1] };
}

function tally(values) {
  const map = new Map();
  values.filter(v => v !== '' && v != null).forEach(v => map.set(v, (map.get(v) || 0) + 1));
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function computeAdsAnalysis(rows) {
  const n = rows.length;
  const isVideo = r => /video/i.test(r['Asset type'] || '');
  const active = rows.filter(r => /active/i.test(r.Status || '') && !/inactive/i.test(r.Status || ''));

  const dates = rows.map(r => parseAdDate(r.Date)).filter(Boolean);
  let range = 'n/a';
  if (dates.length) {
    const key = d => d.y * 12 + d.m;
    const lo = dates.reduce((a, b) => (key(b) < key(a) ? b : a));
    const hi = dates.reduce((a, b) => (key(b) > key(a) ? b : a));
    const fmt = d => `${MONTHS[d.m]}-${d.y}`;
    range = fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} → ${fmt(hi)}`;
  }

  // Offer signals are multi-valued per ad, so count ads-per-signal.
  const offerCounts = new Map();
  rows.forEach(r => {
    const list = r['Offer Signals']
      ? String(r['Offer Signals']).split(',').map(s => s.trim()).filter(Boolean)
      : detectOfferSignals([r.Description, r.Headline, r['Image Text']].filter(Boolean).join(' '));
    new Set(list).forEach(s => offerCounts.set(s, (offerCounts.get(s) || 0) + 1));
  });

  const quarters = new Map();
  dates.forEach(d => {
    const q = Math.floor(d.m / 3);
    const label = `${MONTHS[q * 3]}-${MONTHS[q * 3 + 2]} ${d.y}`;
    quarters.set(label, (quarters.get(label) || 0) + 1);
  });

  const durations = rows
    .map(r => (String(r['Creative Duration'] || '').match(/(\d+)\s*sec/i) || [])[1])
    .filter(Boolean).map(Number);

  return {
    count: n,
    active: active.length,
    inactive: n - active.length,
    video: rows.filter(isVideo).length,
    image: rows.filter(r => r['Asset type'] && !isVideo(r)).length,
    dateRange: range,
    brands: tally(rows.map(r => r.Brand)),
    assetTypes: tally(rows.map(r => (isVideo(r) ? 'Video' : r['Asset type'] ? 'Display (image)' : ''))),
    verticals: tally(rows.map(r => r['Type of creative'])),
    campaigns: tally(rows.map(r => r['Campaign Signals'])),
    languages: tally(rows.map(r => r['Creative Language'])),
    ctas: tally(rows.map(r => r.CTA).filter(v => v && v !== '-')),
    domains: tally(rows.map(r => r['Landing Page'])),
    offers: [...offerCounts.entries()].sort((a, b) => b[1] - a[1]),
    cadence: [...quarters.entries()].sort(),
    avgDuration: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
  };
}

/* Label/value pairs for the Executive Summary sheet. Kept in the reference
 * workbook's order so the two files line up column for column. */
function buildAdsSummaryPairs(a) {
  const pairs = [
    ['Total ads', a.count],
    ['Active', a.active],
    ['Inactive', a.inactive],
    ['Video creatives', a.video],
    ['Image creatives', a.image],
    ['Date range', a.dateRange],
  ];
  if (a.avgDuration) pairs.push(['Average video duration', a.avgDuration + 'sec']);
  const block = (title, entries, limit) => {
    if (!entries.length) return;
    pairs.push(['', '']);
    pairs.push([title, '']);
    entries.slice(0, limit || 10).forEach(([k, v]) => pairs.push([k, v]));
  };
  block('Advertisers Scraped', a.brands);
  block('Top Landing Domains', a.domains);
  block('Top CTAs', a.ctas);
  block('Offer Signals Detected', a.offers);
  block('Campaign Signals', a.campaigns);
  return pairs;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectOfferSignals, classifyCampaign, classifyVertical, describeLanguage,
    applyDerivedColumns, computeAdsAnalysis, buildAdsSummaryPairs, parseAdDate, tally,
  };
}
