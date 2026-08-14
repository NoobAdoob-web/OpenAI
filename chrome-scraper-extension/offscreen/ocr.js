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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.action === 'ocr') {
    (async () => {
      try {
        const worker = await getWorker();
        const { data } = await worker.recognize(msg.dataUrl);
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
