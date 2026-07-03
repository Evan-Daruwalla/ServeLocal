# ADR-0005: Hash-chained, tamper-evident audit log

**Status:** Accepted

## Context
Security and compliance (accountability, breach investigation) require a trustworthy record of
sensitive actions. A plain log can be edited after the fact, especially in a JSON-file store.

## Decision
Maintain an append-only `auditLog`. Each entry embeds `prevHash` and a SHA-256 `hash` over
`(prevHash + canonical entry)`, forming a chain (`appendAudit`). `verifyAuditChain()`
recomputes the chain and reports the first broken entry, so any edit or deletion of a past
entry is detectable. Entries store actor **ids** and non-PII metadata. Read access is
admin-only (`GET /api/admin/audit[/verify]`).

## Logged actions
Login success/failure, sign-out-all, org approve/reject/suspend, account deletion, plan
upgrade/downgrade, opportunity creation, check-in code generation + redemption, data export,
donations.

## Consequences
- **Pros:** tamper-evidence without external infra; cheap; verifiable on demand and in tests.
- **Cons:** detection (not prevention) — an attacker with write access could rebuild the whole
  chain; mitigate by shipping entries off-box in production. Growth is unbounded; rotate at
  deploy time preserving chain continuity (note the last hash as the next genesis).
