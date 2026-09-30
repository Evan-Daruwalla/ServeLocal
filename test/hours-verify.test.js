// Hours verification authorization (audit DN, 2026-09-29).
// The old guard on PATCH /api/hours/:id/verify was `oppId && !orgOppIds.includes(oppId)`, which a null
// oppId skipped entirely: any org, even an unapproved one, could verify a student's SELF-REPORTED hours.
// Now: only an approved org, only its own listing's hours, only while pending. Also covers the
// production seed (admin account only, no demo accounts with the public demo password).
const { srv, boot, cleanup, tmp } = require('./_boot.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

let H, approvedTok, pendingTok, student, approvedOrg, pendingOrg, ownOpp, otherOpp;
before(async () => {
  H = await boot();
  approvedTok = await H.login('contact@greenroots.org', 'demo1234');
  pendingTok = await H.login('info@citylibrary.org', 'demo1234');
  student = srv.DB.users.find(u => u.email === 'alex@student.edu');
  approvedOrg = srv.DB.users.find(u => u.email === 'contact@greenroots.org');
  pendingOrg = srv.DB.users.find(u => u.email === 'info@citylibrary.org');
  ownOpp = srv.DB.opportunities.find(o => o.orgId === approvedOrg.orgId);
  // The unapproved org's listing: an org can lose its approval after posting (revoke), so this is a real state.
  otherOpp = { id: 'hv-other-opp', orgId: pendingOrg.orgId, orgName: pendingOrg.orgName, orgEmail: pendingOrg.email,
    title: 'Library Reading Hour', active: true, createdAt: new Date().toISOString() };
  srv.DB.opportunities.push(otherOpp);
  srv.saveDB();
});
after(async () => { await H.close(); cleanup(); });

function addHours(over) {
  const h = { id: 'hv-' + crypto.randomBytes(5).toString('hex'), userId: student.id, oppId: null, orgName: 'x',
    activity: 'Volunteering', hours: 2, status: 'pending', notes: '', appeal: null, createdAt: new Date().toISOString(), ...over };
  srv.DB.hours.push(h);
  return h;
}
const verify = (id, tok, action = 'approve') =>
  H.api(`/api/hours/${id}/verify`, { method: 'PATCH', body: JSON.stringify({ action }) }, tok);

test('an unapproved org cannot verify hours, even on its own listing', async () => {
  const h = addHours({ oppId: otherOpp.id, orgName: pendingOrg.orgName });
  const r = await verify(h.id, pendingTok);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(h.status, 'pending');
});

test('an approved org cannot verify SELF-REPORTED hours (null oppId)', async () => {
  const h = addHours({ oppId: null, status: 'self', supervisorEmail: 'someone@example.org' });
  const r = await verify(h.id, approvedTok);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(h.status, 'self', 'the entry must be unchanged');
});

test('an approved org cannot verify pending hours on ANOTHER org\'s listing', async () => {
  const h = addHours({ oppId: otherOpp.id });
  const r = await verify(h.id, approvedTok);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(h.status, 'pending');
});

test('an approved org verifies pending hours on its OWN listing; the same entry again is 409', async () => {
  const h = addHours({ oppId: ownOpp.id, orgName: approvedOrg.orgName });
  const first = await verify(h.id, approvedTok);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(h.status, 'verified');
  const again = await verify(h.id, approvedTok);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(h.status, 'verified');
});

test('an unapproved org cannot bulk-verify, and its pending hours are left alone', async () => {
  const h = addHours({ oppId: otherOpp.id, orgName: pendingOrg.orgName });
  const r = await H.api('/api/hours/bulk-verify', { method: 'PATCH' }, pendingTok);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(h.status, 'pending');
});

test('production seeds the admin account only, not the demo accounts', () => {
  // A child process: NODE_ENV is fixed at require time, and _boot.js already booted this file as 'test'.
  const script = `
    const srv = require(${JSON.stringify(path.resolve(__dirname, '..', 'server.js'))});
    srv.loadDB();          // empty DB file -> seeds
    srv.loadDB();          // second load reads what the seed PERSISTED
    console.log('USERS:' + JSON.stringify(srv.DB.users.map(u => u.email)));
    srv.closeDB();
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_SECRET: 'prod-' + crypto.randomBytes(24).toString('hex'),
      ADMIN_PASSWORD: 'prod-admin-' + crypto.randomBytes(8).toString('hex'),
      DB_FILE: path.join(tmp, 'prod-db.sqlite'),
      BACKUP_DIR: path.join(tmp, 'prod-backups'),
    },
  });
  assert.strictEqual(r.status, 0, 'production boot failed: ' + r.stderr);
  const line = r.stdout.split('\n').find(l => l.startsWith('USERS:'));
  assert.ok(line, 'child printed no user list: ' + r.stdout);
  const emails = JSON.parse(line.slice('USERS:'.length));
  assert.deepStrictEqual(emails, ['admin@servelocal.org']);
});
