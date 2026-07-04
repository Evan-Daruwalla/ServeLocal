#!/usr/bin/env node
// Large-database load test. Unlike scripts/loadtest.js (which uses the small demo
// seed), this spawns the real server against a synthetic N-user db.json with the
// per-IP rate limiter lifted, so it measures the ENDPOINTS at scale rather than the
// limiter (a single-IP loadtest otherwise just measures rate-limiting). Drives the
// three read endpoints the ADR-0012 optimizations target and reports throughput +
// latency percentiles + a single-shot (uncontended) read per endpoint.
//
//   npm run loadtest:scale                    # 10k users, 3000 reqs @ 50
//   USERS=50000 npm run loadtest:scale 5000 100
//
// Zero-dependency, standalone; never touches the real db.json. One dev machine —
// real end-to-end HTTP, but not a distributed benchmark.
const { spawn } = require('node:child_process');
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs'); const crypto = require('node:crypto');

const USERS = Number(process.env.USERS) || 10000;
const TOTAL = Number(process.argv[2]) || 3000;
const CONCURRENCY = Number(process.argv[3]) || 50;
const PORT = Number(process.env.PORT) || 3997;
const base = 'http://127.0.0.1:' + PORT;
const ENDPOINTS = ['/api/opportunities', '/api/stats', '/api/leaderboard'];
const pct = (s, p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];

// ── synthetic corpus (scales off USERS) ────────────────────────────
function buildDB() {
  const S = Math.round(USERS * 0.85), O = USERS - S, OPPS = Math.round(USERS * 0.3);
  const APPS = USERS * 8, HRS = USERS * 12, NOT = USERS * 15, MSG = USERS * 5, REV = Math.round(USERS * 0.5);
  const rid = (p, i) => p + i, ISO = '2026-05-01T12:00:00.000Z';
  const DB = { users: [], opportunities: [], applications: [], hours: [], notifications: [], messages: [], reviews: [], reports: [], endorsements: [], donations: [], verificationTokens: [], auditLog: [] };
  for (let i = 0; i < S; i++) DB.users.push({ id: rid('u', i), role: 'student', email: 'student' + i + '@example.edu', firstName: 'First' + i, lastName: 'Last' + i, school: 'School ' + (i % 400), dob: '2008-01-01', passwordHash: 'x', savedOpps: [], createdAt: ISO, adminApproved: true });
  for (let i = 0; i < O; i++) DB.users.push({ id: rid('u', S + i), role: 'org', orgId: rid('org', i), orgName: 'Organization ' + i, email: 'org' + i + '@example.org', passwordHash: 'x', adminApproved: true, plan: i % 5 === 0 ? 'pro' : 'free', createdAt: '2024-06-01T00:00:00.000Z' });
  for (let i = 0; i < OPPS; i++) DB.opportunities.push({ id: rid('o', i), orgId: rid('org', i % Math.max(1, O)), orgName: 'Organization ' + (i % Math.max(1, O)), title: 'Volunteer Opportunity ' + i, description: 'A meaningful community service role. '.repeat(3), category: 'Environment', skills: ['Teamwork'], commitment: 'One-time', active: true, featured: i % 20 === 0, views: i % 500, spotsAvailable: 20, startTime: ISO, endTime: ISO, lat: 41 + (i % 100) / 100, lng: -87 - (i % 100) / 100, checkinCodes: {} });
  for (let i = 0; i < APPS; i++) DB.applications.push({ id: rid('a', i), userId: rid('u', i % S), oppId: rid('o', i % OPPS), status: ['pending', 'approved', 'approved', 'waitlisted'][i % 4], type: 'single-date', createdAt: ISO, resolvedAt: i % 2 ? ISO : null });
  for (let i = 0; i < HRS; i++) DB.hours.push({ id: rid('h', i), userId: rid('u', i % S), oppId: rid('o', i % OPPS), hours: 2 + (i % 4), status: ['verified', 'verified', 'pending'][i % 3], startTime: ISO, autoKey: 'a:' + i });
  for (let i = 0; i < NOT; i++) DB.notifications.push({ id: rid('n', i), userId: rid('u', i % S), type: 't', title: 'T', message: 'M', link: 'dash', read: i % 3 === 0, createdAt: ISO });
  for (let i = 0; i < MSG; i++) DB.messages.push({ id: rid('m', i), oppId: rid('o', i % OPPS), senderId: rid('u', i % USERS), text: 'hi', createdAt: ISO });
  for (let i = 0; i < REV; i++) DB.reviews.push({ id: rid('r', i), orgId: rid('org', i % Math.max(1, O)), userId: rid('u', i % S), rating: 3 + (i % 3), text: 'great', createdAt: ISO });
  return DB;
}

