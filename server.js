/**
 * ServeLocal v2 — Full Backend (zero npm dependencies)
 * Run: node server.js
 */

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const url  = require('url');

// ── LOAD .env FILE ────────────────────────────────
// Looks for .env in the same folder as server.js
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  fs.readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return; // skip blanks and comments
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, ''); // strip optional quotes
      if (!process.env[key]) process.env[key] = value; // don't override real env vars
    });
  console.log('✅ .env loaded from', ENV_FILE);
} else {
  console.warn('⚠️  No .env file found at', ENV_FILE, '— using defaults');
}

const NODE_ENV   = process.env.NODE_ENV || 'development';
const IS_PROD    = NODE_ENV === 'production';
const PORT       = process.env.PORT || 3000;
const DB_FILE    = process.env.DB_FILE || path.join(__dirname, 'db.json');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const DEFAULT_SECRET = 'servelocal-v2-secret-CHANGE-IN-PROD';
const SECRET     = process.env.JWT_SECRET || DEFAULT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@servelocal.org';
const DEFAULT_ADMIN_PASSWORD = 'admin1234';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

// ── SECRETS MANAGEMENT ────────────────────────
// Fail closed in production if the signing secret was never set — a default
// secret means anyone can forge auth tokens and calendar-feed HMACs.
if (IS_PROD && SECRET === DEFAULT_SECRET) {
  console.error('FATAL: JWT_SECRET is unset in production. Refusing to start with the default secret.');
  console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
if (!IS_PROD && SECRET === DEFAULT_SECRET) {
  console.warn('⚠️  Using the built-in development JWT secret. Set JWT_SECRET before deploying (see .env.example).');
}
// Same posture for the seeded admin account: the default password is public (it's
// in this source), so booting prod with it is a known backdoor to full admin.
if (IS_PROD && ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD is unset in production. Refusing to start with the default admin password.');
  console.error('Set a strong ADMIN_PASSWORD (and ADMIN_EMAIL) before deploying (see .env.example).');
  process.exit(1);
}
if (!IS_PROD && ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) {
  console.warn('⚠️  Using the built-in development admin password. Set ADMIN_PASSWORD before deploying.');
}
// Token lifetime is configurable; default 7 days. Shorter = tighter session window.
const TOKEN_TTL_MS = (Number(process.env.TOKEN_TTL_HOURS) || 168) * 36e5;
// Guardian-consent one-time approval link lifetime; default 72h.
const CONSENT_TOKEN_TTL_HOURS = Number(process.env.CONSENT_TOKEN_TTL_HOURS) || 72;
const CONSENT_TOKEN_TTL_MS = CONSENT_TOKEN_TTL_HOURS * 36e5;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// CORS allowlist. Empty (dev default) => permissive "*". In production set
// ALLOWED_ORIGINS to a comma-separated list of exact origins to lock down CORS.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
// Per-IP rate-limit buckets (tunable via env for prod/testing).
const RL_WRITE = { capacity: Number(process.env.RL_WRITE_CAP) || 40,  refillPerSec: Number(process.env.RL_WRITE_REFILL) || 1 };
const RL_READ  = { capacity: Number(process.env.RL_READ_CAP)  || 120, refillPerSec: Number(process.env.RL_READ_REFILL)  || 2 };
function resolveCors(req) {
  if (!ALLOWED_ORIGINS.length) return '*';
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

// Free-provider domains blocked for org signup
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com',
  'icloud.com','protonmail.com','mail.com','zoho.com','yandex.com',
  'live.com','msn.com','me.com','inbox.com','gmx.com','fastmail.com'
]);

// ── NATIONAL AWARD THRESHOLDS ─────────────────
const AWARDS = [
  { id:'nhs',        name:'National Honor Society',          hours:10,  description:'Minimum volunteer hours for NHS consideration' },
  { id:'president',  name:"President's Volunteer Service Award — Bronze", hours:50,  description:'Ages 14–18: 50 verified hours' },
  { id:'president_s',name:"President's Volunteer Service Award — Silver", hours:100, description:'Ages 14–18: 100 verified hours' },
  { id:'president_g',name:"President's Volunteer Service Award — Gold",   hours:250, description:'Ages 14–18: 250 verified hours' },
  { id:'ssl',        name:'SSL Certificate (Maryland)',       hours:75,  description:'75 hours for SSL Certificate' },
  { id:'gold_seal',  name:'Governor\'s Gold Seal (varies by state)',      hours:100, description:'100 verified hours' },
];

// ── ORG PLANS (students are always free) ──────
// Revenue comes from org Pro subscriptions + community supporters — never student fees.
// Checkout is DEMO-mode until Stripe keys are configured (see DEPLOY.txt §9).
const PLANS = {
  free: { id:'free', name:'Community', price:0,  maxActiveListings:3,    maxFeatured:0, rosterExport:false,
          blurb:'Everything a small organization needs to recruit student volunteers.' },
  pro:  { id:'pro',  name:'Pro',       price:19, maxActiveListings:null, maxFeatured:3, rosterExport:true,
          blurb:'For organizations that run many programs and want to grow faster.' },
};
function orgPlan(u) { return PLANS[u?.plan] || PLANS.free; }

// ════════════════════════════════════════════════════════════════════
// SECURITY & RESILIENCE INFRASTRUCTURE
// All zero-dependency. See docs/security.md for the controls matrix.
// ════════════════════════════════════════════════════════════════════

// ── INPUT SANITIZATION ────────────────────────
// Strip control characters (incl. null bytes), trim, and length-cap any
// user-supplied string. Defense-in-depth alongside output escaping in the SPA.
function sstr(v, max = 500) {
  if (v == null) return '';
  // strip control chars (incl. null bytes) using explicit code-point ranges
  return String(v).split('').filter(c=>{const n=c.charCodeAt(0);return !((n>=0&&n<=8)||n===11||n===12||(n>=14&&n<=31)||n===127);}).join('').trim().slice(0, max);
}
function clampNum(v, min, max, dflt = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isEmail(v) { return EMAIL_RE.test(String(v || '')); }

// ── IN-MEMORY CACHE (TTL + write-invalidation) ──
// Coarse but safe: every DB write bumps the version, invalidating all entries.
let _cacheVersion = 0;
const _cache = new Map(); // key -> { v, exp, data }
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (e.v !== _cacheVersion || e.exp < Date.now()) { _cache.delete(key); return undefined; }
  return e.data;
}
function cacheSet(key, data, ttlMs = 10000) {
  _cache.set(key, { v: _cacheVersion, exp: Date.now() + ttlMs, data });
  return data;
}
function bumpCache() { _cacheVersion++; if (_cache.size > 500) _cache.clear(); }

// ── IN-MEMORY INDEXES (primary + foreign key) ──
// The whole JSON store lives in memory, so without indexes every lookup is an O(n)
// Array.find/filter scan — and the hot handlers do several per request. These Maps
// make id / foreign-key lookups O(1). They're *derived* state: rebuilt lazily
// whenever the DB object is swapped (load/seed/restore/tests) OR any write bumps
// `_cacheVersion` — the same coarse invalidation the read cache uses, so an index
// can never return state older than the last save. Read only via IDX(); never hold
// the returned object across a write (it may be rebuilt underneath you).
let _idx = null, _idxVersion = -1, _idxDbRef = null;
function buildIndexes() {
  const byId = arr => { const m = new Map(); for (const x of arr) m.set(x.id, x); return m; };
  // Group into Map<key, item[]>; skips null/undefined keys so a missing FK doesn't bucket.
  const group = (arr, key) => { const m = new Map(); for (const x of arr) { const k = x[key]; if (k == null) continue; let g = m.get(k); if (!g) m.set(k, g = []); g.push(x); } return m; };
  const usersByEmail = new Map(); for (const u of DB.users) if (u.email) usersByEmail.set(u.email, u);
  const usersByOrgId = new Map(); for (const u of DB.users) if (u.orgId) usersByOrgId.set(u.orgId, u);
  _idx = {
    userById: byId(DB.users),
    userByEmail: usersByEmail,
    userByOrgId: usersByOrgId,               // one org user per orgId
    oppById: byId(DB.opportunities),
    appById: byId(DB.applications),
    hoursById: byId(DB.hours),
    appsByOpp: group(DB.applications, 'oppId'),
    appsByUser: group(DB.applications, 'userId'),
    hoursByUser: group(DB.hours, 'userId'),
    notifsByUser: group(DB.notifications, 'userId'),
    messagesByOpp: group(DB.messages, 'oppId'),
    reviewsByOrg: group(DB.reviews, 'orgId'),
    oppsByOrg: group(DB.opportunities, 'orgId'),
    endorsementsByUser: group(DB.endorsements, 'userId'),
  };
  _idxVersion = _cacheVersion;
  _idxDbRef = DB;
}
function IDX() {
  if (_idx === null || _idxDbRef !== DB || _idxVersion !== _cacheVersion) buildIndexes();
  return _idx;
}
// Convenience: foreign-key groups return a shared [] when empty so callers can
// iterate/spread without null checks (never mutate the returned array in place).
const _EMPTY = Object.freeze([]);
function idxList(map, key) { return map.get(key) || _EMPTY; }
// Owned-opportunity lookup: O(1) by id, then the ownership guard. Returns undefined
// if the id is unknown or the opp belongs to another org (same result the old
// `find(o=>o.id===X && o.orgId===Y)` produced, so downstream !opp checks are unchanged).
function ownedOpp(oppId, orgId) { const o = IDX().oppById.get(oppId); return o && o.orgId === orgId ? o : undefined; }

// ── RATE LIMITER (per-IP token bucket) ────────
// Abuse prevention layered on top of the auth-specific login throttle.
const _buckets = new Map(); // ip -> { tokens, last }
function rateLimit(ip, { capacity = 120, refillPerSec = 2 } = {}) {
  const now = Date.now();
  let b = _buckets.get(ip);
  if (!b) { b = { tokens: capacity, last: now }; _buckets.set(ip, b); }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
  b.last = now;
  if (b.tokens < 1) return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerSec) };
  b.tokens -= 1;
  return { ok: true };
}
setInterval(() => { // evict idle buckets so the map can't grow unbounded
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [ip, b] of _buckets) if (b.last < cutoff) _buckets.delete(ip);
  for (const [k, a] of loginAttempts) if (Date.now() - a.first > 15 * 60 * 1000) loginAttempts.delete(k);
}, 5 * 60 * 1000).unref?.();

// ── CIRCUIT BREAKER (for external calls) ──────
function makeBreaker({ failThreshold = 5, cooldownMs = 30000 } = {}) {
  let failures = 0, openUntil = 0;
  return {
    canRequest() { return Date.now() >= openUntil; },
    success() { failures = 0; openUntil = 0; },
    failure() { if (++failures >= failThreshold) openUntil = Date.now() + cooldownMs; },
    get state() { return Date.now() < openUntil ? 'open' : (failures > 0 ? 'half-open' : 'closed'); },
  };
}
const geocodeBreaker = makeBreaker();

// ── IDEMPOTENCY STORE ─────────────────────────
// Replays the original response when a client retries a mutating request
// carrying the same Idempotency-Key (network retries become safe).
const _idem = new Map(); // key -> { exp, status, body }
function idemGet(key) {
  const e = _idem.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) { _idem.delete(key); return undefined; }
  return e;
}
function idemSet(key, status, body) {
  _idem.set(key, { exp: Date.now() + 10 * 60 * 1000, status, body });
  if (_idem.size > 2000) { const k = _idem.keys().next().value; _idem.delete(k); }
}

// ── SECURITY HEADERS ──────────────────────────
// CSP keeps 'unsafe-inline' for script/style because the SPA is intentionally
// inline-everything (see ADR-0007); everything else is locked down: no external
// scripts, no framing (clickjacking), no plugins, same-origin connections only.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');
function securityHeaders(extra = {}) {
  const h = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...extra,
  };
  // HSTS only over TLS (and behind a TLS-terminating proxy in prod)
  if (IS_PROD) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

// ── RBAC HELPER ───────────────────────────────
// Returns the user if they hold one of the allowed roles, else null. Callers
// still own the response; this centralizes the role check so it can't drift.
function requireRole(user, ...roles) {
  return user && roles.includes(user.role) ? user : null;
}

// ── FILE-BASED DATABASE ───────────────────────
const DB_COLLECTIONS = ['users','opportunities','hours','applications','messages','reviews','reports','verificationTokens','notifications','endorsements','donations','auditLog'];
let DB = Object.fromEntries(DB_COLLECTIONS.map(k => [k, []]));
let _dbHealthy = true;   // flips false if a save fails — surfaced at /api/health/ready
let _lastSaveFailure = null;

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      DB_COLLECTIONS.forEach(k => { if (!DB[k]) DB[k] = []; });
      console.log('📂 Database loaded');
    } else {
      seedDB();
    }
  } catch(e) {
    // Graceful degradation: a corrupt db.json must not take the service down.
    console.error('DB load error:', e.message, '— attempting newest backup, else reseeding');
    // Persist the recovered state back to the primary file so disk is healthy
    // again immediately (not left corrupt until the next write). seedDB() already saves.
    if (restoreFromBackup()) saveDB();
    else seedDB();
  }
}

// Atomic write: serialise to a temp file then rename (rename is atomic on the
// same volume on both POSIX and Windows), so a crash mid-write can never leave
// a half-written db.json. A failed save degrades gracefully — we keep serving
// from memory and flag readiness rather than crashing.
function saveDB() {
  try {
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
    fs.renameSync(tmp, DB_FILE);
    _dbHealthy = true; _lastSaveFailure = null;
    bumpCache(); // any write invalidates read caches
  } catch (e) {
    _dbHealthy = false; _lastSaveFailure = e.message;
    console.error('DB save FAILED (serving from memory):', e.message);
  }
}

// ── BACKUPS (RPO) + RESTORE (RTO) ─────────────
function backupSnapshot() {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `db-${stamp}.json`);
    fs.copyFileSync(DB_FILE, dest);
    // Retain the most recent 48 snapshots (~24h at 30-min cadence)
    const snaps = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('db-') && f.endsWith('.json')).sort();
    while (snaps.length > 48) fs.unlinkSync(path.join(BACKUP_DIR, snaps.shift()));
    return dest;
  } catch (e) { console.error('Backup failed:', e.message); return null; }
}
function restoreFromBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return false;
    const snaps = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('db-') && f.endsWith('.json')).sort();
    while (snaps.length) {
      const latest = snaps.pop();
      try {
        const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, latest), 'utf8'));
        DB = data; DB_COLLECTIONS.forEach(k => { if (!DB[k]) DB[k] = []; });
        console.log('♻️  Restored database from backup', latest);
        return true;
      } catch { /* try the next-older snapshot */ }
    }
  } catch (e) { console.error('Restore failed:', e.message); }
  return false;
}

// ── TAMPER-EVIDENT AUDIT LOG (hash-chained) ───
// Each entry embeds the SHA-256 of (prevHash + canonical entry). Altering or
// deleting any past entry breaks the chain, which verifyAuditChain() detects.
function auditCanonical(e) {
  return e.prevHash + '|' + e.seq + '|' + e.ts + '|' + e.actor + '|' + e.action + '|' + e.target + '|' + JSON.stringify(e.meta);
}
function appendAudit(actor, action, target, meta = {}) {
  const prev = DB.auditLog[DB.auditLog.length - 1];
  const entry = {
    seq: DB.auditLog.length,
    ts: iso(),
    actor: actor || 'system',
    action,
    target: target || '',
    meta,
    prevHash: prev ? prev.hash : 'GENESIS',
  };
  entry.hash = crypto.createHash('sha256').update(auditCanonical(entry)).digest('hex');
  DB.auditLog.push(entry);
  return entry;
}
function verifyAuditChain() {
  let prevHash = 'GENESIS';
  for (const e of DB.auditLog) {
    const h = crypto.createHash('sha256').update(auditCanonical({ ...e, prevHash })).digest('hex');
    if (e.prevHash !== prevHash || e.hash !== h) return { valid: false, brokenAt: e.seq };
    prevHash = e.hash;
  }
  return { valid: true, entries: DB.auditLog.length };
}

function uid() { return crypto.randomBytes(10).toString('hex'); }

