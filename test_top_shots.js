/* End-to-end test of the top-posts screenshot feature in real Chrome with the
 * extension installed: ranks the posts, scrolls to each one, photographs the
 * tab, crops to the card, and writes a ZIP. The ZIP is then opened with an
 * independent unzip and the images decoded, so "it worked" means the file is
 * genuinely readable - not that our own writer agreed with itself.
 *
 * Each post tile is a distinct solid colour, so the crop can be checked
 * against the RIGHT post rather than merely being the right size. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SRC = process.env.EXT_DIR || path.resolve('chrome-scraper-extension');
const OUT = process.env.SCRATCH || '/tmp';

/* captureVisibleTab needs <all_urls> or activeTab, and activeTab is granted
 * only when a user clicks the extension - which a test cannot do. So the
 * extension is copied with <all_urls> added purely to exercise the capture
 * path here. Everything else under test is the shipped code; the only thing
 * this skips is Chrome's permission prompt, which production satisfies
 * because the user starts the capture from the popup. */
const EXT = path.join(OUT, 'ext-capture-test');
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(SRC, EXT, { recursive: true });
{
  const mf = path.join(EXT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions = [...new Set([...(m.host_permissions || []), '<all_urls>'])];
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
}

// code, views, colour. Deliberately NOT in rank order on the page.
const POSTS = [
  ['DfjorOsHGfj', 149000, '#e01b24'],
  ['DfcFbukiRxQ', 46000, '#2ec27e'],
  ['DfHeZyFjCF7', 240000, '#1c71d8'],   // top by views, sits third
  ['DdENBc2D94A', 19000, '#f5c211'],
  ['DfZbRslDz1z', 72000, '#9141ac'],
];

const html = `<!DOCTYPE html><html><head><style>
body{margin:0;font-family:system-ui}
.grid{display:flex;flex-wrap:wrap;gap:40px;padding:40px}
.cell{width:360px}
.tile{width:360px;height:620px;display:flex;align-items:flex-end;justify-content:center;color:#fff;font:600 28px system-ui}
</style></head><body><main><div class="grid">
${POSTS.map(([code, views, colour]) => `
  <div class="cell"><a class="tile" style="background:${colour}" href="/samsungindia/reel/${code}/">
    <span>${(views / 1000).toFixed(0)}K</span></a></div>`).join('')}
</div></main></body></html>`;

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

  const userDataDir = fs.mkdtempSync('/tmp/ss-shots-');
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1000, height: 820 },
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  await context.route('**/*', route => {
    if (!/^https?:/i.test(route.request().url())) return route.continue();
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    return route.fulfill({ status: 200, body: '' });
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 820 });
  await page.goto('https://www.instagram.com/samsungindia/reels/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: '*://*.instagram.com/*' }))[0].id);

  // the offscreen document hosts the cropper
  const off = await context.newPage();
  await off.goto(`chrome-extension://${extId}/offscreen/ocr.html`);
  await off.waitForTimeout(1500);

  // ── the content script must find and frame a post ───────────────────────
  const framed = await sw.evaluate(async ({ tabId, url }) =>
    chrome.tabs.sendMessage(tabId, { action: 'scrollToPost', url }),
  { tabId, url: 'https://www.instagram.com/samsungindia/reel/DfHeZyFjCF7/' });
  ok('content script locates a post by its url', framed && framed.ok === true, JSON.stringify(framed));
  ok('it reports a sensible rectangle',
    framed.rect && framed.rect.w > 300 && framed.rect.h > 500, JSON.stringify(framed.rect));
  ok('it reports the device pixel ratio', framed.dpr >= 1);

  const missing = await sw.evaluate(async ({ tabId }) =>
    chrome.tabs.sendMessage(tabId, { action: 'scrollToPost', url: 'https://www.instagram.com/p/NOPE12345/' }),
  { tabId });
  ok('a post that is not on the page fails cleanly', missing && missing.ok === false, JSON.stringify(missing));

  // ── drive the real capture loop ─────────────────────────────────────────
  const ranked = [...POSTS].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const items = ranked.map(([code, views], i) => ({
    key: `https://www.instagram.com/samsungindia/reel/${code}/`,
    rank: i + 1,
    label: `${String(i + 1).padStart(2, '0')}-${Math.round(views / 1000)}K-views`,
  }));

  // The worker broadcasts progress to extension PAGES, not to itself, so the
  // offscreen document stands in for the popup as the listener here.
  await off.evaluate(() => {
    window.__shots = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.type === 'shotProgress') window.__shots.push(m);
      if (m && m.type === 'shotsComplete') window.__shotsDone = true;
    });
  });

  // Also sent from a page, not the worker: a worker's own sendMessage does
  // not reach its own onMessage listener.
  await off.evaluate(({ tabId, items }) =>
    chrome.runtime.sendMessage({ action: 'startShots', tabId, items }), { tabId, items });

  await off.waitForFunction(() => window.__shotsDone === true, { timeout: 30000 }).catch(() => {});
  const results = await off.evaluate(() => (window.__shots || []).map(g => ({
    rank: g.rank, label: g.label, w: g.w, h: g.h, error: g.error, dataUrl: g.dataUrl,
  })));

  ok('every requested post was captured', results.length === ranked.length, `${results.length}/${ranked.length}`);
  ok('no capture errored', results.every(r => !r.error), JSON.stringify(results.map(r => r.error)));
  ok('each image has real dimensions', results.every(r => r.w > 100 && r.h > 100),
    JSON.stringify(results.map(r => `${r.w}x${r.h}`)));
  ok('images are cropped to the card, not the whole 1000px viewport',
    results.every(r => r.w < 600), JSON.stringify(results.map(r => r.w)));

  // ── the crop must contain the RIGHT post ────────────────────────────────
  const expected = ranked.map(p => p[2]);
  const sampled = await off.evaluate(async (urls) => {
    const out = [];
    for (const u of urls) {
      const bmp = await createImageBitmap(await (await fetch(u)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0);
      const d = x.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data;
      out.push([d[0], d[1], d[2]]);
    }
    return out;
  }, results.map(r => r.dataUrl));

  const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  const near = (got, want) => {
    const w = [1, 3, 5].map(i => parseInt(want.slice(i, i + 2), 16));
    return got.every((v, i) => Math.abs(v - w[i]) < 40);
  };
  results.forEach((r, i) => {
    ok(`shot ${r.label} shows the right post (${expected[i]})`, near(sampled[i], expected[i]),
      `sampled ${hex(sampled[i])}, expected ${expected[i]}`);
  });

  // ── the ZIP the popup builds must be a real, readable ZIP ───────────────
  const zipBytes = await off.evaluate(async ({ urls, labels, writer }) => {
    eval(writer);
    const toBytes = (u) => {
      const bin = atob(String(u).split(',')[1]);
      const a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return a;
    };
    const z = zipStore(urls.map((u, i) => ({ name: labels[i] + '.jpg', data: toBytes(u) })));
    return Array.from(z);
  }, {
    urls: results.map(r => r.dataUrl),
    labels: results.map(r => r.label),
    writer: fs.readFileSync(path.join(EXT, 'popup/xlsx.js'), 'utf8')
      .replace(/^if \(typeof module[\s\S]*$/m, ''),
  });

  const zipPath = path.join(OUT, 'top_posts_test.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipBytes));
  ok('zip written', fs.statSync(zipPath).size > 2000, String(fs.statSync(zipPath).size));

  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
  ok('an independent unzip reads it', listing.length === results.length, JSON.stringify(listing));
  ok('files are named by rank, 01 first',
    listing.sort()[0].startsWith('01-'), JSON.stringify(listing));
  ok('the name carries the metric', listing.every(n => /-\d+K-views\.jpg$/.test(n)), JSON.stringify(listing));

  const outDir = path.join(OUT, 'zipcheck');
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync('unzip', ['-qq', zipPath, '-d', outDir]);
  const files = fs.readdirSync(outDir);
  ok('extracted files are valid JPEGs', files.every(f => {
    const b = fs.readFileSync(path.join(outDir, f));
    return b[0] === 0xFF && b[1] === 0xD8 && b.length > 1000;
  }), JSON.stringify(files.map(f => fs.statSync(path.join(outDir, f)).size)));

  console.log('\n  zip contents:');
  files.sort().forEach(f => console.log(`    ${f.padEnd(26)} ${(fs.statSync(path.join(outDir, f)).size / 1024).toFixed(0)} KB`));

  console.log(`\n${pass} passed, ${fail} failed`);
  await context.close();
  process.exit(fail ? 1 : 0);
})();
