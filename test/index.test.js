// In-memory index correctness — invalidation on write, DB-swap rebuild, and
// agreement with a linear scan (see the IDX() layer in server.js).
const { srv } = require('./_boot.js');
const { test, before } = require('node:test');
const assert = require('node:assert');

before(() => { srv.loadDB(); }); // seeds the isolated temp DB

test('primary-key index agrees with a linear scan', () => {
  for (const u of srv.DB.users) assert.strictEqual(srv.IDX().userById.get(u.id), u);
  for (const o of srv.DB.opportunities) assert.strictEqual(srv.IDX().oppById.get(o.id), o);
});

test('foreign-key groups agree with a linear scan', () => {
  for (const u of srv.DB.users) {
    const expected = srv.DB.applications.filter(a => a.userId === u.id);
    const got = srv.idxList(srv.IDX().appsByUser, u.id);
    assert.strictEqual(got.length, expected.length);
    for (const a of expected) assert.ok(got.includes(a));
  }
});

test('a write bumps the cache version and the index rebuilds (no staleness)', () => {
  const id = 'idx-test-' + Date.now();
  assert.strictEqual(srv.IDX().userById.get(id), undefined); // builds index at current version
  srv.DB.users.push({ id, role: 'student', email: id + '@test.edu', dob: '2000-01-01' });
  srv.saveDB(); // atomic write -> bumpCache() -> version changes
  assert.ok(srv.IDX().userById.get(id), 'index must reflect the new user after a write');
  assert.strictEqual(srv.IDX().userByEmail.get(id + '@test.edu').id, id);
});

test('an in-place field mutation is visible through the index (same object ref)', () => {
  const u = srv.DB.users[0];
  srv.IDX(); // ensure built
  u.school = 'Mutated High ' + Date.now();
  assert.strictEqual(srv.IDX().userById.get(u.id).school, u.school); // same reference, no rebuild needed
});

test('swapping the DB object forces a rebuild', () => {
  const saved = srv.DB;
  try {
    srv.DB = { users: [{ id: 'solo', role: 'student', email: 'solo@test.edu' }], opportunities: [], applications: [], hours: [], notifications: [], messages: [], reviews: [], endorsements: [], reports: [], auditLog: [], donations: [], verificationTokens: [] };
    assert.strictEqual(srv.IDX().userById.size, 1);
    assert.ok(srv.IDX().userById.get('solo'));
  } finally {
    srv.DB = saved;
    srv.bumpCache(); // re-invalidate so later tests see the restored DB
  }
});

test('empty foreign-key lookup returns a stable empty array (safe to iterate/spread)', () => {
  const empty = srv.idxList(srv.IDX().appsByUser, 'no-such-user');
  assert.deepStrictEqual(empty, []);
  assert.doesNotThrow(() => [...empty].sort());
});
