/* Builds the WebM fixture used by test_video_ocr.js: four distinct on-screen
 * texts, one per segment, so the test can prove OCR reads MULTIPLE frames of a
 * reel rather than just the cover image.
 *
 * Recorded with Chrome's own MediaRecorder (canvas.captureStream) because the
 * ffmpeg in this image has no drawtext, image2 demuxer or libx264.
 *
 * Writes chrome-scraper-extension/tools/fixtures/reel.webm. Committed, so the
 * test no longer depends on a scratch directory that disappears between
 * sessions. Re-run only if the expected texts change.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = path.resolve('chrome-scraper-extension/tools/fixtures/reel.webm');

const SEGMENTS = [
  'Ultra performance\nunlocked',
  'Powered by\nSnapdragon',
  'Galaxy AI',
  'The all new\nGalaxy Z Fold8',
];

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const b64 = await page.evaluate(async (segments) => {
    const W = 540, H = 960, FPS = 25, SEG_MS = 1500;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');

    const stream = cv.captureStream(FPS);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2500000 });
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

    const draw = (lines) => {
      ctx.fillStyle = '#0d0f14';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 62px Arial, Helvetica, sans-serif';
      const arr = lines.split('\n');
      const start = H / 2 - ((arr.length - 1) * 78) / 2;
      arr.forEach((l, i) => ctx.fillText(l, W / 2, start + i * 78));
    };

    draw(segments[0]);
    rec.start();

    for (const seg of segments) {
      draw(seg);
      // keep repainting so every captured frame carries the text
      const until = performance.now() + SEG_MS;
      while (performance.now() < until) {
        draw(seg);
        await new Promise(r => setTimeout(r, 1000 / FPS));
      }
    }

    await new Promise(r => { rec.onstop = r; rec.stop(); });
    const blob = new Blob(chunks, { type: 'video/webm' });
    const buf = await blob.arrayBuffer();
    let s = '';
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }, SEGMENTS);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
  await browser.close();
})();
