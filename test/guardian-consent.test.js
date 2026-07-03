// Guardian consent flow — see docs/guardian-consent-spec.md, ADR-0010.
const { srv, boot, cleanup } = require('./_boot.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

let H;
before(async () => { H = await boot(); });
after(async () => { await H.close(); cleanup(); });

function dobForAge(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}
function hashHex(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

// Injects a known raw token into a user's record by writing its hash directly —
// simulates "the guardian received this exact link by email" without needing to
// intercept the (intentionally one-way-hashed) token the server actually generated.
function issueConsentToken(email, ttlMs = 3600000) {
  const idx = srv.DB.users.findIndex(u => u.email === email);
  const token = crypto.randomBytes(32).toString('hex');
  srv.DB.users[idx].guardianConsentTokenHash = hashHex(token);
  srv.DB.users[idx].guardianConsentTokenExpires = new Date(Date.now() + ttlMs).toISOString();
  srv.saveDB();
  return token;
}

async function firstOppId() {
  return (await H.api('/api/opportunities')).data[0].id;
}

test('register a minor without guardianEmail -> 400', async () => {
  const r = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Mi', lastName: 'No', dob: dobForAge(15), email: 'minor-noguardian@test.edu', password: 'Zx9qwePass!',
  }) });
  assert.strictEqual(r.status, 400);
});

test('register a minor with guardianEmail === email -> 400', async () => {
  const r = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Mi', lastName: 'No', dob: dobForAge(15), email: 'minor-sameemail@test.edu', password: 'Zx9qwePass!',
    guardianName: 'Parent', guardianEmail: 'minor-sameemail@test.edu',
  }) });
  assert.strictEqual(r.status, 400);
});

test('register a minor -> guardianConsentStatus is pending, apply is blocked', async () => {
  const reg = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Mi', lastName: 'No', dob: dobForAge(15), email: 'minor-pending@test.edu', password: 'Zx9qwePass!',
    guardianName: 'Parent Pending', guardianEmail: 'parent-pending@test.edu',
  }) });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.data.user.guardianConsentStatus, 'pending');

  const oppId = await firstOppId();
  const apply = await H.api(`/api/opportunities/${oppId}/apply`, { method: 'POST', body: JSON.stringify({}) }, reg.data.token);
  assert.strictEqual(apply.status, 403);
  assert.strictEqual(apply.data.code, 'GUARDIAN_CONSENT_REQUIRED');
});

test('register an 18+ user -> not_required, no guardian fields needed, apply succeeds immediately', async () => {
  const reg = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Ad', lastName: 'Ult', dob: dobForAge(25), email: 'adult-student@test.edu', password: 'Zx9qwePass!',
  }) });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.data.user.guardianConsentStatus, 'not_required');

  const oppId = await firstOppId();
  const apply = await H.api(`/api/opportunities/${oppId}/apply`, { method: 'POST', body: JSON.stringify({}) }, reg.data.token);
  assert.notStrictEqual(apply.status, 403);
});

test('a pending minor who ages into 18+ is unblocked despite the stored pending status', async () => {
  const reg = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Ag', lastName: 'Ed', dob: dobForAge(15), email: 'ages-out@test.edu', password: 'Zx9qwePass!',
    guardianName: 'Parent Ages', guardianEmail: 'parent-ages@test.edu',
  }) });
  assert.strictEqual(reg.data.user.guardianConsentStatus, 'pending');

  // Back-date dob so the account is now 18+, without touching guardianConsentStatus.
  const idx = srv.DB.users.findIndex(u => u.email === 'ages-out@test.edu');
  srv.DB.users[idx].dob = dobForAge(19);
  srv.saveDB();
  assert.strictEqual(srv.DB.users[idx].guardianConsentStatus, 'pending'); // status itself never changed

  const oppId = await firstOppId();
  const apply = await H.api(`/api/opportunities/${oppId}/apply`, { method: 'POST', body: JSON.stringify({}) }, reg.data.token);
  assert.notStrictEqual(apply.status, 403); // gate re-checks age live and unblocks anyway
});

test('GET /api/consent/:token — wrong token 404, expired token 410', async () => {
  await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Ex', lastName: 'Pr', dob: dobForAge(15), email: 'expiry-check@test.edu', password: 'Zx9qwePass!',
    guardianName: 'Parent Expiry', guardianEmail: 'parent-expiry@test.edu',
  }) });

  const wrong = await H.api('/api/consent/' + crypto.randomBytes(32).toString('hex'));
  assert.strictEqual(wrong.status, 404);

  const expiredToken = issueConsentToken('expiry-check@test.edu', -1000); // already expired
  const expired = await H.api('/api/consent/' + expiredToken);
  assert.strictEqual(expired.status, 410);
  assert.strictEqual(expired.data.code, 'CONSENT_TOKEN_EXPIRED');
});

