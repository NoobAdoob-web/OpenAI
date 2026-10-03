/* Proves tools/capture_ads_payloads.js actually captures the page's own
 * ad-library responses (fetch + XHR), scrubs tokens, and ignores noise. */
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const snippet = fs.readFileSync('chrome-scraper-extension/tools/capture_ads_payloads.js', 'utf8');
  let pass = 0, fail = 0;
  const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  const graphql = { data: { ad_library_main: { search_results_connection: { edges: [
    { node: { collated_results: [{ ad_archive_id: '1457675952913913', page_name: 'Flipkaart offer',
        snapshot: { body: { text: 'Vivo V50 at Just ₹899 🔥' }, cta_text: 'Shop Now',
                    link_url: 'https://example.in/v50' },
        start_date: 1791010915, is_active: true, publisher_platform: ['FACEBOOK', 'INSTAGRAM'] }] } },
  ] } } }, access_token: 'EAAB-secret-token' };

  const atc = { 1: [{ 1: 'CR12345', 2: 'AR999', 12: { 1: 'Samsung India' } }], 2: 'cursor-abc' };

  const html = `<!DOCTYPE html><html><body><div id="r">idle</div><script>
    window.__go = async function () {
      // 1. fetch to a graphql endpoint  -> should be captured
      const a = await fetch('/api/graphql/?doc_id=123&access_token=EAAB-secret-token', {method:'POST'});
      const aj = await a.json();
      // 2. XHR to the ATC rpc endpoint  -> should be captured
      await new Promise(res => {
        const x = new XMLHttpRequest();
        x.open('POST', '/anji/_/rpc/SearchService/SearchCreatives?authuser=0');
        x.onload = res; x.send('f.req={}');
      });
      // 3. unrelated request -> must be ignored
      await fetch('/static/bundle.js');
      document.getElementById('r').textContent = aj.data ? 'done' : 'bad';
    };
  </script></body></html>`;

  await context.route('**/*', route => {
    const u = route.request().url();
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    if (u.includes('/api/graphql')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(graphql) });
    }
    if (u.includes('SearchCreatives')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(atc) });
    }
    return route.fulfill({ status: 200, body: 'console.log(1)' });
  });

  await page.goto('https://www.facebook.com/ads/library/?q=samsung', { waitUntil: 'domcontentloaded' });

  // arm the capture tool the same way the user will: paste into the console
  const armed = await page.evaluate(s => { eval(s); return !!window.__ssCapture; }, snippet);
  ok('tool arms without error', armed === true);

  // the page then does its own requests (user scrolling)
  await page.evaluate(() => window.__go());
  await page.waitForFunction(() => document.getElementById('r').textContent !== 'idle');
  await page.waitForTimeout(400);

  const state = await page.evaluate(() => ({
    count: window.__ssCapture.count,
    urls: [0, 1, 2].map(i => (window.__ssCapture.peek(i) || {}).url).filter(Boolean),
    bodies: [0, 1, 2].map(i => (window.__ssCapture.peek(i) || {}).body).filter(Boolean),
  }));

  ok('no page errors', errors.length === 0, errors.join(' | '));
  ok('page still got its own response (clone, not consumed)',
    (await page.textContent('#r')) === 'done');
  ok('captured exactly the 2 interesting responses', state.count === 2, 'count=' + state.count);
  ok('captured the graphql response', state.urls.some(u => /\/api\/graphql/.test(u)), JSON.stringify(state.urls));
  ok('captured the ATC rpc response (via XHR)', state.urls.some(u => /SearchCreatives/.test(u)), JSON.stringify(state.urls));
  ok('ignored the unrelated bundle.js', !state.urls.some(u => /bundle\.js/.test(u)), JSON.stringify(state.urls));
  ok('query string dropped from recorded url', !state.urls.some(u => u.includes('?')), JSON.stringify(state.urls));
  ok('ad body copy present in capture', state.bodies.some(b => b.includes('Vivo V50 at Just')));
  ok('ATC numeric-key payload present', state.bodies.some(b => b.includes('cursor-abc')));
  ok('access_token scrubbed from body', !state.bodies.some(b => b.includes('EAAB-secret-token')),
    'token leaked into capture');

  // save() must actually produce a downloadable file
  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.evaluate(() => window.__ssCapture.save()),
  ]).then(r => r[0]);
  ok('save() downloads a json file', !!dl && /^ads-capture-.*\.json$/.test(dl.suggestedFilename() || ''),
    dl ? dl.suggestedFilename() : 'no download event');

  if (dl) {
    const p = await dl.path();
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    ok('saved file parses and holds both responses',
      parsed.responses && parsed.responses.length === 2, JSON.stringify(Object.keys(parsed)));
    ok('saved file records the site', parsed.site === 'www.facebook.com', parsed.site);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
