#!/usr/bin/env node
// Zero-dependency chaos / resilience harness. Injects faults and asserts the
// service degrades gracefully and recovers. Usage: node scripts/chaos.js
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { waitReady } = require('./_spawn.js');

const ROOT = path.join(__dirname, '..');
const results = [];
const rec = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

// Spawn a server bound to an explicit data dir + port so we can corrupt/restart
// against the same db.sqlite across runs.
async function spawnAt(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DB_FILE: path.join(dir, 'db.sqlite'), BACKUP_DIR: path.join(dir, 'backups'), JWT_SECRET: 'chaos-secret', NODE_ENV: 'development' },
    stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:' + port;
  await waitReady(base);
  const stop = () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 2500); });
  return { base, child, stop, dbFile: path.join(dir, 'db.sqlite') };
}

(async () => {
  console.log('Chaos / resilience harness\n');
  const dir = path.join(os.tmpdir(), 'servelocal-chaos-' + crypto.randomBytes(5).toString('hex'));

  // ── Scenario A: request flood — rate limiter holds, server stays up ──
  try {
    const s = await spawnAt(dir, 3997);
    const codes = [];
    await Promise.all(Array.from({ length: 300 }, async () => { try { codes.push((await fetch(s.base + '/api/opportunities')).status); } catch { codes.push(0); } }));
    const up = (await fetch(s.base + '/api/health')).ok;
    rec('A. Flood: rate limiter engages and server stays responsive', up && codes.includes(429), `${codes.filter((c) => c === 429).length}/300 limited`);
    await s.stop();
  } catch (e) { rec('A. Flood', false, e.message); }

  // ── Scenario B: corrupt db.sqlite at rest -> restart -> recover, no crash ──
  try {
    fs.writeFileSync(path.join(dir, 'db.sqlite'), '{ corrupt json ][ not valid, and not a sqlite file either');
    const s = await spawnAt(dir, 3996); // loadDB() must recover (newest backup) or reseed
    const health = (await fetch(s.base + '/api/health')).ok;
    const serves = (await fetch(s.base + '/api/opportunities')).ok;
    rec('B. Corrupt DB at rest: recovers on restart, no crash', health && serves);
    await s.stop();
  } catch (e) { rec('B. Corrupt DB recovery', false, e.message); }

  // ── Scenario C: graceful shutdown leaves a valid db.sqlite ──
  try {
    const s = await spawnAt(dir, 3995);
    await s.stop(); // SIGTERM -> flush DB -> exit
    const check = new Database(s.dbFile, { readonly: true }); // throws if invalid
    check.prepare('SELECT COUNT(*) FROM users').get();
    check.close();
    rec('C. Graceful shutdown writes a valid db.sqlite', true);
  } catch (e) { rec('C. Graceful shutdown', false, e.message); }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} chaos checks passed`);
  process.exit(failed ? 1 : 0);
})();
