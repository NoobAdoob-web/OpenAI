/* Generates Chrome Web Store listing assets at the exact required sizes:
 *   - 5 screenshots at 1280x800
 *   - small promo tile at 440x280
 *   - marquee promo tile at 1400x560
 * All flattened to 24-bit PNG (no alpha channel), which is what the store wants.
 *
 * The popup in every shot is the REAL popup from the built upload package,
 * running in Chrome against a local profile fixture - not a mockup. Captions
 * describe only features that actually ship in this build.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const EXT = process.env.EXT_DIR || path.resolve('chrome-scraper-extension');
const OUT = path.resolve('store-assets');

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

const pageHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
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

// Only claims this build actually delivers.
const PANELS = [
  { id: 'capture', title: 'Turn a profile into a ranked spreadsheet',
    sub: 'YouTube, Instagram, Facebook and LinkedIn. Set the scrolls, hit start, export.',
    setup: () => {}, focus: null },
  { id: 'ocr', title: 'Reads the text inside images and video',
    sub: 'PaddleOCR PP-OCRv4 runs on your own machine. Nothing is uploaded, anywhere.',
    setup: () => { const c = document.getElementById('ocr-toggle'); if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } }, focus: '#ocr-section' },
  { id: 'deep', title: 'Gets the numbers the grid never shows',
    sub: 'Opens each post for likes, comments, shares and the full caption.',
    setup: () => { const c = document.getElementById('deep-toggle'); if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } }, focus: '#deep-section' },
  { id: 'analysis', title: 'Analysis built in, not bolted on',
    sub: 'Top performers, posting cadence and plain-language insights in every export.',
    setup: () => {}, focus: '#analysis-insights' },
  { id: 'howto', title: 'Excel or CSV in one click',
    sub: 'A ranked sheet plus all the raw data, ready to drop into your own analysis.',
    setup: () => { const d = document.getElementById('help-box'); if (d) d.open = true; }, focus: '#help-box' },
];

const frameHtml = (title, sub, imgDataUri) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1280px;height:800px;overflow:hidden}
body{display:flex;align-items:center;gap:56px;padding:0 64px;
  font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  background:radial-gradient(1100px 760px at 8% 12%,#243a74 0%,#141a2e 48%,#0c0f1a 100%);color:#fff}
.copy{flex:1;min-width:0}
.badge{display:inline-flex;align-items:center;gap:9px;padding:7px 14px;border-radius:999px;
  background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);font-size:15px;
  letter-spacing:.02em;margin-bottom:26px}
.badge img{width:20px;height:20px;border-radius:5px}
h1{font-size:50px;line-height:1.1;font-weight:700;letter-spacing:-1px;margin-bottom:20px}
p{font-size:21px;line-height:1.5;color:#b9c2da;max-width:600px}
.shot{flex:none;width:512px;height:720px;border-radius:16px;overflow:hidden;
  box-shadow:0 36px 80px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.1)}
.shot img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
</style></head><body>
<div class="copy">
  <div class="badge"><img src="ICON"> ScrapeSuite</div>
  <h1>${title}</h1><p>${sub}</p>
</div>
<div class="shot"><img src="${imgDataUri}"></div>
</body></html>`;

const tileHtml = (w, h, iconUri, big) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${w}px;height:${h}px;overflow:hidden}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${big?20:12}px;
  font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:center;padding:0 ${big?80:28}px;
  background:radial-gradient(${big?'1000px 560px':'420px 300px'} at 20% 0%,#2a4486 0%,#141a2e 55%,#0c0f1a 100%);color:#fff}
img{width:${big?104:62}px;height:${big?104:62}px;border-radius:${big?24:14}px}
h1{font-size:${big?58:28}px;font-weight:700;letter-spacing:-.5px}
p{font-size:${big?24:14}px;color:#b9c2da;line-height:1.45}
</style></head><body>
<img src="${iconUri}"><h1>ScrapeSuite</h1>
<p>${big ? 'Scrape social posts and product reviews into ranked, analysis-ready Excel &mdash; with on-device image and video text reading.'
         : 'Social posts &amp; reviews &rarr; ranked Excel'}</p>
</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const iconUri = 'data:image/png;base64,' +
    fs.readFileSync(path.join(EXT, 'icons/icon128.png')).toString('base64');

  const userDataDir = fs.mkdtempSync('/tmp/ss-store-');
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  await context.route('**/*', route => {
    const u = route.request().url();
    // never intercept the extension's own files - that blanks popup.js/css
    if (!/^https?:/i.test(u)) return route.continue();
    if (u.includes('/api/v1/clips/user/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (route.request().resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml });
    return route.fulfill({ status: 200, body: '' });
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto('https://www.instagram.com/samsungindia/reels/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const igTabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://*.instagram.com/*' }))[0].id);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 540, height: 760 });
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
  // A transient "opening posts in the background" banner would otherwise be
  // frozen into the listing images; wait for it to clear.
  await popup.waitForFunction(() => {
    const el = document.getElementById('crawl-status') || document.getElementById('analysis-note');
    const t = (document.body.innerText || '');
    return !/Please wait|Opening \d+ posts/i.test(t);
  }, { timeout: 90000 }).catch(() => console.log('  (banner still showing after 90s)'));
  await popup.waitForTimeout(1200);

  const rows = await popup.evaluate(() => document.querySelectorAll('#preview-table tr').length);
  if (rows < 2) { console.error('popup rendered no data (rows=' + rows + ') - aborting'); await context.close(); process.exit(1); }
  console.log('popup rendered', rows, 'preview rows');

  const frame = await context.newPage();
  await frame.setViewportSize({ width: 1280, height: 800 });
  const made = [];

  for (let i = 0; i < PANELS.length; i++) {
    const p = PANELS[i];
    // reset, then apply this panel's state
    await popup.evaluate(() => {
      const d = document.getElementById('help-box'); if (d) d.open = false;
      const note = document.getElementById('analysis-note'); if (note) note.style.display = 'none';
      for (const id of ['deep-toggle', 'ocr-toggle']) {
        const c = document.getElementById(id);
        if (c && c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      window.scrollTo(0, 0);
    });
    await popup.evaluate(p.setup);
    await popup.waitForTimeout(500);
    if (p.focus) {
      await popup.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ block: 'center' });
      }, p.focus);
      await popup.waitForTimeout(500);
    }

    const shot = await popup.screenshot({ type: 'png' });   // 540x760 viewport
    const uri = 'data:image/png;base64,' + shot.toString('base64');

    await frame.setContent(frameHtml(p.title, p.sub, uri).replace('ICON', iconUri), { waitUntil: 'load' });
    await frame.waitForTimeout(350);
    const file = path.join(OUT, `screenshot-${i + 1}-${p.id}.png`);
    await frame.screenshot({ path: file });
    made.push(file);
    console.log('  1280x800', path.basename(file));
  }

  // promo tiles
  for (const [w, h, name, big] of [[440, 280, 'promo-small-440x280.png', false], [1400, 560, 'promo-marquee-1400x560.png', true]]) {
    await frame.setViewportSize({ width: w, height: h });
    await frame.setContent(tileHtml(w, h, iconUri, big), { waitUntil: 'load' });
    await frame.waitForTimeout(300);
    const file = path.join(OUT, name);
    await frame.screenshot({ path: file });
    made.push(file);
    console.log(`  ${w}x${h}`, name);
  }

  await context.close();

  // Flatten to 24-bit RGB PNG (store wants no alpha channel) and verify sizes.
  const report = execFileSync('python3', ['-I', path.resolve('flatten_png.py'), ...made], { encoding: 'utf8' });
  console.log(report.trim());
})();
