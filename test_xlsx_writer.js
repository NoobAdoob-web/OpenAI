/* Unit-tests the OOXML writer, then validates the result with a real
 * spreadsheet reader (openpyxl) via verify_xlsx.py — the same reader used to
 * dissect the reference AdSignal workbook, so "it opens" means the same thing.
 *
 * Covers what the ad-library export needs on top of the old writer: an
 * embedded screenshot per row, two external hyperlinks per row, column widths
 * and row heights, plus a second sheet with none of that. */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const X = require('./chrome-scraper-extension/popup/xlsx.js');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

// A real (tiny) JPEG, so the reader has to actually decode it.
function jpeg(w, h) {
  // 1x1 baseline JPEG, then patched SOF dimensions to (w,h).
  const b64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEA' +
    'AAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKB' +
    'kaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlq' +
    'c3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ' +
    '2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z';
  const buf = Buffer.from(b64, 'base64');
  for (let i = 2; i < buf.length - 9; i++) {
    if (buf[i] === 0xFF && (buf[i + 1] === 0xC0 || buf[i + 1] === 0xC2)) {
      buf.writeUInt16BE(h, i + 5); buf.writeUInt16BE(w, i + 7); break;
    }
  }
  return new Uint8Array(buf);
}

const HEADERS = ['Brand', 'ID', 'Status', 'Date', 'Asset type', 'CTA', 'Ad Preview Link',
  'Landing Page', 'Headline', 'Description', 'Creative Duration', 'Creative Screenshot',
  'Type of creative', 'Campaign Signals', 'Creative Language'];

const LANDING = 'https://www.samsung.com/in/buy/?cid=in_pd&utm_campaign={{ad.id}}&fbclid=IwZXh0bgN';

const rows = [
  {
    Brand: 'Samsung', ID: 'Library ID: 1075552802051653', Status: 'Active',
    Date: 'Started running on 27 Sep 2026', 'Asset type': 'Video', CTA: '-',
    'Ad Preview Link': 'Open in Ad Library', 'Landing Page': 'samsung.com', Headline: '-',
    Description: 'Unstoppable 5000 mAh battery in Galaxy Z Fold8 Ultra. EMI starting ₹ 2525/month*.',
    'Creative Duration': '20sec', 'Creative Screenshot': '',
    'Type of creative': 'Electronics & Gadgets',
    'Campaign Signals': 'Brand Awareness (unconfirmed — no strong text signal)',
    'Creative Language': 'English (assumed)',
    __links: {
      'Ad Preview Link': 'https://www.facebook.com/ads/library/?id=1075552802051653',
      'Landing Page': LANDING,
    },
    __image: { bytes: jpeg(442, 570), ext: 'jpeg', w: 442, h: 570 },
  },
  {
    Brand: 'Samsung', ID: 'Library ID: 1083570714080419', Status: 'Active',
    Date: 'Started running on 5 Oct 2026', 'Asset type': 'Image', CTA: 'Shop Now',
    'Ad Preview Link': 'Open in Ad Library', 'Landing Page': 'flipkart.com', Headline: '-',
    Description: 'Unfold your inner fan on the #GalaxyZFold8 ✨ <script>alert(1)</script> & co.',
    'Creative Duration': '', 'Creative Screenshot': '',
    'Type of creative': 'Electronics & Gadgets',
    'Campaign Signals': 'Offer/Discount-led', 'Creative Language': 'English (assumed)',
    __links: {
      'Ad Preview Link': 'https://www.facebook.com/ads/library/?id=1083570714080419',
      'Landing Page': 'https://www.flipkart.com/sale?x=1&y=2',
    },
    __image: { bytes: jpeg(338, 600), ext: 'jpeg', w: 338, h: 600 },
  },
];

const summary = [
  ['Total ads', 2], ['Active', 2], ['Inactive', 0],
  ['Video creatives', 1], ['Image creatives', 1],
  ['Date range', 'Sep-2026 → Oct-2026'],
];

const bytes = X.buildWorkbook([
  { name: 'Executive Summary', title: 'AdSignal — Executive Summary',
    headers: [], rows: [], summaryPairs: summary },
  { name: 'Meta Ads', headers: HEADERS, rows,
    imageColumn: 'Creative Screenshot',
    colWidths: { 'Creative Screenshot': 60, Description: 50 } },
]);

