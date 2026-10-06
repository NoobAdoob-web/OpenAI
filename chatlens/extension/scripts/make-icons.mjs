// Draws the placeholder icon (indigo square, white lens) as PNGs. No green, no
// WhatsApp-style shapes (PID section 17). Run: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y, size), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const clamp = (v) => Math.max(0, Math.min(1, v));
function pixel(px, py, size) {
  const S = 4; // supersample
  let bg = 0, fg = 0;
  for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
    const x = (px + (i + 0.5) / S) / size, y = (py + (j + 0.5) / S) / size;
    // rounded square
    const r = 0.22, dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0), dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
    if (Math.hypot(dx, dy) > r) continue;
    bg++;
    // lens ring
    const d = Math.hypot(x - 0.44, y - 0.44);
    const ring = d > 0.2 && d < 0.29;
    // handle
    const t = clamp(((x - 0.62) + (y - 0.62)) / 2 / 0.16), hx = 0.62 + t * 0.16, hy = 0.62 + t * 0.16;
    const handle = Math.hypot(x - hx, y - hy) < 0.065 && x + y > 1.2;
    if (ring || handle) fg++;
  }
  const a = bg / (S * S), f = bg ? fg / bg : 0;
  const mix = (c1, c2) => Math.round(c1 * (1 - f) + c2 * f);
  return [mix(79, 255), mix(70, 255), mix(229, 255), Math.round(a * 255)];
}

mkdirSync('public/icon', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icon/${s}.png`, png(s, pixel));
console.log('icons written');
