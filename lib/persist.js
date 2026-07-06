'use strict';
// SQLite persistence mechanics (ADR-0013, extracted per ADR-0015).
// This module owns the live WAL handle and the per-row hash mirror; server.js
// owns the in-memory DB object and all recovery/health orchestration. Nothing
// outside this file touches better-sqlite3.
//
// Each collection is its own table (primary-key column + a JSON `data` column
// per row). Serialising per row keeps every JS string tiny — the whole point of
// ADR-0013, since JSON.stringify of the whole DB hit V8's ~512MB string cap.
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let COLLECTIONS = null;     // set once via init(); table names + iteration order
let _sqldb = null;          // persistent handle; null until first successful load/save
let _rowHashes = null;      // {collection: Map(pk -> sha1)} mirror of what's on disk; null = disk state unknown, rewrite all

const _pk = k => (k === 'auditLog' ? 'seq' : 'id');
const _rowHash = s => crypto.createHash('sha1').update(s).digest('base64');

function init(collections) { COLLECTIONS = collections; }

function _openSqlite(file) {
  const db = new Database(file);
  try {
    COLLECTIONS.forEach(k => {
      const pk = _pk(k);
      db.exec(`CREATE TABLE IF NOT EXISTS "${k}" (${pk} ${pk === 'seq' ? 'INTEGER' : 'TEXT'} PRIMARY KEY, data TEXT NOT NULL)`);
    });
  } catch (e) {
    // A corrupt/non-sqlite file throws here (on the first schema touch, not the
    // constructor) — close the handle before rethrowing so Windows releases its
    // lock immediately. Without this, the caller's recovery rename over this same
    // path fails with EPERM (found via the chaos harness's corrupt-DB scenario).
    db.close();
    throw e;
  }
  return db;
}

function _openLive(file) {
  const db = _openSqlite(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL'); // fsync on checkpoint, not every commit — WAL keeps commits durable-enough (power-loss window = last checkpoint)
  return db;
}

function _readAllFromSqlite(db) {
  const out = {};
  COLLECTIONS.forEach(k => {
    out[k] = db.prepare(`SELECT data FROM "${k}" ORDER BY ${_pk(k)}`).all().map(r => JSON.parse(r.data));
  });
  return out;
}

function _writeAllToSqlite(db, data) {
  db.transaction(() => {
    COLLECTIONS.forEach(k => {
      const pk = _pk(k);
      db.prepare(`DELETE FROM "${k}"`).run();
      const insert = db.prepare(`INSERT INTO "${k}" (${pk}, data) VALUES (?, ?)`);
      for (const row of data[k]) insert.run(row[pk], JSON.stringify(row));
    });
  })();
}

function _hashAll(db) {
  const out = {};
  COLLECTIONS.forEach(k => {
    out[k] = new Map(db.prepare(`SELECT ${_pk(k)} pk, data FROM "${k}"`).all().map(r => [r.pk, _rowHash(r.data)]));
  });
  return out;
}

// Flush `data` to the live handle, writing only changed/new rows and deleting
// removed ones. With _rowHashes === null (fresh handle, or memory was swapped
// by a restore) every table is cleared and rewritten.
function _flushIncremental(db, data) {
  const next = {};
  const work = []; // [{k, upserts:[[pk,json]], deletes:[pk]}]
  COLLECTIONS.forEach(k => {
    const prev = _rowHashes && _rowHashes[k];
    const map = new Map(); const upserts = [];
    for (const row of data[k]) {
      const s = JSON.stringify(row); const pk = row[_pk(k)]; const h = _rowHash(s);
      map.set(pk, h);
      if (!prev || prev.get(pk) !== h) upserts.push([pk, s]);
    }
    const deletes = [];
    if (prev) { for (const pk of prev.keys()) if (!map.has(pk)) deletes.push(pk); }
    next[k] = map;
    if (upserts.length || deletes.length || !prev) work.push({ k, upserts, deletes, wipe: !prev });
  });
  if (work.length) {
    db.transaction(() => {
      for (const { k, upserts, deletes, wipe } of work) {
        const pk = _pk(k);
        if (wipe) db.prepare(`DELETE FROM "${k}"`).run();
        const up = db.prepare(`INSERT OR REPLACE INTO "${k}" (${pk}, data) VALUES (?, ?)`);
        for (const [id, s] of upserts) up.run(id, s);
        if (deletes.length) { const del = db.prepare(`DELETE FROM "${k}" WHERE ${pk} = ?`); for (const id of deletes) del.run(id); }
      }
    })();
  }
  _rowHashes = next; // only after commit — a throw above leaves the old mirror intact
}

// ── Public API ──────────────────────────────────────────────────────

// Open `file` as the live handle and return its full contents. Closes any
// previous handle first (tests re-load onto fresh temp files). On any failure
// the handle is released before the error propagates.
function load(file) {
  close();
  try {
    _sqldb = _openLive(file);
    const data = _readAllFromSqlite(_sqldb);
    _rowHashes = _hashAll(_sqldb); // mirror of on-disk state -> first flush only writes real changes
    return data;
  } catch (e) { close(); throw e; }
}

// Persist `data`. Normal path: incremental flush over the live WAL handle (only
// changed rows touch disk). Fallback path (no healthy handle — first boot, or
// the primary file was corrupt): build a fresh sqlite file at a temp path and
// atomically rename it over the primary, then adopt it as the live handle.
function save(file, data) {
  if (!_sqldb) {
    const tmp = file + '.' + process.pid + '.tmp';
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
    const db = _openSqlite(tmp);
    _writeAllToSqlite(db, data);
    db.close();
    // A leftover -wal/-shm from the file being replaced must not be paired
    // with the fresh file (SQLite would try to replay the stale WAL into it).
    for (const ext of ['-wal', '-shm']) { try { fs.rmSync(file + ext, { force: true }); } catch { /* best effort */ } }
    fs.renameSync(tmp, file);
    _sqldb = _openLive(file);
    _rowHashes = _hashAll(_sqldb);
  } else {
    _flushIncremental(_sqldb, data);
  }
}

function close() {
  if (_sqldb) { try { _sqldb.close(); } catch { /* already closed */ } _sqldb = null; _rowHashes = null; }
}

// WAL keeps recent commits in the -wal sidecar; checkpoint before a file copy
// so the main file alone is a complete snapshot.
function checkpoint() {
  if (_sqldb) { try { _sqldb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* copy still valid, just older */ } }
}

// Read a snapshot file without adopting it as the live handle (restore path).
function readBackup(file) {
  const db = _openSqlite(file);
  try { return _readAllFromSqlite(db); } finally { db.close(); }
}

module.exports = { init, load, save, close, checkpoint, readBackup };
