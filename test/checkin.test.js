// Check-in code redemption: O(1) code index + per-user guess throttle.
const { srv, boot, cleanup } = require('./_boot.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let H, studentTok, orgTok, opp, student;
before(async () => {
  H = await boot();
  studentTok = await H.login('alex@student.edu', 'demo1234');
  orgTok = await H.login('contact@greenroots.org', 'demo1234');
  student = srv.DB.users.find(u => u.email === 'alex@student.edu');
  opp = srv.DB.opportunities[0];
  opp.durationHours = 2;
  // approved signup is a precondition for check-in
  srv.DB.applications.push({ id: 'ck-app-1', oppId: opp.id, userId: student.id, status: 'approved', type: 'single-date', createdAt: new Date().toISOString() });
  srv.saveDB();
});
after(async () => { await H.close(); cleanup(); });

test('org generates a code; student redeems it for verified hours', async () => {
  const gen = await H.api(`/api/opportunities/${opp.id}/checkin-code`, { method: 'POST', body: JSON.stringify({}) }, orgTok);
  assert.strictEqual(gen.status, 200);
  assert.match(gen.data.code, /^[A-Z2-9]{6}$/);
  const r = await H.api('/api/checkin', { method: 'POST', body: JSON.stringify({ code: gen.data.code }) }, studentTok);
  assert.strictEqual(r.status, 200);
  const hours = srv.DB.hours.find(h => h.userId === student.id && h.oppId === opp.id && h.status === 'verified');
  assert.ok(hours, 'verified hours entry created');
});

test('code guessing is throttled per user after 10 failures', async () => {
  let last;
  for (let i = 0; i < 11; i++) {
    last = await H.api('/api/checkin', { method: 'POST', body: JSON.stringify({ code: 'WRONG' + (i % 9) }) }, studentTok);
  }
  assert.strictEqual(last.status, 429);
});