(async () => {
  const tmp = path.join(os.tmpdir(), 'servelocal-scale-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(tmp, { recursive: true });
  const dbFile = path.join(tmp, 'db.json');

  console.log(`Building ${USERS.toLocaleString()}-user corpus…`);
  const DB = buildDB();
  let mb;
  try {
    fs.writeFileSync(dbFile, JSON.stringify(DB)); // may exceed V8's ~512MB max string length
    mb = fs.statSync(dbFile).size / 1e6;
  } catch (e) {
    console.error('\n*** Could not serialise the DB at ' + USERS.toLocaleString() + ' users: ' + e.message);
    console.error('This is the ADR-0002 / ADR-0012 ceiling: the whole DB is one JSON string, and V8 caps');
    console.error('a string at ~512 MB (~0.5 GB). Beyond that the app cannot even write OR load db.json —');
    console.error('the file-JSON store must become an on-disk DB (node:sqlite) first. See docs/adr/0012.');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    process.exit(2);
  }
  console.log(`DB: ${mb.toFixed(1)} MB. Spawning server (rate-limit lifted)…`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile, BACKUP_DIR: path.join(tmp, 'backups'), JWT_SECRET: 'scale-' + crypto.randomBytes(6).toString('hex'), NODE_ENV: 'development', RL_READ_CAP: '100000000', RL_WRITE_CAP: '100000000' },
    stdio: 'ignore',
  });
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* noop */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } };

  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) { try { const r = await fetch(base + '/api/health'); if (r.ok) { ready = true; break; } } catch { /* retry */ } await new Promise(r => setTimeout(r, 250)); }
  if (!ready) { console.error('Server did not become ready (a >512 MB DB fails to load — see ADR-0012).'); kill(); process.exit(2); }

  for (const e of ENDPOINTS) { try { await fetch(base + e); } catch { /* warm */ } } // warm indexes/caches

  const lat = []; let ok = 0, err = 0, rl = 0, done = 0, bytes = 0;
  const t0 = Date.now();
  async function worker() {
    while (true) {
      const i = done++; if (i >= TOTAL) break;
      const s = performance.now();
      try { const r = await fetch(base + ENDPOINTS[i % ENDPOINTS.length]); bytes += (await r.arrayBuffer()).byteLength; lat.push(performance.now() - s); if (r.status === 429) rl++; else if (r.ok) ok++; else err++; }
      catch { err++; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const mean = lat.reduce((a, b) => a + b, 0) / lat.length;

  const solo = {};
  for (const e of ENDPOINTS) { const s = performance.now(); const r = await fetch(base + e); await r.arrayBuffer(); solo[e] = performance.now() - s; }

  console.log(`\n── ${USERS.toLocaleString()} users · ${mb.toFixed(0)} MB · ${TOTAL} reqs @ concurrency ${CONCURRENCY} ──`);
  console.log(`Throughput      : ${(TOTAL / elapsed).toFixed(0)} req/s   (${elapsed.toFixed(1)} s)`);
  console.log(`OK / RateLtd / Err : ${ok} / ${rl} / ${err}`);
  console.log(`Resp bytes      : ${(bytes / 1e6).toFixed(0)} MB`);
  console.log(`Latency mean    : ${mean.toFixed(1)} ms`);
  console.log(`Latency p50/p90/p99 : ${pct(lat, 50).toFixed(0)} / ${pct(lat, 90).toFixed(0)} / ${pct(lat, 99).toFixed(0)} ms`);
  console.log('  single-shot (uncontended):');
  for (const e of ENDPOINTS) console.log(`    ${e.padEnd(22)} ${solo[e].toFixed(1)} ms`);
  console.log('────────────────────────────────────────');

  kill();
  process.exit(0);
})();
