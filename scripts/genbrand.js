#!/usr/bin/env node
// Derives ServeLocal's brand PNGs from the master logo (public/servelocal-logo.png)
// — zero dependencies (Node `zlib` only). Decodes the logo, box-filter downscales
// it, and composites the icon/share assets. Re-run after replacing the logo:
//   node scripts/genbrand.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');
const MASTER = path.join(OUT, 'servelocal-logo.png');

// ── PNG encode (RGBA, 8-bit) ──
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── PNG decode (8-bit, colour type 6 RGBA, non-interlaced) ──
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function decodePNG(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) throw new Error('expected 8-bit RGBA non-interlaced PNG');
  let off = 8, idat = [];
  while (off < buf.length) { const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8); if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len)); off += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4, out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], rowIn = y * (stride + 1) + 1, rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rowIn + x];
      const a = x >= 4 ? out[rowOut + x - 4] : 0;
      const b = y > 0 ? out[rowOut - stride + x] : 0;
      const c = (x >= 4 && y > 0) ? out[rowOut - stride + x - 4] : 0;
      let r;
      switch (ft) { case 0: r = v; break; case 1: r = v + a; break; case 2: r = v + b; break; case 3: r = v + ((a + b) >> 1); break; case 4: r = v + paeth(a, b, c); break; default: throw new Error('bad filter ' + ft); }
      out[rowOut + x] = r & 0xff;
    }
  }
  return { w, h, data: out };
}

// ── alpha-weighted box-filter downscale ──
function resize(img, dw, dh) {
  const { w: sw, h: sh, data: src } = img, dst = Buffer.alloc(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * sh / dh), y1 = Math.max(y0 + 1, Math.floor((dy + 1) * sh / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * sw / dw), x1 = Math.max(x0 + 1, Math.floor((dx + 1) * sw / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * sw + x) * 4, al = src[i + 3];
        r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++;
      }
      const i = (dy * dw + dx) * 4;
      if (a > 0) { dst[i] = Math.round(r / a); dst[i + 1] = Math.round(g / a); dst[i + 2] = Math.round(b / a); }
      dst[i + 3] = Math.round(a / n);
    }
  }
  return { w: dw, h: dh, data: dst };
}

// solid canvas + source-over composite
function canvas(w, h, rgba) { const d = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = rgba[0]; d[i * 4 + 1] = rgba[1]; d[i * 4 + 2] = rgba[2]; d[i * 4 + 3] = rgba[3]; } return { w, h, data: d }; }
function over(dst, src, ox, oy) {
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const s = (y * src.w + x) * 4, di = ((oy + y) * dst.w + (ox + x)) * 4;
    const sa = src.data[s + 3] / 255; if (sa === 0) continue;
    const da = dst.data[di + 3] / 255, oa = sa + da * (1 - sa);
    for (let k = 0; k < 3; k++) dst.data[di + k] = Math.round((src.data[s + k] * sa + dst.data[di + k] * da * (1 - sa)) / (oa || 1));
    dst.data[di + 3] = Math.round(oa * 255);
  }
}
// dominant tile green: the single most common opaque, non-white colour in the
// master (edge-midpoint sampling caught antialiased pixels and read too light).
function sampleGreen(img) {
  const tally = new Map();
  for (let i = 0; i < img.w * img.h; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2], a = img.data[i * 4 + 3];
    if (a < 250 || (r > 230 && g > 230 && b > 230)) continue; // skip transparent + near-white
    const k = (r << 16) | (g << 8) | b;
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [k, n] of tally) if (n > bestN) { bestN = n; best = k; }
  return bestN < 0 ? [0x1a, 0x6b, 0x4a] : [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

function write(name, png) { fs.writeFileSync(path.join(OUT, name), png); console.log(name.padEnd(22), (png.length / 1024).toFixed(1) + ' KB'); }

const logo = decodePNG(fs.readFileSync(MASTER));
const green = sampleGreen(logo);
console.log('master', logo.w + 'x' + logo.h, 'green #' + green.map(x => x.toString(16).padStart(2, '0')).join(''));

// Favicons: transparent rounded tile (browsers show the logo as-is).
write('favicon-32.png', encodePNG(32, 32, resize(logo, 32, 32).data));
write('favicon-16.png', encodePNG(16, 16, resize(logo, 16, 16).data));

// Apple touch: opaque green square (iOS masks corners) with the logo composited.
const apple = canvas(180, 180, [...green, 255]); over(apple, resize(logo, 180, 180), 0, 0);
write('apple-touch-icon.png', encodePNG(180, 180, apple.data));

// Share card: 1200x630 green card with the logo centred.
const W = 1200, H = 630, L = 460;
const og = canvas(W, H, [...green, 255]); over(og, resize(logo, L, L), Math.round((W - L) / 2), Math.round((H - L) / 2));
write('og-image.png', encodePNG(W, H, og.data));
console.log('done.');