test('POST /api/consent/:token approve -> verified, apply succeeds, token is single-use', async () => {
  const reg = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Ap', lastName: 'Pr', dob: dobForAge(15), email: 'approve-flow@test.edu', password: 'Zx9qwePass!',
    guardianName: 'Parent Approve', guardianEmail: 'parent-approve@test.edu',
  }) });

  const token = issueConsentToken('approve-flow@test.edu');
  const preview = await H.api('/api/consent/' + token);
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.data.studentFirstName, 'Ap');

  const decide = await H.api('/api/consent/' + token, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.strictEqual(decide.status, 200);
  assert.strictEqual(decide.data.status, 'verified');

  const oppId = await firstOppId();
  const apply = await H.api(`/api/opportunities/${oppId}/apply`, { method: 'POST', body: JSON.stringify({}) }, reg.data.token);
  assert.notStrictEqual(apply.status, 403);

  const replay = await H.api('/api/consent/' + token, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  assert.strictEqual(replay.status, 404); // single-use — already consumed
});

test('POST /api/consent/:token decline -> declined, apply still blocked', async () => {
  const reg = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'De', lastName: 'Cl', dob: dobForAge(15), email: 'decline-flow@test.edu', password: 'Zx9qwePass!',
    guardianName: 'Parent Decline', guardianEmail: 'parent-decline@test.edu',
  }) });

  const token = issueConsentToken('decline-flow@test.edu');
  const decide = await H.api('/api/consent/' + token, { method: 'POST', body: JSON.stringify({ decision: 'decline' }) });
  assert.strictEqual(decide.status, 200);
  assert.strictEqual(decide.data.status, 'declined');

  const oppId = await firstOppId();
  const apply = await H.api(`/api/opportunities/${oppId}/apply`, { method: 'POST', body: JSON.stringify({}) }, reg.data.token);
  assert.strictEqual(apply.status, 403);
});

test('POST /api/account/consent/resend — cooldown enforced, old token invalidated', async () => {
  const reg = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Re', lastName: 'Sd', dob: dobForAge(15), email: 'resend-flow@test.edu', password: 'Zx9qwePass!',
    guardianName: 'Parent Resend', guardianEmail: 'parent-resend@test.edu',
  }) });
  const idx = srv.DB.users.findIndex(u => u.email === 'resend-flow@test.edu');
  const oldTokenHash = srv.DB.users[idx].guardianConsentTokenHash;

  // Immediate resend hits the cooldown (registration itself set guardianConsentRequestedAt).
  const tooSoon = await H.api('/api/account/consent/resend', { method: 'POST', body: '{}' }, reg.data.token);
  assert.strictEqual(tooSoon.status, 429);

  // Simulate the cooldown having elapsed, then resend for real.
  srv.DB.users[idx].guardianConsentRequestedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  srv.saveDB();
  const resend = await H.api('/api/account/consent/resend', { method: 'POST', body: '{}' }, reg.data.token);
  assert.strictEqual(resend.status, 200);
  assert.notStrictEqual(srv.DB.users[idx].guardianConsentTokenHash, oldTokenHash);
});

test('POST /api/consent/manage/:token revoke — kill switch works after prior approval', async () => {
  const reg = await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({
    firstName: 'Re', lastName: 'Vk', dob: dobForAge(15), email: 'revoke-flow@test.edu', password: 'Zx9qwePass!',
    guardianName: 'Parent Revoke', guardianEmail: 'parent-revoke@test.edu',
  }) });
  const token = issueConsentToken('revoke-flow@test.edu');
  await H.api('/api/consent/' + token, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });

  const oppId = await firstOppId();
  const applyBefore = await H.api(`/api/opportunities/${oppId}/apply`, { method: 'POST', body: JSON.stringify({}) }, reg.data.token);
  assert.notStrictEqual(applyBefore.status, 403);

  const idx = srv.DB.users.findIndex(u => u.email === 'revoke-flow@test.edu');
  const manageRawToken = crypto.randomBytes(32).toString('hex');
  srv.DB.users[idx].guardianManageTokenHash = hashHex(manageRawToken);
  srv.saveDB();

  const revoke = await H.api('/api/consent/manage/' + manageRawToken, { method: 'POST', body: JSON.stringify({ action: 'revoke' }) });
  assert.strictEqual(revoke.status, 200);
  assert.strictEqual(revoke.data.status, 'revoked');

  // A second opportunity so re-applying isn't blocked by "already applied" instead of consent.
  const opps = (await H.api('/api/opportunities')).data;
  const secondOppId = opps[1] ? opps[1].id : opps[0].id;
  const applyAfter = await H.api(`/api/opportunities/${secondOppId}/apply`, { method: 'POST', body: JSON.stringify({}) }, reg.data.token);
  assert.strictEqual(applyAfter.status, 403);
  assert.strictEqual(applyAfter.data.code, 'GUARDIAN_CONSENT_REQUIRED');
});

test('audit chain still verifies after the full guardian-consent lifecycle', async () => {
  const admin = await H.login('admin@servelocal.org', process.env.ADMIN_PASSWORD);
  const verify = await H.api('/api/admin/audit/verify', {}, admin);
  assert.strictEqual(verify.data.valid, true);
});
