#!/usr/bin/env node
// Repeatable micro-benchmark for the ADR-0012 scaling primitives, on a synthetic
// large database. It measures the cost of the exact operations the optimizations
// target — full-DB serialise (saveDB), index rebuild, and the leaderboard /
// opportunity-list read paths — old (linear/N+1) vs new (indexed).
//
//   npm run bench                 # ~10k-user default corpus
//   USERS=50000 npm run bench     # scale the corpus
//
// Single machine, synthetic data — the per-operation numbers are solid; any
// "time saved per day" figure depends on a traffic model (see docs/adr/0012).
// Zero-dependency, standalone: it does NOT touch the real db.json.

const fs = require('fs'); const os = require('os'); const path = require('path');
const now = () => Number(process.hrtime.bigint()) / 1e6; // ms
const median = (fn, reps) => { const t = []; for (let i = 0; i < reps; i++) { const s = now(); fn(); t.push(now() - s); } t.sort((a, b) => a - b); return t[Math.floor(t.length / 2)]; };

// ── corpus sizing (scales off USERS) ───────────────────────────────
const USERS = Number(process.env.USERS) || 10000;
const N_STUDENTS = Math.round(USERS * 0.85), N_ORGS = USERS - N_STUDENTS;
const N_OPPS = Math.round(USERS * 0.3), N_APPS = USERS * 8, N_HOURS = USERS * 12;
const N_NOTIF = USERS * 15, N_MSG = USERS * 5, N_REV = Math.round(USERS * 0.5);
const rid = (p, i) => p + i, ISO = '2026-05-01T12:00:00.000Z';

const DB = { users: [], opportunities: [], applications: [], hours: [], notifications: [], messages: [], reviews: [], reports: [], endorsements: [], donations: [], verificationTokens: [], auditLog: [] };
for (let i = 0; i < N_STUDENTS; i++) DB.users.push({ id: rid('u', i), role: 'student', email: 'student' + i + '@example.edu', firstName: 'First' + i, lastName: 'Last' + i, school: 'School ' + (i % 400), dob: '2008-01-01', passwordHash: 'scrypt$'.padEnd(180, 'a'), savedOpps: [], createdAt: ISO, adminApproved: true });
for (let i = 0; i < N_ORGS; i++) DB.users.push({ id: rid('u', N_STUDENTS + i), role: 'org', orgId: rid('org', i), email: 'org' + i + '@example.org', orgName: 'Organization ' + i, passwordHash: 'scrypt$'.padEnd(180, 'a'), adminApproved: true, plan: i % 5 === 0 ? 'pro' : 'free', createdAt: ISO });
for (let i = 0; i < N_OPPS; i++) DB.opportunities.push({ id: rid('o', i), orgId: rid('org', i % Math.max(1, N_ORGS)), orgName: 'Organization ' + (i % Math.max(1, N_ORGS)), title: 'Volunteer Opportunity ' + i, description: 'A meaningful community service role helping local residents. '.repeat(3), category: 'Environment', skills: ['Teamwork', 'Communication'], commitment: 'One-time', active: true, featured: i % 20 === 0, views: (i * 7) % 500, spotsAvailable: 20, startTime: ISO, endTime: ISO, lat: 41 + (i % 100) / 100, lng: -87 - (i % 100) / 100, checkinCodes: {} });
for (let i = 0; i < N_APPS; i++) DB.applications.push({ id: rid('a', i), userId: rid('u', i % N_STUDENTS), oppId: rid('o', i % N_OPPS), status: ['pending', 'approved', 'approved', 'waitlisted'][i % 4], type: 'single-date', createdAt: ISO, resolvedAt: i % 2 ? ISO : null });
for (let i = 0; i < N_HOURS; i++) DB.hours.push({ id: rid('h', i), userId: rid('u', i % N_STUDENTS), oppId: rid('o', i % N_OPPS), hours: 2 + (i % 4), status: ['verified', 'verified', 'pending'][i % 3], startTime: ISO, autoKey: 'auto:' + i });
for (let i = 0; i < N_NOTIF; i++) DB.notifications.push({ id: rid('n', i), userId: rid('u', i % N_STUDENTS), type: 'event_reminder_24h', title: 'Event Tomorrow', message: 'Your event "Volunteer Opportunity" starts in ~24 hours.', link: 'dash', read: i % 3 === 0, createdAt: ISO });
for (let i = 0; i < N_MSG; i++) DB.messages.push({ id: rid('m', i), oppId: rid('o', i % N_OPPS), senderId: rid('u', i % USERS), text: 'Hello, looking forward to volunteering with you!', createdAt: ISO });
for (let i = 0; i < N_REV; i++) DB.reviews.push({ id: rid('r', i), orgId: rid('org', i % Math.max(1, N_ORGS)), userId: rid('u', i % N_STUDENTS), rating: 3 + (i % 3), text: 'Great experience volunteering here.', createdAt: ISO });

