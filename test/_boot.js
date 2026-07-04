// Shared test bootstrap. MUST be required before anything else in a test file:
// it sets env (isolated temp DB, test secret) BEFORE server.js is first required.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const tmp = path.join(os.tmpdir(), 'servelocal-test-' + crypto.randomBytes(6).toString('hex'));
fs.mkdirSync(tmp, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex');
process.env.ADMIN_PASSWORD = 'test-admin-' + crypto.randomBytes(8).toString('hex');
process.env.DB_FILE = path.join(tmp, 'db.sqlite');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.SCRYPT_N = '8192'; // 2^13 — keep scrypt fast in CI while still exercising the path
// Generous rate limits so multi-request test flows don't trip the shared-IP bucket.
// (The limiter itself is covered directly in unit.test.js and by scripts/chaos.js.)
process.env.RL_WRITE_CAP = '100000';
process.env.RL_READ_CAP = '100000';

const srv = require('../server.js'); // require AFTER env is set

// Boot an isolated HTTP server on an ephemeral port with a freshly-seeded DB.
async function boot() {
  srv.loadDB(); // file does not exist yet -> seeds demo data into the temp DB
  const server = srv.buildServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (p, opts = {}, tok) => {
    const r = await fetch(base + p, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    });
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data, headers: r.headers };
  };
  const login = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).data.token;
  return { server, base, api, login, close: () => new Promise((r) => server.close(r)) };
}

function cleanup() { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

module.exports = { srv, boot, cleanup, tmp };
