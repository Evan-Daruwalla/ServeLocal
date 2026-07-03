// Integration / end-to-end tests — real HTTP server, isolated temp DB.
const { boot, cleanup } = require('./_boot.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let H;
before(async () => { H = await boot(); });
after(async () => { await H.close(); cleanup(); });

test('health + readiness endpoints', async () => {
  assert.strictEqual((await H.api('/api/health')).data.status, 'ok');
  const ready = await H.api('/api/health/ready');
  assert.strictEqual(ready.status, 200);
  assert.strictEqual(ready.data.ready, true);
});

test('security headers on API responses', async () => {
  const r = await H.api('/api/stats');
  assert.ok(r.headers.get('content-security-policy'));
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
});

test('student registration validation', async () => {
  const bad = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'A', lastName: 'B', dob: '2008-01-01', email: 'not-email', password: 'Zx9qwePass!' }) });
  assert.strictEqual(bad.status, 400);
  const young = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'A', lastName: 'B', dob: '2020-01-01', email: 'kid@test.edu', password: 'Zx9qwePass!' }) });
  assert.strictEqual(young.status, 400); // under 12
  const short = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'A', lastName: 'B', dob: '2008-01-01', email: 'ok@test.edu', password: 'short' }) });
  assert.strictEqual(short.status, 400); // password < 8
  const ok = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'A', lastName: 'B', dob: '2008-01-01', email: 'newstudent@test.edu', password: 'Zx9qwePass!' }) });
  assert.strictEqual(ok.status, 201);
  assert.ok(ok.data.token);
});

test('login throttle returns 429 after repeated failures', async () => {
  // Use a throwaway email so we don't lock out the demo accounts other tests use.
  let last;
  for (let i = 0; i < 10; i++) last = await H.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'throttle-victim@test.edu', password: 'wrong' + i }) });
  assert.strictEqual(last.status, 429);
});

test('RBAC: student cannot read admin endpoints', async () => {
  const tok = await H.login('alex@student.edu', 'demo1234');
  assert.strictEqual((await H.api('/api/admin/stats', {}, tok)).status, 401);
  assert.strictEqual((await H.api('/api/admin/audit', {}, tok)).status, 401);
});

test('opportunities never leak check-in codes or org email to public', async () => {
  const list = await H.api('/api/opportunities');
  for (const o of list.data) {
    assert.ok(!('checkinCodes' in o), 'checkinCodes leaked');
    assert.ok(!('orgEmail' in o), 'orgEmail leaked');
    assert.ok(!('views' in o), 'views leaked');
  }
});

test('GDPR data export returns the caller’s own records', async () => {
  const tok = await H.login('alex@student.edu', 'demo1234');
  const exp = await H.api('/api/account/export', {}, tok);
  assert.strictEqual(exp.status, 200);
  assert.ok(exp.data.account && exp.data.exportedAt);
  assert.ok(Array.isArray(exp.data.hours));
  assert.match(exp.headers.get('content-disposition') || '', /attachment/);
});

test('tamper-evident audit log: chain valid + admin-only', async () => {
  const admin = await H.login('admin@servelocal.org', process.env.ADMIN_PASSWORD);
  const a = await H.api('/api/admin/audit', {}, admin);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.data.chain.valid, true);
  const v = await H.api('/api/admin/audit/verify', {}, admin);
  assert.strictEqual(v.data.valid, true);
});

test('idempotency: duplicate Idempotency-Key applies once', async () => {
  const before = (await H.api('/api/donations/stats')).data.donorCount;
  const key = 'itest-' + Date.now();
  await H.api('/api/donations', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ amount: 12, name: 'T' }) });
  await H.api('/api/donations', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ amount: 12, name: 'T' }) });
  const after = (await H.api('/api/donations/stats')).data.donorCount;
  assert.strictEqual(after - before, 1);
});

test('signout-all revokes existing tokens', async () => {
  const tok = await H.login('contact@greenroots.org', 'demo1234');
  const so = await H.api('/api/auth/signout-all', { method: 'POST' }, tok);
  assert.ok(so.data.token);
  assert.strictEqual((await H.api('/api/auth/me', {}, tok)).status, 401);          // old token dead
  assert.strictEqual((await H.api('/api/auth/me', {}, so.data.token)).status, 200); // fresh token works
});

test('registration rejects weak/common passwords', async () => {
  const r = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'W', lastName: 'K', dob: '2008-01-01', email: 'weakpw@test.edu', password: 'password1' }) });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /common|guess/i);
});

test('password change requires current password and revokes other sessions', async () => {
  // register a fresh user, then change their password
  const reg = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'P', lastName: 'C', dob: '2008-01-01', email: 'pwchange@test.edu', password: 'Zx9qwePass!' }) });
  const tok = reg.data.token;
  const wrong = await H.api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'nope', newPassword: 'N3wStr0ng!pw' }) }, tok);
  assert.strictEqual(wrong.status, 401);
  const weak = await H.api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'Zx9qwePass!', newPassword: 'password1' }) }, tok);
  assert.strictEqual(weak.status, 400);
  const ok = await H.api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'Zx9qwePass!', newPassword: 'N3wStr0ng!pw' }) }, tok);
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.data.token, 'returns a fresh token for the current session');
  assert.strictEqual((await H.api('/api/auth/me', {}, tok)).status, 401);   // old token revoked
  // new password works for login; old one does not
  assert.ok(await H.login('pwchange@test.edu', 'N3wStr0ng!pw'));
  const oldLogin = await H.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'pwchange@test.edu', password: 'Zx9qwePass!' }) });
  assert.strictEqual(oldLogin.status, 401);
});

// NOTE: HTTP-level rate limiting is verified end-to-end by scripts/chaos.js
// (flood scenario) and the token bucket itself by unit.test.js. We keep this
// suite's shared-IP bucket generous (see test/_boot.js) so multi-step auth
// flows above don't trip it.
