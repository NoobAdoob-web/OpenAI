/* Captures real screenshots of the running extension in Chrome.
 * The UI and data flow are genuine (real content script, real net_hook, real
 * popup); only the Instagram page is a local fixture, since this sandbox
 * cannot reach instagram.com. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve('chrome-scraper-extension');
const OUT = path.resolve('screenshots');

const POSTS = [
  ['DC3Vend', 'Ultra performance, unlocked ⚡ Powered by Snapdragon, customized for Galaxy. #GalaxyZFold8', 1757030400, 14.6, 96216, 743, 14],
  ['DC08Q6j', 'Happy Teacher’s Day 🎓 Bespoke AI that learns the way you do. #SamsungIndia', 1756944000, 6.2, 231986, 1577, 25],
  ['DCgDZcp', 'Recommended by the pros 🏆 Galaxy Watch Ultra2 — built for the extremes.', 1756857600, 21.0, 76661, 512, 31],
  ['DCf9VeZ', 'The moment won’t wait, neither will you. Engineered for extreme. #P9PortableSSD', 1756771200, 18.4, 73139, 498, 12],
  ['DCdgS9Q', 'An all-new shape unfolds. Meet the #GalaxyZFold8. 📱 Frames you’ve never seen before.', 1756684800, 12.8, 71658, 455, 19],
  ['DCbvPc4', '🐾 Found a moment too good to keep to yourself? #QuickShare makes it instant.', 1756598400, 9.5, 70006, 431, 8],
  ['DCbvKH5', 'One group video. Infinite ways to reframe it on the #GalaxyZFold8Ultra.', 1756512000, 15.2, 64120, 388, 22],
  ['DCbvJlr', 'Tune out the bustle 🎧 Galaxy S26 FE — flat 20% off this festive week.', 1756425600, 11.1, 58904, 349, 17],
];

const payload = {
  data: { items: POSTS.map(([code, caption, taken, dur, views, likes, comments]) => ({
    media: { code, caption: { text: caption }, taken_at: taken, video_duration: dur,
             play_count: views, like_count: likes, comment_count: comments },
  })) },
};

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui;background:#fff;margin:0;padding:16px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-width:900px}
.cell{position:relative}
.tile{position:relative;display:block;background:#222;aspect-ratio:9/16;border-radius:4px;overflow:hidden}
.v{position:absolute;bottom:6px;left:8px;color:#fff;font-size:13px;font-weight:600}
</style></head><body><main><div class="grid">
${POSTS.map(([code,,,,views]) => `<div class="cell"><a class="tile" href="/samsungindia/reel/${code}/"><div class="c"><img src="https://x/${code}.jpg" alt=""></div><span class="v">${views>=1000?(views/1000).toFixed(1)+'K':views}</span></a></div>`).join('')}
</div></main>
<script>fetch('/api/v1/clips/user/').then(r=>r.json()).then(()=>{window.__done=1;});</script>
</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = fs.mkdtempSync('/tmp/ss-shot-');
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 540, height: 900 }, deviceScaleFactor: 2,
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  await context.route('**/*', route => {
    const r = route.request();
    const u = r.url();
    // NEVER intercept the extension's own files - doing so blanks popup.js/css
    if (!/^https?:/i.test(u)) return route.continue();
    if (u.includes('/api/v1/clips/user/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (r.resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    return route.fulfill({ status: 200, body: '' });
  });

  // 1. the Instagram-style grid the extension runs on
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto('https://www.instagram.com/samsungindia/reels/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const igTabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://*.instagram.com/*' }))[0].id);

  // 2. the popup, pointed at that tab (Chrome's real popup can't be scripted,
  //    so we open popup.html and tell it which tab is active)
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 540, height: 980 });
  await popup.addInitScript((id) => {
    const wait = setInterval(() => {
      if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return;
      clearInterval(wait);
      const orig = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = function (q) {
        if (q && q.active && q.currentWindow) {
          return Promise.resolve([{ id, url: 'https://www.instagram.com/samsungindia/reels/' }]);
        }
        return orig(q);
      };
    }, 1);
  }, igTabId);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForTimeout(9000);

  await popup.screenshot({ path: path.join(OUT, '1-popup-scraped.png'), fullPage: true });
  console.log('shot 1: popup with scraped data');

  // 3. expand the how-to-use box
  await popup.evaluate(() => { const d = document.getElementById('help-box'); if (d) d.open = true; });
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: path.join(OUT, '2-popup-howto.png'), fullPage: true });
  console.log('shot 2: how-to-use expanded');

  // 4. expand Deep Scrape + image reading options
  await popup.evaluate(() => {
    const d = document.getElementById('help-box'); if (d) d.open = false;
    for (const id of ['deep-toggle', 'ocr-toggle']) {
      const cb = document.getElementById(id);
      if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  });
  await popup.waitForTimeout(600);
  await popup.screenshot({ path: path.join(OUT, '3-popup-deep-and-ocr.png'), fullPage: true });
  console.log('shot 3: deep scrape + image reading options');

  // 5. the grid page itself
  await page.screenshot({ path: path.join(OUT, '4-target-page.png') });
  console.log('shot 4: target page');

  const rows = await popup.evaluate(() => document.querySelectorAll('#preview-table tr').length);
  console.log('preview table rows rendered:', rows);

  await context.close();
  console.log('\nsaved to', OUT);
})();