function seedDB() {
  console.log('🌱 Seeding database…');

  // Admin
  const adminSalt = crypto.randomBytes(16).toString('hex');
  DB.users.push({
    id: uid(), role: 'admin', email: ADMIN_EMAIL,
    passwordHash: hashPasswordScrypt(ADMIN_PASSWORD, adminSalt), salt: adminSalt,
    name: 'ServeLocal Admin', createdAt: iso()
  });

  // Demo student
  const sSalt = crypto.randomBytes(16).toString('hex');
  const student = {
    id: uid(), role: 'student', email: 'alex@student.edu',
    passwordHash: hashPasswordScrypt('demo1234', sSalt), salt: sSalt,
    firstName: 'Alex', lastName: 'Johnson', dob: '2007-03-15',
    school: 'Lincoln High School', grade: 'Grade 11', location: 'Springfield, IL',
    skills: ['Tutoring','Gardening','Social Media'],
    causes: ['Education','Environment'],
    savedOpps: [], signedUpOpps: [], emailVerified: true, portfolioPublic: false, savedSearches: [],
    guardianName: '', guardianEmail: '', guardianConsentStatus: 'not_required',
    guardianConsentTokenHash: '', guardianConsentTokenExpires: null, guardianManageTokenHash: '',
    guardianConsentRequestedAt: '', guardianConsentDecidedAt: null,
    guardianConsentIp: '', guardianConsentUserAgent: '',
    createdAt: iso()
  };
  DB.users.push(student);

  // Demo org (approved)
  const oSalt = crypto.randomBytes(16).toString('hex');
  const orgUser = {
    id: uid(), role: 'org', email: 'contact@greenroots.org',
    passwordHash: hashPasswordScrypt('demo1234', oSalt), salt: oSalt,
    orgName: 'Green Roots Community Garden', orgId: uid(),
    website: 'https://greenroots.org', description: 'We grow community through urban agriculture.',
    ein: '', emailVerified: true, adminApproved: true,
    adminApprovedAt: iso(), reviewStatus: 'approved',
    proofLinks: [], proofNotes: '',
    createdAt: iso()
  };
  DB.users.push(orgUser);

  // Demo org 2 (pending)
  const oSalt2 = crypto.randomBytes(16).toString('hex');
  DB.users.push({
    id: uid(), role: 'org', email: 'info@citylibrary.org',
    passwordHash: hashPasswordScrypt('demo1234', oSalt2), salt: oSalt2,
    orgName: 'City Library Foundation', orgId: uid(),
    website: 'https://citylibrary.org', description: 'Promoting literacy and learning for all.',
    ein: '', emailVerified: true, adminApproved: false,
    reviewStatus: 'pending', proofLinks: ['https://citylibrary.org/about'],
    proofNotes: 'We are a registered 501c3 nonprofit.',
    createdAt: iso()
  });

  // Demo opportunities
  const now = new Date();
  const d = (daysAhead, h=9, m=0) => {
    const dt = new Date(now); dt.setDate(dt.getDate()+daysAhead);
    dt.setHours(h,m,0,0); return dt.toISOString();
  };

  DB.opportunities = [
    {
      id: uid(), orgId: orgUser.orgId, orgName: orgUser.orgName, orgEmail: orgUser.email,
      title: 'Community Garden Helper', category: 'Environment',
      location: '123 Green St, Springfield, IL', lat: 39.78, lng: -89.65,
      startTime: d(3,9), endTime: d(3,13),
      skills: ['Gardening','Physical Activity'], commitment: 'Weekly',
      spotsAvailable: 10, spotsRemaining: 7,
      description: 'Assist with planting, weeding, watering and harvesting at our community garden.',
      requiresApproval: false, active: true, emoji:'🌱', bg:'#e8f5ef',
      createdAt: iso()
    },
    {
      id: uid(), orgId: orgUser.orgId, orgName: orgUser.orgName, orgEmail: orgUser.email,
      title: 'Youth STEM Workshop Helper', category: 'Education',
      location: '456 Science Ave, Springfield, IL', lat: 39.80, lng: -89.64,
      startTime: d(7,10), endTime: d(7,14),
      skills: ['STEM','Communication','Tutoring'], commitment: 'One-time',
      spotsAvailable: 5, spotsRemaining: 3,
      description: 'Help lead hands-on STEM activities for middle schoolers at our weekend workshop.',
      requiresApproval: true, active: true, emoji:'🔬', bg:'#e8eaf6',
      createdAt: iso()
    },
    {
      id: uid(), orgId: orgUser.orgId, orgName: orgUser.orgName, orgEmail: orgUser.email,
      title: 'Trail Cleanup Day', category: 'Environment',
      location: 'Riverside Park, Springfield, IL', lat: 39.77, lng: -89.67,
      startTime: d(14,8), endTime: d(14,12),
      skills: ['Physical Activity','Teamwork'], commitment: 'One-time',
      spotsAvailable: 20, spotsRemaining: 15,
      description: 'Join us to clear litter and maintain trails along the city greenway.',
      requiresApproval: false, active: true, emoji:'🌲', bg:'#e0f2f1',
      createdAt: iso()
    },
  ];

  // Seed some hours for demo student
  DB.hours = [
    { id:uid(), userId:student.id, oppId:DB.opportunities[0].id, orgName:'Green Roots Community Garden',
      activity:'Community Garden Helper', startTime:d(-14,9), endTime:d(-14,13),
      hours:4.0, status:'verified', supervisorName:'T. Nguyen',
      notes:'Great session!', appeal:null, createdAt:iso() },
    { id:uid(), userId:student.id, oppId:null, orgName:'St. Mary\'s Food Pantry',
      activity:'Food Distribution Drive', startTime:d(-7,10), endTime:d(-7,13),
      hours:3.0, status:'self', supervisorEmail:'volunteer@stmarys.org',
      supervisorName:'—', notes:'Self-reported', appeal:null, createdAt:iso() },
  ];

  // Seed student signup for opp 0
  DB.applications.push({
    id:uid(), oppId:DB.opportunities[0].id, userId:student.id,
    userName:'Alex Johnson', userEmail:student.email,
    status:'approved', type:'subscription', singleDate:null, excludedDates:[],
    reminder24h:false, reminder1h:false, createdAt:iso()
  });

  // Seed a review
  DB.reviews.push({
    id:uid(), orgId:orgUser.orgId, userId:student.id, userName:'Alex J.',
    rating:5, comment:'Amazing organization, very welcoming to volunteers!', createdAt:iso()
  });

  saveDB();
  console.log('✅ Seeded');
}

function iso() { return new Date().toISOString(); }

function createNotification(userId, type, title, message, link='') {
  DB.notifications.push({ id:uid(), userId, type, title, message, link, read:false, createdAt:iso() });
}

// When a spot frees up on a full one-time event, the earliest waitlisted
// student is auto-promoted to approved and notified.
function promoteFromWaitlist(opp) {
  if ((opp.spotsRemaining||0) <= 0) return;
  const wl = DB.applications
    .filter(a=>a.oppId===opp.id&&a.status==='waitlisted')
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
  if (!wl) return;
  wl.status = 'approved';
  wl.type = 'subscription';
  wl.resolvedAt = iso();
  opp.spotsRemaining = Math.max(0, opp.spotsRemaining-1);
  const sIdx = DB.users.findIndex(u=>u.id===wl.userId);
  if (sIdx>-1) {
    if (!DB.users[sIdx].signedUpOpps) DB.users[sIdx].signedUpOpps=[];
    if (!DB.users[sIdx].signedUpOpps.includes(opp.id)) DB.users[sIdx].signedUpOpps.push(opp.id);
  }
  createNotification(wl.userId, 'waitlist_promoted', "You're In! 🎉", 'A spot opened up for "'+opp.title+'" — you\'ve been moved off the waitlist and signed up.', 'dash');
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

// ── AUTH HELPERS ──────────────────────────────
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
function b64u(str) { return Buffer.from(str).toString('base64url'); }
function getUser(req) {
  const auth = req.headers['authorization']||'';
  const token = auth.replace('Bearer ','');
  if (!token) return null;
  const d = verifyToken(token);
  if (!d) return null;
  const u = IDX().userById.get(d.sub);
  if (!u) return null;
  // Reject tokens issued before the user's current token version (revoked sessions)
  if ((d.tv||0) !== (u.tokenVersion||0)) return null;
  return u;
}
function safeUser(u) {
  if (!u) return null;
  const {passwordHash,salt,...rest} = u;
  return rest;
}

// Strip org-internal / sensitive fields before sending opportunities to students or the public.
// checkinCodes especially must never leak — students could self-verify hours without attending.
function publicOpp(o) {
  if (!o) return o;
  const {checkinCodes,_verifiedDates,hoursVerificationPrompted,hoursVerificationSent,views,orgEmail,...rest} = o;
  return rest;
}

// Simple in-memory login throttle: 8 failed attempts per email+IP per 15 minutes
const loginAttempts = new Map();
function loginThrottleKey(req, email) {
  return (req.socket?.remoteAddress||'unknown')+'|'+String(email||'').toLowerCase();
}


// ── EMAIL via Resend ──────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = 'ServeLocal <onboarding@resend.dev>';

function sendEmail(to, subject, bodyText) {
  if (!RESEND_API_KEY) {
    console.log('📧 [dev, no RESEND_API_KEY] would email', to, '—', subject, '\n' + bodyText);
    return;
  }
  const payload = JSON.stringify({
    from: FROM_EMAIL,
    to: [to],
    subject: subject,
    text: bodyText,
    html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">'
      + '<div style="background:#1a6b4a;border-radius:12px;padding:20px 24px;margin-bottom:24px">'
      + '<span style="color:#fff;font-size:1.2rem;font-weight:700">&#128154; ServeLocal</span></div>'
      + '<p style="color:#1a1a1a;font-size:1rem;line-height:1.6">' + bodyText.replace(/\n/g,'<br>') + '</p>'
      + '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">'
      + '<p style="color:#6b7280;font-size:.78rem">ServeLocal — Connecting students with meaningful service.</p>'
      + '</div>'
  });
  const req = https.request({
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode >= 400) console.error('Resend error:', res.statusCode, data);
      else console.log('📧 Email sent to', to);
    });
  });
  req.on('error', e => console.error('Email send failed:', e.message));
  req.write(payload);
  req.end();
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── GUARDIAN CONSENT (minors only — see docs/guardian-consent-spec.md) ──
// Every student under 18 needs a verified guardian email on file before they can
// apply to an opportunity, message an org, redeem a check-in code, or be endorsed.
// 18+ students are never gated. Age is recomputed live (not cached) so a student
// who ages into adulthood while a request is pending is unblocked automatically.
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function studentAge(dob) { return (Date.now() - new Date(dob)) / (365.25 * 864e5); }
function requireGuardianConsent(user) {
  if (!user || user.role !== 'student') return null; // orgs/admin unaffected
  if (studentAge(user.dob) >= 18) return null; // adults are never gated, regardless of stored status
  if (user.guardianConsentStatus === 'verified') return null;
  return { error: 'Guardian approval is required before you can do this.', code: 'GUARDIAN_CONSENT_REQUIRED' };
}
function sendGuardianConsentEmail(student, token) {
  const link = `${PUBLIC_BASE_URL}/#consent/${token}`;
  sendEmail(student.guardianEmail, `Approve ${student.firstName}'s ServeLocal account`,
    `${student.guardianName},\n\n${student.firstName} ${student.lastName} signed up for ServeLocal, ` +
    `a platform connecting students with community service opportunities. Because they're under 18, ` +
    `we need your approval before they can sign up for an opportunity or message an organization.\n\n` +
    `Approve or decline here (expires in ${CONSENT_TOKEN_TTL_HOURS} hours):\n${link}\n\n— ServeLocal`);
}
function sendGuardianManageEmail(student, manageToken) {
  const link = `${PUBLIC_BASE_URL}/#consent-manage/${manageToken}`;
  sendEmail(student.guardianEmail, `You approved ${student.firstName}'s ServeLocal account`,
    `Thanks for approving ${student.firstName}'s ServeLocal account. If you ever want to revoke this ` +
    `approval, you can do so anytime here:\n${link}\n\n— ServeLocal`);
}

