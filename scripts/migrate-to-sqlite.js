#!/usr/bin/env node
// One-time migration: db.json (old whole-JSON-file store, ADR-0002) -> db.sqlite
// (ADR-0013, per-row SQLite persistence — removes the ~90k-user V8 string-length
// ceiling documented in ADR-0012). The old db.json is left untouched on disk.
// Usage: npm run migrate:sqlite                (db.json -> db.sqlite, both next to server.js)
//        node scripts/migrate-to-sqlite.js --force   (overwrite an existing db.sqlite)
const fs = require('fs');
const path = require('path');

const JSON_FILE = process.env.OLD_DB_FILE || path.join(__dirname, '..', 'db.json');
const SQLITE_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.sqlite');

if (!fs.existsSync(JSON_FILE)) { console.error('No db.json found at', JSON_FILE, '— nothing to migrate.'); process.exit(1); }
if (fs.existsSync(SQLITE_FILE) && !process.argv.includes('--force')) {
  console.error(SQLITE_FILE, 'already exists. Re-run with --force to overwrite it.'); process.exit(1);
}

const srv = require('../server.js');
srv.DB = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
srv.saveDB();
console.log('✅ Migrated', JSON_FILE, '->', SQLITE_FILE);
