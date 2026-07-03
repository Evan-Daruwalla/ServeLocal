# Regulatory Compliance

## GDPR (and similar regimes: UK GDPR, CCPA/CPRA)

ServeLocal is designed so the technical controls a controller needs are already in place.
Operational/legal obligations (DPA, privacy notice, lawful basis, DPO if required) are the
deploying organization's responsibility.

| GDPR principle / right | Implementation |
|---|---|
| Lawfulness, fairness, transparency | Privacy notice (`docs/privacy.md`); clear free-for-students model |
| Data minimization | Only fields needed for service/awards; `publicOpp()` strips extras |
| Right of access (Art. 15) | `GET /api/account/export` |
| Right to data portability (Art. 20) | Export is machine-readable JSON |
| Right to erasure (Art. 17) | `DELETE /api/account` + backup-purge guidance |
| Right to rectification (Art. 16) | Profile editing |
| Storage limitation | `docs/data-retention.md` + automated purge |
| Integrity & confidentiality (Art. 32) | Hashed passwords, TLS/HSTS, RBAC, rate limiting, audit log, atomic backups |
| Accountability | Tamper-evident audit trail; controls matrix (`docs/security.md`) |
| Breach notification | DR/runbook + audit trail support timely investigation (`docs/disaster-recovery.md`) |

**Minors:** minimum age 12; for school deployments obtain parental/guardian consent per local
law (COPPA/FERPA in the US) before onboarding.

## HIPAA — out of scope (no PHI)

ServeLocal is **not** a HIPAA covered entity or business associate and processes **no Protected
Health Information**. It records volunteer scheduling and verified service hours, not health,
treatment, or payment-for-care data. "Health" appears only as a volunteer *interest category*,
which is not PHI.

If a future deployment were to handle PHI (e.g., partnering with a healthcare provider on
medical-volunteer data), HIPAA would require additional controls **not** implemented here:
Business Associate Agreements, encryption at rest, stricter access logging/retention, and a
formal risk assessment. Do not store PHI in ServeLocal without that work.

## SOC 2 / ISO 27001 readiness (informational)
The audit trail, access control, change-management (CI + CODEOWNERS), backup/DR, and the
controls matrix provide evidence aligned with common Trust Services Criteria, but no formal
attestation has been performed.
