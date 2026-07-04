# Disaster Recovery Plan

## Objectives

| Metric | Target | Basis |
|---|---|---|
| **RPO** (max data loss) | ≤ 30 minutes | Snapshot cadence (`backupSnapshot()` every 30 min) + on-boot snapshot |
| **RTO** (max downtime) | ≤ 15 minutes | Stateless app + single-file restore (`scripts/restore.js`) |

These assume managed hosting (Railway/equivalent) with a **persistent volume** for `db.sqlite`
and `backups/`. On ephemeral filesystems, push snapshots to off-box storage (see below) or the
effective RPO is "since last deploy."

## What can fail, and the response

| Failure | Detection | Response |
|---|---|---|
| Corrupt `db.sqlite` | Boot log + `/api/health/ready` shows `db: degraded` | On boot the app auto-restores the newest valid backup, else reseeds, then **rewrites** a healthy `db.sqlite` |
| Bad deploy | Smoke check / health endpoint | Roll back to previous image; data is decoupled from code |
| Disk/volume loss | Platform alert | Re-provision volume, run `node scripts/restore.js --force` from the latest off-box snapshot |
| Process crash | Platform restart / health check | App reloads DB on boot; in-flight writes are atomic so no torn file |
| Failed write (disk full) | `/api/health/ready` → 503, logs | App keeps serving from memory; fix disk, writes resume; no crash |
| Secret compromise | — | Rotate `JWT_SECRET` (invalidates all sessions + calendar feeds), redeploy |

## Backup & restore runbook

```bash
# Manual snapshot (also runs automatically on boot and every 30 min)
node scripts/backup.js          # -> backups/db-<timestamp>.sqlite  (keeps newest 48)

# Restore the newest valid snapshot (snapshots current state first for safety)
node scripts/restore.js --force # overwrites db.sqlite, then app loads it on next boot
```

Health checks for load balancers / uptime monitors:
- **Liveness:** `GET /api/health` → `200 {status:"ok"}`
- **Readiness:** `GET /api/health/ready` → `200` when DB is healthy, `503` when degraded

## Off-box backups (recommended for production)
The built-in snapshots protect against corruption and bad deploys but live on the same host.
For true DR, copy `backups/` to durable off-box storage on a schedule, e.g. a cron/job that
runs `node scripts/backup.js` then syncs `backups/` to S3/R2/GCS. Restore = pull the newest
object into `backups/` and run `scripts/restore.js --force`.

## Verification
`scripts/chaos.js` exercises corrupt-DB recovery and graceful-shutdown durability on every CI
run, so the recovery paths above are continuously tested, not just documented.
