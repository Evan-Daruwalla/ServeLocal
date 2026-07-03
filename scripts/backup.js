#!/usr/bin/env node
// Manual DB backup: snapshot db.json into backups/ (timestamped, pruned to 48).
// Usage: npm run backup   (or  node scripts/backup.js)
const srv = require('../server.js');
const dest = srv.backupSnapshot();
if (dest) { console.log('✅ Backup written:', dest); process.exit(0); }
console.error('⚠️  No db.json found to back up.'); process.exit(1);
