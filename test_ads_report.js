/* Tests the derived columns, the cross-ad aggregates and the HTML report.
 *
 * The report is then LOADED IN REAL CHROME and read back from the DOM, so
 * "the report is right" means a browser parsed it and found the numbers -
 * not that a regex matched our own output. */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const A = require('./chrome-scraper-extension/popup/ads_analysis.js');
const R = require('./chrome-scraper-extension/popup/ads_report.js');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

// ── derived columns ────────────────────────────────────────────────────────
console.log('\nDerived columns');
ok('percentage discount detected',
  A.detectOfferSignals('Flat 20% off this festive week').includes('Percentage discount'));
ok('rupee price detected',
  A.detectOfferSignals('EMI starting ₹ 2525/month*').includes('Price mentioned'));
ok('EMI detected separately',
  A.detectOfferSignals('EMI starting ₹ 2525/month*').includes('EMI / financing'));
ok('exchange offer detected',
  A.detectOfferSignals('Get up to 10,000 exchange bonus').includes('Exchange offer'));
ok('urgency detected',
  A.detectOfferSignals('Hurry, offer ends today!').includes('Urgency/scarcity'));
ok('festive detected',
  A.detectOfferSignals('Celebrate the festive season with Galaxy S26 FE').includes('Festive/seasonal'));
ok('no false positive on plain brand copy',
  A.detectOfferSignals('Unfold your inner fan on the #GalaxyZFold8').length === 0,
  JSON.stringify(A.detectOfferSignals('Unfold your inner fan on the #GalaxyZFold8')));

ok('discount copy classified offer-led',
  A.classifyCampaign('Galaxy S26 FE — flat 20% off this festive week') === 'Offer/Discount-led');
ok('launch copy classified as launch',
  A.classifyCampaign('Introducing the all-new Galaxy Z Fold8') === 'Launch/Announcement');
ok('cta-only copy classified direct response',
  A.classifyCampaign('The moment won’t wait.', 'Shop Now') === 'Direct Response');
ok('thin copy stays hedged, not asserted',
  /unconfirmed/.test(A.classifyCampaign('#Samsung')), A.classifyCampaign('#Samsung'));

ok('phone copy -> electronics',
  A.classifyVertical('Unstoppable 5000 mAh battery in Galaxy Z Fold8 smartphone') === 'Electronics & Gadgets');
ok('loan copy -> finance',
  A.classifyVertical('Personal loan at low interest, apply now') === 'Finance & Insurance');
ok('unknown copy -> Uncategorised, not a wrong guess',
  A.classifyVertical('A moment worth sharing') === 'Uncategorised');

ok('ocr-read language stated as read',
  A.describeLanguage({ 'Image Text': 'SAVE 20% TODAY', 'Asset type': 'Image' }) === 'English (read from creative)');
ok('video with no ocr is marked not verified',
  /Not verified/.test(A.describeLanguage({ Description: 'Galaxy Fold', 'Asset type': 'Video' })));
ok('devanagari detected',
  /Devanagari/.test(A.describeLanguage({ Description: 'आज ही खरीदें', 'Asset type': 'Image' })));

const row = { Description: 'Flat 20% off on Galaxy S26 smartphone. Hurry, ends today!', 'Asset type': 'Image', CTA: 'Shop Now' };
A.applyDerivedColumns(row);
ok('applyDerivedColumns fills all four', !!(row['Type of creative'] && row['Campaign Signals'] &&
  row['Creative Language'] && row['Offer Signals']), JSON.stringify(row));
const preset = { Description: 'x', 'Type of creative': 'Preset Vertical' };
A.applyDerivedColumns(preset);
ok('does not overwrite an extractor-supplied value', preset['Type of creative'] === 'Preset Vertical');

// ── aggregates ─────────────────────────────────────────────────────────────
console.log('\nAggregates');
const rows = [
  { Brand: 'Samsung', Status: 'Active', Date: 'Started running on 27 Sep 2026', 'Asset type': 'Video',
    CTA: '-', 'Landing Page': 'samsung.com', 'Creative Duration': '20sec',
    Description: 'Unstoppable 5000 mAh battery in Galaxy Z Fold8 Ultra. EMI starting ₹ 2525/month*.',
    __links: { 'Ad Preview Link': 'https://www.facebook.com/ads/library/?id=1' } },
  { Brand: 'Samsung', Status: 'Active', Date: 'Started running on 5 Oct 2026', 'Asset type': 'Image',
    CTA: 'Shop Now', 'Landing Page': 'samsung.com', Description: 'Galaxy S26 FE — flat 20% off this festive week.' },
  { Brand: 'Samsung', Status: 'Inactive', Date: 'Started running on 10 Oct 2026', 'Asset type': 'Image',
    CTA: 'Learn More', 'Landing Page': 'flipkart.com', Description: 'Introducing the all-new Galaxy Z Fold8 smartphone.' },
];
rows.forEach(A.applyDerivedColumns);
const a = A.computeAdsAnalysis(rows);

ok('counts', a.count === 3 && a.active === 2 && a.inactive === 1, JSON.stringify([a.count, a.active, a.inactive]));
ok('"Inactive" is not counted as active', a.active === 2, String(a.active));
ok('video/image split', a.video === 1 && a.image === 2, JSON.stringify([a.video, a.image]));
ok('date range spans the months', a.dateRange === 'Sep-2026 → Oct-2026', a.dateRange);
ok('cadence bucketed by quarter', a.cadence.length === 2 &&
  a.cadence[0][0] === 'Jul-Sep 2026' && a.cadence[1][0] === 'Oct-Dec 2026', JSON.stringify(a.cadence));
