// Cost optimizations (ADR-0012): coalesced writes, structural-signature index rebuilds,
// bounded notifications, and conditional-GET caching on public reads.
const { srv, boot, cleanup } = require('./_boot.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let ctx;
before(async () => { ctx = await boot(); });
after(async () => { if (ctx) await ctx.close(); cleanup(); });

test('view beacon increments in memory and coalesces the write (no per-view saveDB)', async () => {
  const opp = srv.DB.opportunities[0];
  const before = opp.views || 0;
  const r = await ctx.api('/api/opportunities/' + opp.id + '/view', { method: 'POST' });
  assert.strictEqual(r.status, 200);
  // Increment is visible immediately in memory (analytics reads it live)...
  assert.strictEqual(srv.IDX().oppById.get(opp.id).views, before + 1);
  // ...and an explicit saveDB flushes the coalesced state to disk.
  srv.saveDB();
  srv.loadDB();
  assert.strictEqual(srv.IDX().oppById.get(opp.id).views, before + 1);
});

test('saveDBSoon marks state dirty; a later explicit saveDB persists it', () => {
  const u = srv.DB.users[0];
  const marker = 'coalesce-' + Date.now();
  u.school = marker;
  srv.saveDBSoon();      // debounced — not written synchronously
  srv.saveDB();          // explicit save must flush the pending change
  srv.loadDB();          // reload from disk
  assert.strictEqual(srv.IDX().userById.get(u.id).school, marker);
});

test('a field-only write keeps FK groupings correct without a structural rebuild', () => {
  const student = srv.DB.users.find(u => u.role === 'student');
  const app = { id: 'ftest-' + Date.now(), userId: student.id, oppId: 'x', status: 'pending' };
  srv.DB.applications.push(app);      // structural change -> signature changes -> rebuild
  assert.ok(srv.idxList(srv.IDX().appsByUser, student.id).includes(app));
  app.status = 'approved';            // field-only change -> no rebuild needed
  const grp = srv.idxList(srv.IDX().appsByUser, student.id);
  assert.ok(grp.includes(app), 'field mutation must not drop the row from its FK group');
  assert.strictEqual(grp.find(a => a.id === app.id).status, 'approved');
});

test('appending to a non-indexed collection (auditLog) does not desync the indexes', () => {
  const u = srv.DB.users[0];
  const sigUserCount = srv.IDX().userById.size;
  srv.appendAudit('test', 'noop_action', u.id, {});   // pushes to auditLog only
  // auditLog is not an indexed collection, so the user index must remain valid & complete.
  assert.strictEqual(srv.IDX().userById.size, sigUserCount);
  assert.strictEqual(srv.IDX().userById.get(u.id), u);
});

test('retentionPurge caps notifications per user to the most recent 200', () => {
  const student = srv.DB.users.find(u => u.role === 'student');
  const now = Date.now();
  for (let i = 0; i < 250; i++) {
    srv.DB.notifications.push({
      id: 'cap-' + i, userId: student.id, type: 't', title: 'x', message: 'y',
      read: false, createdAt: new Date(now - i * 1000).toISOString(),   // i=0 is newest
    });
  }
  srv.retentionPurge();
  const mine = srv.DB.notifications.filter(n => n.userId === student.id);
  assert.ok(mine.length <= 200, 'per-user notifications must be capped at 200, got ' + mine.length);
  // The newest survive; the oldest (cap-249) is dropped.
  assert.ok(mine.some(n => n.id === 'cap-0'), 'newest notification must be kept');
  assert.ok(!mine.some(n => n.id === 'cap-249'), 'oldest over-cap notification must be purged');
});

test('public reads send an ETag and honor If-None-Match with a 304', async () => {
  const first = await ctx.api('/api/stats');
  assert.strictEqual(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'stats response must carry an ETag');
  assert.match(first.headers.get('cache-control') || '', /max-age=/);
  const second = await ctx.api('/api/stats', { headers: { 'If-None-Match': etag } });
  assert.strictEqual(second.status, 304, 'matching ETag must return 304 Not Modified');
});

test('a write changes the public-read ETag (staleness is bounded by cache version)', async () => {
  const before = (await ctx.api('/api/stats')).headers.get('etag');
  srv.DB.opportunities.push({ id: 'etag-opp-' + Date.now(), orgId: 'x', active: true, title: 't' });
  srv.saveDB(); // bumps _cacheVersion
  const after = (await ctx.api('/api/stats')).headers.get('etag');
  assert.notStrictEqual(before, after, 'ETag must change after a write bumps the cache version');
});
