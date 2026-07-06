'use strict';
// Zero-dependency RFC 6238 TOTP (and RFC 4226 HOTP) on node:crypto.
// 6-digit codes, 30s steps, SHA-1 — the parameters every authenticator app
// (Google Authenticator, Authy, 1Password, ...) uses by default.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1e6).padStart(6, '0');
}

function totp(secretB32, t = Date.now()) {
  return hotp(base32Decode(secretB32), Math.floor(t / 1000 / 30));
}

// Accepts the current step plus/minus one (clock drift). Constant-time compares.
function verifyTotp(secretB32, code, t = Date.now()) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(t / 1000 / 30);
  const secret = base32Decode(secretB32);
  let ok = false;
  for (const s of [step, step - 1, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(c))) ok = true;
  }
  return ok;
}

function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

module.exports = { generateSecret, totp, verifyTotp, hotp, base32Encode, base32Decode };
