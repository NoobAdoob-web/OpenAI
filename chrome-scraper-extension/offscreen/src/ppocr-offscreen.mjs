'use strict';
// Offscreen document: on-device OCR using PaddleOCR PP-OCRv4 (detection +
// recognition) via onnxruntime-web (WASM). English/Latin. No network, no
// OpenCV — detection post-processing is a light connected-components pass.
import * as ort from 'onnxruntime-web';

const BASE = chrome.runtime.getURL('ocr/');
ort.env.wasm.wasmPaths = BASE;
ort.env.wasm.numThreads = 1;
try { ort.env.wasm.proxy = false; } catch (_) {}

const DICT = (() => null)();
let dictArr = null;
let detSess = null, recSess = null;

async function loadDict() {
  if (dictArr) return dictArr;
  const txt = await (await fetch(BASE + 'ppocr_keys_v1.txt')).text();
  dictArr = [...txt.split('\n'), ' '];
  return dictArr;
}
function getDet() {
  if (!detSess) detSess = ort.InferenceSession.create(BASE + 'ch_PP-OCRv4_det_infer.onnx', { executionProviders: ['wasm'] });
  return detSess;
}
function getRec() {
  if (!recSess) recSess = ort.InferenceSession.create(BASE + 'ch_PP-OCRv4_rec_infer.onnx', { executionProviders: ['wasm'] });
  return recSess;
}

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img load')); i.src = src; });
}
// Draw a data URL into a canvas and return {data(RGBA), width, height}.
async function toRGBA(dataUrl) {
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  return { data: id.data, width: c.width, height: c.height };
}

// Bilinear resize of an RGBA buffer.
function resizeRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * yr - 0.5); const y0 = Math.max(0, Math.floor(sy)); const y1 = Math.min(sh - 1, y0 + 1); const wy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x + 0.5) * xr - 0.5); const x0 = Math.max(0, Math.floor(sx)); const x1 = Math.min(sw - 1, x0 + 1); const wx = sx - x0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4, o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) { const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx, bot = src[i10 + c] * (1 - wx) + src[i11 + c] * wx; out[o + c] = top * (1 - wy) + bot * wy; }
    }
  }
  return out;
}

async function detect(img, W, H) {
  const sess = await getDet();
  const cap = 960; const scale = Math.min(1, cap / Math.max(W, H));
  const W2 = Math.max(32, Math.round(W * scale / 32) * 32), H2 = Math.max(32, Math.round(H * scale / 32) * 32);
  const r = resizeRGBA(img, W, H, W2, H2);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const n = W2 * H2; const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = ((r[i * 4] / 255) - mean[0]) / std[0];
    data[n + i] = ((r[i * 4 + 1] / 255) - mean[1]) / std[1];
    data[2 * n + i] = ((r[i * 4 + 2] / 255) - mean[2]) / std[2];
  }
  const out = (await sess.run({ x: new ort.Tensor('float32', data, [1, 3, H2, W2]) }))['sigmoid_0.tmp_0'];
  const oh = out.dims[2], ow = out.dims[3], prob = out.data;
  const bin = new Uint8Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) bin[i] = prob[i] > 0.3 ? 1 : 0;
  const boxes = []; const seen = new Uint8Array(ow * oh); const stack = [];
  const sx = W / ow, sy = H / oh;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const idx = y * ow + x; if (!bin[idx] || seen[idx]) continue;
    let minx = x, maxx = x, miny = y, maxy = y, area = 0; stack.length = 0; stack.push(idx); seen[idx] = 1;
    while (stack.length) {
      const p = stack.pop(); const py = (p / ow) | 0, px = p % ow; area++;
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= ow || ny >= oh) continue; const q = ny * ow + nx; if (bin[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (area < 10 || bh < 3 || bw < 3) continue;
    const padx = Math.round(bh * sy * 0.6), pady = Math.round(bh * sy * 0.35);
    const ox0 = Math.max(0, Math.round(minx * sx) - padx), oy0 = Math.max(0, Math.round(miny * sy) - pady);
    const ox1 = Math.min(W, Math.round((maxx + 1) * sx) + padx), oy1 = Math.min(H, Math.round((maxy + 1) * sy) + pady);
    boxes.push({ x: ox0, y: oy0, w: ox1 - ox0, h: oy1 - oy0, cy: (oy0 + oy1) / 2 });
  }
  return boxes;
}

function cropRGBA(src, W, H, b) {
  const out = new Uint8ClampedArray(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) { const s = ((b.y + y) * W + (b.x + x)) * 4, d = (y * b.w + x) * 4; out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255; }
  return out;
}
function decodeCTC(dict, idx, prob) {
  const cs = [], cf = [];
  for (let i = 0; i < idx.length; i++) { if (idx[i] === 0) continue; if (i > 0 && idx[i - 1] === idx[i]) continue; cs.push(dict[idx[i] - 1]); cf.push(prob[i]); }
  const mean = cf.length ? cf.reduce((a, b) => a + b, 0) / cf.length : 0;
  return { text: cs.join(''), mean };
}
async function recognize(dict, crop, cw, ch) {
  const sess = await getRec();
  const Hh = 48, Wr = Math.max(16, Math.round(cw * 48 / ch));
  const r = resizeRGBA(crop, cw, ch, Wr, Hh);
  const n = Wr * Hh; const R = [], G = [], B = [];
  for (let i = 0; i < n; i++) { R.push(r[i * 4] / 255); G.push(r[i * 4 + 1] / 255); B.push(r[i * 4 + 2] / 255); }
  const out = (await sess.run({ x: new ort.Tensor('float32', Float32Array.from([...B, ...G, ...R]), [1, 3, Hh, Wr]) }))['softmax_11.tmp_0'];
  const predLen = out.dims[2]; const idx = [], prob = [];
  for (let i = 0; i < out.data.length; i += predLen) { const a = out.data.slice(i, i + predLen); let m = -Infinity, mi = 0; for (let k = 0; k < a.length; k++) if (a[k] > m) { m = a[k]; mi = k; } idx.push(mi); prob.push(m); }
  return decodeCTC(dict, idx, prob);
}

async function runOcr(dataUrl) {
  const dict = await loadDict();
  const { data, width, height } = await toRGBA(dataUrl);
  const boxes = await detect(data, width, height);
  boxes.sort((a, b) => Math.abs(a.cy - b.cy) > 10 ? a.cy - b.cy : a.x - b.x);
  const items = [];
  for (const b of boxes) {
    const c = cropRGBA(data, width, height, b);
    const r = await recognize(dict, c, b.w, b.h);
    if (r.text && r.text.trim() && r.mean >= 0.5) items.push({ text: r.text.trim(), mean: r.mean, cy: b.cy });
  }
  // Group boxes on the same visual row into one line (join with spaces).
  const lines = []; let cur = null;
  for (const it of items) {
    if (cur && Math.abs(it.cy - cur.cy) <= 14) { cur.parts.push(it.text); cur.confs.push(it.mean); }
    else { cur = { cy: it.cy, parts: [it.text], confs: [it.mean] }; lines.push(cur); }
  }
  const text = lines.map(l => l.parts.join(' ')).join('\n').trim();
  const allc = items.map(i => i.mean);
  const conf = allc.length ? Math.round(100 * allc.reduce((a, b) => a + b, 0) / allc.length) : 0;
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
