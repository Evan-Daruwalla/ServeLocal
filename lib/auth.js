'use strict';
// Password + token cryptography (extracted per ADR-0015). Pure mechanism: no
// DB access, no request state. Config (JWT secret, token TTL) is injected once
// via init() from server.js, which owns env parsing and the prod-boot refusals.
const crypto = require('crypto');

let SECRET = 'uninitialised';         // set by init(); server.js refuses prod boot on defaults
let TOKEN_TTL_MS = 168 * 36e5;

function init({ secret, tokenTtlMs }) {
  if (secret) SECRET = secret;
  if (tokenTtlMs) TOKEN_TTL_MS = tokenTtlMs;
}

// ── PASSWORD HASHING (scrypt — slow KDF, OWASP-recommended) ──
// New hashes use scrypt and are self-describing: "scrypt$N$r$p$salt$hash".
// Legacy HMAC-SHA256 hashes are still verified and transparently upgraded on
// the user's next successful login (see migrateLegacyPassword).
const SCRYPT_N = Number(process.env.SCRYPT_N) || 32768; // 2^15; raise in prod via env
const SCRYPT_PARAMS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
function hashPassword(pw, salt) { // legacy (kept for migration + verification only)
  return crypto.createHmac('sha256', salt).update(pw).digest('hex');
}
function hashPasswordScrypt(pw, salt = crypto.randomBytes(16).toString('hex'), N = SCRYPT_N) {
  const h = crypto.scryptSync(pw, salt, 64, { ...SCRYPT_PARAMS, N }).toString('hex');
  return `scrypt$${N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${h}`;
}
// Constant-time hex compare (avoids timing side-channels). Returns false on length mismatch.
function timingEqualHex(a, b) {
  try { const ba = Buffer.from(String(a), 'hex'), bb = Buffer.from(String(b), 'hex');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb); } catch { return false; }
}
// Verify a plaintext password against a stored credential (scrypt or legacy).
function verifyPassword(pw, user) {
  const stored = user.passwordHash || '';
  if (stored.startsWith('scrypt$')) {
    const [, N, r, p, salt, hash] = stored.split('$');
    const calc = crypto.scryptSync(pw, salt, 64, { N: +N, r: +r, p: +p, maxmem: SCRYPT_PARAMS.maxmem }).toString('hex');
    return timingEqualHex(calc, hash);
  }
  // legacy HMAC-SHA256 with the per-user salt field
  return timingEqualHex(hashPassword(pw, user.salt), stored);
}
// Set/replace a user's password with a fresh scrypt hash.
function setPassword(user, pw) { user.salt = crypto.randomBytes(16).toString('hex'); user.passwordHash = hashPasswordScrypt(pw, user.salt); }
// Upgrade a legacy hash to scrypt after a verified login (called with plaintext).
function migrateLegacyPassword(user, pw) { if (!(user.passwordHash || '').startsWith('scrypt$')) { setPassword(user, pw); return true; } return false; }

// ── WEAK PASSWORD DENYLIST ────────────────────
// Small bundled list of the most-common passwords; blocks the worst offenders
// at registration / change without a network call (zero-dependency).
const COMMON_PASSWORDS = new Set([
  'password','password1','password123','12345678','123456789','1234567890','qwerty123','qwertyuiop',
  'iloveyou','admin123','welcome1','letmein1','abc12345','11111111','00000000','football','baseball',
  'sunshine','princess','dragon123','monkey123','passw0rd','trustno1','superman','starwars','michael1',
  'changeme','servelocal','volunteer','student1','password!','p@ssword','qwerty12','asdfghjkl',
]);
function weakPassword(pw, email) {
  const p = String(pw || '').toLowerCase();
  if (COMMON_PASSWORDS.has(p)) return true;
  if (/^(.)\1+$/.test(p)) return true;                 // all one character
  if (/^(0123456789|1234567890|abcdefgh)/.test(p)) return true; // obvious sequences
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local && local.length >= 4 && p.includes(local)) return true; // contains the email name
  return false;
}

// ── TOKENS (HMAC-JWT + one-way token hashing) ─
function b64u(str) { return Buffer.from(str).toString('base64url'); }
function makeToken(user) {
  const h = b64u(JSON.stringify({alg:'HS256',typ:'JWT'}));
  // tv = token version: bumping user.tokenVersion invalidates all prior tokens
  // (logout-everywhere / forced revocation on suspend).
  const p = b64u(JSON.stringify({sub:user.id,role:user.role,tv:user.tokenVersion||0,iat:Date.now(),exp:Date.now()+TOKEN_TTL_MS}));
  const s = crypto.createHmac('sha256',SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
function verifyToken(token) {
  try {
    const [h,p,s] = token.split('.');
    const exp = crypto.createHmac('sha256',SECRET).update(`${h}.${p}`).digest('base64url');
    // Constant-time signature comparison (avoids timing oracle on the HMAC).
    const sb = Buffer.from(String(s)), eb = Buffer.from(exp);
    if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
    const d = JSON.parse(Buffer.from(p,'base64url').toString());
    if (d.exp < Date.now()) return null;
    return d;
  } catch { return null; }
}
// One-way hash for single-use secrets stored server-side (reset tickets, MFA
// tickets, backup codes): a DB leak can't be replayed as the original token.
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

module.exports = {
  init, hashPassword, hashPasswordScrypt, verifyPassword, setPassword, migrateLegacyPassword,
  weakPassword, timingEqualHex, b64u, makeToken, verifyToken, hashToken,
};
