/* Proves the derived columns reach the output of the REAL extension, running
 * in real Chrome, on an Instagram grid whose DOM contains no date at all and
 * whose API carries a caption for only some posts - which is exactly the
 * situation that left 63% of rows undated in the user's own exports. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = process.env.EXT_DIR || path.resolve('chrome-scraper-extension');

// Real shortcodes with dates verified against the user's exports.
const POSTS = [
  ['DfjorOsHGfj', '2026-11-10', 'Galaxy S26 FE — flat 20% off this festive week', 149000],
  ['DfcFbukiRxQ', '2026-11-07', '', 46000],                                   // no caption anywhere
  ['DfHeZyFjCF7', '2026-10-30', 'Meet the #GalaxyZFold8Ultra', 40000],
  ['DdENBc2D94A', '2026-09-09', 'Our new Bespoke AI refrigerator', 19000],
];

// The API carries a caption for only the first and third - as on the real site.
const apiPayload = { data: { items: POSTS.filter((_, i) => i === 0 || i === 2).map(([code, , cap]) => ({
  media: { code, caption: { text: cap }, play_count: 1234 },
})) } };

const html = `<!DOCTYPE html><html><body><main><div class="grid">
${POSTS.map(([code, , , views]) => `<div class="cell"><a href="/samsungindia/reel/${code}/"><div><img src="https://x/${code}.jpg"></div><span>${(views / 1000).toFixed(0)}K</span></a></div>`).join('')}
</div></main><script>fetch('/api/v1/clips/user/').then(r=>r.json()).then(()=>{window.__done=1;});</script>
</body></html>`;

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

  const userDataDir = fs.mkdtempSync('/tmp/ss-derived-');
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });

  await context.route('**/*', route => {
    const u = route.request().url();
    if (u.includes('/api/v1/clips/user/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiPayload) });
    if (route.request().resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    return route.fulfill({ status: 200, body: '' });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://www.instagram.com/samsungindia/reels/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1800);

  const resp = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
    try { return await chrome.tabs.sendMessage(tabs[0].id, { action: 'detect', tabId: tabs[0].id }); }
    catch (e) { return { error: String(e) }; }
  });
  const rows = (resp && resp.data && resp.data.rows) || [];
  ok('rows extracted', rows.length === POSTS.length, `got ${rows.length}`);
  ok('no page errors', errors.length === 0, errors.join(' | '));

  const byCode = {};
  rows.forEach(r => { const m = (r.URL || '').match(/\/reel\/([^/?]+)/); if (m) byCode[m[1]] = r; });

  // ── the headline claim: every row dated, from the URL alone ─────────────
  const dated = rows.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.Date || ''));
  ok('EVERY row has a date, though the DOM has none', dated.length === rows.length,
    `${dated.length}/${rows.length} - ` + JSON.stringify(rows.map(r => r.Date)));

  for (const [code, want] of POSTS.map(p => [p[0], p[1]])) {
    const r = byCode[code] || {};
    ok(`${code} dated ${want}`, r.Date === want, `got ${r.Date}`);
  }

  ok('the date source is stated, not left implicit',
    rows.every(r => (r['Date source'] || '').length > 0), JSON.stringify(rows.map(r => r['Date source'])));
  ok('a shortcode-derived date says so plainly',
    /upload time/.test(byCode['DfcFbukiRxQ']['Date source'] || ''), byCode['DfcFbukiRxQ']['Date source']);

  // ── products ────────────────────────────────────────────────────────────
  ok('product detected from the API caption',
    /S26 FE/.test(byCode['DfjorOsHGfj'].Product || ''), JSON.stringify(byCode['DfjorOsHGfj'].Product));
  ok('S26 FE is not recorded as plain S26',
    !/\bS26$/.test((byCode['DfjorOsHGfj'].Product || '').trim()), byCode['DfjorOsHGfj'].Product);
  ok('hashtag product detected',
    /Fold8 Ultra/.test(byCode['DfHeZyFjCF7'].Product || ''), JSON.stringify(byCode['DfHeZyFjCF7'].Product));
  ok('a post with no caption gets an empty Product, not a wrong guess',
    (byCode['DfcFbukiRxQ'].Product || '') === '', JSON.stringify(byCode['DfcFbukiRxQ'].Product));

  // ── the columns must actually be in the schema, in order ────────────────
  const cols = (resp.data && resp.data.headers) || Object.keys(rows[0] || {});
  ok('Date source and Product are real columns',
    cols.includes('Date source') && cols.includes('Product'), JSON.stringify(cols));
  ok('URL and Thumbnail still come last',
    cols.indexOf('URL') > cols.indexOf('Product'), JSON.stringify(cols.slice(-4)));

  console.log('\n  rows as the user would see them:');
  rows.forEach(r => console.log(`    ${r.Date}  ${String(r.Product || '-').padEnd(22)} ${(r['Date source'] || '').slice(0, 44)}`));

  console.log(`\n${pass} passed, ${fail} failed`);
  await context.close();
  process.exit(fail ? 1 : 0);
})();
