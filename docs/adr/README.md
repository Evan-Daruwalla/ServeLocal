# Architecture Decision Records

Short records of significant, hard-to-reverse decisions. Format: Context → Decision →
Consequences. Add a new numbered file (don't edit accepted ones; supersede instead).

- [0001 — Zero npm runtime dependencies](./0001-zero-dependency-architecture.md)
- [0002 — JSON-file database with atomic writes & snapshots](./0002-json-file-database.md)
- [0003 — Stateless HMAC-JWT auth with tokenVersion revocation](./0003-jwt-auth-token-revocation.md)
- [0004 — Demo-mode billing until Stripe is configured](./0004-demo-mode-billing.md)
- [0005 — Hash-chained, tamper-evident audit log](./0005-hash-chained-audit-log.md)
- [0006 — In-memory rate limiting & circuit breaker](./0006-rate-limiting-and-circuit-breaker.md)
- [0007 — CSP retains `unsafe-inline` for the inline SPA](./0007-csp-unsafe-inline-tradeoff.md)
- [0008 — Coarse cache invalidation by global version bump](./0008-cache-invalidation-strategy.md)
- [0009 — scrypt password hashing with transparent migration](./0009-scrypt-password-hashing.md)
- [0010 — Guardian consent is a precondition, not a feature](./0010-guardian-consent-precondition.md)
- [0011 — In-memory indexes over the JSON store](./0011-in-memory-indexes.md)
- [0012 — Server-cost optimizations for large user counts](./0012-scaling-cost-optimizations.md)
- [0013 — SQLite persistence (replaces the whole-JSON-file store)](./0013-sqlite-persistence.md)
