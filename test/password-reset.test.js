// Password reset flow: POST /api/auth/forgot + /api/auth/reset.
const { srv, boot, cleanup } = require('./_boot.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

let H;
before(async () => { H = await boot(); });
after(async () => { await H.close(); cleanup(); });

const DEMO_EMAIL = 'alex@student.edu'; // seeded demo student
function hashHex(t) { return crypto.createHash('sha256').update(t).digest('hex'); }

// Same pattern as the guardian-consent tests: inject a known raw token by
// writing its hash directly, simulating "this exact link arrived by email".
function issueResetToken(email, ttlMs = 3600000) {
  const u = srv.DB.users.find(x => x.email === email);
  const token = crypto.randomBytes(32).toString('hex');
  u.resetTokenHash = hashHex(token);
  u.resetTokenExpires = new Date(Date.now() + ttlMs).toISOString();
  srv.saveDB();
  return token;
}

test('forgot: same 200 response for existing and unknown emails (no enumeration)', async () => {
  const a = await H.api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email: DEMO_EMAIL }) });
  const b = await H.api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email: 'nobody-here@example.com' }) });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(a.data.message, b.data.message);
  // existing account got a hashed token stored; unknown did not create anything
  const u = srv.DB.users.find(x => x.email === DEMO_EMAIL);
  assert.ok(u.resetTokenHash && u.resetTokenExpires);
});

test('reset: valid token sets the new password, is single-use, and revokes sessions', async () => {
  const oldTok = await H.login(DEMO_EMAIL, 'demo1234');
  const token = issueResetToken(DEMO_EMAIL);
  const r = await H.api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token, password: 'Zx9qweNewPass!' }) });
  assert.strictEqual(r.status, 200);
  // old session revoked (tokenVersion bumped)
  const me = await H.api('/api/auth/me', {}, oldTok);
  assert.strictEqual(me.status, 401);
  // new password works, old one doesn't
  assert.ok(await H.login(DEMO_EMAIL, 'Zx9qweNewPass!'));
  const bad = await H.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: DEMO_EMAIL, password: 'demo1234' }) });
  assert.strictEqual(bad.status, 401);
  // token is single-use
  const again = await H.api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token, password: 'Zx9qweOther!' }) });
  assert.strictEqual(again.status, 400);
  // restore the demo password for other tests
  const u = srv.DB.users.find(x => x.email === DEMO_EMAIL);
  srv.setPassword(u, 'demo1234'); srv.saveDB();
});

test('reset: expired or bogus tokens are rejected; weak passwords are rejected', async () => {
  const expired = issueResetToken(DEMO_EMAIL, -1000);
  const r1 = await H.api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token: expired, password: 'Zx9qweNewPass!' }) });
  assert.strictEqual(r1.status, 400);
  const r2 = await H.api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token: 'deadbeef', password: 'Zx9qweNewPass!' }) });
  assert.strictEqual(r2.status, 400);
  const fresh = issueResetToken(DEMO_EMAIL);
  const r3 = await H.api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token: fresh, password: 'password' }) });
  assert.strictEqual(r3.status, 400, 'weak password must be rejected');
});

test('forgot: throttled after 3 requests from one IP+email', async () => {
  const email = 'throttle-me@example.com';
  let last;
  for (let i = 0; i < 4; i++) last = await H.api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
  assert.strictEqual(last.status, 429);
});

test('safeUser never exposes reset token fields', async () => {
  issueResetToken(DEMO_EMAIL);
  const tok = await H.login(DEMO_EMAIL, 'demo1234');
  const me = await H.api('/api/auth/me', {}, tok);
  assert.strictEqual(me.status, 200);
  assert.ok(!('resetTokenHash' in me.data), 'resetTokenHash leaked');
  assert.ok(!('resetTokenExpires' in me.data), 'resetTokenExpires leaked');
});
