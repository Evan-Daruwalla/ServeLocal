// TOTP MFA (RFC 6238, zero-dep lib/totp.js): enrollment, two-step login,
// backup codes, throttling, and secret hygiene.
const { srv, boot, cleanup } = require('./_boot.js');
const { totp } = require('../lib/totp.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let H, tok, student;
before(async () => {
  H = await boot();
  tok = await H.login('alex@student.edu', 'demo1234');
  student = srv.DB.users.find(u => u.email === 'alex@student.edu');
});
after(async () => { await H.close(); cleanup(); });

let backupCodes;

test('setup + enable turns MFA on and returns backup codes', async () => {
  const setup = await H.api('/api/auth/mfa/setup', { method: 'POST', body: '{}' }, tok);
  assert.strictEqual(setup.status, 200);
  assert.match(setup.data.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.data.otpauth, /^otpauth:\/\/totp\//);
  // wrong code is rejected, MFA stays off
  const bad = await H.api('/api/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code: '000000' }) }, tok);
  assert.strictEqual(bad.status, 400);
  assert.ok(!student.mfaEnabled);
  // live code enables
  const good = await H.api('/api/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code: totp(setup.data.secret) }) }, tok);
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.data.backupCodes.length, 8);
  backupCodes = good.data.backupCodes;
  assert.ok(student.mfaEnabled);
});

test('login becomes two-step; ticket + live code yields a session', async () => {
  const r1 = await H.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alex@student.edu', password: 'demo1234' }) });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.data.mfaRequired, true);
  assert.ok(r1.data.mfaToken && !r1.data.token, 'no session token before MFA');
  // wrong code rejected
  const bad = await H.api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken: r1.data.mfaToken, code: '000000' }) });
  assert.strictEqual(bad.status, 401);
  // live TOTP accepted
  const r2 = await H.api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken: r1.data.mfaToken, code: totp(student.mfaSecret) }) });
  assert.strictEqual(r2.status, 200);
  assert.ok(r2.data.token, 'session token issued');
  // ticket is single-use
  const replay = await H.api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken: r1.data.mfaToken, code: totp(student.mfaSecret) }) });
  assert.strictEqual(replay.status, 401);
});

test('backup code works once, then is consumed', async () => {
  const r1 = await H.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alex@student.edu', password: 'demo1234' }) });
  const r2 = await H.api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken: r1.data.mfaToken, code: backupCodes[0] }) });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(student.mfaBackupCodes.length, 7, 'backup code consumed');
  // consumed code no longer works
  const r3 = await H.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alex@student.edu', password: 'demo1234' }) });
  const r4 = await H.api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken: r3.data.mfaToken, code: backupCodes[0] }) });
  assert.strictEqual(r4.status, 401);
});

test('safeUser never exposes MFA secrets', async () => {
  const r1 = await H.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alex@student.edu', password: 'demo1234' }) });
  const r2 = await H.api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken: r1.data.mfaToken, code: totp(student.mfaSecret) }) });
  const u = r2.data.user;
  assert.strictEqual(u.mfaEnabled, true, 'mfaEnabled is visible');
  for (const k of ['mfaSecret', 'mfaPendingSecret', 'mfaBackupCodes', 'mfaLoginTokenHash', 'mfaLoginExpires'])
    assert.ok(!(k in u), k + ' must not be serialized');
});

test('code guessing at the verify step is throttled', async () => {
  const r1 = await H.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alex@student.edu', password: 'demo1234' }) });
  let last;
  for (let i = 0; i < 9; i++)
    last = await H.api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ mfaToken: r1.data.mfaToken, code: '111111' }) });
  assert.strictEqual(last.status, 429);
});

test('disable requires a valid code and turns MFA off', async () => {
  // fresh session (throttle state keyed separately from login throttle)
  srv.DB.users.find(u => u.email === 'alex@student.edu'); // still same ref
  const fresh = srv.makeToken(student);
  const bad = await H.api('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ code: '000000' }) }, fresh);
  assert.strictEqual(bad.status, 400);
  const good = await H.api('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ code: totp(student.mfaSecret) }) }, fresh);
  assert.strictEqual(good.status, 200);
  assert.ok(!student.mfaEnabled && !student.mfaSecret, 'MFA fully cleared');
  // sessions revoked (tokenVersion bumped) — old token now 401
  const check = await H.api('/api/auth/mfa/setup', { method: 'POST', body: '{}' }, fresh);
  assert.strictEqual(check.status, 401);
});