const out = path.join(process.env.SCRATCH || '/tmp', 'xlsx-writer-test.xlsx');
fs.writeFileSync(out, Buffer.from(bytes));
ok('workbook produced', bytes.length > 2000, bytes.length + ' bytes');

const report = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, 'verify_xlsx.py'), out],
  { encoding: 'utf8' }));

if (report.error) {
  ok('opens in a real spreadsheet reader', false, report.error);
} else {
  ok('opens in a real spreadsheet reader', true);
  ok('two sheets, named correctly',
    JSON.stringify(report.sheets) === JSON.stringify(['Executive Summary', 'Meta Ads']),
    JSON.stringify(report.sheets));
  ok('summary sheet carries the stat pairs',
    report.summary_pairs['Total ads'] === 2 && report.summary_pairs['Date range'] === 'Sep-2026 → Oct-2026',
    JSON.stringify(report.summary_pairs));
  ok('15 columns in the ads sheet, in order',
    JSON.stringify(report.headers) === JSON.stringify(HEADERS), JSON.stringify(report.headers));
  ok('2 data rows', report.row_count === 2, String(report.row_count));
  ok('unicode survived (rupee, em dash, sparkle)',
    report.rows[0].Description.includes('₹ 2525') &&
    report.rows[0]['Campaign Signals'].includes('—') &&
    report.rows[1].Description.includes('✨'),
    JSON.stringify(report.rows[0].Description));
  ok('xml-unsafe text escaped, not mangled',
    report.rows[1].Description.includes('<script>alert(1)</script>') &&
    report.rows[1].Description.includes('& co.'),
    JSON.stringify(report.rows[1].Description));
  ok('2 images embedded, one per row', report.image_count === 2, String(report.image_count));
  ok('image dimensions preserved',
    JSON.stringify(report.image_sizes) === JSON.stringify([[442, 570], [338, 600]]),
    JSON.stringify(report.image_sizes));
  ok('images anchored to the Creative Screenshot column',
    report.anchor_cols.every(c => c === 11), JSON.stringify(report.anchor_cols));
  ok('images anchored to their own row (not all stacked)',
    JSON.stringify(report.anchor_rows) === JSON.stringify([1, 2]), JSON.stringify(report.anchor_rows));
  ok('row heights match the screenshots',
    report.row_heights[0] > 420 && report.row_heights[1] > 440, JSON.stringify(report.row_heights));
  ok('4 external hyperlinks (2 per row)', report.hyperlink_count === 4, String(report.hyperlink_count));
  ok('ad preview link targets the library permalink',
    report.hyperlinks['G2'] === 'https://www.facebook.com/ads/library/?id=1075552802051653',
    JSON.stringify(report.hyperlinks));
  ok('landing page keeps its full tracking url',
    report.hyperlinks['H2'] === LANDING, JSON.stringify(report.hyperlinks['H2']));
  ok('landing cell still DISPLAYS the bare domain',
    report.rows[0]['Landing Page'] === 'samsung.com', report.rows[0]['Landing Page']);
  ok('column widths applied', report.col_widths['L'] === 60 && report.col_widths['J'] === 50,
    JSON.stringify(report.col_widths));
  ok('summary sheet has no drawing part', report.summary_images === 0, String(report.summary_images));
}

// The original string-only path must still work (social-post export).
const legacy = X.buildXlsx(['Top Performers', 'Raw Data'],
  [X.buildSheetXml(['A', 'B'], [{ A: '1', B: 'x' }], [['Posts', 3]]),
   X.buildSheetXml(['A'], [{ A: 'y' }], null)]);
const out2 = path.join(process.env.SCRATCH || '/tmp', 'xlsx-legacy-test.xlsx');
fs.writeFileSync(out2, Buffer.from(legacy));
const r2 = JSON.parse(execFileSync('python3', ['-I', path.join(__dirname, 'verify_xlsx.py'), out2], { encoding: 'utf8' }));
ok('legacy two-sheet export still opens', !r2.error && r2.sheets.length === 2, r2.error || JSON.stringify(r2.sheets));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
