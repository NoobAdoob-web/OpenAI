/* REAL end-to-end test: launches Chrome with the extension actually INSTALLED
 * (not eval'd), then exercises it against fixture pages served at the real
 * hostnames. Catches whole classes of bugs the script-eval tests cannot:
 * invalid manifest, service-worker registration failure, CSP violations,
 * content-script match failures, bad icon/asset references. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve('chrome-scraper-extension');

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

  const userDataDir = fs.mkdtempSync('/tmp/ss-profile-');
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: false,
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });

  const consoleErrors = [];

  // ── 1. Does the extension actually load? (service worker must register) ──
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  ok('extension loaded (service worker registered)', !!sw, 'no service worker');
  if (!sw) { console.log(`\n${pass} passed, ${fail} failed`); await context.close(); process.exit(1); }

  const extId = new URL(sw.url()).host;
  console.log('  extension id:', extId);

  // ── 2. Icons: fetch each declared icon THROUGH Chrome and decode it ──────
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  // default_icon may be a single path string OR a {size: path} map
  const asPaths = (v) => (typeof v === 'string' ? [v] : Object.values(v || {}));
  const iconPaths = [...new Set([
    ...asPaths(manifest.icons),
    ...asPaths((manifest.action || {}).default_icon),
  ])];
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${extId}/popup/popup.html`).catch(() => {});
  for (const rel of iconPaths) {
    const res = await probe.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        if (!r.ok) return { ok: false, why: 'HTTP ' + r.status };
        const blob = await r.blob();
        // decode it the way Chrome must be able to
        const bmp = await createImageBitmap(blob);
        return { ok: true, w: bmp.width, h: bmp.height, type: blob.type };
      } catch (e) { return { ok: false, why: String(e).slice(0, 80) }; }
    }, `chrome-extension://${extId}/${rel}`);
    ok(`icon decodes: ${rel}`, res.ok && res.w > 0, JSON.stringify(res));
  }

  // ── 3. Popup renders ────────────────────────────────────────────────────
  const title = await probe.title().catch(() => '');
  ok('popup page loads', /ScrapeSuite/i.test(title), 'title=' + title);
  const badge = await probe.textContent('#version-badge').catch(() => '');
  ok('popup shows version from manifest', (badge || '').includes(manifest.version), `badge="${badge}" manifest=${manifest.version}`);

  // ── 4. Content script + net_hook really inject on instagram.com ─────────
  const apiPayload = { data: { items: [
    { media: { code: 'ABC123', caption: { text: 'Ultra performance, unlocked #Galaxy' },
               taken_at: 1756944000, video_duration: 14.6,
               play_count: 85700, like_count: 668, comment_count: 12 } },
  ] } };
  const html = `<!DOCTYPE html><html><body><main>
    <div class="grid"><a href="/samsungindia/reel/ABC123/"><div class="c"><img src="https://x/1.jpg" alt=""></div><span>85.7K</span></a></div>
    <script>window.__done = fetch('/api/v1/clips/user/').then(r=>r.json()).then(()=>true);</script>
  </body></html>`;

  const page = await context.newPage();
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await context.route('**/*', route => {
    const req = route.request();
    if (req.url().includes('/api/v1/clips/user/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiPayload) });
    }
    if (req.resourceType() === 'document') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    return route.fulfill({ status: 200, body: '' });
  });
  await page.goto('https://www.instagram.com/samsungindia/reels/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);

  // NOTE: the content script sets __IDS_INIT__ in its ISOLATED world, which
  // page.evaluate (MAIN world) cannot see. Proving injection therefore means
  // talking to it over the real extension messaging API (step 5 below).
  const hooked = await page.evaluate(() => !!window.__SS_NET_HOOK__);
  ok('net_hook injected in MAIN world', hooked === true, 'window.__SS_NET_HOOK__=' + hooked);

  // ── 5. Ask the REAL content script for data via the REAL messaging API ──
  const data = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
    if (!tabs.length) return { error: 'no tab' };
    try { return await chrome.tabs.sendMessage(tabs[0].id, { action: 'detect', tabId: tabs[0].id }); }
    catch (e) { return { error: String(e) }; }
  });
  const rows = (data && data.data && data.data.rows) || [];
  console.log('  rows via real messaging:', rows.length, rows[0] ? JSON.stringify({ C: rows[0].Caption, D: rows[0].Date, Du: rows[0].Duration }) : '');
  ok('service worker can message content script', !data.error, data.error);
  ok('row extracted', rows.length === 1, 'got ' + rows.length);
  ok('caption captured from API (real extension)', /Ultra performance, unlocked/.test((rows[0] || {}).Caption || ''), JSON.stringify((rows[0] || {}).Caption));
  ok('date from API', ((rows[0] || {}).Date || '').startsWith('2025-09'), (rows[0] || {}).Date);
  ok('duration from API', /0:1[45]/.test((rows[0] || {}).Duration || ''), (rows[0] || {}).Duration);

  // ── 6. No CSP / console errors anywhere ─────────────────────────────────
  const bad = consoleErrors.filter(e => !/favicon|net::ERR|Failed to load resource/i.test(e));
  ok('no console/CSP errors', bad.length === 0, bad.slice(0, 4).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  await context.close();
  process.exit(fail ? 1 : 0);
})();
