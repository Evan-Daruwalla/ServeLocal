// Regression tests — lock in the fixes from the security audit so they can't
// silently regress. Each maps to a specific bug found and fixed.
const { boot, cleanup } = require('./_boot.js');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

let H, orgTok;
const futureISO = (days, h = 9) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.toISOString(); };

// Raw GET that sends the path verbatim (fetch/WHATWG-URL would collapse '..').
function rawGet(base, rawPath) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method: 'GET', path: rawPath }, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

async function makeOneTimeEvent(spots = 1, title = 'Reg Test Event') {
  const r = await H.api('/api/opportunities', { method: 'POST', body: JSON.stringify({
    title, category: 'Community', location: 'Springfield, IL',
    startTime: futureISO(7), endTime: futureISO(7, 11), description: 'regression', spotsAvailable: spots,
  }) }, orgTok);
  return r.data;
}

before(async () => {
  H = await boot();
  orgTok = await H.login('contact@greenroots.org', 'demo1234');
  await H.api('/api/billing/upgrade', { method: 'POST' }, orgTok); // pro -> bypass 3-listing limit for test fixtures
});
after(async () => { await H.close(); cleanup(); });

test('regression: inactive listing is 404 to public but visible to owner', async () => {
  const opp = await makeOneTimeEvent(5, 'Visibility Test');
  await H.api('/api/opportunities/' + opp.id, { method: 'DELETE' }, orgTok); // deactivate
  assert.strictEqual((await H.api('/api/opportunities/' + opp.id)).status, 404);          // public
  assert.strictEqual((await H.api('/api/opportunities/' + opp.id, {}, orgTok)).status, 200); // owner
});

test('regression: PUT listing rejects end<=start and spots<1', async () => {
  const opp = await makeOneTimeEvent(5, 'Validation Test');
  const badEnd = await H.api('/api/opportunities/' + opp.id, { method: 'PUT', body: JSON.stringify({ endTime: futureISO(-3) }) }, orgTok);
  assert.strictEqual(badEnd.status, 400);
  const badSpots = await H.api('/api/opportunities/' + opp.id, { method: 'PUT', body: JSON.stringify({ spotsAvailable: 0 }) }, orgTok);
  assert.strictEqual(badSpots.status, 400);
});

test('regression: check-in code never leaks to a student via opportunity fetch', async () => {
  const opp = await makeOneTimeEvent(5, 'Code Leak Test');
  await H.api('/api/opportunities/' + opp.id + '/checkin-code', { method: 'POST', body: JSON.stringify({}) }, orgTok);
  const studentTok = await H.login('alex@student.edu', 'demo1234');
  const seen = await H.api('/api/opportunities/' + opp.id, {}, studentTok);
  assert.ok(!('checkinCodes' in seen.data), 'student must never receive checkinCodes');
});

test('regression: waitlist FIFO auto-promotion when the spot frees', async () => {
  const opp = await makeOneTimeEvent(1, 'Waitlist Test');
  const a = (await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'Aa', lastName: 'Aa', dob: '2008-01-01', email: 'wa@test.edu', password: 'Zx9qwePass!' }) })).data.token;
  const b = (await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'Bb', lastName: 'Bb', dob: '2008-01-01', email: 'wb@test.edu', password: 'Zx9qwePass!' }) })).data.token;
  await H.api('/api/opportunities/' + opp.id + '/apply', { method: 'POST', body: JSON.stringify({}) }, a); // A takes the only spot
  const bApply = await H.api('/api/opportunities/' + opp.id + '/apply', { method: 'POST', body: JSON.stringify({}) }, b);
  assert.strictEqual(bApply.status, 400); // full
  const wl = await H.api('/api/opportunities/' + opp.id + '/waitlist', { method: 'POST' }, b);
  assert.strictEqual(wl.status, 201);
  await H.api('/api/opportunities/' + opp.id + '/unsubscribe', { method: 'DELETE', body: JSON.stringify({}) }, a); // A leaves
  const bApps = (await H.api('/api/applications/my', {}, b)).data;
  assert.strictEqual(bApps.find((x) => x.oppId === opp.id).status, 'approved'); // B promoted
});

test('regression: deleting a student frees the one-time spot they held', async () => {
  const opp = await makeOneTimeEvent(1, 'Deletion Spot Test');
  const c = (await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'Cc', lastName: 'Cc', dob: '2008-01-01', email: 'wc@test.edu', password: 'Zx9qwePass!' }) })).data.token;
  await H.api('/api/opportunities/' + opp.id + '/apply', { method: 'POST', body: JSON.stringify({}) }, c);
  assert.strictEqual((await H.api('/api/opportunities/' + opp.id)).data.spotsRemaining, 0);
  await H.api('/api/account', { method: 'DELETE', body: JSON.stringify({ password: 'Zx9qwePass!' }) }, c);
  assert.strictEqual((await H.api('/api/opportunities/' + opp.id)).data.spotsRemaining, 1);
});

test('regression: rejecting a previously-approved applicant frees the spot', async () => {
  const opp = await makeOneTimeEvent(1, 'Reject Frees Spot');
  const d = (await H.api('/api/auth/register/student', { method: 'POST', body: JSON.stringify({ firstName: 'Dd', lastName: 'Dd', dob: '2008-01-01', email: 'wd@test.edu', password: 'Zx9qwePass!' }) })).data.token;
  const apply = await H.api('/api/opportunities/' + opp.id + '/apply', { method: 'POST', body: JSON.stringify({}) }, d);
  assert.strictEqual((await H.api('/api/opportunities/' + opp.id)).data.spotsRemaining, 0);
  await H.api('/api/applications/' + apply.data.application.id, { method: 'PATCH', body: JSON.stringify({ action: 'reject' }) }, orgTok);
  assert.strictEqual((await H.api('/api/opportunities/' + opp.id)).data.spotsRemaining, 1);
});

test('regression: static handler blocks ../ path traversal out of public/', async () => {
  // These resolve to real files at the project root; before the containment
  // fix `serveStatic` served them (arbitrary file read). They must now 404.
  for (const p of ['/../db.json', '/../server.js', '/../package.json', '/../.env']) {
    const r = await rawGet(H.base, p);
    assert.strictEqual(r.status, 404, p + ' must be blocked (404)');
    assert.ok(!/scrypt\$|JWT_SECRET|serveStatic/.test(r.body), p + ' leaked file contents');
  }
  // Legitimate assets under public/ still serve.
  assert.strictEqual((await rawGet(H.base, '/')).status, 200);
  assert.strictEqual((await rawGet(H.base, '/emoji/2705.png')).status, 200);
});

test('regression: production refuses to boot with the default admin password', () => {
  // Spawn a fresh prod-mode load (JWT_SECRET set so it reaches the admin check).
  // ADMIN_PASSWORD unset -> falls back to the public default -> must fail closed.
  const serverPath = path.join(__dirname, '..', 'server.js');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(serverPath)})`], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48), ADMIN_PASSWORD: '',
           DB_FILE: path.join(os.tmpdir(), 'sl-guard-' + Date.now() + '.json'),
           BACKUP_DIR: path.join(os.tmpdir(), 'sl-guard-bak-' + Date.now()) },
  });
  assert.strictEqual(r.status, 1, 'should exit 1 in prod with default admin password');
  assert.match((r.stderr || '') + (r.stdout || ''), /ADMIN_PASSWORD/, 'should explain the ADMIN_PASSWORD requirement');
});