const mb = Buffer.byteLength(JSON.stringify(DB)) / 1e6;

// ── index build (mirrors buildIndexes() in server.js) ──────────────
function buildIndexes() {
  const byId = arr => { const m = new Map(); for (const x of arr) m.set(x.id, x); return m; };
  const group = (arr, key) => { const m = new Map(); for (const x of arr) { const k = x[key]; if (k == null) continue; let g = m.get(k); if (!g) m.set(k, g = []); g.push(x); } return m; };
  return { userById: byId(DB.users), oppById: byId(DB.opportunities), appById: byId(DB.applications), hoursById: byId(DB.hours), appsByOpp: group(DB.applications, 'oppId'), appsByUser: group(DB.applications, 'userId'), hoursByUser: group(DB.hours, 'userId'), notifsByUser: group(DB.notifications, 'userId'), messagesByOpp: group(DB.messages, 'oppId'), reviewsByOrg: group(DB.reviews, 'orgId'), oppsByOrg: group(DB.opportunities, 'orgId') };
}
const IDX = buildIndexes();
const idxList = (m, k) => m.get(k) || [];
const EMPTY = '';

// ── measurements ───────────────────────────────────────────────────
const tmp = path.join(os.tmpdir(), 'servelocal-bench-' + process.pid + '.json');
const t_serialize = median(() => JSON.stringify(DB, null, 2), 5);
const t_savedb = median(() => { const s = JSON.stringify(DB, null, 2); const f = tmp + '.tmp'; fs.writeFileSync(f, s); fs.renameSync(f, tmp); }, 5);
try { fs.unlinkSync(tmp); } catch { void EMPTY; }
const t_idxrebuild = median(buildIndexes, 5);

const students = DB.users.filter(u => u.role === 'student');
const t_lb_old = median(() => students.map(s => DB.hours.filter(h => h.userId === s.id && h.status === 'verified').reduce((a, h) => a + h.hours, 0)), 3);
const t_lb_new = median(() => students.map(s => idxList(IDX.hoursByUser, s.id).filter(h => h.status === 'verified').reduce((a, h) => a + h.hours, 0)), 3);

const page = DB.opportunities.filter(o => o.active).slice(0, 200);
const t_list_old = median(() => page.map(o => { const ac = DB.applications.filter(a => a.oppId === o.id && a.status === 'approved').length; const ids = DB.opportunities.filter(x => x.orgId === o.orgId).map(x => x.id); return ac + DB.applications.filter(a => ids.includes(a.oppId) && a.resolvedAt).slice(-10).length; }), 3);
const t_list_new = median(() => page.map(o => { const ac = idxList(IDX.appsByOpp, o.id).filter(a => a.status === 'approved').length; return ac + idxList(IDX.oppsByOrg, o.orgId).flatMap(op => idxList(IDX.appsByOpp, op.id)).filter(a => a.resolvedAt).slice(-10).length; }), 3);

// ── report ─────────────────────────────────────────────────────────
const f = n => n.toFixed(1).padStart(9);
const x = (o, n) => (o / n >= 10 ? Math.round(o / n) + 'x' : (o / n).toFixed(1) + 'x');
console.log(`\nServeLocal bench — ${USERS.toLocaleString()} users, ${mb.toFixed(1)} MB DB`);
console.log(`  (${DB.users.length} users · ${DB.applications.length} apps · ${DB.hours.length} hours · ${DB.notifications.length} notifs)\n`);
console.log('  operation                         before        after    speedup');
console.log('  ' + '-'.repeat(64));
console.log(`  saveDB serialize+write        ${f(t_savedb)} ms          n/a   (coalesced: ~0 per view)`);
console.log(`    (serialize alone)           ${f(t_serialize)} ms`);
console.log(`  full index rebuild            ${f(t_idxrebuild)} ms          n/a   (only on structural writes)`);
console.log(`  leaderboard (uncached)        ${f(t_lb_old)} ms ${f(t_lb_new)} ms   ${x(t_lb_old, t_lb_new)}`);
console.log(`  opportunity list (200)        ${f(t_list_old)} ms ${f(t_list_new)} ms   ${x(t_list_old, t_list_new)}`);
console.log('\n  Per-op numbers are solid; any per-day figure depends on a traffic model (docs/adr/0012).\n');
