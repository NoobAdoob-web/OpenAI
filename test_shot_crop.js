/* Tests the ad-card screenshot cropper in real Chrome.
 *
 * Builds a synthetic "viewport capture" with known coloured regions, crops a
 * known rectangle out of it, then decodes the JPEG and samples pixels to
 * prove the RIGHT region came out — not merely that something of the right
 * size did. */
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, extra) => { if (c) { console.log('  PASS', n); pass++; } else { console.log('  FAIL', n, extra || ''); fail++; } };

  const shotJs = fs.readFileSync('chrome-scraper-extension/offscreen/shot.js', 'utf8');

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('about:blank');

  // shot.js registers a chrome.runtime listener; stub just enough for it to load.
  await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener() {} } } }; });
  await page.evaluate(shotJs);
  ok('cropper loads without a chrome extension context', await page.evaluate(() => typeof self.__cropShot === 'function'));

  const result = await page.evaluate(async () => {
    // A 1000x800 "viewport": white, with a red card at (100,150,200,250) and a
    // blue block elsewhere that must NOT appear in the crop.
    const c = new OffscreenCanvas(1000, 800);
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 1000, 800);
    x.fillStyle = '#0000ff'; x.fillRect(600, 500, 300, 200);
    x.fillStyle = '#ff0000'; x.fillRect(100, 150, 200, 250);
    // a green stripe along the card's top edge, to check orientation
    x.fillStyle = '#00ff00'; x.fillRect(100, 150, 200, 20);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const viewport = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });

    const sample = async (dataUrl, px, py) => {
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const cc = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = cc.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const d = cx.getImageData(px, py, 1, 1).data;
      return { w: bmp.width, h: bmp.height, rgb: [d[0], d[1], d[2]] };
    };

    const out = {};

    // 1. plain crop, dpr 1, no downscale needed
    out.plain = await self.__cropShot({ dataUrl: viewport, rect: { x: 100, y: 150, w: 200, h: 250 }, dpr: 1 });
    out.plainMid = await sample(out.plain.dataUrl, 100, 180);   // should be red
    out.plainTop = await sample(out.plain.dataUrl, 100, 5);     // should be green

    // 2. dpr 2 - rect is in CSS px, capture is in device px
    out.dpr2 = await self.__cropShot({ dataUrl: viewport, rect: { x: 50, y: 75, w: 100, h: 125 }, dpr: 2 });
    out.dpr2Mid = await sample(out.dpr2.dataUrl, 100, 180);

    // 3. downscale: a card bigger than maxEdge
    out.big = await self.__cropShot({ dataUrl: viewport, rect: { x: 0, y: 0, w: 1000, h: 800 }, dpr: 1, maxEdge: 600 });

    // 4. card hanging off the bottom edge of the viewport
    out.clamped = await self.__cropShot({ dataUrl: viewport, rect: { x: 900, y: 700, w: 400, h: 400 }, dpr: 1 });

    // 5. zero-size / nonsense rect must not throw
    try { out.degenerate = await self.__cropShot({ dataUrl: viewport, rect: { x: 0, y: 0, w: 0, h: 0 }, dpr: 1 }); }
    catch (e) { out.degenerate = { ok: false, threw: String(e) }; }

    return out;
  });

  ok('no page errors', errors.length === 0, errors.join(' | '));

  ok('crop has the card dimensions', result.plain.w === 200 && result.plain.h === 250,
    JSON.stringify([result.plain.w, result.plain.h]));
  ok('crop contains the CARD (red), not the page',
    result.plainMid.rgb[0] > 200 && result.plainMid.rgb[1] < 80 && result.plainMid.rgb[2] < 80,
    JSON.stringify(result.plainMid.rgb));
  ok('crop is not flipped (green stripe stays at the top)',
    result.plainTop.rgb[1] > 200 && result.plainTop.rgb[0] < 120,
    JSON.stringify(result.plainTop.rgb));

  ok('dpr 2 maps CSS px to device px', result.dpr2.w === 200 && result.dpr2.h === 250,
    JSON.stringify([result.dpr2.w, result.dpr2.h]));
  ok('dpr 2 crop lands on the same card',
    result.dpr2Mid.rgb[0] > 200 && result.dpr2Mid.rgb[2] < 80, JSON.stringify(result.dpr2Mid.rgb));

  ok('oversized card is downscaled to maxEdge',
    result.big.w === 600 && result.big.h === 480, JSON.stringify([result.big.w, result.big.h]));
  ok('aspect ratio preserved when downscaling',
    Math.abs((result.big.w / result.big.h) - (1000 / 800)) < 0.01,
    String(result.big.w / result.big.h));

  ok('off-screen overhang is clamped, not an error',
    result.clamped.ok === true && result.clamped.w === 100 && result.clamped.h === 100,
    JSON.stringify([result.clamped.ok, result.clamped.w, result.clamped.h]));

  ok('degenerate rect yields a 1x1 image instead of throwing',
    result.degenerate.ok === true && result.degenerate.w === 1, JSON.stringify(result.degenerate));

  ok('output is jpeg', /^data:image\/jpeg;base64,/.test(result.plain.dataUrl));
  ok('jpeg is a sane size (compressed, not raw)',
    result.plain.bytes > 400 && result.plain.bytes < 60000, String(result.plain.bytes));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
