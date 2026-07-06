// Notification email delivery (Track 2 #1): every in-app notification also
// attempts an email via sendEmail(), honoring the per-user emailNotifications
// opt-out (default on). Without RESEND_API_KEY the dev stub logs instead of
// sending, which is what these tests assert against.
const { srv, boot, cleanup } = require('./_boot.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let H, tok, student;
before(async () => {
  H = await boot();
  tok = await H.login('alex@student.edu', 'demo1234');
  student = srv.DB.users.find(u => u.email === 'alex@student.edu');
});
after(async () => { await H.close(); cleanup(); });

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('notification emails by default and writes the in-app record', () => {
  const lines = captureLog(() => srv.createNotification(student.id, 'test', 'Email Test Title', 'Test body'));
  assert.ok(lines.some(l => l.includes('would email') && l.includes(student.email)), 'email attempted via dev stub');
  assert.ok(srv.DB.notifications.find(n => n.userId === student.id && n.title === 'Email Test Title'), 'in-app record created');
});

test('emailNotifications=false suppresses email but keeps the in-app record', async () => {
  const r = await H.api('/api/profile', { method: 'PUT', body: JSON.stringify({ emailNotifications: false }) }, tok);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.emailNotifications, false);
  const lines = captureLog(() => srv.createNotification(student.id, 'test', 'Quiet Title', 'No email'));
  assert.ok(!lines.some(l => l.includes('would email')), 'no email attempted');
  assert.ok(srv.DB.notifications.find(n => n.userId === student.id && n.title === 'Quiet Title'), 'in-app record still created');
  await H.api('/api/profile', { method: 'PUT', body: JSON.stringify({ emailNotifications: true }) }, tok); // restore
});
