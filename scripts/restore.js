#!/usr/bin/env node
// Restore db.sqlite from the newest valid backup snapshot (disaster recovery).
// Safety: snapshots the current db.sqlite first, so a restore is itself reversible.
// Usage: node scripts/restore.js --force
const srv = require('../server.js');

if (!process.argv.includes('--force')) {
  console.log('This OVERWRITES db.sqlite with the newest backup snapshot.');
  console.log('Re-run with --force to proceed:  node scripts/restore.js --force');
  process.exit(0);
}

srv.backupSnapshot(); // safety snapshot of current state before overwriting
const ok = srv.restoreFromBackup(); // loads newest backup into memory
if (ok) { srv.saveDB(); console.log('✅ Restored db.sqlite from newest backup.'); process.exit(0); }
console.error('⚠️  No backup snapshot found to restore from.'); process.exit(1);