// ── HTTP HELPERS ──────────────────────────────
function readBody(req) {
  return new Promise((res,rej)=>{
    let b=''; let size=0; const MAX=1e6; // 1 MB limit
    req.on('data',c=>{ size+=c.length; if(size>MAX){req.destroy();rej(new Error('Request body too large'));}else b+=c; });
    req.on('end',()=>{ try{res(b?JSON.parse(b):{});}catch{res({});} });
    req.on('error',rej);
  });
}
function json(res,data,status=200,extraHeaders={}) {
  const body = JSON.stringify(data);
  const acao = res._acao || '*';
  res.writeHead(status,{
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':acao,
    ...(acao !== '*' ? { 'Vary':'Origin' } : {}),
    'Access-Control-Allow-Headers':'Content-Type,Authorization,Idempotency-Key',
    'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    'Cache-Control':'no-store',
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}
function serveStatic(res,filePath,req) {
  if (res.headersSent) return;
  // Containment: resolve the request to an absolute path and require it to stay
  // inside public/. url.parse() does not normalise '..', so without this a
  // request like `GET /../db.json` would escape the web root (arbitrary file
  // read). path.resolve collapses '..' so the prefix check is reliable.
  const PUBLIC = path.join(__dirname, 'public');
  const fp = path.resolve(filePath);
  if (fp !== PUBLIC && !fp.startsWith(PUBLIC + path.sep)) {
    res.writeHead(404, securityHeaders()); res.end('Not found'); return;
  }
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    try {
      const ext = path.extname(fp);
      const mime = {'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
      const st = fs.statSync(fp);
      const etag = '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"';
      // HTML must always revalidate so deploys show immediately. Emoji are
      // content-addressed by codepoint (immutable) -> cache for a year; other
      // assets cache 1h.
      const immutable = fp.startsWith(path.join(PUBLIC, 'emoji') + path.sep);
      const cacheCtl = ext === '.html' ? 'no-cache'
        : immutable ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';
      if (req && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': cacheCtl, ...securityHeaders() });
        return res.end();
      }
      res.writeHead(200,{'Content-Type':mime[ext]||'text/plain','Cache-Control':cacheCtl,'ETag':etag,...securityHeaders()});
      res.end(fs.readFileSync(fp));
      return;
    } catch(e) { /* fall through to 404 */ }
  }
  if (!res.headersSent) { res.writeHead(404, securityHeaders()); res.end('Not found'); }
}

// ── CALC HELPERS ──────────────────────────────
function calcHours(start, end) {
  const diff = (new Date(end) - new Date(start)) / 36e5;
  return Math.round(diff * 100) / 100;
}
function timesOverlap(s1,e1,s2,e2) {
  return new Date(s1)<new Date(e2) && new Date(s2)<new Date(e1);
}
function isValidOccurrence(opp, dateISO) {
  const commit = opp.commitment || 'One-time';
  if (commit === 'One-time') return false;
  const origin = new Date(opp.startTime);
  const target = dateISO.slice(0,10);
  let cur = new Date(origin);
  for (let i = 0; i < 500; i++) {
    if (cur.toISOString().slice(0,10) === target) return true;
    if (cur > new Date(dateISO)) return false;
    if (commit === 'Weekly') cur.setDate(cur.getDate() + 7);
    else if (commit === 'Monthly') cur.setMonth(cur.getMonth() + 1);
    else break;
  }
  return false;
}
function nextOccurrenceAfter(opp, afterDate, excludedDates) {
  const commit = opp.commitment || 'One-time';
  const excluded = new Set((excludedDates||[]).map(d=>d.slice(0,10)));
  if (commit === 'One-time') return new Date(opp.startTime) >= afterDate ? new Date(opp.startTime) : null;
  let cur = new Date(opp.startTime);
  for (let i = 0; i < 500; i++) {
    if (cur >= afterDate && !excluded.has(cur.toISOString().slice(0,10))) return cur;
    if (commit === 'Weekly') cur.setDate(cur.getDate() + 7);
    else if (commit === 'Monthly') cur.setMonth(cur.getMonth() + 1);
    else break;
  }
  return null;
}
function isFreeEmailDomain(email) {
  const domain = (email||'').split('@')[1]||'';
  return FREE_EMAIL_DOMAINS.has(domain.toLowerCase());
}


function haversineMiles(lat1,lon1,lat2,lon2){
  const R=3958.8; // Earth radius miles
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// Client IP, honoring a single trusted proxy hop (Railway/Cloudflare set XFF).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ── ROUTER ────────────────────────────────────
async function router(req, res) {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const method = req.method;
  const ip = clientIp(req);
  res._acao = resolveCors(req); // per-request CORS origin, read by json()

  if (method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':res._acao,...(res._acao!=='*'?{'Vary':'Origin'}:{}),'Access-Control-Allow-Headers':'Content-Type,Authorization,Idempotency-Key','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,PATCH,OPTIONS'});
    return res.end();
  }

  // ── HEALTH CHECKS (for load balancers / chaos tests) ──
  // Public health is intentionally minimal — no internal error strings exposed.
  if (method==='GET' && p==='/api/health') return json(res,{status:'ok',uptime:Math.round(process.uptime())});
  if (method==='GET' && p==='/api/health/ready') {
    return json(res, { ready:_dbHealthy, db:_dbHealthy?'ok':'degraded' }, _dbHealthy?200:503);
  }

  // Static files
  if (!p.startsWith('/api')) {
    const file = p==='/' ? 'index.html' : p.slice(1);
    return serveStatic(res, path.join(__dirname,'public',file), req);
  }

  // ── RATE LIMITING (abuse prevention) ──
  // Tighter bucket for auth + mutating verbs; generous for reads. Tunable via env.
  const isWrite = method!=='GET';
  const rl = rateLimit(ip, isWrite ? RL_WRITE : RL_READ);
  if (!rl.ok) return json(res,{error:'Rate limit exceeded. Please slow down.'},429,{'Retry-After':String(rl.retryAfter||1)});

  const body = await readBody(req);
  const user = getUser(req);

  // ── IDEMPOTENCY (safe retries for mutating requests) ──
  // If a client resends a POST/PATCH with the same Idempotency-Key, replay the
  // original response instead of double-applying the effect.
  const idemKey = isWrite && req.headers['idempotency-key']
    ? method+' '+p+' '+(user?user.id:ip)+' '+String(req.headers['idempotency-key']).slice(0,100) : null;
  if (idemKey) {
    const cached = idemGet(idemKey);
    if (cached) return json(res, cached.body, cached.status);
  }
  // Wrap json() so idempotent responses get recorded for replay.
  const _json = json;
  const respond = idemKey
    ? (r, data, status=200, extra) => { idemSet(idemKey, status, data); return _json(r, data, status, extra); }
    : _json;

  // ══════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════

  // POST /api/auth/register/student
  if (method==='POST' && p==='/api/auth/register/student') {
    const {firstName,lastName,dob,email,password,school,grade,location,guardianName,guardianEmail} = body;
    if (!firstName||!lastName||!dob||!email||!password)
      return json(res,{error:'First name, last name, date of birth, email and password are required'},400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,{error:'Enter a valid email address'},400);
    if (password.length<8) return json(res,{error:'Password must be at least 8 characters'},400);
    if (weakPassword(password,email)) return json(res,{error:'That password is too common or easy to guess. Please choose a stronger one.'},400);
    if (IDX().userByEmail.get(email.toLowerCase()))
      return json(res,{error:'Email already registered'},409);
    // Age check — must be 12+
    const age = (Date.now()-new Date(dob))/(365.25*864e5);
    if (age<12) return json(res,{error:'You must be at least 12 years old to register'},400);

    // Guardian consent — required for under-18 students; 18+ students skip it entirely
    // (see docs/guardian-consent-spec.md and ADR-0010).
    const isMinor = age < 18;
    if (isMinor) {
      if (!guardianName||!guardianEmail) return json(res,{error:'Parent/guardian name and email are required for students under 18'},400);
      if (!isEmail(guardianEmail)) return json(res,{error:'Enter a valid parent/guardian email address'},400);
      if (guardianEmail.toLowerCase()===email.toLowerCase()) return json(res,{error:'Parent/guardian email must be different from your own email'},400);
    }

    const u = {
      id:uid(), role:'student', email:email.toLowerCase(),
      passwordHash:'', salt:'',
      firstName, lastName, dob,
      school:school||'', grade:grade||'', location:location||'',
      skills:[], causes:[], savedOpps:[], signedUpOpps:[],
      emailVerified:true, portfolioPublic:false, savedSearches:[], createdAt:iso(),
      guardianName: isMinor ? sstr(guardianName,120) : '',
      guardianEmail: isMinor ? guardianEmail.toLowerCase() : '',
      guardianConsentStatus: isMinor ? 'pending' : 'not_required',
      guardianConsentTokenHash: '', guardianConsentTokenExpires: null, guardianManageTokenHash: '',
      guardianConsentRequestedAt: isMinor ? iso() : '', guardianConsentDecidedAt: null,
      guardianConsentIp: '', guardianConsentUserAgent: '',
    };
    setPassword(u, password); // scrypt
    DB.users.push(u);
    appendAudit(u.id,'account.register',u.id,{role:'student'});
    if (isMinor) {
      const token = crypto.randomBytes(32).toString('hex');
      u.guardianConsentTokenHash = hashToken(token);
      u.guardianConsentTokenExpires = new Date(Date.now()+CONSENT_TOKEN_TTL_MS).toISOString();
      sendGuardianConsentEmail(u, token);
      appendAudit(u.id,'account.guardian_consent_requested',u.id,{guardianEmail:u.guardianEmail});
    }
    saveDB();
    return json(res,{token:makeToken(u),user:safeUser(u)},201);
  }

  // POST /api/auth/register/org
  if (method==='POST' && p==='/api/auth/register/org') {
    const {orgName,email,confirmEmail,password,confirmPassword,website,ein,proofLinks,proofNotes,optOutDomainVerification} = body;
    if (!orgName||!email||!password) return json(res,{error:'Organization name, email and password are required'},400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,{error:'Enter a valid email address'},400);
    if (email!==confirmEmail) return json(res,{error:'Emails do not match'},400);
    if (password!==confirmPassword) return json(res,{error:'Passwords do not match'},400);
    if (password.length<8) return json(res,{error:'Password must be at least 8 characters'},400);
    if (weakPassword(password,email)) return json(res,{error:'That password is too common or easy to guess. Please choose a stronger one.'},400);
    if (IDX().userByEmail.get(email.toLowerCase())) return json(res,{error:'Email already registered'},409);

    const isFree = isFreeEmailDomain(email);
    // If using free domain and NOT opting out → block
    if (isFree && !optOutDomainVerification)
      return json(res,{error:'Please use your official organizational email address (not Gmail/Yahoo/etc). If you don\'t have one, choose the manual review option.'},400);

    const orgId = uid();
    const needsManualReview = isFree && optOutDomainVerification;
    const u = {
      id:uid(), role:'org', email:email.toLowerCase(),
      passwordHash:'', salt:'',
      orgName:sstr(orgName,120), orgId, website:website||'',
      description:'', ein:sstr(ein,20),
      emailVerified: !isFree, // org email = auto-verified; free domain = not
      adminApproved:false, reviewStatus:'pending',
      proofLinks:proofLinks||[], proofNotes:sstr(proofNotes,1000),
      optOutDomainVerification:!!optOutDomainVerification,
      createdAt:iso()
    };
    setPassword(u, password); // scrypt
    DB.users.push(u);
    appendAudit(u.id,'account.register',u.id,{role:'org'});
    // TODO production: if (!isFree) send domain verification email
    saveDB();
    const msg = needsManualReview
      ? 'Account created. Because you opted out of domain email verification, your account requires manual admin review before listings go live. You will be notified by email.'
      : 'Account created! Your listings will go live after admin review (usually within 24 hours).';
    return json(res,{token:makeToken(u),user:safeUser(u),message:msg},201);
  }

  // POST /api/auth/login
  if (method==='POST' && p==='/api/auth/login') {
    const {email,password} = body;
    const throttleKey = loginThrottleKey(req, email);
    const attempts = loginAttempts.get(throttleKey);
    if (attempts && Date.now()-attempts.first >= 15*60*1000) loginAttempts.delete(throttleKey);
    else if (attempts && attempts.count >= 8)
      return json(res,{error:'Too many failed attempts. Please try again in 15 minutes.'},429);
    const found = email ? IDX().userByEmail.get(email.toLowerCase()) : null;
    if (!found||!verifyPassword(password,found)) {
      const rec = loginAttempts.get(throttleKey)||{count:0,first:Date.now()};
      rec.count++; loginAttempts.set(throttleKey,rec);
      appendAudit(String(email||'').toLowerCase()||'unknown','auth.login.fail','',{ip}); saveDB();
      return json(res,{error:'Invalid email or password'},401);
    }
    loginAttempts.delete(throttleKey);
    // Transparently upgrade legacy HMAC password hashes to scrypt on login.
    const upgraded = migrateLegacyPassword(found, password);
    appendAudit(found.id,'auth.login.success','',{ip,role:found.role,upgraded}); saveDB();
    return json(res,{token:makeToken(found),user:safeUser(found)});
  }

  // POST /api/auth/signout-all — revoke every existing session for this user
  if (method==='POST' && p==='/api/auth/signout-all') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const idx = DB.users.findIndex(u=>u.id===user.id);
    DB.users[idx].tokenVersion = (DB.users[idx].tokenVersion||0)+1;
    appendAudit(user.id,'auth.signout_all','');
    saveDB();
    return json(res,{token:makeToken(DB.users[idx])}); // issue a fresh token for the current session
  }

  // POST /api/account/password — change password (requires current password)
  if (method==='POST' && p==='/api/account/password') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const {currentPassword,newPassword} = body;
    const me = IDX().userById.get(user.id);
    if (!currentPassword||!verifyPassword(currentPassword,me))
      return json(res,{error:'Current password is incorrect'},401);
    if (!newPassword||newPassword.length<8) return json(res,{error:'New password must be at least 8 characters'},400);
    if (weakPassword(newPassword,me.email)) return json(res,{error:'That password is too common or easy to guess. Please choose a stronger one.'},400);
    if (verifyPassword(newPassword,me)) return json(res,{error:'New password must be different from the current one'},400);
    setPassword(me, newPassword);
    me.tokenVersion = (me.tokenVersion||0)+1; // revoke all other sessions
    appendAudit(me.id,'account.password_change','');
    saveDB();
    return json(res,{token:makeToken(me)}); // keep the current session signed in
  }


  // GET /api/auth/me
  if (method==='GET' && p==='/api/auth/me') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    return json(res,safeUser(user));
  }

  // ══════════════════════════════════════════
  // GUARDIAN CONSENT (minors only — see docs/guardian-consent-spec.md, ADR-0010)
  // ══════════════════════════════════════════

  // GET /api/consent/:token — public; lets a guardian preview who they're approving
  const consentToken = p.match(/^\/api\/consent\/([^/]+)$/);
  if (method==='GET' && consentToken) {
    const tokenHash = hashToken(consentToken[1]);
    const student = DB.users.find(u=>u.role==='student'&&u.guardianConsentTokenHash&&timingEqualHex(u.guardianConsentTokenHash,tokenHash));
    if (!student) return json(res,{error:'Invalid or already-used consent link'},404);
    if (new Date(student.guardianConsentTokenExpires) < new Date())
      return json(res,{error:'This consent link has expired. Ask your student to resend it.',code:'CONSENT_TOKEN_EXPIRED'},410);
    return json(res,{studentFirstName:student.firstName, studentLastInitial:(student.lastName||'')[0]||''});
  }

  // POST /api/consent/:token — public; guardian approves or declines
  if (method==='POST' && consentToken) {
    const tokenHash = hashToken(consentToken[1]);
    const idx = DB.users.findIndex(u=>u.role==='student'&&u.guardianConsentTokenHash&&timingEqualHex(u.guardianConsentTokenHash,tokenHash));
    if (idx===-1) return json(res,{error:'Invalid or already-used consent link'},404);
    const student = DB.users[idx];
    if (new Date(student.guardianConsentTokenExpires) < new Date())
      return json(res,{error:'This consent link has expired. Ask your student to resend it.',code:'CONSENT_TOKEN_EXPIRED'},410);
    const {decision} = body;
    if (decision!=='approve'&&decision!=='decline') return json(res,{error:'decision must be "approve" or "decline"'},400);

    student.guardianConsentDecidedAt = iso();
    student.guardianConsentIp = ip;
    student.guardianConsentUserAgent = String(req.headers['user-agent']||'').slice(0,300);
    student.guardianConsentTokenHash = ''; // single-use
    student.guardianConsentTokenExpires = null;

    if (decision==='approve') {
      student.guardianConsentStatus = 'verified';
      const manageToken = crypto.randomBytes(32).toString('hex');
      student.guardianManageTokenHash = hashToken(manageToken);
      sendGuardianManageEmail(student, manageToken);
      createNotification(student.id,'guardian_consent_verified','Guardian Approved!','Your parent/guardian approved your ServeLocal account — you can now sign up for opportunities.','dash');
    } else {
      student.guardianConsentStatus = 'declined';
      createNotification(student.id,'guardian_consent_declined','Guardian Declined','Your parent/guardian did not approve your ServeLocal account. Contact support@servelocal.org for help.','dash');
    }
    appendAudit('guardian:'+student.id,'account.guardian_consent_decided',student.id,{decision,ip});
    saveDB();
    return json(res,{status:student.guardianConsentStatus});
  }

  // GET/POST /api/consent/manage/:manageToken — public; guardian revokes consent anytime
  const consentManage = p.match(/^\/api\/consent\/manage\/([^/]+)$/);
  if ((method==='GET'||method==='POST') && consentManage) {
    const tokenHash = hashToken(consentManage[1]);
    const idx = DB.users.findIndex(u=>u.role==='student'&&u.guardianManageTokenHash&&timingEqualHex(u.guardianManageTokenHash,tokenHash));
    if (idx===-1) return json(res,{error:'Invalid consent-management link'},404);
    const student = DB.users[idx];
    if (method==='GET')
      return json(res,{studentFirstName:student.firstName, studentLastInitial:(student.lastName||'')[0]||'', status:student.guardianConsentStatus});
    if (body.action!=='revoke') return json(res,{error:'action must be "revoke"'},400);
    student.guardianConsentStatus = 'revoked';
    student.guardianConsentDecidedAt = iso();
    student.guardianConsentIp = ip;
    student.guardianConsentUserAgent = String(req.headers['user-agent']||'').slice(0,300);
    createNotification(student.id,'guardian_consent_revoked','Guardian Revoked Approval','Your parent/guardian revoked approval for your ServeLocal account.','dash');
    appendAudit('guardian:'+student.id,'account.guardian_consent_revoked',student.id,{ip});
    saveDB();
    return json(res,{status:'revoked'});
  }

  // POST /api/account/consent/resend — authenticated student; 5-minute cooldown
  if (method==='POST' && p==='/api/account/consent/resend') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    if (studentAge(user.dob)>=18) return json(res,{error:'Guardian consent is not required for your account'},400);
    if (user.guardianConsentStatus==='verified') return json(res,{error:'Guardian consent is already verified'},400);
    if (user.guardianConsentStatus!=='pending'&&user.guardianConsentStatus!=='legacy_pending')
      return json(res,{error:'Contact support@servelocal.org to update your guardian consent status.'},400);
    const idx = DB.users.findIndex(u=>u.id===user.id);
    if (DB.users[idx].guardianConsentRequestedAt && Date.now()-new Date(DB.users[idx].guardianConsentRequestedAt).getTime() < 5*60*1000)
      return json(res,{error:'Please wait a few minutes before resending.'},429);
    const token = crypto.randomBytes(32).toString('hex');
    DB.users[idx].guardianConsentTokenHash = hashToken(token);
    DB.users[idx].guardianConsentTokenExpires = new Date(Date.now()+CONSENT_TOKEN_TTL_MS).toISOString();
    DB.users[idx].guardianConsentRequestedAt = iso();
    sendGuardianConsentEmail(DB.users[idx], token);
    appendAudit(user.id,'account.guardian_consent_requested',user.id,{guardianEmail:DB.users[idx].guardianEmail,resend:true});
    saveDB();
    return json(res,{status:DB.users[idx].guardianConsentStatus});
  }

  // ══════════════════════════════════════════
  // OPPORTUNITIES (public read)
  // ══════════════════════════════════════════

  // GET /api/geocode?zip=XXXXX — free zip-to-coords via zippopotam.us
  // Wrapped in a circuit breaker so a flaky upstream fails fast (and is cached).
  if (method==='GET' && p==='/api/geocode') {
    const zip = (parsed.query.zip||'').trim();
    if (!/^\d{5}$/.test(zip)) return json(res,{error:'Invalid US zip code'},400);
    const cacheKey = 'geo:'+zip;
    const hit = cacheGet(cacheKey);
    if (hit) return json(res, hit);
    if (!geocodeBreaker.canRequest())
      return json(res,{error:'ZIP lookup is temporarily unavailable. Please try again shortly.'},503);
    let done=false;
    const finish = (fn)=>{ if(done) return; done=true; fn(); };
    const greq = https.get('https://api.zippopotam.us/us/'+zip, {timeout:5000}, gres=>{
      let d='';
      gres.on('data',c=>d+=c);
      gres.on('end',()=>finish(()=>{
        try {
          const gj=JSON.parse(d);
          if (!gj.places||!gj.places[0]) { geocodeBreaker.success(); return json(res,{error:'ZIP code not found'},404); }
          geocodeBreaker.success();
          const result = {
            lat:parseFloat(gj.places[0].latitude),
            lng:parseFloat(gj.places[0].longitude),
            city:gj.places[0]['place name'],
            state:gj.places[0]['state abbreviation'],
            zip
          };
          cacheSet(cacheKey, result, 24*36e5); // ZIP coords are stable; cache a day
          return json(res, result);
        } catch { geocodeBreaker.failure(); return json(res,{error:'Geocode parse failed'},502); }
      }));
    });
    greq.on('error',()=>finish(()=>{ geocodeBreaker.failure(); json(res,{error:'Geocode service unavailable'},503); }));
    greq.on('timeout',()=>{ greq.destroy(); finish(()=>{ geocodeBreaker.failure(); json(res,{error:'Geocode service timed out'},504); }); });
    return; // response sent inside async callback
  }

  // GET /api/opportunities
  if (method==='GET' && p==='/api/opportunities') {
    const {q,category,skill,startDate,endDate,commitment,orgId,zipLat,zipLng,maxMiles} = parsed.query;
    const radiusMiles = Math.min(parseFloat(maxMiles)||15, 50); // default 15 mi, cap 50
    let opps = DB.opportunities.filter(o=>{
      if (!o.active) return false;
      const org = IDX().userByOrgId.get(o.orgId);
      if (org && !org.adminApproved) return false;
      return true;
    });
    if (q) { const lq=q.toLowerCase(); opps=opps.filter(o=>o.title.toLowerCase().includes(lq)||o.orgName.toLowerCase().includes(lq)||o.description.toLowerCase().includes(lq)); }
    if (category) opps=opps.filter(o=>o.category===category);
    if (skill) opps=opps.filter(o=>(o.skills||[]).some(s=>s.toLowerCase().includes(skill.toLowerCase())));
    if (startDate) opps=opps.filter(o=>new Date(o.startTime)>=new Date(startDate));
    if (endDate) opps=opps.filter(o=>new Date(o.endTime)<=new Date(endDate));
    if (commitment) opps=opps.filter(o=>o.commitment===commitment);
    if (orgId) opps=opps.filter(o=>o.orgId===orgId);
    // Distance filter — attach distanceMiles; remote opps always pass
    if (zipLat && zipLng) {
      const uLat=parseFloat(zipLat), uLng=parseFloat(zipLng);
      opps = opps.map(o=>{
        if (!o.lat||!o.lng) return {...o,distanceMiles:null}; // unknown coords = pass through
        const d=haversineMiles(uLat,uLng,o.lat,o.lng);
        return {...o,distanceMiles:Math.round(d*10)/10};
      }).filter(o=>o.distanceMiles===null||o.distanceMiles<=radiusMiles)
        .sort((a,b)=>(a.distanceMiles??999)-(b.distanceMiles??999));
    }
    opps = opps.map(o=>{
      const ac = DB.applications.filter(a=>a.oppId===o.id&&a.status==='approved').length;
      // Compute org badges
      const org = IDX().userByOrgId.get(o.orgId);
      const badges = [];
      if (org?.adminApproved) badges.push('verified');
      const orgReviews = idxList(IDX().reviewsByOrg,o.orgId);
      if (orgReviews.length>=3) { const avg=orgReviews.reduce((s,r)=>s+r.rating,0)/orgReviews.length; if(avg>=4.5) badges.push('top-rated'); }
      const orgOppIds = DB.opportunities.filter(x=>x.orgId===o.orgId).map(x=>x.id);
      const resolved = DB.applications.filter(a=>orgOppIds.includes(a.oppId)&&a.resolvedAt).slice(-10);
      if (resolved.length>=3) { const avg=resolved.reduce((s,a)=>s+(new Date(a.resolvedAt)-new Date(a.createdAt))/36e5,0)/resolved.length; if(avg<=24) badges.push('responsive'); }
      if (org?.createdAt&&(Date.now()-new Date(org.createdAt))>180*864e5&&org.adminApproved) badges.push('established');
      return {...publicOpp(o), applicantCount:ac, badges};
    });
    // Featured (Pro) listings pin to the top; stable sort preserves distance order within groups
    opps.sort((a,b)=>(b.featured?1:0)-(a.featured?1:0));
    return json(res,opps);
  }

  // GET /api/opportunities/:id/date-spots  →  per-occurrence spot counts for recurring events
  const dateSpotsMatch = p.match(/^\/api\/opportunities\/([^/]+)\/date-spots$/);
  if (method==='GET' && dateSpotsMatch) {
    const opp = IDX().oppById.get(dateSpotsMatch[1]);
    if (!opp) return json(res,{error:'Not found'},404);
    const commit = opp.commitment;
    if (commit!=='Weekly'&&commit!=='Monthly') return json(res,{});
    const approvedApps = DB.applications.filter(a=>a.oppId===opp.id&&a.status==='approved');
    const results = {};
    let cur = new Date(opp.startTime);
    const now = new Date();
    let count=0, safety=0;
    while (count<10 && safety++<500) {
      if (cur>=now) {
        const ds = cur.toISOString().slice(0,10);
        const subTaken = approvedApps.filter(a=>a.type==='subscription'&&!(a.excludedDates||[]).some(d=>d.slice(0,10)===ds)).length;
        const sdTaken  = approvedApps.filter(a=>a.type==='single-date'&&a.singleDate?.slice(0,10)===ds).length;
        results[ds] = Math.max(0,(opp.spotsAvailable||0)-(subTaken+sdTaken));
        count++;
      }
      if (commit==='Weekly') cur.setDate(cur.getDate()+7);
      else cur.setMonth(cur.getMonth()+1);
    }
    return json(res,results);
  }

  // GET /api/opportunities/:id
  const oppById = p.match(/^\/api\/opportunities\/([^/]+)$/);
  if (method==='GET' && oppById) {
    const opp = IDX().oppById.get(oppById[1]);
    if (!opp) return json(res,{error:'Not found'},404);
    const isOwner = user && ((user.role==='org'&&user.orgId===opp.orgId) || user.role==='admin');
    const oppOrg = IDX().userByOrgId.get(opp.orgId);
    if (!isOwner && (!opp.active || !oppOrg?.adminApproved)) return json(res,{error:'Not found'},404);
    const applicants = DB.applications.filter(a=>a.oppId===opp.id&&a.status==='approved').length;
    return json(res, isOwner ? {...opp,applicantCount:applicants} : {...publicOpp(opp),applicantCount:applicants});
  }

  // POST /api/opportunities (org only, approved)
  if (method==='POST' && p==='/api/opportunities') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    if (!user.adminApproved) return json(res,{error:'Your organization is pending admin review. You cannot post listings yet.'},403);
    const plan = orgPlan(user);
    const activeCount = DB.opportunities.filter(o=>o.orgId===user.orgId&&o.active).length;
    if (plan.maxActiveListings && activeCount>=plan.maxActiveListings)
      return json(res,{error:'The '+plan.name+' plan includes up to '+plan.maxActiveListings+' active listings. Upgrade to Pro for unlimited listings.',code:'PLAN_LIMIT'},403);
    const {title,category,location,lat,lng,startTime,endTime,skills,commitment,spotsAvailable,description,requiresApproval,minAge,format} = body;
    if (!title||!category||!location||!startTime||!endTime||!description)
      return json(res,{error:'Missing required fields'},400);
    if (new Date(endTime)<=new Date(startTime))
      return json(res,{error:'End time must be after start time'},400);
    if (!(Number(spotsAvailable)>=1))
      return json(res,{error:'Spots available must be at least 1'},400);
    const opp = {
      id:uid(), orgId:user.orgId, orgName:user.orgName, orgEmail:user.email,
      title:sstr(title,140), category:sstr(category,60), location:sstr(location,200), lat:lat||null, lng:lng||null,
      startTime, endTime,
      durationHours: calcHours(startTime,endTime),
      skills:(skills||[]).slice(0,20).map(s=>sstr(s,40)), commitment:commitment||'One-time',
      spotsAvailable:clampNum(spotsAvailable,1,100000,1),
      spotsRemaining:clampNum(spotsAvailable,1,100000,1),
      description:sstr(description,5000), requiresApproval:!!requiresApproval,
      minAge:minAge?clampNum(minAge,0,120,0)||null:null,
      format:format||'In-Person',
      active:true, emoji:'🏛️', bg:'#e8f5ef',
      featured:false, views:0,
      hoursVerificationSent:false, createdAt:iso()
    };
    DB.opportunities.push(opp);
    appendAudit(user.id,'opportunity.created',opp.id,{title:opp.title});
    // Notify students with matching saved searches
    DB.users.filter(u=>u.role==='student'&&u.savedSearches?.length).forEach(student=>{
      student.savedSearches.forEach(ss=>{
        let matches=true;
        if(ss.category&&opp.category!==ss.category) matches=false;
        if(ss.commitment&&opp.commitment!==ss.commitment) matches=false;
        if(ss.query&&!opp.title.toLowerCase().includes(ss.query.toLowerCase())&&!(opp.description||'').toLowerCase().includes(ss.query.toLowerCase())) matches=false;
        if(matches) createNotification(student.id,'saved_search_match','New Match','"'+opp.title+'" matches your saved search "'+ss.name+'"','discover');
      });
    });
    saveDB();
    return json(res,opp,201);
  }

  // PUT /api/opportunities/:id
  const oppEdit = p.match(/^\/api\/opportunities\/([^/]+)$/);
  if (method==='PUT' && oppEdit) {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const idx = DB.opportunities.findIndex(o=>o.id===oppEdit[1]&&o.orgId===user.orgId);
    if (idx===-1) return json(res,{error:'Not found'},404);
    // Must be at least 2 days before the event starts
    const hoursUntil = (new Date(DB.opportunities[idx].startTime)-Date.now())/36e5;
    if (hoursUntil < 48) return json(res,{error:'Events can only be edited at least 2 days before they start.'},400);
    // Validate BEFORE mutating so a rejected request can't leave bad data in memory
    if (body.spotsAvailable!==undefined && !(Number(body.spotsAvailable)>=1))
      return json(res,{error:'Spots available must be at least 1'},400);
    const candStart = body.startTime||DB.opportunities[idx].startTime;
    const candEnd = body.endTime||DB.opportunities[idx].endTime;
    if (new Date(candEnd)<=new Date(candStart))
      return json(res,{error:'End time must be after start time'},400);
    const allowed=['title','category','location','startTime','endTime','skills','commitment','description','requiresApproval','minAge','format'];
    allowed.forEach(k=>{ if(body[k]!==undefined) DB.opportunities[idx][k]=body[k]; });
    if (body.spotsAvailable!==undefined) {
      const upd = DB.opportunities[idx];
      upd.spotsAvailable = Number(body.spotsAvailable);
      if (upd.commitment!=='Weekly'&&upd.commitment!=='Monthly') {
        const approvedCount = DB.applications.filter(a=>a.oppId===upd.id&&a.status==='approved').length;
        upd.spotsRemaining = Math.max(0, upd.spotsAvailable-approvedCount);
        promoteFromWaitlist(upd);
      }
    }
    if (body.startTime||body.endTime) DB.opportunities[idx].durationHours = calcHours(DB.opportunities[idx].startTime,DB.opportunities[idx].endTime);
    saveDB();
    return json(res,DB.opportunities[idx]);
  }

  // DELETE /api/opportunities/:id  (deactivate — sets active:false)
  const oppDeactivate = p.match(/^\/api\/opportunities\/([^/]+)$/);
  if (method==='DELETE' && oppDeactivate) {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const idx = DB.opportunities.findIndex(o=>o.id===oppDeactivate[1]&&o.orgId===user.orgId);
    if (idx===-1) return json(res,{error:'Not found'},404);
    DB.opportunities[idx].active = false;
    saveDB();
    return json(res,{success:true});
  }

  // PATCH /api/opportunities/:id/reactivate
  const reactivateMatch = p.match(/^\/api\/opportunities\/([^/]+)\/reactivate$/);
  if (method==='PATCH' && reactivateMatch) {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const oppR = IDX().oppById.get(reactivateMatch[1]);
    if (!oppR) return json(res,{error:'Listing not found'},404);
    if (oppR.orgId!==user.orgId) return json(res,{error:'Unauthorized'},401);
    const rPlan = orgPlan(user);
    const rActive = DB.opportunities.filter(o=>o.orgId===user.orgId&&o.active).length;
    if (rPlan.maxActiveListings && rActive>=rPlan.maxActiveListings)
      return json(res,{error:'The '+rPlan.name+' plan includes up to '+rPlan.maxActiveListings+' active listings. Upgrade to Pro for unlimited listings.',code:'PLAN_LIMIT'},403);
    oppR.active = true;
    saveDB();
    return json(res,oppR);
  }

  // DELETE /api/opportunities/:id/permanent  (removes from DB entirely)
  const permDeleteMatch = p.match(/^\/api\/opportunities\/([^/]+)\/permanent$/);
  if (method==='DELETE' && permDeleteMatch) {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const oppP = IDX().oppById.get(permDeleteMatch[1]);
    if (!oppP) return json(res,{error:'Listing not found'},404);
    if (oppP.orgId!==user.orgId) return json(res,{error:'Unauthorized'},401);
    const oppPId = oppP.id;
    DB.opportunities.splice(DB.opportunities.indexOf(oppP),1);
    DB.applications = DB.applications.filter(a=>a.oppId!==oppPId);
    DB.hours = DB.hours.filter(h=>h.oppId!==oppPId);
    DB.messages = DB.messages.filter(m=>m.oppId!==oppPId);
    saveDB();
    return json(res,{success:true});
  }

  // ══════════════════════════════════════════
  // APPLICATIONS
  // ══════════════════════════════════════════

  // POST /api/opportunities/:id/apply
  const applyMatch = p.match(/^\/api\/opportunities\/([^/]+)\/apply$/);
  if (method==='POST' && applyMatch) {
    if (!user||user.role!=='student') return json(res,{error:'Must be logged in as student'},401);
    const consentBlock = requireGuardianConsent(user);
    if (consentBlock) return json(res,consentBlock,403);
    const opp = IDX().oppById.get(applyMatch[1]);
    if (!opp || !opp.active) return json(res,{error:'Opportunity not found'},404);
    if (opp.spotsRemaining===0) return json(res,{error:'No spots remaining'},400);

    const signupType = body.signupType || 'subscription';
    const singleDate = body.singleDate || null;
    const isRecurring = opp.commitment === 'Weekly' || opp.commitment === 'Monthly';

    if (signupType === 'single-date') {
      if (!isRecurring) return json(res,{error:'Single-date signup only for recurring events'},400);
      if (!singleDate) return json(res,{error:'singleDate required'},400);
      if (!isValidOccurrence(opp, singleDate)) return json(res,{error:'Date does not match event schedule'},400);
      // Check duplicate single-date
      if (DB.applications.find(a=>a.oppId===opp.id&&a.userId===user.id&&(a.type||'subscription')==='single-date'&&a.singleDate?.slice(0,10)===singleDate.slice(0,10)))
        return json(res,{error:'Already signed up for this date'},409);
      // Check if subscription already covers this date
      const sub = DB.applications.find(a=>a.oppId===opp.id&&a.userId===user.id&&(a.type||'subscription')==='subscription');
      if (sub && !(sub.excludedDates||[]).some(d=>d.slice(0,10)===singleDate.slice(0,10)))
        return json(res,{error:'Your subscription already covers this date'},409);
    } else {
      // subscription — check for existing subscription
      if (DB.applications.find(a=>a.oppId===opp.id&&a.userId===user.id&&(a.type||'subscription')==='subscription'))
        return json(res,{error:'Already subscribed'},409);
      // For one-time events, check any existing app
      if (!isRecurring && DB.applications.find(a=>a.oppId===opp.id&&a.userId===user.id))
        return json(res,{error:'Already applied'},409);
    }

    // Conflict check
    const conflicts = DB.applications
      .filter(a=>a.userId===user.id&&a.status==='approved')
      .map(a=>IDX().oppById.get(a.oppId))
      .filter(Boolean)
      .filter(o=>timesOverlap(opp.startTime,opp.endTime,o.startTime,o.endTime));

    const app = {
      id:uid(), oppId:opp.id, oppTitle:opp.title, orgName:opp.orgName,
      userId:user.id, userName:`${user.firstName} ${user.lastName}`,
      userEmail:user.email,
      status: opp.requiresApproval ? 'pending' : 'approved',
      type: isRecurring ? signupType : 'subscription',
      singleDate: signupType==='single-date' ? singleDate : null,
      excludedDates: [],
      reminder24h:false, reminder1h:false, createdAt:iso()
    };
    DB.applications.push(app);
    if (!opp.requiresApproval) {
      // Only decrement global spots for one-time events; recurring uses per-date tracking
      if (!isRecurring) opp.spotsRemaining = Math.max(0,(opp.spotsRemaining||opp.spotsAvailable)-1);
      const idx = DB.users.findIndex(u=>u.id===user.id);
      if (!DB.users[idx].signedUpOpps) DB.users[idx].signedUpOpps=[];
      if (!DB.users[idx].signedUpOpps.includes(opp.id)) DB.users[idx].signedUpOpps.push(opp.id);
    }
    saveDB();
    return respond(res,{application:app, conflicts: conflicts.map(c=>({id:c.id,title:c.title,startTime:c.startTime,endTime:c.endTime}))},201);
  }

  // PATCH /api/opportunities/:id/exclude-date  (exclude/include a date from subscription)
  const excludeMatch = p.match(/^\/api\/opportunities\/([^/]+)\/exclude-date$/);
  if (method==='PATCH' && excludeMatch) {
    if (!user||user.role!=='student') return json(res,{error:'Must be logged in as student'},401);
    const opp = IDX().oppById.get(excludeMatch[1]);
    if (!opp) return json(res,{error:'Opportunity not found'},404);
    const sub = DB.applications.find(a=>a.oppId===opp.id&&a.userId===user.id&&(a.type||'subscription')==='subscription');
    if (!sub) return json(res,{error:'No subscription found'},404);
    const dateStr = (body.date||'').slice(0,10);
    if (!dateStr) return json(res,{error:'date required'},400);
    const action = body.action || 'exclude';
    if (action==='exclude') {
      // 3-hour cutoff for the specific date
      const occStart = new Date(dateStr+'T'+opp.startTime.split('T')[1]);
      if ((occStart-Date.now())/36e5 < 3) return json(res,{error:'Cannot skip within 3 hours of event start'},400);
      if (!sub.excludedDates) sub.excludedDates=[];
      if (!sub.excludedDates.some(d=>d.slice(0,10)===dateStr)) {
        sub.excludedDates.push(dateStr);
        // Per-date spots computed dynamically via date-spots endpoint
      }
    } else if (action==='include') {
      if (!sub.excludedDates) sub.excludedDates=[];
      sub.excludedDates = sub.excludedDates.filter(d=>d.slice(0,10)!==dateStr);
    }
    saveDB();
    return json(res,{application:sub});
  }

  // DELETE /api/opportunities/:id/unsubscribe  (student unsubscribes, 3hr cutoff)
  const unsubMatch = p.match(/^\/api\/opportunities\/([^/]+)\/unsubscribe$/);
  if (method==='DELETE' && unsubMatch) {
    if (!user||user.role!=='student') return json(res,{error:'Must be logged in as student'},401);
    const opp = IDX().oppById.get(unsubMatch[1]);
    if (!opp) return json(res,{error:'Opportunity not found'},404);
    const singleDate = body.singleDate || null;
    const isRecurring = opp.commitment==='Weekly'||opp.commitment==='Monthly';

    // Block unsigning from past one-time events
    if (!isRecurring && !singleDate) {
      const eventEnd = new Date(opp.endTime||opp.startTime); eventEnd.setHours(0,0,0,0);
      const todayMid = new Date(); todayMid.setHours(0,0,0,0);
      if (eventEnd < todayMid) return json(res,{error:'This event has already passed — hours have been logged to your history'},400);
    }

    if (singleDate) {
      // Remove a specific single-date application
      const appIdx = DB.applications.findIndex(a=>a.oppId===opp.id&&a.userId===user.id&&(a.type||'subscription')==='single-date'&&a.singleDate?.slice(0,10)===singleDate.slice(0,10));
      if (appIdx===-1) return json(res,{error:'Not signed up for this date'},404);
      const occStart = new Date(singleDate.slice(0,10)+'T'+opp.startTime.split('T')[1]);
      if ((occStart-Date.now())/36e5 < 3) return json(res,{error:'Cannot unsign within 3 hours of event start'},400);
      const wasApproved = DB.applications[appIdx].status==='approved';
      DB.applications.splice(appIdx,1);
      // Per-date spots are computed dynamically; no global adjustment needed for recurring
    } else {
      // Unsubscribe from subscription (and remove all single-date apps for this opp)
      const nextOcc = nextOccurrenceAfter(opp, new Date(), []);
      if (nextOcc && (nextOcc-Date.now())/36e5 < 3) return json(res,{error:'Cannot unsubscribe within 3 hours of next event'},400);
      const appIdx = DB.applications.findIndex(a=>a.oppId===opp.id&&a.userId===user.id&&(a.type||'subscription')==='subscription');
      if (appIdx===-1) return json(res,{error:'You are not subscribed to this event'},404);
      const wasApproved = DB.applications[appIdx].status==='approved';
      DB.applications.splice(appIdx,1);
      // Also remove any single-date apps for the same opp
      for (let i=DB.applications.length-1; i>=0; i--) {
        if (DB.applications[i].oppId===opp.id&&DB.applications[i].userId===user.id) DB.applications.splice(i,1);
      }
      // Only adjust global spots for one-time events
      if (!isRecurring && wasApproved) {
        opp.spotsRemaining = Math.min(opp.spotsAvailable,(opp.spotsRemaining||0)+1);
        promoteFromWaitlist(opp);
      }
    }
    // Remove from signedUpOpps if no more apps for this opp
    const hasRemainingApps = DB.applications.some(a=>a.oppId===opp.id&&a.userId===user.id);
    const uIdx = DB.users.findIndex(u=>u.id===user.id);
    if (!hasRemainingApps && uIdx>-1 && DB.users[uIdx].signedUpOpps) {
      DB.users[uIdx].signedUpOpps = DB.users[uIdx].signedUpOpps.filter(id=>id!==opp.id);
    }
    saveDB();
    return json(res,{success:true});
  }

  // GET /api/applications/my  (student's own)
  if (method==='GET' && p==='/api/applications/my') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const apps = idxList(IDX().appsByUser,user.id);
    const enriched = apps.map(a=>{
      const opp = IDX().oppById.get(a.oppId);
      return {...a, opp: publicOpp(opp)};
    });
    return json(res,enriched);
  }

  // GET /api/applications/org  (org sees applicants for their opps)
  if (method==='GET' && p==='/api/applications/org') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const orgOppIds = idxList(IDX().oppsByOrg,user.orgId).map(o=>o.id);
    return json(res, DB.applications.filter(a=>orgOppIds.includes(a.oppId)));
  }

  // PATCH /api/applications/:id  (org approve/reject)
  const appPatch = p.match(/^\/api\/applications\/([^/]+)$/);
  if (method==='PATCH' && appPatch) {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const idx = DB.applications.findIndex(a=>a.id===appPatch[1]);
    if (idx===-1) return json(res,{error:'Not found'},404);
    const opp = ownedOpp(DB.applications[idx].oppId, user.orgId);
    if (!opp) return json(res,{error:'Forbidden'},403);
    const {action} = body;
    const prevStatus = DB.applications[idx].status;
    DB.applications[idx].status = action==='approve'?'approved':action==='reject'?'rejected':'pending';
    DB.applications[idx].resolvedAt = iso();
    if (action==='approve') {
      const isRecurringOpp = opp.commitment==='Weekly'||opp.commitment==='Monthly';
      if (!isRecurringOpp) opp.spotsRemaining = Math.max(0,(opp.spotsRemaining||0)-1);
      const sIdx = DB.users.findIndex(u=>u.id===DB.applications[idx].userId);
      if (sIdx>-1) {
        if (!DB.users[sIdx].signedUpOpps) DB.users[sIdx].signedUpOpps=[];
        DB.users[sIdx].signedUpOpps.push(opp.id);
      }
      createNotification(DB.applications[idx].userId, 'app_approved', 'Application Approved', 'Your application for "'+opp.title+'" has been approved!', 'dash');
    } else if (action==='reject') {
      // If the org pulls a previously-approved volunteer, free the spot and promote the waitlist
      const isRecurringOpp = opp.commitment==='Weekly'||opp.commitment==='Monthly';
      if (prevStatus==='approved' && !isRecurringOpp) {
        opp.spotsRemaining = Math.min(opp.spotsAvailable,(opp.spotsRemaining||0)+1);
        promoteFromWaitlist(opp);
      }
      const sIdx2 = DB.users.findIndex(u=>u.id===DB.applications[idx].userId);
      if (prevStatus==='approved' && sIdx2>-1 && DB.users[sIdx2].signedUpOpps)
        DB.users[sIdx2].signedUpOpps = DB.users[sIdx2].signedUpOpps.filter(id=>id!==opp.id);
      createNotification(DB.applications[idx].userId, 'app_rejected', 'Application Rejected', 'Your application for "'+opp.title+'" was not accepted.', 'dash');
    }
    saveDB();
    return json(res,DB.applications[idx]);
  }

  // ══════════════════════════════════════════
  // HOURS
  // ══════════════════════════════════════════

  // POST /api/hours/auto-log-attended  — create pending entries for past attended dates
  if (method==='POST' && p==='/api/hours/auto-log-attended') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const today = new Date(); today.setHours(0,0,0,0);
    const approvedApps = idxList(IDX().appsByUser,user.id).filter(a=>a.status==='approved');
    let created = 0;
    for (const app of approvedApps) {
      const opp = IDX().oppById.get(app.oppId);
      if (!opp||!opp.startTime) continue;
      const durHrs = opp.durationHours || (opp.endTime?(new Date(opp.endTime)-new Date(opp.startTime))/36e5:0);
      if (durHrs<=0) continue;
      const commit = opp.commitment||'One-time';
      const pastDates = [];
      if (app.type==='single-date' && app.singleDate) {
        const sd = new Date(app.singleDate); sd.setHours(0,0,0,0);
        if (sd < today) pastDates.push(app.singleDate.slice(0,10));
      } else if (commit==='One-time') {
        const ed = new Date(opp.endTime||opp.startTime); ed.setHours(0,0,0,0);
        if (ed < today) pastDates.push(new Date(opp.startTime).toISOString().slice(0,10));
      } else {
        // Recurring subscription — collect all past occurrences not excluded
        const excluded = new Set((app.excludedDates||[]).map(d=>d.slice(0,10)));
        let cur = new Date(opp.startTime); cur.setHours(0,0,0,0);
        let safety = 0;
        while (cur < today && safety++ < 500) {
          const ds = cur.toISOString().slice(0,10);
          if (!excluded.has(ds)) pastDates.push(ds);
          if (commit==='Weekly') cur.setDate(cur.getDate()+7);
          else cur.setMonth(cur.getMonth()+1);
        }
      }
      for (const ds of pastDates) {
        const autoKey = `auto:${user.id}:${opp.id}:${ds}`;
        if (DB.hours.some(h=>h.autoKey===autoKey)) continue;
        const occStart = new Date(ds+'T'+new Date(opp.startTime).toISOString().split('T')[1]);
        const occEnd   = new Date(occStart.getTime()+durHrs*36e5);
        DB.hours.push({
          id:uid(), userId:user.id, oppId:opp.id,
          orgName:opp.orgName, activity:opp.title,
          startTime:occStart.toISOString(), endTime:occEnd.toISOString(),
          hours:Math.round(durHrs*100)/100,
          status:'pending', supervisorName:'—', notes:'',
          appeal:null, appealNote:'', autoKey, createdAt:iso()
        });
        created++;
      }
    }
    if (created>0) saveDB();
    return json(res,{created});
  }

  // GET /api/hours  (student: own; org: pending for their opps)
  if (method==='GET' && p==='/api/hours') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    if (user.role==='student') return json(res, idxList(IDX().hoursByUser,user.id));
    if (user.role==='org') {
      const orgOppIds = idxList(IDX().oppsByOrg,user.orgId).map(o=>o.id);
      const pending = DB.hours.filter(h=>orgOppIds.includes(h.oppId)&&['pending','verified','denied'].includes(h.status));
      return json(res, pending.map(h=>{
        const s = IDX().userById.get(h.userId);
        return {...h, studentName:s?`${s.firstName} ${s.lastName}`:'Unknown', studentEmail:s?.email||''};
      }));
    }
    return json(res,{error:'Unauthorized'},401);
  }

  // POST /api/hours  (student logs hours)
  if (method==='POST' && p==='/api/hours') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const {oppId,orgName,activity,startTime,endTime,supervisorEmail,notes,type} = body;
    if (!activity||!startTime||!endTime||!orgName) return json(res,{error:'Missing required fields'},400);
    const hrs = calcHours(startTime,endTime);
    if (hrs<=0) return json(res,{error:'End time must be after start time'},400);

    let status = type==='self'||!oppId ? 'self' : 'pending';
    let resolvedOrgName = orgName;
    let resolvedOppId = oppId||null;

    if (oppId) {
      const opp = IDX().oppById.get(oppId);
      if (opp) { resolvedOrgName = opp.orgName; }
    }

    const entry = {
      id:uid(), userId:user.id, oppId:resolvedOppId,
      orgName:resolvedOrgName, activity,
      startTime, endTime, hours:hrs,
      status, supervisorEmail:supervisorEmail||'',
      supervisorName:'—', notes:notes||'',
      appeal:null, appealNote:'', createdAt:iso()
    };
    DB.hours.push(entry);

    // If supervisor email given for self-report, note it (would send email in prod)
    if (supervisorEmail && status==='self') {
      entry.supervisorEmailSent = true;
      // In prod: send email to supervisorEmail asking them to verify
    }

    saveDB();
    return json(res,entry,201);
  }

  // PATCH /api/hours/:id/verify  (org verify/deny)
  const hoursVerify = p.match(/^\/api\/hours\/([^/]+)\/verify$/);
  if (method==='PATCH' && hoursVerify) {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const idx = DB.hours.findIndex(h=>h.id===hoursVerify[1]);
    if (idx===-1) return json(res,{error:'Not found'},404);
    const orgOppIds = idxList(IDX().oppsByOrg,user.orgId).map(o=>o.id);
    if (DB.hours[idx].oppId && !orgOppIds.includes(DB.hours[idx].oppId))
      return json(res,{error:'Forbidden'},403);
    const {action,supervisorName,note} = body;
    if (action==='approve') {
      DB.hours[idx].status = 'verified';
      DB.hours[idx].supervisorName = supervisorName||user.orgName;
      createNotification(DB.hours[idx].userId, 'hours_verified', 'Hours Verified', DB.hours[idx].hours+' hours for "'+DB.hours[idx].activity+'" have been verified.', 'dash');
    } else if (action==='deny') {
      DB.hours[idx].status = 'denied';
      DB.hours[idx].denyNote = note||'';
      createNotification(DB.hours[idx].userId, 'hours_denied', 'Hours Denied', 'Your '+DB.hours[idx].hours+' hours for "'+DB.hours[idx].activity+'" were denied.'+(note?' Reason: '+note:''), 'dash');
    }
    saveDB();
    return json(res,DB.hours[idx]);
  }

  // PATCH /api/hours/:id/appeal  (student appeals denied hours)
  const hoursAppeal = p.match(/^\/api\/hours\/([^/]+)\/appeal$/);
  if (method==='PATCH' && hoursAppeal) {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const idx = DB.hours.findIndex(h=>h.id===hoursAppeal[1]&&h.userId===user.id);
    if (idx===-1) return json(res,{error:'Not found'},404);
    if (DB.hours[idx].status!=='denied') return json(res,{error:'Can only appeal denied hours'},400);
    if (DB.hours[idx].appeal==='used') return json(res,{error:'Appeal already used'},400);
    const {note} = body;
    DB.hours[idx].status = 'pending';
    DB.hours[idx].appeal = 'used';
    DB.hours[idx].appealNote = note||'';
    saveDB();
    return json(res,DB.hours[idx]);
  }

  // DELETE /api/hours/:id  (student deletes own non-verified)
  const hoursDel = p.match(/^\/api\/hours\/([^/]+)$/);
  if (method==='DELETE' && hoursDel) {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const idx = DB.hours.findIndex(h=>h.id===hoursDel[1]&&h.userId===user.id);
    if (idx===-1) return json(res,{error:'Not found'},404);
    if (DB.hours[idx].status==='verified') return json(res,{error:'Cannot delete verified hours'},400);
    DB.hours.splice(idx,1);
    saveDB();
    return json(res,{success:true});
  }


  // DELETE /api/account  (delete own account, requires password confirmation)
  if (method==='DELETE' && p==='/api/account') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const {password} = body;
    if (!password) return json(res,{error:'Password required to delete account'},400);
    const fullUser = IDX().userById.get(user.id);
    if (!verifyPassword(password, fullUser))
      return json(res,{error:'Incorrect password'},401);
    // Remove user data
    DB.users.splice(DB.users.indexOf(fullUser), 1);
    if (user.role==='student') {
      // Free any one-time spots this student held, then promote waitlists
      idxList(IDX().appsByUser,user.id).filter(a=>a.status==='approved').forEach(a=>{
        const heldOpp = IDX().oppById.get(a.oppId);
        if (heldOpp && heldOpp.commitment!=='Weekly' && heldOpp.commitment!=='Monthly')
          heldOpp.spotsRemaining = Math.min(heldOpp.spotsAvailable,(heldOpp.spotsRemaining||0)+1);
      });
      DB.applications = DB.applications.filter(a=>a.userId!==user.id);
      DB.opportunities.forEach(o=>{ if(o.commitment!=='Weekly'&&o.commitment!=='Monthly') promoteFromWaitlist(o); });
      DB.hours = DB.hours.filter(h=>h.userId!==user.id);
      DB.reviews = DB.reviews.filter(r=>r.userId!==user.id);
      DB.messages = DB.messages.filter(m=>m.senderId!==user.id);
    } else if (user.role==='org') {
      const orgOppIds = idxList(IDX().oppsByOrg,user.orgId).map(o=>o.id);
      DB.opportunities = DB.opportunities.filter(o=>o.orgId!==user.orgId);
      DB.applications = DB.applications.filter(a=>!orgOppIds.includes(a.oppId));
      DB.messages = DB.messages.filter(m=>!orgOppIds.includes(m.oppId));
    }
    // Right to erasure (GDPR Art. 17). Record only non-PII metadata in the
    // tamper-evident log so the deletion itself is provable without re-storing PII.
    appendAudit('self','account.deleted',user.id,{role:user.role});
    saveDB();
    return json(res,{success:true});
  }

  // ══════════════════════════════════════════
  // PROFILE
  // ══════════════════════════════════════════

  // PUT /api/profile
  if (method==='PUT' && p==='/api/profile') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const idx = DB.users.findIndex(u=>u.id===user.id);
    if (user.role==='student') {
      ['school','grade','location','skills','causes'].forEach(k=>{ if(body[k]!==undefined) DB.users[idx][k]=body[k]; });
      if (body.hoursGoal!==undefined) DB.users[idx].hoursGoal = Math.max(0,Math.min(10000,Number(body.hoursGoal)||0));
    } else if (user.role==='org') {
      ['orgName','description','website','phone'].forEach(k=>{ if(body[k]!==undefined) DB.users[idx][k]=body[k]; });
    }
    saveDB();
    return json(res,safeUser(DB.users[idx]));
  }

  // ══════════════════════════════════════════
  // MESSAGES / CHAT
  // ══════════════════════════════════════════

  // GET /api/messages/:oppId
  const msgGet = p.match(/^\/api\/messages\/([^/]+)$/);
  if (method==='GET' && msgGet) {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const oppId = msgGet[1];
    const opp = IDX().oppById.get(oppId);
    if (!opp) return json(res,{error:'Not found'},404);
    // Only signed-up students and the org can see messages
    const isOrg = user.role==='org'&&user.orgId===opp.orgId;
    const isStudent = user.role==='student'&&DB.applications.find(a=>a.oppId===oppId&&a.userId===user.id&&a.status==='approved');
    if (!isOrg&&!isStudent) return json(res,{error:'Forbidden'},403);
    return json(res, [...idxList(IDX().messagesByOpp,oppId)].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)));
  }

  // POST /api/messages/:oppId
  const msgPost = p.match(/^\/api\/messages\/([^/]+)$/);
  if (method==='POST' && msgPost) {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const oppId = msgPost[1];
    const opp = IDX().oppById.get(oppId);
    if (!opp) return json(res,{error:'Not found'},404);
    const isOrg = user.role==='org'&&user.orgId===opp.orgId;
    const isStudent = user.role==='student'&&DB.applications.find(a=>a.oppId===oppId&&a.userId===user.id&&a.status==='approved');
    if (!isOrg&&!isStudent) return json(res,{error:'Forbidden'},403);
    // Defense in depth: an approved application already implies verified consent
    // (or 18+) at apply time, but re-check live so a post-approval guardian
    // revoke (§ manage/revoke) blocks new messages immediately.
    if (isStudent) { const consentBlock = requireGuardianConsent(user); if (consentBlock) return json(res,consentBlock,403); }
    const msg = {
      id:uid(), oppId, senderId:user.id,
      senderName: user.role==='org' ? user.orgName : `${user.firstName} ${user.lastName}`,
      senderRole: user.role,
      text: sstr(body.text,2000), createdAt:iso()
    };
    if (!msg.text) return json(res,{error:'Message cannot be empty'},400);
    DB.messages.push(msg);
    // Notify other participants
    const senderName = user.role==='org' ? user.orgName : user.firstName;
    if (isOrg) {
      // Notify all approved students for this opp
      DB.applications.filter(a=>a.oppId===oppId&&a.status==='approved'&&a.userId!==user.id).forEach(a=>{
        createNotification(a.userId, 'new_message', 'New Message', senderName+' sent a message in "'+opp.title+'"', 'chat:'+oppId);
      });
    } else {
      // Notify the org
      const orgUser = IDX().userByOrgId.get(opp.orgId);
      if (orgUser) createNotification(orgUser.id, 'new_message', 'New Message', senderName+' sent a message in "'+opp.title+'"', 'chat:'+oppId);
    }
    saveDB();
    return json(res,msg,201);
  }

  // ══════════════════════════════════════════
  // REVIEWS
  // ══════════════════════════════════════════

  // GET /api/reviews/:orgId
  const reviewsGet = p.match(/^\/api\/reviews\/([^/]+)$/);
  if (method==='GET' && reviewsGet) {
    return json(res, idxList(IDX().reviewsByOrg,reviewsGet[1]));
  }

  // POST /api/reviews/:orgId
  if (method==='POST' && reviewsGet) {
    if (!user||user.role!=='student') return json(res,{error:'Must be a student to review'},401);
    if (DB.reviews.find(r=>r.orgId===reviewsGet[1]&&r.userId===user.id))
      return json(res,{error:'Already reviewed this organization'},409);
    const {rating,comment} = body;
    if (!rating||rating<1||rating>5) return json(res,{error:'Rating must be 1-5'},400);
    const review = {
      id:uid(), orgId:reviewsGet[1], userId:user.id,
      userName:`${user.firstName} ${user.lastName[0]}.`,
      rating:clampNum(rating,1,5,1), comment:sstr(comment,1000), createdAt:iso()
    };
    DB.reviews.push(review);
    saveDB();
    return json(res,review,201);
  }


  // DELETE /api/reviews/:reviewId  (student deletes own review)
  const reviewDel = p.match(/^\/api\/reviews\/([^/]+)\/delete$/);
  if (method==='DELETE' && reviewDel) {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const idx = DB.reviews.findIndex(r=>r.id===reviewDel[1]&&r.userId===user.id);
    if (idx===-1) return json(res,{error:'Review not found or not yours'},404);
    DB.reviews.splice(idx,1);
    saveDB();
    return json(res,{success:true});
  }


  // GET /api/org/:orgId/reviews  (dedicated, with userId for auth checking)
  const orgReviewsRoute = p.match(/^\/api\/org\/([^/]+)\/reviews$/);
  if (method==='GET' && orgReviewsRoute) {
    const reviews = idxList(IDX().reviewsByOrg,orgReviewsRoute[1]);
    const enriched = reviews.map(r=>({...r, isOwn: user?.id===r.userId}));
    const avg = reviews.length ? Math.round(reviews.reduce((s,r)=>s+r.rating,0)/reviews.length*10)/10 : null;
    const dist = [5,4,3,2,1].map(n=>({stars:n,count:reviews.filter(r=>r.rating===n).length}));
    return json(res,{reviews:enriched, avgRating:avg, total:reviews.length, distribution:dist});
  }

  // ══════════════════════════════════════════
  // REPORTS
  // ══════════════════════════════════════════

  // POST /api/reports
  if (method==='POST' && p==='/api/reports') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const {orgId,reason,details} = body;
    if (!orgId||!reason) return json(res,{error:'Missing orgId or reason'},400);
    const report = { id:uid(), orgId, reporterId:user.id, reporterEmail:user.email, reason, details:details||'', status:'open', createdAt:iso() };
    DB.reports.push(report);
    saveDB();
    return json(res,report,201);
  }

  // ══════════════════════════════════════════
  // ORG LANDING PAGE
  // ══════════════════════════════════════════

  // GET /api/org/:orgId/profile
  const orgProfile = p.match(/^\/api\/org\/([^/]+)\/profile$/);
  if (method==='GET' && orgProfile) {
    const org = IDX().userByOrgId.get(orgProfile[1]);
    if (!org) return json(res,{error:'Not found'},404);
    const opps = DB.opportunities.filter(o=>o.orgId===orgProfile[1]&&o.active);
    const reviews = idxList(IDX().reviewsByOrg,orgProfile[1]);
    const avgRating = reviews.length ? Math.round(reviews.reduce((s,r)=>s+r.rating,0)/reviews.length*10)/10 : null;
    // Compute org badges
    const orgBadges = [];
    if (org.adminApproved) orgBadges.push('verified');
    if (reviews.length>=3 && avgRating>=4.5) orgBadges.push('top-rated');
    const orgOppIds = opps.map(o=>o.id);
    const resolved = DB.applications.filter(a=>orgOppIds.includes(a.oppId)&&a.resolvedAt).slice(-10);
    if (resolved.length>=3) { const avg=resolved.reduce((s,a)=>s+(new Date(a.resolvedAt)-new Date(a.createdAt))/36e5,0)/resolved.length; if(avg<=24) orgBadges.push('responsive'); }
    if (org.createdAt&&(Date.now()-new Date(org.createdAt))>180*864e5&&org.adminApproved) orgBadges.push('established');
    return json(res,{
      orgId: org.orgId, orgName: org.orgName, description: org.description,
      website: org.website, verified: org.adminApproved, badges: orgBadges,
      opportunities: opps.map(publicOpp), reviews, avgRating,
      totalVolunteers: DB.applications.filter(a=>orgOppIds.includes(a.oppId)&&a.status==='approved').length
    });
  }

  // ══════════════════════════════════════════
  // ADMIN
  // ══════════════════════════════════════════

  // GET /api/admin/stats
  if (method==='GET' && p==='/api/admin/stats') {
    if (!user||user.role!=='admin') return json(res,{error:'Unauthorized'},401);
    return json(res,{
      totalStudents: DB.users.filter(u=>u.role==='student').length,
      totalOrgs: DB.users.filter(u=>u.role==='org').length,
      pendingOrgs: DB.users.filter(u=>u.role==='org'&&!u.adminApproved).length,
      totalOpps: DB.opportunities.filter(o=>o.active).length,
      totalHoursVerified: DB.hours.filter(h=>h.status==='verified').reduce((s,h)=>s+h.hours,0),
      totalApplications: DB.applications.length,
      openReports: DB.reports.filter(r=>r.status==='open').length,
      proOrgs: DB.users.filter(u=>u.role==='org'&&u.plan==='pro').length,
      donationsTotal: Math.round(DB.donations.reduce((s,d)=>s+d.amount,0)*100)/100,
    });
  }

  // GET /api/admin/orgs/pending
  if (method==='GET' && p==='/api/admin/orgs/pending') {
    if (!user||user.role!=='admin') return json(res,{error:'Unauthorized'},401);
    return json(res, DB.users.filter(u=>u.role==='org'&&!u.adminApproved).map(safeUser));
  }

  // GET /api/admin/orgs/all
  if (method==='GET' && p==='/api/admin/orgs/all') {
    if (!user||user.role!=='admin') return json(res,{error:'Unauthorized'},401);
    return json(res, DB.users.filter(u=>u.role==='org').map(safeUser));
  }

  // GET /api/admin/consent/pending — minors awaiting guardian consent >3 days
  if (method==='GET' && p==='/api/admin/consent/pending') {
    if (!requireRole(user,'admin')) return json(res,{error:'Unauthorized'},401);
    const cutoff = Date.now()-3*864e5;
    const stuck = DB.users.filter(u=>u.role==='student'
      &&(u.guardianConsentStatus==='pending'||u.guardianConsentStatus==='legacy_pending')
      &&new Date(u.guardianConsentRequestedAt).getTime()<cutoff);
    return json(res, stuck.map(safeUser));
  }

  // PATCH /api/admin/orgs/:userId
  const adminOrg = p.match(/^\/api\/admin\/orgs\/([^/]+)$/);
  if (method==='PATCH' && adminOrg) {
    if (!user||user.role!=='admin') return json(res,{error:'Unauthorized'},401);
    const idx = DB.users.findIndex(u=>u.id===adminOrg[1]&&u.role==='org');
    if (idx===-1) return json(res,{error:'Not found'},404);
    const {action,note} = body;
    if (action==='approve') {
      DB.users[idx].adminApproved = true;
      DB.users[idx].reviewStatus = 'approved';
      DB.users[idx].adminApprovedAt = iso();
      DB.users[idx].adminNote = sstr(note,500);
    } else if (action==='reject') {
      DB.users[idx].adminApproved = false;
      DB.users[idx].reviewStatus = 'rejected';
      DB.users[idx].adminNote = sstr(note,500);
    } else if (action==='suspend') {
      DB.users[idx].adminApproved = false;
      DB.users[idx].reviewStatus = 'suspended';
      DB.users[idx].adminNote = sstr(note,500);
      // Revoke the suspended org's active sessions immediately
      DB.users[idx].tokenVersion = (DB.users[idx].tokenVersion||0)+1;
    }
    appendAudit(user.id,'admin.org.'+action,DB.users[idx].id,{org:DB.users[idx].orgName});
    saveDB();
    return json(res,safeUser(DB.users[idx]));
  }

  // GET /api/admin/audit — tamper-evident audit trail (newest first)
  if (method==='GET' && p==='/api/admin/audit') {
    if (!requireRole(user,'admin')) return json(res,{error:'Unauthorized'},401);
    const limit = clampNum(parsed.query.limit,1,500,100);
    return json(res,{
      total: DB.auditLog.length,
      chain: verifyAuditChain(),
      entries: DB.auditLog.slice(-limit).reverse(),
    });
  }
  // GET /api/admin/audit/verify — explicit integrity check of the whole chain
  if (method==='GET' && p==='/api/admin/audit/verify') {
    if (!requireRole(user,'admin')) return json(res,{error:'Unauthorized'},401);
    return json(res, verifyAuditChain());
  }

  // GET /api/admin/reports
  if (method==='GET' && p==='/api/admin/reports') {
    if (!user||user.role!=='admin') return json(res,{error:'Unauthorized'},401);
    const enriched = DB.reports.map(r=>{
      const org = IDX().userByOrgId.get(r.orgId);
      return {...r, orgName:org?.orgName||'Unknown'};
    });
    return json(res,enriched);
  }

  // PATCH /api/admin/reports/:id
  const adminReport = p.match(/^\/api\/admin\/reports\/([^/]+)$/);
  if (method==='PATCH' && adminReport) {
    if (!user||user.role!=='admin') return json(res,{error:'Unauthorized'},401);
    const idx = DB.reports.findIndex(r=>r.id===adminReport[1]);
    if (idx===-1) return json(res,{error:'Not found'},404);
    DB.reports[idx].status = body.status||'resolved';
    saveDB();
    return json(res,DB.reports[idx]);
  }

  // GET /api/org/opportunities  (org's own listings)
  if (method==='GET' && p==='/api/org/opportunities') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const opps = idxList(IDX().oppsByOrg,user.orgId);
    return json(res, opps.map(o=>({...o, applicantCount:DB.applications.filter(a=>a.oppId===o.id&&a.status==='approved').length})));
  }

  // ══════════════════════════════════════════
  // STATS (public)
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/stats') {
    const cached = cacheGet('stats');
    if (cached) return json(res, cached);
    return json(res, cacheSet('stats', {
      opportunities: DB.opportunities.filter(o=>o.active).length,
      students: DB.users.filter(u=>u.role==='student').length,
      totalHours: Math.round(DB.hours.filter(h=>h.status==='verified').reduce((s,h)=>s+h.hours,0)*100)/100,
      organisations: DB.users.filter(u=>u.role==='org'&&u.adminApproved).length,
    }, 15000));
  }

  // CALENDAR FEED (.ics)
  // Public endpoint — uses a per-user token so calendar apps can poll without auth headers
  // GET /api/calendar/:userId/:token.ics
  const calMatch = p.match(/^\/api\/calendar\/([^/]+)\/([^/]+)\.ics$/);
  if (method==='GET' && calMatch) {
    const calUserId = calMatch[1];
    const calToken  = calMatch[2];
    const calUser   = IDX().userById.get(calUserId);
    if (!calUser || calUser.role !== 'student') return json(res, {error:'Not found'}, 404);
    // Verify token: HMAC of the userId with the server secret
    const expectedToken = crypto.createHmac('sha256', SECRET).update(calUserId).digest('hex').slice(0, 24);
    if (calToken !== expectedToken) return json(res, {error:'Forbidden'}, 403);
    // Build .ics from approved applications
    const apps = DB.applications.filter(a => a.userId === calUserId && a.status === 'approved');
    const icsEsc = s => String(s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
    const toICS  = d => d ? new Date(d).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'') : '';
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ServeLocal//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:ServeLocal Events\r\n';
    for (const a of apps) {
      const opp = DB.opportunities.find(o => o.id === a.oppId);
      if (!opp) continue;
      const appType = a.type || 'subscription';
      if (appType === 'single-date' && a.singleDate) {
        // Single-date: one VEVENT with no RRULE
        const durMs = new Date(opp.endTime) - new Date(opp.startTime);
        const sdStart = new Date(a.singleDate.slice(0,10)+'T'+opp.startTime.split('T')[1]);
        const sdEnd = new Date(sdStart.getTime() + durMs);
        ics += 'BEGIN:VEVENT\r\n';
        ics += 'UID:servelocal-' + a.id + '@servelocal.app\r\n';
        ics += 'DTSTAMP:' + toICS(new Date().toISOString()) + '\r\n';
        ics += 'DTSTART:' + toICS(sdStart.toISOString()) + '\r\n';
        ics += 'DTEND:' + toICS(sdEnd.toISOString()) + '\r\n';
        ics += 'SUMMARY:' + icsEsc(opp.title + ' — ServeLocal') + '\r\n';
        ics += 'DESCRIPTION:' + icsEsc((opp.description||'') + '\nOrganization: ' + (opp.orgName||'') + '\nSkills: ' + (opp.skills||[]).join(', ')) + '\r\n';
        ics += 'LOCATION:' + icsEsc(opp.location || '') + '\r\n';
        ics += 'END:VEVENT\r\n';
      } else {
        // Subscription: VEVENT with RRULE + EXDATE
        ics += 'BEGIN:VEVENT\r\n';
        ics += 'UID:servelocal-' + a.id + '@servelocal.app\r\n';
        ics += 'DTSTAMP:' + toICS(new Date().toISOString()) + '\r\n';
        ics += 'DTSTART:' + toICS(opp.startTime) + '\r\n';
        ics += 'DTEND:' + toICS(opp.endTime) + '\r\n';
        ics += 'SUMMARY:' + icsEsc(opp.title + ' — ServeLocal') + '\r\n';
        ics += 'DESCRIPTION:' + icsEsc((opp.description||'') + '\nOrganization: ' + (opp.orgName||'') + '\nSkills: ' + (opp.skills||[]).join(', ')) + '\r\n';
        ics += 'LOCATION:' + icsEsc(opp.location || '') + '\r\n';
        if (opp.commitment === 'Weekly')  ics += 'RRULE:FREQ=WEEKLY\r\n';
        if (opp.commitment === 'Monthly') ics += 'RRULE:FREQ=MONTHLY\r\n';
        const exDates = (a.excludedDates||[]).filter(Boolean);
        if (exDates.length) {
          ics += 'EXDATE:' + exDates.map(d => toICS(d.slice(0,10)+'T'+opp.startTime.split('T')[1])).join(',') + '\r\n';
        }
        ics += 'END:VEVENT\r\n';
      }
    }
    ics += 'END:VCALENDAR\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="servelocal.ics"',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    return res.end(ics);
  }

  // GET /api/calendar-token — returns the user's personal calendar feed URL
  if (method==='GET' && p==='/api/calendar-token') {
    if (!user || user.role !== 'student') return json(res, {error:'Unauthorized'}, 401);
    const token = crypto.createHmac('sha256', SECRET).update(user.id).digest('hex').slice(0, 24);
    return json(res, { token, userId: user.id });
  }

  // ══════════════════════════════════════════
  // NOTIFICATIONS
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/notifications') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const limit = parseInt(parsed.query.limit)||30;
    const offset = parseInt(parsed.query.offset)||0;
    const all = [...idxList(IDX().notifsByUser,user.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return json(res, { notifications:all.slice(offset,offset+limit), total:all.length });
  }
  if (method==='GET' && p==='/api/notifications/unread-count') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    return json(res, { count:idxList(IDX().notifsByUser,user.id).filter(n=>!n.read).length });
  }
  const notifRead = p.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (method==='PATCH' && notifRead) {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const n = DB.notifications.find(n=>n.id===notifRead[1]&&n.userId===user.id);
    if (!n) return json(res,{error:'Not found'},404);
    n.read = true;
    saveDB();
    return json(res,n);
  }
  if (method==='PATCH' && p==='/api/notifications/read-all') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    idxList(IDX().notifsByUser,user.id).filter(n=>!n.read).forEach(n=>n.read=true);
    saveDB();
    return json(res,{ok:true});
  }

  // ══════════════════════════════════════════
  // ENDORSEMENTS
  // ══════════════════════════════════════════
  if (method==='POST' && p==='/api/endorsements') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const {userId:targetId,oppId,skills} = body;
    if (!targetId||!oppId||!skills||!skills.length) return json(res,{error:'userId, oppId, and skills[] required'},400);
    const opp = ownedOpp(oppId, user.orgId);
    if (!opp) return json(res,{error:'Opportunity not found or not yours'},403);
    const app = DB.applications.find(a=>a.oppId===oppId&&a.userId===targetId&&a.status==='approved');
    if (!app) return json(res,{error:'Student must have approved application'},400);
    const targetStudent = IDX().userById.get(targetId);
    const consentBlock = targetStudent && requireGuardianConsent(targetStudent);
    if (consentBlock) return json(res,consentBlock,403);
    if (DB.endorsements.find(e=>e.userId===targetId&&e.oppId===oppId&&e.orgId===user.orgId)) return json(res,{error:'Already endorsed for this opportunity'},409);
    const endorsement = { id:uid(), userId:targetId, orgId:user.orgId, orgName:user.orgName, oppId, oppTitle:opp.title, skills, createdAt:iso() };
    DB.endorsements.push(endorsement);
    createNotification(targetId, 'endorsement', 'Skill Endorsement', user.orgName+' endorsed your skills: '+skills.join(', '), 'dash');
    saveDB();
    return json(res,endorsement,201);
  }
  const endorseGet = p.match(/^\/api\/endorsements\/([^/]+)$/);
  if (method==='GET' && endorseGet) {
    const endsForUser = DB.endorsements.filter(e=>e.userId===endorseGet[1]);
    const skillCounts = {};
    endsForUser.forEach(e=>e.skills.forEach(s=>{ skillCounts[s]=(skillCounts[s]||0)+1; }));
    return json(res, { endorsements:endsForUser, skillCounts });
  }

  // ══════════════════════════════════════════
  // PORTFOLIO
  // ══════════════════════════════════════════
  const portfolioGet = p.match(/^\/api\/portfolio\/([^/]+)$/);
  if (method==='GET' && portfolioGet) {
    const student = IDX().userById.get(portfolioGet[1]);
    if (!student || student.role!=='student') return json(res,{error:'Not found'},404);
    // Allow owner to always see their own, otherwise check public flag
    const isOwner = user&&user.id===student.id;
    if (!isOwner&&!student.portfolioPublic) return json(res,{error:'Portfolio is private'},403);
    const hours = DB.hours.filter(h=>h.userId===student.id&&h.status==='verified');
    const totalHours = Math.round(hours.reduce((s,h)=>s+h.hours,0)*100)/100;
    const hoursByOrg = {};
    hours.forEach(h=>{ hoursByOrg[h.orgName] = Math.round(((hoursByOrg[h.orgName]||0)+h.hours)*100)/100; });
    const awards = AWARDS.filter(a=>totalHours>=a.hours);
    const endorsements = DB.endorsements.filter(e=>e.userId===student.id);
    const skillCounts = {};
    endorsements.forEach(e=>e.skills.forEach(s=>{ skillCounts[s]=(skillCounts[s]||0)+1; }));
    return json(res,{
      name:student.firstName+' '+student.lastName, school:student.school, grade:student.grade,
      skills:student.skills, causes:student.causes,
      totalVerifiedHours:totalHours,
      hoursByOrg, awards, skillCounts,
      uniqueOrgs:[...new Set(hours.map(h=>h.orgName))].length,
      totalEvents:hours.length
    });
  }
  if (method==='PATCH' && p==='/api/portfolio/visibility') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const idx = DB.users.findIndex(u=>u.id===user.id);
    DB.users[idx].portfolioPublic = !!body.public;
    saveDB();
    return json(res,{portfolioPublic:DB.users[idx].portfolioPublic});
  }

  // ══════════════════════════════════════════
  // IMPACT DASHBOARD
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/impact') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const hours = DB.hours.filter(h=>h.userId===user.id&&h.status==='verified');
    const totalHours = Math.round(hours.reduce((s,h)=>s+h.hours,0)*100)/100;
    // Hours by month
    const byMonth = {};
    hours.forEach(h=>{ const d=new Date(h.startTime); const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); byMonth[k]=Math.round(((byMonth[k]||0)+h.hours)*100)/100; });
    // Hours by category
    const byCat = {};
    hours.forEach(h=>{ const opp=IDX().oppById.get(h.oppId); const cat=opp?.category||'Other'; byCat[cat]=Math.round(((byCat[cat]||0)+h.hours)*100)/100; });
    // Streak (consecutive weeks with activity)
    const weekSet = new Set();
    hours.forEach(h=>{ const d=new Date(h.startTime); const w=Math.floor(d.getTime()/(7*864e5)); weekSet.add(w); });
    const weeks = [...weekSet].sort((a,b)=>b-a);
    let currentStreak=0;
    if (weeks.length) { const nowWeek=Math.floor(Date.now()/(7*864e5)); for(let i=0;i<weeks.length;i++) { if(weeks[i]===nowWeek-i) currentStreak++; else break; } }
    let longestStreak=0,run=0;
    for(let i=0;i<weeks.length;i++) { if(i===0||weeks[i]===weeks[i-1]-1) { run++; longestStreak=Math.max(longestStreak,run); } else run=1; }
    // Percentile
    const allStudents = DB.users.filter(u=>u.role==='student');
    const studentHours = allStudents.map(s=>DB.hours.filter(h=>h.userId===s.id&&h.status==='verified').reduce((sum,h)=>sum+h.hours,0));
    const rank = studentHours.filter(h=>h<totalHours).length;
    const percentile = allStudents.length>1?Math.round(rank/(allStudents.length-1)*100):100;
    return json(res,{
      hoursByMonth:Object.entries(byMonth).map(([month,hours])=>({month,hours})).sort((a,b)=>a.month.localeCompare(b.month)),
      hoursByCategory:Object.entries(byCat).map(([category,hours])=>({category,hours})).sort((a,b)=>b.hours-a.hours),
      currentStreak, longestStreak, percentileRank:percentile,
      totalOrgs:[...new Set(hours.map(h=>h.orgName))].length,
      totalEvents:hours.length, totalHours
    });
  }

  // ══════════════════════════════════════════
  // RECOMMENDATIONS
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/recommendations') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    let opps = DB.opportunities.filter(o=>o.active);
    const myApps = idxList(IDX().appsByUser,user.id);
    const appliedIds = myApps.map(a=>a.oppId);
    opps = opps.filter(o=>!appliedIds.includes(o.id));
    const pastCommit = myApps.filter(a=>a.status==='approved').map(a=>IDX().oppById.get(a.oppId)?.commitment).filter(Boolean);
    opps = opps.map(o=>{
      let score=0;
      (o.skills||[]).forEach(s=>{ if((user.skills||[]).includes(s)) score+=3; });
      if((user.causes||[]).includes(o.category)) score+=2;
      if(pastCommit.includes(o.commitment)) score+=1;
      return {...publicOpp(o), matchScore:score};
    }).filter(o=>o.matchScore>0).sort((a,b)=>b.matchScore-a.matchScore).slice(0,6);
    return json(res,opps);
  }

  // ══════════════════════════════════════════
  // SAVED SEARCHES
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/saved-searches') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    return json(res,user.savedSearches||[]);
  }
  if (method==='POST' && p==='/api/saved-searches') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    if ((user.savedSearches||[]).length>=10) return json(res,{error:'Max 10 saved searches'},400);
    const ss = { id:uid(), name:body.name||'My Search', query:body.query||'', category:body.category||'', commitment:body.commitment||'', format:body.format||'', zip:body.zip||'', miles:body.miles||'', createdAt:iso() };
    const idx = DB.users.findIndex(u=>u.id===user.id);
    if (!DB.users[idx].savedSearches) DB.users[idx].savedSearches=[];
    DB.users[idx].savedSearches.push(ss);
    saveDB();
    return json(res,ss,201);
  }
  const ssDelete = p.match(/^\/api\/saved-searches\/([^/]+)$/);
  if (method==='DELETE' && ssDelete) {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const idx = DB.users.findIndex(u=>u.id===user.id);
    DB.users[idx].savedSearches = (DB.users[idx].savedSearches||[]).filter(s=>s.id!==ssDelete[1]);
    saveDB();
    return json(res,{ok:true});
  }

  // AWARDS helper
  if (method==='GET' && p==='/api/awards') {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const verifiedHours = DB.hours.filter(h=>h.userId===user.id&&h.status==='verified').reduce((s,h)=>s+h.hours,0);
    const allHours = idxList(IDX().hoursByUser,user.id).reduce((s,h)=>s+h.hours,0);
    return json(res, AWARDS.map(a=>({
      ...a,
      progress: Math.min(100,Math.round(verifiedHours/a.hours*100)),
      achieved: verifiedHours>=a.hours,
      verifiedHours: Math.round(verifiedHours*100)/100,
      allHours: Math.round(allHours*100)/100,
      allProgress: Math.min(100,Math.round(allHours/a.hours*100))
    })));
  }

  // ══════════════════════════════════════════
  // GDPR / PII — data access & portability (right to access, Art. 15 & 20)
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/account/export') {
    if (!user) return json(res,{error:'Unauthorized'},401);
    const me = safeUser(IDX().userById.get(user.id));
    const mine = {
      exportedAt: iso(),
      account: me,
      applications: idxList(IDX().appsByUser,user.id),
      hours: idxList(IDX().hoursByUser,user.id),
      reviews: DB.reviews.filter(r=>r.userId===user.id),
      endorsements: idxList(IDX().endorsementsByUser,user.id),
      notifications: idxList(IDX().notifsByUser,user.id),
      messages: DB.messages.filter(m=>m.senderId===user.id),
    };
    if (user.role==='org') {
      mine.opportunities = idxList(IDX().oppsByOrg,user.orgId);
    }
    appendAudit(user.id,'account.data_export',''); saveDB();
    return json(res, mine, 200, {
      'Content-Disposition':'attachment; filename="servelocal-my-data.json"',
      'Cache-Control':'no-store',
    });
  }

  // ══════════════════════════════════════════
  // BILLING (org plans — demo checkout until Stripe is configured)
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/billing/plans') {
    return json(res,{plans:Object.values(PLANS)});
  }
  if (method==='GET' && p==='/api/billing/me') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const plan = orgPlan(user);
    return json(res,{
      plan:plan.id, planName:plan.name, price:plan.price,
      activeListings: DB.opportunities.filter(o=>o.orgId===user.orgId&&o.active).length,
      maxActiveListings: plan.maxActiveListings,
      featuredListings: DB.opportunities.filter(o=>o.orgId===user.orgId&&o.featured).length,
      maxFeatured: plan.maxFeatured,
      rosterExport: plan.rosterExport,
      demo: !!user.planDemo
    });
  }
  if (method==='POST' && p==='/api/billing/upgrade') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    // DEMO checkout — replace with a Stripe Checkout session in production (DEPLOY.txt §9)
    user.plan = 'pro'; user.planSince = iso(); user.planDemo = true;
    appendAudit(user.id,'billing.upgrade','',{plan:'pro',demo:true});
    saveDB();
    return respond(res,{plan:'pro',demo:true,message:'Upgraded to ServeLocal Pro (demo checkout — no payment was collected).'});
  }
  if (method==='POST' && p==='/api/billing/downgrade') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    user.plan = 'free';
    DB.opportunities.filter(o=>o.orgId===user.orgId&&o.featured).forEach(o=>o.featured=false);
    appendAudit(user.id,'billing.downgrade','',{plan:'free'});
    saveDB();
    return respond(res,{plan:'free'});
  }

  // PATCH /api/opportunities/:id/feature  (Pro orgs pin listings to top of search)
  const featMatch = p.match(/^\/api\/opportunities\/([^/]+)\/feature$/);
  if (method==='PATCH' && featMatch) {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const opp = ownedOpp(featMatch[1], user.orgId);
    if (!opp) return json(res,{error:'Not found'},404);
    const plan = orgPlan(user);
    const want = !!body.featured;
    if (want) {
      if (!plan.maxFeatured) return json(res,{error:'Featured listings are a ServeLocal Pro feature.',code:'PRO_REQUIRED'},403);
      const cnt = DB.opportunities.filter(o=>o.orgId===user.orgId&&o.featured).length;
      if (cnt>=plan.maxFeatured) return json(res,{error:'Pro includes '+plan.maxFeatured+' featured listings at a time. Unfeature one first.'},400);
    }
    opp.featured = want;
    saveDB();
    return json(res,opp);
  }

  // POST /api/opportunities/:id/view  (lightweight view counter for org analytics)
  const viewMatch = p.match(/^\/api\/opportunities\/([^/]+)\/view$/);
  if (method==='POST' && viewMatch) {
    const opp = IDX().oppById.get(viewMatch[1]);
    if (opp) { opp.views = (opp.views||0)+1; saveDB(); }
    return json(res,{ok:true});
  }

  // ══════════════════════════════════════════
  // WAITLIST (one-time events only)
  // ══════════════════════════════════════════
  const wlMatch = p.match(/^\/api\/opportunities\/([^/]+)\/waitlist$/);
  if (method==='POST' && wlMatch) {
    if (!user||user.role!=='student') return json(res,{error:'Must be logged in as student'},401);
    const opp = IDX().oppById.get(wlMatch[1]);
    if (!opp || !opp.active) return json(res,{error:'Opportunity not found'},404);
    if (opp.commitment==='Weekly'||opp.commitment==='Monthly')
      return json(res,{error:'Waitlists are only available for one-time events'},400);
    if (new Date(opp.endTime||opp.startTime) < new Date())
      return json(res,{error:'This event has already ended'},400);
    if ((opp.spotsRemaining||0)>0) return json(res,{error:'Spots are available — sign up directly'},400);
    if (DB.applications.find(a=>a.oppId===opp.id&&a.userId===user.id))
      return json(res,{error:'You already have a signup or waitlist spot for this event'},409);
    const app = {
      id:uid(), oppId:opp.id, oppTitle:opp.title, orgName:opp.orgName,
      userId:user.id, userName:`${user.firstName} ${user.lastName}`, userEmail:user.email,
      status:'waitlisted', type:'waitlist', singleDate:null, excludedDates:[],
      reminder24h:false, reminder1h:false, createdAt:iso()
    };
    DB.applications.push(app);
    saveDB();
    const position = DB.applications.filter(a=>a.oppId===opp.id&&a.status==='waitlisted').length;
    return respond(res,{application:app, position},201);
  }
  if (method==='DELETE' && wlMatch) {
    if (!user||user.role!=='student') return json(res,{error:'Unauthorized'},401);
    const idx = DB.applications.findIndex(a=>a.oppId===wlMatch[1]&&a.userId===user.id&&a.status==='waitlisted');
    if (idx===-1) return json(res,{error:'Not on the waitlist'},404);
    DB.applications.splice(idx,1);
    saveDB();
    return json(res,{success:true});
  }

  // ══════════════════════════════════════════
  // SAVED OPPORTUNITIES (student bookmarks)
  // ══════════════════════════════════════════
  const saveOppMatch = p.match(/^\/api\/saved-opps\/([^/]+)$/);
  if (method==='PATCH' && saveOppMatch) {
    if (!user||user.role!=='student') return json(res,{error:'Must be logged in as student'},401);
    const idx = DB.users.findIndex(u=>u.id===user.id);
    if (!DB.users[idx].savedOpps) DB.users[idx].savedOpps=[];
    const oid = saveOppMatch[1];
    const pos = DB.users[idx].savedOpps.indexOf(oid);
    let saved;
    if (pos===-1) { DB.users[idx].savedOpps.push(oid); saved=true; }
    else { DB.users[idx].savedOpps.splice(pos,1); saved=false; }
    saveDB();
    return json(res,{saved, savedOpps:DB.users[idx].savedOpps});
  }

  // ══════════════════════════════════════════
  // EVENT CHECK-IN CODES (instant verified hours at the event)
  // ══════════════════════════════════════════

  // POST /api/opportunities/:id/checkin-code — org generates/reuses a code for a date
  const ccMatch = p.match(/^\/api\/opportunities\/([^/]+)\/checkin-code$/);
  if (method==='POST' && ccMatch) {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const opp = ownedOpp(ccMatch[1], user.orgId);
    if (!opp) return json(res,{error:'Not found'},404);
    const dateStr = (body.date||new Date().toISOString()).slice(0,10);
    if (!opp.checkinCodes) opp.checkinCodes={};
    let entry = opp.checkinCodes[dateStr];
    if (!entry || entry.expiresAt < Date.now()) {
      const chars='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L
      let code=''; for (let i=0;i<6;i++) code+=chars[crypto.randomInt(chars.length)];
      entry = { code, expiresAt: Date.now()+12*36e5 };
      opp.checkinCodes[dateStr]=entry;
      appendAudit(user.id,'checkin.code_generated',opp.id,{date:dateStr});
      saveDB();
    }
    return json(res,{code:entry.code, date:dateStr, expiresAt:entry.expiresAt});
  }

  // POST /api/checkin — student redeems a code -> instantly verified hours
  if (method==='POST' && p==='/api/checkin') {
    if (!user||user.role!=='student') return json(res,{error:'Must be logged in as student'},401);
    const consentBlock = requireGuardianConsent(user);
    if (consentBlock) return json(res,consentBlock,403);
    const code = String(body.code||'').trim().toUpperCase();
    if (!code) return json(res,{error:'Code required'},400);
    let opp=null, dateStr=null;
    for (const o of DB.opportunities) {
      for (const [d,e] of Object.entries(o.checkinCodes||{})) {
        if (e.code===code && e.expiresAt>=Date.now()) { opp=o; dateStr=d; break; }
      }
      if (opp) break;
    }
    if (!opp) return json(res,{error:'Invalid or expired check-in code'},404);
    const app = DB.applications.find(a=>a.oppId===opp.id&&a.userId===user.id&&a.status==='approved');
    if (!app) return json(res,{error:'You need an approved signup for "'+opp.title+'" before checking in.'},400);
    const durHrs = opp.durationHours || (opp.endTime?(new Date(opp.endTime)-new Date(opp.startTime))/36e5:0);
    if (durHrs<=0) return json(res,{error:'This event has no duration set'},400);
    const autoKey = `auto:${user.id}:${opp.id}:${dateStr}`;
    let entry = DB.hours.find(h=>h.autoKey===autoKey);
    if (entry && entry.status==='verified') return json(res,{error:'Already checked in for this date'},409);
    if (entry) {
      entry.status='verified';
      entry.supervisorName = opp.orgName+' (event check-in)';
    } else {
      const occStart = new Date(dateStr+'T'+new Date(opp.startTime).toISOString().split('T')[1]);
      const occEnd = new Date(occStart.getTime()+durHrs*36e5);
      entry = {
        id:uid(), userId:user.id, oppId:opp.id,
        orgName:opp.orgName, activity:opp.title,
        startTime:occStart.toISOString(), endTime:occEnd.toISOString(),
        hours:Math.round(durHrs*100)/100,
        status:'verified', supervisorName:opp.orgName+' (event check-in)',
        notes:'Checked in with event code', appeal:null, appealNote:'', autoKey, createdAt:iso()
      };
      DB.hours.push(entry);
    }
    saveDB();
    appendAudit(user.id,'checkin.redeemed',opp.id,{date:dateStr,hours:entry.hours});
    return respond(res,{activity:opp.title, hours:entry.hours, date:dateStr});
  }

  // ══════════════════════════════════════════
  // ORG ANALYTICS & PRODUCTIVITY
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/org/analytics') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const opps = idxList(IDX().oppsByOrg,user.orgId);
    const perListing = opps.map(o=>{
      const apps = DB.applications.filter(a=>a.oppId===o.id);
      const approved = apps.filter(a=>a.status==='approved').length;
      const vh = Math.round(DB.hours.filter(h=>h.oppId===o.id&&h.status==='verified').reduce((s,h)=>s+h.hours,0)*100)/100;
      const fillRate = o.spotsAvailable ? Math.min(100,Math.round(approved/o.spotsAvailable*100)) : 0;
      return { id:o.id, title:o.title, active:o.active, featured:!!o.featured,
               views:o.views||0, applicants:apps.length, approved, fillRate, verifiedHours:vh };
    }).sort((a,b)=>b.views-a.views);
    const oppIds = opps.map(o=>o.id);
    const allApps = DB.applications.filter(a=>oppIds.includes(a.oppId));
    const byMonth = {};
    allApps.forEach(a=>{ const k=a.createdAt.slice(0,7); byMonth[k]=(byMonth[k]||0)+1; });
    const perStudent = {};
    allApps.filter(a=>a.status==='approved').forEach(a=>{ perStudent[a.userId]=(perStudent[a.userId]||0)+1; });
    return json(res,{
      plan: orgPlan(user).id,
      perListing,
      totals:{
        views: perListing.reduce((s,l)=>s+l.views,0),
        applicants: allApps.length,
        approved: allApps.filter(a=>a.status==='approved').length,
        verifiedHours: Math.round(perListing.reduce((s,l)=>s+l.verifiedHours,0)*100)/100,
        avgFillRate: perListing.length ? Math.round(perListing.reduce((s,l)=>s+l.fillRate,0)/perListing.length) : 0,
        repeatVolunteers: Object.values(perStudent).filter(c=>c>1).length
      },
      appsByMonth: Object.entries(byMonth).map(([month,count])=>({month,count})).sort((a,b)=>a.month.localeCompare(b.month)).slice(-6)
    });
  }

  // PATCH /api/hours/bulk-verify  (org verifies all pending entries at once)
  if (method==='PATCH' && p==='/api/hours/bulk-verify') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    const orgOppIds = idxList(IDX().oppsByOrg,user.orgId).map(o=>o.id);
    const pending = DB.hours.filter(h=>h.status==='pending'&&h.oppId&&orgOppIds.includes(h.oppId));
    pending.forEach(h=>{
      h.status = 'verified';
      h.supervisorName = user.orgName;
      createNotification(h.userId,'hours_verified','Hours Verified',h.hours+' hours for "'+h.activity+'" have been verified.','dash');
    });
    if (pending.length) saveDB();
    return json(res,{verified:pending.length});
  }

  // GET /api/org/volunteers  (roster export — Pro feature)
  if (method==='GET' && p==='/api/org/volunteers') {
    if (!user||user.role!=='org') return json(res,{error:'Unauthorized'},401);
    if (!orgPlan(user).rosterExport)
      return json(res,{error:'Volunteer roster export is a ServeLocal Pro feature.',code:'PRO_REQUIRED'},403);
    const oppIds = idxList(IDX().oppsByOrg,user.orgId).map(o=>o.id);
    const rows = DB.applications.filter(a=>oppIds.includes(a.oppId)).map(a=>{
      const vh = Math.round(DB.hours.filter(h=>h.userId===a.userId&&h.oppId===a.oppId&&h.status==='verified').reduce((s,h)=>s+h.hours,0)*100)/100;
      return { name:a.userName, email:a.userEmail, opportunity:a.oppTitle||'', status:a.status, signedUp:(a.createdAt||'').slice(0,10), verifiedHours:vh };
    });
    return json(res,{rows});
  }

  // ══════════════════════════════════════════
  // COMMUNITY LEADERBOARD (public — first name + last initial only)
  // ══════════════════════════════════════════
  if (method==='GET' && p==='/api/leaderboard') {
    const lbCached = cacheGet('leaderboard');
    if (lbCached) return json(res, lbCached);
    const students = DB.users.filter(u=>u.role==='student');
    const topVolunteers = students.map(s=>{
      const vh = DB.hours.filter(h=>h.userId===s.id&&h.status==='verified');
      const total = Math.round(vh.reduce((a,h)=>a+h.hours,0)*100)/100;
      const last30 = Math.round(vh.filter(h=>(Date.now()-new Date(h.startTime))<30*864e5).reduce((a,h)=>a+h.hours,0)*100)/100;
      return {
        name:(s.firstName||'')+' '+((s.lastName||'')[0]?s.lastName[0]+'.':''),
        school:s.school||'', hours:total, last30, events:vh.length,
        awards:AWARDS.filter(a=>total>=a.hours).length
      };
    }).filter(r=>r.hours>0).sort((a,b)=>b.hours-a.hours).slice(0,10);
    const schools = {};
    students.forEach(s=>{
      if (!s.school) return;
      const vh = DB.hours.filter(h=>h.userId===s.id&&h.status==='verified').reduce((a,h)=>a+h.hours,0);
      if (!schools[s.school]) schools[s.school]={school:s.school,hours:0,students:0};
      schools[s.school].hours = Math.round((schools[s.school].hours+vh)*100)/100;
      if (vh>0) schools[s.school].students++;
    });
    return json(res,{
      topVolunteers,
      topSchools: Object.values(schools).filter(s=>s.hours>0).sort((a,b)=>b.hours-a.hours).slice(0,5),
      community:{
        totalHours: Math.round(DB.hours.filter(h=>h.status==='verified').reduce((a,h)=>a+h.hours,0)*100)/100,
        students: students.length,
        orgs: DB.users.filter(u=>u.role==='org'&&u.adminApproved).length,
        events: DB.hours.filter(h=>h.status==='verified').length
      }
    });
  }

  // ══════════════════════════════════════════
  // DONATIONS (supporters keep ServeLocal free for students — demo until Stripe)
  // ══════════════════════════════════════════
  if (method==='POST' && p==='/api/donations') {
    const amount = Number(body.amount);
    if (!amount||amount<1||amount>10000) return json(res,{error:'Donation must be between $1 and $10,000'},400);
    // DEMO — replace with a Stripe Checkout session in production (DEPLOY.txt §9)
    const don = {
      id:uid(), amount:Math.round(amount*100)/100,
      name:sstr(body.name,60)||'Anonymous',
      message:sstr(body.message,200),
      demo:true, createdAt:iso()
    };
    DB.donations.push(don);
    appendAudit(user?user.id:'anonymous','donation.created','',{amount:don.amount,demo:true});
    saveDB();
    return respond(res,{ok:true,demo:true},201); // Idempotency-Key prevents double-charge on retry
  }
  if (method==='GET' && p==='/api/donations/stats') {
    return json(res,{
      totalRaised: Math.round(DB.donations.reduce((s,d)=>s+d.amount,0)*100)/100,
      donorCount: DB.donations.length,
      recent: DB.donations.slice(-6).reverse().map(d=>({name:d.name,amount:d.amount,message:d.message}))
    });
  }

  json(res,{error:'Not found'},404);
}

