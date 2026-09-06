'use strict';
// Offscreen document: on-device OCR using PaddleOCR PP-OCRv4 (detection +
// recognition) via onnxruntime-web (WASM). English/Latin. No network, no
// OpenCV. Detection post-processing is a light connected-components pass that
// merges text into LINE regions; each whole line is recognised (the model
// emits spaces natively when given a padded line crop with margins).
import * as ort from 'onnxruntime-web';

const BASE = chrome.runtime.getURL('ocr/');
ort.env.wasm.wasmPaths = BASE;
ort.env.wasm.numThreads = 1;
try { ort.env.wasm.proxy = false; } catch (_) {}

let dictArr = null, detSess = null, recSess = null, allowMask = null;
async function loadDict() {
  if (dictArr) return dictArr;
  const txt = await (await fetch(BASE + 'ppocr_keys_v1.txt')).text();
  dictArr = [...txt.split('\n'), ' '];
  // Latin-only mask: we ship the Chinese PP-OCRv4 model, which can otherwise
  // emit stray CJK glyphs on English creatives. Blocking non-Latin classes
  // removes that noise.
  allowMask = new Uint8Array(dictArr.length + 1);
  allowMask[0] = 1; // CTC blank
  const LATIN = /^[\x20-\x7E\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u20B9]$/;
  for (let i = 0; i < dictArr.length; i++) allowMask[i + 1] = (dictArr[i] && LATIN.test(dictArr[i])) ? 1 : 0;
  return dictArr;
}
function getDet() { if (!detSess) detSess = ort.InferenceSession.create(BASE + 'ch_PP-OCRv4_det_infer.onnx', { executionProviders: ['wasm'] }); return detSess; }
function getRec() { if (!recSess) recSess = ort.InferenceSession.create(BASE + 'ch_PP-OCRv4_rec_infer.onnx', { executionProviders: ['wasm'] }); return recSess; }

function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img load')); i.src = src; }); }

// Draw a data URL into a canvas → {data(RGBA), width, height}. Upscales small
// images so detection/recognition have more pixels.
async function toRGBA(dataUrl) {
  const img = await loadImage(dataUrl);
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  // Upscale to ~1280 on the long edge. Measured: this is what recovers word
  // spaces on SMALL on-image text (e.g. legal/strap lines on reel covers).
  const longest = Math.max(w, h) || 1;
  const scale = longest < 1280 ? Math.min(3, 1280 / longest) : 1;
  w = Math.round(w * scale); h = Math.round(h * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  return { data: id.data, width: w, height: h };
}

// Bilinear resize of an RGBA buffer.
function resizeRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4); const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * yr - 0.5), y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), wy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x + 0.5) * xr - 0.5), x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), wx = sx - x0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4, o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) { const t = src[i00 + c] * (1 - wx) + src[i01 + c] * wx, b = src[i10 + c] * (1 - wx) + src[i11 + c] * wx; out[o + c] = t * (1 - wy) + b * wy; }
    }
  }
  return out;
}

// Detection → connected components → merge into LINE boxes (with generous pad).
async function detLines(img, W, H) {
  const sess = await getDet();
  const cap = 1280, scale = Math.min(2.5, cap / Math.max(W, H));
  const W2 = Math.max(32, Math.round(W * scale / 32) * 32), H2 = Math.max(32, Math.round(H * scale / 32) * 32);
  const r = resizeRGBA(img, W, H, W2, H2);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]; const n = W2 * H2; const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { data[i] = ((r[i * 4] / 255) - mean[0]) / std[0]; data[n + i] = ((r[i * 4 + 1] / 255) - mean[1]) / std[1]; data[2 * n + i] = ((r[i * 4 + 2] / 255) - mean[2]) / std[2]; }
  const out = (await sess.run({ x: new ort.Tensor('float32', data, [1, 3, H2, W2]) }))['sigmoid_0.tmp_0'];
  const oh = out.dims[2], ow = out.dims[3], prob = out.data; const bin = new Uint8Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) bin[i] = prob[i] > 0.3 ? 1 : 0;
  const seen = new Uint8Array(ow * oh), stack = []; const comps = []; const sx = W / ow, sy = H / oh;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const idx = y * ow + x; if (!bin[idx] || seen[idx]) continue;
    let minx = x, maxx = x, miny = y, maxy = y, area = 0; stack.length = 0; stack.push(idx); seen[idx] = 1;
    while (stack.length) { const p = stack.pop(), py = (p / ow) | 0, px = p % ow; area++; if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= ow || ny >= oh) continue; const q = ny * ow + nx; if (bin[q] && !seen[q]) { seen[q] = 1; stack.push(q); } } }
    if (area < 6) continue;
    comps.push({ x0: minx * sx, x1: (maxx + 1) * sx, y0: miny * sy, y1: (maxy + 1) * sy });
  }
  comps.sort((a, b) => a.y0 - b.y0); const lines = [];
  for (const c of comps) {
    let m = null; for (const l of lines) { const oy = Math.min(l.y1, c.y1) - Math.max(l.y0, c.y0); const h = Math.min(l.y1 - l.y0, c.y1 - c.y0); if (oy > 0.5 * h) { m = l; break; } }
    if (m) { m.x0 = Math.min(m.x0, c.x0); m.x1 = Math.max(m.x1, c.x1); m.y0 = Math.min(m.y0, c.y0); m.y1 = Math.max(m.y1, c.y1); } else lines.push({ ...c });
  }
  return lines.map(l => { const h = l.y1 - l.y0, pad = Math.max(3, h * 0.5); const x = Math.max(0, Math.round(l.x0 - pad)), y = Math.max(0, Math.round(l.y0 - pad)); return { x, y, w: Math.min(W, Math.round(l.x1 + pad)) - x, h: Math.min(H, Math.round(l.y1 + pad)) - y, cy: (l.y0 + l.y1) / 2 }; });
}

