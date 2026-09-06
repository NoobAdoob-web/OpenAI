/* Verifies post copy (caption) is captured on an Instagram reels GRID, where
 * the caption is NOT in the DOM and only arrives via the page's own API call.
 * Also checks Date and Duration get filled from the same source. */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const fs = require('fs');
  const netHook = fs.readFileSync('chrome-scraper-extension/content/net_hook.js', 'utf8');
  const contentScript = fs.readFileSync('chrome-scraper-extension/content/content.js', 'utf8');
  let pass = 0, fail = 0;
  const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

  // Instagram-shaped API payload: caption lives ONLY here, never in the DOM.
  const apiPayload = {
    data: {
      xdt_api__v1__clips__user__connection_v2: {
        edges: [
          { node: { media: {
              code: 'ABC123',
              caption: { text: 'Ultra performance, unlocked ⚡ Powered by Snapdragon #GalaxyZFold8 #Samsung' },
              taken_at: 1756944000,           // 2025-09-04
              video_duration: 14.6,
              play_count: 85700, like_count: 668, comment_count: 12,
          } } },
          { node: { media: {
              code: 'XYZ789',
              caption: { text: 'Happy Teacher’s Day 🎓 Bespoke AI' },
              taken_at: 1756512000,
              video_duration: 6.2,
              play_count: 214000, like_count: 1484, comment_count: 23,
          } } },
        ],
      },
    },
  };

  // Grid markup mirrors the real thing: thumbnail + view count only. No caption.
  const html = `<!DOCTYPE html><html><body><main>
    <div class="grid">
      <a href="/samsungindia/reel/ABC123/"><div><img src="https://x/1.jpg" alt=""></div><span>85.7K</span></a>
      <a href="/samsungindia/reel/XYZ789/"><div><img src="https://x/2.jpg" alt=""></div><span>214K</span></a>
    </div>
    <script>
      // The page fetches its own data (exactly what Instagram does on scroll)
      window.__done = fetch('/api/v1/clips/user/', {method:'POST'})
        .then(r => r.json()).then(() => true);
    </script>
  </body></html>`;

  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await context.route('**/*', route => {
    const req = route.request();
    if (req.resourceType() === 'document') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    if (req.url().includes('/api/v1/clips/user/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiPayload) });
    }
    return route.fulfill({ status: 200, body: '' });
  });

  // net_hook must be installed BEFORE page scripts run (document_start, MAIN world)
  await page.addInitScript(netHook);
  await page.goto('https://www.instagram.com/samsungindia/reels/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForFunction(() => window.__done !== undefined).catch(() => {});
  await page.evaluate(() => window.__done);

  const result = await page.evaluate((cs) => {
    window.chrome = {
      runtime: { onMessage: { addListener: (fn) => { window.__L__ = fn; } }, sendMessage: () => {}, connect: () => ({ onDisconnect: { addListener: () => {} }, postMessage: () => {} }) },
      storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    };
    try { eval(cs); } catch (e) { return { bootError: e.message }; }
    return { ok: true };
  }, contentScript);

  if (result.bootError) { console.log('  BOOT ERROR', result.bootError); fail++; }

  // give the hook's postMessage a tick to be consumed, then re-detect
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    return new Promise((resolve) => {
      if (!window.__L__) { resolve({ error: 'no listener' }); return; }
      window.__L__({ action: 'detect', tabId: 1 }, {}, (resp) => resolve(resp));
    });
  });

  const rows = (data && data.data && data.data.rows) || [];
  console.log('\nRows:', rows.length);
  for (const r of rows) console.log('   ', JSON.stringify({ URL: r.URL, Caption: r.Caption, Date: r.Date, Duration: r.Duration, Views: r.Views }));

  ok('no page errors', errors.length === 0, errors.join('|'));
  ok('2 rows detected', rows.length === 2, 'got ' + rows.length);
  const a = rows.find(r => (r.URL || '').includes('ABC123')) || {};
  const b = rows.find(r => (r.URL || '').includes('XYZ789')) || {};
  ok('caption captured for post 1', /Ultra performance, unlocked/.test(a.Caption || ''), JSON.stringify(a.Caption));
  ok('hashtags kept in caption', /#GalaxyZFold8/.test(a.Caption || ''), JSON.stringify(a.Caption));
  ok('caption captured for post 2', /Bespoke AI/.test(b.Caption || ''), JSON.stringify(b.Caption));
  ok('date filled from API', (a.Date || '').startsWith('2025-09'), a.Date);
  ok('duration filled from API', /0:14|0:15/.test(a.Duration || ''), a.Duration);
  ok('duration seconds filled', String(a['Duration (sec)'] || '') === '15' || String(a['Duration (sec)'] || '') === '14', a['Duration (sec)']);

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
