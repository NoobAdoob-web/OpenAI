/* Screenshot cropping for the ad-library export.
 *
 * chrome.tabs.captureVisibleTab gives one PNG of the whole viewport. Each ad
 * card is a rectangle inside it, so the card has to be cut out and scaled
 * down before it goes into the workbook and the report.
 *
 * Lives in the offscreen document because the MV3 service worker has no
 * canvas. Deliberately a separate plain script rather than part of
 * ocr.bundle.mjs: this is pure canvas work with no ONNX dependency, so it
 * costs nothing to load and the OCR bundle does not need rebuilding.
 */
(function () {
  'use strict';

  const MAX_EDGE = 600;      // matches the reference workbook's screenshots
  const JPEG_QUALITY = 0.82;

  async function cropShot(msg) {
    const rect = msg.rect || {};
    const dpr = msg.dpr > 0 ? msg.dpr : 1;
    const maxEdge = msg.maxEdge > 0 ? msg.maxEdge : MAX_EDGE;

    const res = await fetch(msg.dataUrl);
    const bmp = await createImageBitmap(await res.blob());

    try {
      // The capture is in device pixels; getBoundingClientRect is in CSS px.
      let sx = Math.round((rect.x || 0) * dpr);
      let sy = Math.round((rect.y || 0) * dpr);
      let sw = Math.round((rect.w || 0) * dpr);
      let sh = Math.round((rect.h || 0) * dpr);

      // A card can hang off the edge of the viewport; clamp rather than fail,
      // so a partially visible card still yields the part that was captured.
      sx = Math.max(0, Math.min(sx, bmp.width - 1));
      sy = Math.max(0, Math.min(sy, bmp.height - 1));
      sw = Math.max(1, Math.min(sw, bmp.width - sx));
      sh = Math.max(1, Math.min(sh, bmp.height - sy));

      const scale = Math.min(1, maxEdge / Math.max(sw, sh));
      const outW = Math.max(1, Math.round(sw * scale));
      const outH = Math.max(1, Math.round(sh * scale));

      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingQuality = 'high';
      // Flatten onto white: JPEG has no alpha, and a transparent card would
      // otherwise come out black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, outW, outH);

      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return { ok: true, dataUrl: 'data:image/jpeg;base64,' + btoa(bin), w: outW, h: outH, bytes: buf.length };
    } finally {
      bmp.close();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen' || msg.action !== 'cropShot') return;
    cropShot(msg)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e).slice(0, 180) }));
    return true;
  });

  // Exposed for the test harness; harmless in the extension.
  self.__cropShot = cropShot;
})();
