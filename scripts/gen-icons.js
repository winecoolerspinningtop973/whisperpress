// Generates all app icons (PNG + ICO) programmatically — no image deps needed.
// Run: node scripts/gen-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- tiny PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO encoder (BMP entries for small sizes, PNG entry for 256) ----------
function bmpEntry(w, h, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // XOR + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((h - 1 - y) * w + x) * 4; // bottom-up
      const dst = (y * w + x) * 4;
      xor[dst] = rgba[src + 2];     // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src];     // R
      xor[dst + 3] = rgba[src + 3]; // A
    }
  }
  const andStride = Math.ceil(w / 32) * 4;
  const and = Buffer.alloc(andStride * h); // all zero: rely on alpha
  return Buffer.concat([header, xor, and]);
}
function encodeICO(images) {
  // images: [{w, h, rgba}]
  const count = images.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(count, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + count * 16;
  for (const img of images) {
    const data = img.w >= 256 ? encodePNG(img.w, img.h, img.rgba) : bmpEntry(img.w, img.h, img.rgba);
    const e = Buffer.alloc(16);
    e[0] = img.w >= 256 ? 0 : img.w;
    e[1] = img.h >= 256 ? 0 : img.h;
    e[4] = 1; e[5] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
    blobs.push(data);
  }
  return Buffer.concat([dir, ...entries, ...blobs]);
}

// ---------- vector-ish renderer using signed distance functions ----------
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r;
}
function sdCircle(px, py, cx, cy, r) { return Math.hypot(px - cx, py - cy) - r; }

// Render the WhisperPress mark: rounded gradient tile + white microphone.
// theme: 'brand' (violet) | 'rec' (red) | 'mono' (transparent bg, solid fg for tray)
function render(size, theme = 'brand') {
  const buf = Buffer.alloc(size * size * 4);
  const S = 2; // supersampling
  const fg = theme === 'mono' ? [255, 255, 255] : [255, 255, 255];
  const topC = theme === 'rec' ? [239, 68, 68] : [109, 94, 246];   // red-500 / indigo-violet
  const botC = theme === 'rec' ? [185, 28, 28] : [147, 51, 234];   // red-700 / purple-600
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0, fgCov = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          const aa = 1.0 / size; // ~1px smoothing in normalized units
          const cov = (d) => clamp(0.5 - d / aa, 0, 1);
          // background tile
          let bg = 0;
          if (theme !== 'mono') bg = cov(sdRoundRect(u, v, 0.5, 0.5, 0.46, 0.46, 0.21));
          // microphone: capsule body
          let d = sdRoundRect(u, v, 0.5, 0.375, 0.085, 0.155, 0.085);
          // U-holder: ring clipped to lower half
          const ring = Math.abs(sdCircle(u, v, 0.5, 0.50, 0.165)) - 0.0335;
          if (v >= 0.50) d = Math.min(d, ring);
          // side ring tips (square off at v=0.50 handled by clip; add small caps)
          d = Math.min(d, sdCircle(u, v, 0.5 - 0.165, 0.50, 0.0335));
          d = Math.min(d, sdCircle(u, v, 0.5 + 0.165, 0.50, 0.0335));
          // stem
          d = Math.min(d, sdRoundRect(u, v, 0.5, 0.715, 0.0335, 0.052, 0.03));
          // base
          d = Math.min(d, sdRoundRect(u, v, 0.5, 0.79, 0.105, 0.0335, 0.03));
          const f = cov(d);
          bgCov += bg;
          fgCov += f;
        }
      }
      bgCov /= S * S; fgCov /= S * S;
      const t = y / size;
      const br = topC[0] + (botC[0] - topC[0]) * t;
      const bgC = topC[1] + (botC[1] - topC[1]) * t;
      const bb = topC[2] + (botC[2] - topC[2]) * t;
      // composite: fg over bg over transparent
      const outA = fgCov + bgCov * (1 - fgCov);
      const i = (y * size + x) * 4;
      if (outA <= 0) { buf[i + 3] = 0; continue; }
      const r = (fg[0] * fgCov + br * bgCov * (1 - fgCov)) / outA;
      const g = (fg[1] * fgCov + bgC * bgCov * (1 - fgCov)) / outA;
      const b = (fg[2] * fgCov + bb * bgCov * (1 - fgCov)) / outA;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(outA * 255);
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(256, 256, render(256)));
fs.writeFileSync(path.join(outDir, 'tray.png'), encodePNG(32, 32, render(32)));
fs.writeFileSync(path.join(outDir, 'tray-rec.png'), encodePNG(32, 32, render(32, 'rec')));
fs.writeFileSync(path.join(outDir, 'app.ico'), encodeICO([
  { w: 16, h: 16, rgba: render(16) },
  { w: 24, h: 24, rgba: render(24) },
  { w: 32, h: 32, rgba: render(32) },
  { w: 48, h: 48, rgba: render(48) },
  { w: 256, h: 256, rgba: render(256) },
]));
console.log('icons written to', outDir);
