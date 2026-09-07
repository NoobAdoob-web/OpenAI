/* Proves the reel fix: OCR text that exists ONLY inside the video, across
 * different frames. Runs the real extension in real Chrome, serves a real
 * WebM whose text changes over time, and checks every segment is recovered. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve('chrome-scraper-extension');
const VIDEO = '/tmp/claude-0/-home-user-OpenAI/462f2b8c-05f9-5fca-8e56-3b43fedb71b6/scratchpad/vid/reel.webm';

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

  const bytes = fs.readFileSync(VIDEO);
  const userDataDir = fs.mkdtempSync('/tmp/ss-vid-');
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  let sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  ok('extension loaded', !!sw);
  if (!sw) { await context.close(); process.exit(1); }
  const extId = new URL(sw.url()).host;

  // serve the video from a CDN host the manifest grants access to
  const VIDEO_URL = 'https://scontent.cdninstagram.com/v/reel_test.webm';
  await context.route('**/*', route => {
    if (route.request().url() === VIDEO_URL) {
      return route.fulfill({ status: 200, contentType: 'video/webm', body: bytes });
    }
    return route.continue();
  });

  // load the offscreen document so its message listener is live
  const off = await context.newPage();
  const offErrors = [];
  off.on('pageerror', e => offErrors.push(e.message));
  off.on('console', m => { if (m.type() === 'error') offErrors.push(m.text()); });
  await off.goto(`chrome-extension://${extId}/offscreen/ocr.html`);
  await off.waitForTimeout(2500);   // let the wasm bundle initialise

  console.log('  running video OCR (loads models + samples frames)...');
  const t0 = Date.now();
  const res = await sw.evaluate(async ({ url }) => {
    try { return await chrome.runtime.sendMessage({ target: 'offscreen', action: 'ocrVideo', url, maxFrames: 8 }); }
    catch (e) { return { ok: false, error: String(e) }; }
  }, { url: VIDEO_URL });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('  result:', JSON.stringify(res).slice(0, 400));
  console.log('  took', secs, 's');

  ok('video OCR returned ok', res && res.ok === true, res && res.error);
  const text = ((res || {}).text || '');
  ok('canvas not tainted (pixels readable)', !/tainted|SecurityError|frame read blocked/i.test((res || {}).error || ''), (res || {}).error);
  ok('duration reported', (res || {}).duration > 0, String((res || {}).duration));

  // the whole point: text from MULTIPLE, DIFFERENT frames
  const want = [
    [/ultra performance/i, 'frame 1: "Ultra performance unlocked"'],
    [/snapdragon/i,        'frame 2: "Powered by Snapdragon"'],
    [/galaxy ai/i,         'frame 3: "Galaxy AI"'],
    [/fold\s*8/i,          'frame 4: "The all new Galaxy Z Fold8"'],
  ];
  let got = 0;
  for (const [re, label] of want) { const hit = re.test(text); if (hit) got++; ok('recovered ' + label, hit, JSON.stringify(text)); }
  ok('multi-frame text merged (>=3 of 4 segments)', got >= 3, `${got}/4`);
  ok('no dupes: line count sane', text.split('\n').filter(Boolean).length <= 8, text.split('\n').length + ' lines');
  ok('no offscreen page errors', offErrors.length === 0, offErrors.slice(0, 3).join(' | '));

  console.log('\n  --- extracted text ---\n' + text.split('\n').map(l => '    ' + l).join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await context.close();
  process.exit(fail ? 1 : 0);
})();
