# ADR-0002: JSON-file database with atomic writes and snapshots

**Status:** Accepted (with a documented migration path)

## Context
The dataset is small and read-heavy. A full RDBMS would add operational weight and a runtime
dependency (ADR-0001) before it is justified by scale.

## Decision
Persist the entire database as a single JSON document loaded into memory. Writes go through
`saveDB()`, which serializes and writes **atomically** (temp file + `rename`) so a crash can
never leave a torn file. `backupSnapshot()` keeps the newest 48 timestamped snapshots. On boot,
a corrupt file triggers restore-from-newest-backup, else reseed, and the healthy state is
written back to disk.

## Consequences
- **Pros:** no DB to run; atomic and snapshotted; the whole store fits in memory for fast reads;
  persistence is isolated to `loadDB`/`saveDB`.
- **Cons:** single-node only; no concurrent multi-process writers; whole-file rewrite per save.
- **Migration path:** (1) put `db.json` + `backups/` on a persistent volume; (2) when write
  volume or dataset size demands it, move to Postgres behind the same `loadDB`/`saveDB` seam.
  Tracked in `DEPLOY.txt` and `docs/architecture.md`.
