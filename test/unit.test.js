// Unit tests — pure exported helpers, no server/network.
const { srv } = require('./_boot.js');
const { test } = require('node:test');
const assert = require('node:assert');

test('calcHours computes duration in hours', () => {
  assert.strictEqual(srv.calcHours('2026-01-01T09:00', '2026-01-01T13:00'), 4);
  assert.strictEqual(srv.calcHours('2026-01-01T09:00', '2026-01-01T09:30'), 0.5);
});

test('isEmail validates format', () => {
  assert.ok(srv.isEmail('a@b.com'));
  assert.ok(!srv.isEmail('nope'));
  assert.ok(!srv.isEmail('a@b'));
  assert.ok(!srv.isEmail(''));
});

test('sstr strips control chars, trims, and length-caps', () => {
  assert.strictEqual(srv.sstr('  hi there  '), 'hi there');
  assert.strictEqual(srv.sstr('a\x00b\x07c\x1f'), 'abc');
  assert.strictEqual(srv.sstr('x'.repeat(20), 5), 'xxxxx');
  assert.strictEqual(srv.sstr(null), '');
});

test('clampNum clamps and defaults non-numbers', () => {
  assert.strictEqual(srv.clampNum(999, 1, 5, 1), 5);
  assert.strictEqual(srv.clampNum(-3, 0, 10, 0), 0);
  assert.strictEqual(srv.clampNum('abc', 0, 10, 7), 7);
});

test('orgPlan resolves plan limits', () => {
  assert.strictEqual(srv.orgPlan({ plan: 'free' }).maxActiveListings, 3);
  assert.strictEqual(srv.orgPlan({ plan: 'pro' }).maxActiveListings, null);
  assert.strictEqual(srv.orgPlan({}).maxFeatured, 0); // defaults to free
});

test('publicOpp strips internal fields (no check-in code leakage)', () => {
  const o = { id: '1', title: 'T', checkinCodes: { '2026-01-01': { code: 'ABC123' } }, views: 9, orgEmail: 'x@y.com', _verifiedDates: ['2026-01-01'] };
  const pub = srv.publicOpp(o);
  assert.ok(!('checkinCodes' in pub));
  assert.ok(!('views' in pub));
  assert.ok(!('orgEmail' in pub));
  assert.ok(!('_verifiedDates' in pub));
  assert.strictEqual(pub.title, 'T');
});

test('isValidOccurrence respects recurrence schedule', () => {
  const opp = { commitment: 'Weekly', startTime: '2026-01-01T09:00:00.000Z' };
  assert.ok(srv.isValidOccurrence(opp, '2026-01-08T09:00:00.000Z'));   // +1 week
  assert.ok(!srv.isValidOccurrence(opp, '2026-01-09T09:00:00.000Z'));  // not on schedule
  assert.ok(!srv.isValidOccurrence({ commitment: 'One-time', startTime: '2026-01-01T09:00:00.000Z' }, '2026-01-08'));
});

test('token make/verify round-trips and rejects tampering', () => {
  const tok = srv.makeToken({ id: 'u1', role: 'student', tokenVersion: 0 });
  const d = srv.verifyToken(tok);
  assert.strictEqual(d.sub, 'u1');
  assert.strictEqual(d.role, 'student');
  assert.strictEqual(srv.verifyToken(tok + 'x'), null);            // bad signature
  assert.strictEqual(srv.verifyToken('a.b.c'), null);              // garbage
});

test('hashPassword is deterministic per salt and salt-sensitive', () => {
  assert.strictEqual(srv.hashPassword('pw', 's1'), srv.hashPassword('pw', 's1'));
  assert.notStrictEqual(srv.hashPassword('pw', 's1'), srv.hashPassword('pw', 's2'));
});

test('rate limiter token bucket eventually blocks', () => {
  let blocked = false;
  for (let i = 0; i < 60; i++) { if (!srv.rateLimit('unit-test-ip', { capacity: 50, refillPerSec: 0 }).ok) { blocked = true; break; } }
  assert.ok(blocked, 'bucket should exhaust');
});

test('circuit breaker opens after threshold and recovers on success', () => {
  const b = srv.makeBreaker({ failThreshold: 3, cooldownMs: 50 });
  assert.strictEqual(b.state, 'closed');
  b.failure(); b.failure(); b.failure();
  assert.strictEqual(b.canRequest(), false);
  assert.strictEqual(b.state, 'open');
  b.success();
  assert.strictEqual(b.canRequest(), true);
});

test('scrypt password hashing: round-trips, rejects wrong, verifies legacy', () => {
  const u = {}; srv.setPassword(u, 'Zx9qwePass!');
  assert.ok(u.passwordHash.startsWith('scrypt$'), 'new hashes use scrypt');
  assert.ok(srv.verifyPassword('Zx9qwePass!', u));
  assert.ok(!srv.verifyPassword('nope', u));
  const legacy = { salt: 'abc', passwordHash: srv.hashPassword('Zx9qwePass!', 'abc') };
  assert.ok(srv.verifyPassword('Zx9qwePass!', legacy), 'legacy HMAC still verifies');
});

test('weak-password denylist flags common/guessable passwords', () => {
  assert.ok(srv.weakPassword('password1'));
  assert.ok(srv.weakPassword('aaaaaaaa'));
  assert.ok(srv.weakPassword('johndoe99', 'johndoe@x.com'));
  assert.ok(!srv.weakPassword('Zx9qwePass!', 'a@b.com'));
});

test('audit chain verifies and detects tampering', () => {
  srv.DB = { ...srv.DB, auditLog: [] };
  srv.appendAudit('u1', 'a.1', 't1');
  srv.appendAudit('u2', 'a.2', 't2');
  srv.appendAudit('u3', 'a.3', 't3');
  assert.strictEqual(srv.verifyAuditChain().valid, true);
  srv.DB.auditLog[1].meta = { tampered: true };
  const v = srv.verifyAuditChain();
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.brokenAt, 1);
});