// ── BACKGROUND WORK ───────────────────────────
// Reminders + hours-verification sweeps are scheduled in startBackgroundJobs()
// (defined below the router). promptOrgToVerify is the shared helper they call.
function promptOrgToVerify(opp, dateStr){
  // Find the org user
  const orgUser = IDX().userByOrgId.get(opp.orgId);
  if(!orgUser) return;
  // Find approved attendees for this event/date
  const approvedApps = DB.applications.filter(a=>a.oppId===opp.id&&a.status==='approved');
  const attendees = [];
  const durHrs = opp.durationHours || (opp.endTime?(new Date(opp.endTime)-new Date(opp.startTime))/36e5:0);
  if(durHrs<=0) return;

  for(const app of approvedApps){
    const student = IDX().userById.get(app.userId);
    if(!student) continue;
    const appType = app.type||'subscription';

    if(dateStr){
      // Recurring: check if student is attending this specific date
      if(appType==='single-date'){
        if(app.singleDate?.slice(0,10)!==dateStr) continue;
      } else {
        // subscription — check not excluded
        if((app.excludedDates||[]).some(d=>d.slice(0,10)===dateStr)) continue;
      }
    }

    // Create a pending hour entry for the student (if not already exists)
    const autoKey = `auto:${app.userId}:${opp.id}:${dateStr||new Date(opp.startTime).toISOString().slice(0,10)}`;
    if(DB.hours.some(h=>h.autoKey===autoKey)) continue;

    const occDateStr = dateStr || new Date(opp.startTime).toISOString().slice(0,10);
    const occStart = new Date(occDateStr+'T'+new Date(opp.startTime).toISOString().split('T')[1]);
    const occEnd = new Date(occStart.getTime()+durHrs*36e5);

    DB.hours.push({
      id:uid(), userId:app.userId, oppId:opp.id,
      orgName:opp.orgName, activity:opp.title,
      startTime:occStart.toISOString(), endTime:occEnd.toISOString(),
      hours:Math.round(durHrs*100)/100,
      status:'pending', supervisorName:'—', notes:'',
      appeal:null, appealNote:'', autoKey, createdAt:iso()
    });
    attendees.push(student.firstName+' '+student.lastName);
  }

  if(attendees.length>0){
    const dateLabel = dateStr
      ? new Date(dateStr+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
      : new Date(opp.startTime).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    createNotification(
      orgUser.id, 'hours_verification_needed', 'Hours Need Verification',
      '"'+opp.title+'" ('+dateLabel+') has ended. '+attendees.length+' volunteer'+(attendees.length>1?'s':'')+' attended — please verify their hours.',
      'org-hours'
    );
  }
}

// ── DATA RETENTION PURGE (PII minimisation) ───
// Runs hourly. Deletes data past its retention window so we don't hold PII or
// derived records longer than needed (documented in docs/data-retention.md).
function retentionPurge() {
  const now = Date.now();
  let changed = false;
  const before = {
    notif: DB.notifications.length, reports: DB.reports.length,
  };
  // Read notifications older than 90 days
  DB.notifications = DB.notifications.filter(n => !(n.read && (now - new Date(n.createdAt)) > 90*864e5));
  // Resolved reports older than 1 year
  DB.reports = DB.reports.filter(r => !(r.status !== 'open' && (now - new Date(r.createdAt)) > 365*864e5));
  // Expired event check-in codes
  DB.opportunities.forEach(o => {
    if (!o.checkinCodes) return;
    for (const [d, e] of Object.entries(o.checkinCodes)) {
      if (e.expiresAt < now - 24*36e5) { delete o.checkinCodes[d]; changed = true; }
    }
  });
  if (before.notif !== DB.notifications.length || before.reports !== DB.reports.length) changed = true;
  if (changed) saveDB();
}

function startBackgroundJobs() {
  // Event reminders — every 15 minutes
  setInterval(()=>{
    const now=Date.now();
    let changed=false;
    DB.applications.filter(a=>a.status==='approved').forEach(a=>{
      const opp=IDX().oppById.get(a.oppId);
      if(!opp) return;
      const until=new Date(opp.startTime).getTime()-now;
      if(until>0&&until<=24*36e5&&!a.reminder24h){
        a.reminder24h=true; changed=true;
        createNotification(a.userId,'event_reminder_24h','Event Tomorrow','"'+opp.title+'" starts in ~24 hours.','dash');
      }
      if(until>0&&until<=1*36e5&&!a.reminder1h){
        a.reminder1h=true; changed=true;
        createNotification(a.userId,'event_reminder_1h','Starting Soon!','"'+opp.title+'" starts in ~1 hour!','dash');
      }
    });
    if(changed) saveDB();
  },15*60*1000).unref?.();

  // Hours verification prompts — every 30 minutes
  setInterval(()=>{ try { hoursVerificationSweep(); } catch(e){ console.error('verify sweep:',e.message); } },30*60*1000).unref?.();

  // Backups (RPO ≈ 30 min) + retention purge — every 30 / 60 minutes
  setInterval(()=>{ backupSnapshot(); },30*60*1000).unref?.();
  setInterval(()=>{ try { retentionPurge(); } catch(e){ console.error('retention purge:',e.message); } },60*60*1000).unref?.();
}

function hoursVerificationSweep() {
  const now=Date.now();
  let changed=false;
  DB.opportunities.forEach(opp=>{
    if(!opp.active) return;
    const isRecurring = opp.commitment==='Weekly'||opp.commitment==='Monthly';
    if(!isRecurring){
      if(!opp.endTime) return;
      const endMs = new Date(opp.endTime).getTime();
      if(now>endMs && now<endMs+6*36e5 && !opp.hoursVerificationPrompted){
        opp.hoursVerificationPrompted = true; changed = true;
        promptOrgToVerify(opp, null);
      }
      return;
    }
    if(!opp._verifiedDates) opp._verifiedDates=[];
    const origin = new Date(opp.startTime);
    const durMs = opp.endTime ? (new Date(opp.endTime)-origin) : 0;
    let cur = new Date(origin);
    let safety=0;
    while(safety++<500){
      const occEnd = new Date(cur.getTime()+durMs);
      const occEndMs = occEnd.getTime();
      const ds = cur.toISOString().slice(0,10);
      if(occEndMs>now) break;
      if(now<occEndMs+6*36e5 && !opp._verifiedDates.includes(ds)){
        opp._verifiedDates.push(ds); changed=true;
        promptOrgToVerify(opp, ds);
      }
      if(opp.commitment==='Weekly') cur.setDate(cur.getDate()+7);
      else cur.setMonth(cur.getMonth()+1);
    }
  });
  if(changed) saveDB();
}

function buildServer() {
  const handler = (req,res)=>{
    router(req,res).catch(err=>{
      console.error('Router error:',err.message);
      if(!res.headersSent){ res.writeHead(500,{'Content-Type':'application/json',...securityHeaders()}); res.end(JSON.stringify({error:'Internal server error'})); }
    });
  };
  // Optional HTTPS when certs are configured (cert rotation = swap files + restart;
  // in managed hosting TLS is terminated at the proxy — see docs/disaster-recovery.md).
  if (process.env.SSL_CERT && process.env.SSL_KEY && fs.existsSync(process.env.SSL_CERT) && fs.existsSync(process.env.SSL_KEY)) {
    return https.createServer({ cert: fs.readFileSync(process.env.SSL_CERT), key: fs.readFileSync(process.env.SSL_KEY) }, handler);
  }
  return http.createServer(handler);
}

function start() {
  loadDB();
  backupSnapshot();        // snapshot on boot
  startBackgroundJobs();
  const server = buildServer();
  server.listen(PORT,()=>{
    const proto = (process.env.SSL_CERT && process.env.SSL_KEY) ? 'https' : 'http';
    console.log(`\n🚀 ServeLocal running at ${proto}://localhost:${PORT}  (${NODE_ENV})`);
    // Never print credentials in production logs (they may be shipped to log aggregators).
    if (!IS_PROD) {
      console.log(` Demo logins:`);
      console.log(`  Student : alex@student.edu     / demo1234`);
      console.log(`  Org     : contact@greenroots.org / demo1234`);
      console.log(`  Admin   : ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}\n`);
    }
  });
  // Graceful shutdown: flush DB and close listeners.
  const shutdown = (sig)=>{ console.log(`\n${sig} — flushing DB and shutting down`); try{ saveDB(); }catch{} server.close(()=>process.exit(0)); setTimeout(()=>process.exit(0),3000).unref?.(); };
  process.on('SIGTERM',()=>shutdown('SIGTERM'));
  process.on('SIGINT',()=>shutdown('SIGINT'));
  return server;
}

// Only auto-start when run directly; when required (tests) the caller controls lifecycle.
if (require.main === module) {
  start();
}

module.exports = {
  start, buildServer, router, loadDB, saveDB, seedDB, backupSnapshot, restoreFromBackup, retentionPurge,
  appendAudit, verifyAuditChain, makeToken, verifyToken, hashPassword, hashPasswordScrypt, verifyPassword, setPassword, weakPassword, publicOpp, sstr, clampNum, isEmail,
  calcHours, isValidOccurrence, nextOccurrenceAfter, orgPlan, rateLimit, makeBreaker,
  IDX, idxList, bumpCache,
  get DB(){ return DB; }, set DB(v){ DB = v; },
  PLANS, AWARDS,
};
