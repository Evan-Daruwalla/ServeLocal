# Data Retention Policy

Enforced automatically by `retentionPurge()` (runs hourly; also runnable on demand) and by
user-initiated deletion. The goal is to hold personal and derived data no longer than needed.

| Data | Retention | Mechanism |
|---|---|---|
| Account + profile (PII) | Until the user deletes the account | `DELETE /api/account` (right to erasure) |
| Read notifications | 90 days | `retentionPurge()` deletes read notifications older than 90d |
| Unread notifications | Kept until read, then 90 days | same |
| Resolved reports | 1 year | `retentionPurge()` |
| Open reports | Until resolved | — |
| Event check-in codes | Expire after 12h; purged ~24h after expiry | `retentionPurge()` |
| Audit log | Retained (tamper-evident chain) | Append-only; rotate at deploy time if it grows large (preserve chain continuity) |
| DB backups | Most recent 48 snapshots (~24h at 30-min cadence) | `backupSnapshot()` prunes older snapshots |
| Auth tokens | Stateless; expire at TTL (default 7d) or on `tokenVersion` bump | no server-side storage |
| Rate-limit / login-throttle / idempotency state | In-memory, minutes | TTL eviction; lost on restart by design |

## Deletion guarantees
Account deletion removes the user, their applications, hours, reviews, endorsements,
notifications, and messages, and (for orgs) their listings and related applications/messages.
A non-PII record of the deletion is written to the audit log for accountability.

## Backups & deleted data
Deleted records may persist in DB snapshots until those snapshots age out (≤24h). Backups are
access-controlled and excluded from version control (`.gitignore`). For a hard "forget me"
guarantee within the backup window, purge snapshots after processing an erasure request.