ok('domains tallied, most common first',
  a.domains[0][0] === 'samsung.com' && a.domains[0][1] === 2, JSON.stringify(a.domains));
ok('CTAs exclude the "-" placeholder',
  !a.ctas.some(([c]) => c === '-'), JSON.stringify(a.ctas));
ok('offer signals counted per-ad, not per-match',
  a.offers.every(([, n]) => n <= 3) && a.offers.some(([s]) => s === 'Percentage discount'), JSON.stringify(a.offers));
ok('average video duration', a.avgDuration === 20, String(a.avgDuration));

const pairs = A.buildAdsSummaryPairs(a);
const flat = Object.fromEntries(pairs.filter(p => p[1] !== '').map(p => [p[0], p[1]]));
ok('summary pairs lead with the reference order',
  pairs[0][0] === 'Total ads' && pairs[3][0] === 'Video creatives', JSON.stringify(pairs.slice(0, 4)));
ok('summary carries the date range', flat['Date range'] === 'Sep-2026 → Oct-2026');

// ── report, parsed by a real browser ───────────────────────────────────────
(async () => {
  console.log('\nHTML report (loaded in Chrome)');
  const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
  const html = R.buildAdsReportHtml(rows, a, { 0: px, 1: px }, { generatedAt: '23/10/2026, 12:35:13' });

  const out = path.join(process.env.SCRATCH || '/tmp', 'ads-report-test.html');
  fs.writeFileSync(out, html);

  ok('no <script> in the output', !/<script/i.test(html));
  ok('exactly one <style>', (html.match(/<style/g) || []).length === 1);
  ok('no external resource references',
    !/(src|href)\s*=\s*"https?:\/\/(?!www\.facebook\.com\/ads\/library)/i.test(html));

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + out);

  const seen = await page.evaluate(() => {
    const txt = el => (el ? el.textContent.trim() : '');
    const stats = {};
    document.querySelectorAll('.ai-stat').forEach(s => {
      stats[txt(s.querySelector('.ai-stat-label'))] = txt(s.querySelector('.ai-stat-value'));
    });
    return {
      title: txt(document.querySelector('h1')),
      sub: txt(document.querySelector('.ai-report-header p')),
      stats,
      sections: [...document.querySelectorAll('.ai-section-head h2')].map(h => h.textContent.trim()),
      bars: [...document.querySelectorAll('.ai-bar-row')].length,
      widths: [...document.querySelectorAll('.ai-bar-fill')].map(b => b.style.width),
      cards: document.querySelectorAll('.ai-gcard').length,
      imgs: document.querySelectorAll('.ai-gcard img').length,
      noimg: document.querySelectorAll('.ai-gnoimg').length,
      firstCopy: txt(document.querySelector('.ai-gcopy')),
      offerTags: [...document.querySelectorAll('.ai-tag.offer')].map(t => t.textContent.trim()),
      links: [...document.querySelectorAll('.ai-glink')].map(x => x.href),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    };
  });

  ok('no page errors', errors.length === 0, errors.join(' | '));
  ok('header renders', /Insights Report/.test(seen.title), seen.title);
  ok('subtitle carries count and timestamp',
    seen.sub.includes('3 ads analysed') && seen.sub.includes('23/10/2026'), seen.sub);
  ok('stat row matches the analysis',
    seen.stats['Total ads'] === '3' && seen.stats['Active'] === '2' &&
    seen.stats['Video creatives'] === '1' && seen.stats['Date range'] === 'Sep-2026 → Oct-2026',
    JSON.stringify(seen.stats));
  const want = ['Advertisers scraped', 'Video vs display', 'Type of creative (product vertical)',
    'Campaign signals', 'Language breakdown', 'Top CTAs', 'Top landing domains',
    'Offer signals detected', 'Posting cadence (by quarter)'];
  ok('all nine chart sections present, in the reference order',
    JSON.stringify(seen.sections.slice(0, 9)) === JSON.stringify(want), JSON.stringify(seen.sections));
  ok('gallery section titled with the count',
    /All creatives \(3\)/.test(seen.sections[9] || ''), seen.sections[9]);
  ok('bars rendered', seen.bars >= 12, String(seen.bars));
  ok('largest bar is full width', seen.widths.includes('100%'), JSON.stringify(seen.widths.slice(0, 5)));
  ok('bar widths are all valid percentages',
    seen.widths.every(w => /^\d+(\.\d+)?%$/.test(w)), JSON.stringify(seen.widths.slice(0, 5)));
  ok('one gallery card per ad', seen.cards === 3, String(seen.cards));
  ok('screenshots rendered where supplied', seen.imgs === 2, String(seen.imgs));
  ok('missing screenshot shows a placeholder, not a broken image', seen.noimg === 1, String(seen.noimg));
  ok('ad copy present in the card', /5000 mAh/.test(seen.firstCopy), seen.firstCopy);
  ok('offer signals surface as tags', seen.offerTags.length > 0, JSON.stringify(seen.offerTags));
  ok('ad library permalink is a real link',
    seen.links.some(h => h.includes('facebook.com/ads/library')), JSON.stringify(seen.links));
  ok('styles applied (dark panel, not default white)',
    seen.bodyBg !== 'rgba(0, 0, 0, 0)' && seen.bodyBg !== 'rgb(255, 255, 255)', seen.bodyBg);
  ok('no horizontal overflow at default width', seen.overflow === true);

  // narrow viewport: the report has to survive being opened on a laptop split-screen
  await page.setViewportSize({ width: 420, height: 900 });
  const narrow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('no horizontal overflow at 420px', narrow === true);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
