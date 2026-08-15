'use strict';

// Runs inside the offscreen document. Owns a single reusable Tesseract worker
// (English + Hindi) and OCRs images sent from the background service worker.

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(['eng', 'hin'], 1, {
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('tesseract/tesseract-core-simd-lstm.wasm.js'),
      langPath: chrome.runtime.getURL('tesseract/lang/'),
      workerBlobURL: false,
      gzip: true,
    });
  }
  return workerPromise;
}

// Preprocess the image to help OCR: upscale small images so text is bigger,
// convert to grayscale, and stretch contrast. Colored text over busy
// backgrounds (maps/photos) reads far better after this.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img load'));
    img.src = src;
  });
}

async function preprocess(dataUrl) {
  const img = await loadImage(dataUrl);
  const longest = Math.max(img.width, img.height) || 1;
  // Upscale small thumbnails up to ~1600px on the long edge (cap the factor)
  const scale = Math.min(4, Math.max(1, 1600 / longest));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  try {
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    const contrast = 1.5;                 // >1 sharpens the light/dark gap
    for (let i = 0; i < d.length; i += 4) {
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; // grayscale
      g = (g - 128) * contrast + 128;      // contrast stretch
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(id, 0, 0);
  } catch (_) { /* tainted canvas shouldn't happen for data URLs */ }

  return canvas;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.action === 'ocr') {
    (async () => {
      try {
        const worker = await getWorker();
        const input = await preprocess(msg.dataUrl).catch(() => msg.dataUrl);
        const { data } = await worker.recognize(input);
        sendResponse({ ok: true, text: (data.text || '').trim(), conf: Math.round(data.confidence || 0) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e).slice(0, 160) });
      }
    })();
    return true; // async response
  }

  if (msg.action === 'ocrDispose') {
    (async () => {
      try { if (workerPromise) { const w = await workerPromise; await w.terminate(); } } catch (_) {}
      workerPromise = null;
      sendResponse({ ok: true });
    })();
    return true;
  }
});
