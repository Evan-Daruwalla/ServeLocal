// Helper: spawn the real server as a child process with an isolated temp DB and
// a random secret, then wait until it answers /api/health. Used by load + chaos.
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

async function waitReady(base, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

async function spawnServer({ port = 3998 } = {}) {
  const tmp = path.join(os.tmpdir(), 'servelocal-run-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(tmp, { recursive: true });
  const dbFile = path.join(tmp, 'db.json');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_FILE: dbFile, BACKUP_DIR: path.join(tmp, 'backups'), JWT_SECRET: 'run-' + crypto.randomBytes(6).toString('hex'), NODE_ENV: 'development' },
    stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:' + port;
  await waitReady(base);
  return {
    base, child, dbFile, tmp,
    stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 2500); }),
    cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} },
  };
}

module.exports = { spawnServer, waitReady };