function cropRGBA(src, W, H, b) { const out = new Uint8ClampedArray(b.w * b.h * 4); for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) { const s = ((b.y + y) * W + (b.x + x)) * 4, d = (y * b.w + x) * 4; out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255; } return out; }
function decodeCTC(dict, idx, prob) { const cs = [], cf = []; for (let i = 0; i < idx.length; i++) { if (idx[i] === 0) continue; if (i > 0 && idx[i - 1] === idx[i]) continue; cs.push(dict[idx[i] - 1]); cf.push(prob[i]); } const mean = cf.length ? cf.reduce((a, b) => a + b, 0) / cf.length : 0; return { text: cs.join(''), mean }; }

async function recognize(dict, cr, cw, ch) {
  const sess = await getRec();
  const Hh = 48, W0 = Math.max(16, Math.round(cw * 48 / ch));
  const r0 = resizeRGBA(cr, cw, ch, W0, Hh);
  // border-median colour, for synthetic left/right margins (helps the model
  // resolve word spaces and edge letters)
  const mcol = [0, 0, 0]; { const px = []; for (let x = 0; x < W0; x++) for (const yy of [0, Hh - 1]) { const o = (yy * W0 + x) * 4; px.push([r0[o], r0[o + 1], r0[o + 2]]); } px.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2])); const m = px[Math.floor(px.length / 2)] || [0, 0, 0]; mcol[0] = m[0]; mcol[1] = m[1]; mcol[2] = m[2]; }
  const MARG = Math.round(Hh * 0.6); const Wr = W0 + 2 * MARG; const r = new Uint8ClampedArray(Wr * Hh * 4);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < Wr; x++) { const o = (y * Wr + x) * 4; const sx = x - MARG; if (sx >= 0 && sx < W0) { const so = (y * W0 + sx) * 4; r[o] = r0[so]; r[o + 1] = r0[so + 1]; r[o + 2] = r0[so + 2]; } else { r[o] = mcol[0]; r[o + 1] = mcol[1]; r[o + 2] = mcol[2]; } r[o + 3] = 255; }
  const n = Wr * Hh, R = [], G = [], B = [];
  for (let i = 0; i < n; i++) { R.push(r[i * 4] / 255); G.push(r[i * 4 + 1] / 255); B.push(r[i * 4 + 2] / 255); }
  const out = (await sess.run({ x: new ort.Tensor('float32', Float32Array.from([...B, ...G, ...R]), [1, 3, Hh, Wr]) }))['softmax_11.tmp_0'];
  const predLen = out.dims[2]; const idx = [], prob = [];
  for (let i = 0; i < out.data.length; i += predLen) {
    const a = out.data.slice(i, i + predLen); let m = -Infinity, mi = 0;
    for (let k = 0; k < a.length; k++) {
      if (allowMask && k < allowMask.length && !allowMask[k]) continue; // Latin-only
      if (a[k] > m) { m = a[k]; mi = k; }
    }
    idx.push(mi); prob.push(m);
  }
  return decodeCTC(dict, idx, prob);
}

async function runOcr(dataUrl) {
  const dict = await loadDict();
  const { data, width, height } = await toRGBA(dataUrl);
  let lines = await detLines(data, width, height);
  lines.sort((a, b) => a.cy - b.cy);
  const out = [], confs = [];
  for (const L of lines) {
    if (L.w < 4 || L.h < 4) continue;
    const r = await recognize(dict, cropRGBA(data, width, height, L), L.w, L.h);
    const t = (r.text || '').replace(/\s+/g, ' ').trim();
    if (t && r.mean >= 0.45) { out.push(t); confs.push(r.mean); }
  }
  const text = out.join('\n').trim();
  const conf = confs.length ? Math.round(100 * confs.reduce((a, b) => a + b, 0) / confs.length) : 0;
  return { text, conf };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.action === 'ocr') {
    runOcr(msg.dataUrl).then(r => sendResponse({ ok: true, text: r.text, conf: r.conf })).catch(e => sendResponse({ ok: false, error: String(e).slice(0, 180) }));
    return true;
  }
  if (msg.action === 'ocrDispose') { detSess = recSess = null; sendResponse({ ok: true }); return true; }
});
