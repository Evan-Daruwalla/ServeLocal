# ServeLocal — Architecture

ServeLocal connects students with vetted community-service opportunities. Students use it
free forever; revenue comes from organization Pro plans and community donations.

## System overview

```mermaid
flowchart TB
  subgraph Client["Browser (single-page app)"]
    SPA["public/index.html<br/>HTML + CSS + vanilla JS<br/>hash router, api() wrapper<br/>(retry/backoff, idempotency,<br/>session-expiry handling)"]
  end

  subgraph Server["Node.js process (server.js, one runtime dep: better-sqlite3)"]
    MW["Request pipeline<br/>rate limit → auth (JWT) →<br/>RBAC → idempotency → handler"]
    SEC["Security/resilience layer<br/>sanitize · cache · circuit breaker<br/>audit log · security headers"]
    JOBS["Background jobs<br/>reminders · hours sweep<br/>backups · retention purge"]
    DB[("In-memory DB<br/>(hydrated from SQLite, atomic file persist)")]
  end

  subgraph Ext["External (optional)"]
    ZIP["zippopotam.us<br/>(ZIP → coords)"]
    RESEND["Resend<br/>(email)"]
    CAL["Calendar apps<br/>(webcal .ics feed)"]
  end

  FS[["db.sqlite + backups/<br/>(disk)"]]

  SPA -->|"HTTPS / fetch JSON"| MW
  MW --> SEC --> DB
  DB <-->|"atomic write / load + restore"| FS
  SEC -->|"circuit breaker"| ZIP
  SEC -.->|"transactional email"| RESEND
  SPA -->|"subscribe"| CAL
  CAL -->|"GET .ics (HMAC token)"| MW
  JOBS --> DB
```

## Components

| Layer | File | Responsibility |
|---|---|---|
| SPA | `public/index.html` | Entire frontend: views, hash routing, resilient `api()` client, accessibility |
| HTTP server | `server.js` | Routing, auth, RBAC, all business logic, persistence, background jobs |
| Persistence | `db.sqlite` (+ `backups/`) | One SQLite table per collection, loaded fully into memory at boot; atomic temp-file + rename writes (ADR-0013) |
| Tests | `test/` | `unit`, `integration` (in-process HTTP), `regression` via Node's built-in runner |
| Ops scripts | `scripts/` | `loadtest`, `chaos`, `backup`, `restore` (all zero-dependency) |
| CI | `.github/workflows/ci.yml` | Tests (Node 20/22), coverage floor, chaos, `npm audit` |

## Request lifecycle

1. **Rate limit** — per-IP token bucket (tighter for writes). 429 + `Retry-After` when exceeded.
2. **Body parse** — 1 MB cap, JSON.
3. **Auth** — `Authorization: Bearer <JWT>`; HMAC-verified; `tokenVersion` checked for revocation.
4. **Idempotency** — for mutating requests carrying `Idempotency-Key`, replay the prior response.
5. **Handler** — validates/sanitizes input, enforces role + tenant ownership, mutates the in-memory DB.
6. **Persist** — `saveDB()` writes atomically (temp + rename) and invalidates read caches.
7. **Audit** — security-relevant actions append a hash-chained entry.
8. **Respond** — JSON with security headers (CSP, HSTS in prod, anti-clickjacking, nosniff).

## Key design decisions

See the Architecture Decision Records in [`docs/adr/`](./adr/). Highlights:

- **ADR-0001** Zero npm runtime dependencies by default (auditable, tiny attack surface); new deps
  require their own ADR — see ADR-0013.
- **ADR-0002** JSON-file database with atomic writes + snapshots (superseded by ADR-0013 for the
  on-disk format; the in-memory-model reasoning still holds).
- **ADR-0003** Stateless HMAC JWT auth with `tokenVersion` revocation.
- **ADR-0004** Demo-mode billing until Stripe is wired (see `DEPLOY.txt` §9).
- **ADR-0005** Hash-chained, tamper-evident audit log.
- **ADR-0006** In-memory token-bucket rate limiting + circuit breaker for external calls.
- **ADR-0007** CSP retains `unsafe-inline` for the intentionally inline-everything SPA.
- **ADR-0008** Coarse cache invalidation: every write bumps a global cache version.
- **ADR-0013** SQLite persistence (replaces the whole-JSON-file store) + `/api/opportunities`
  pagination — removes the confirmed ~90k-user serialization ceiling from ADR-0012's load testing.

## Scaling notes (known limits)

Persistence moved from a single JSON document to SQLite (ADR-0013), which removed the confirmed
`Invalid string length` ceiling at ~90k users — verified at 100k users (763 MB DB, 0 errors). The
in-memory model is still single-node: every collection loads fully into memory at boot, same as
before. The next migration step, if the in-memory-RAM ceiling is ever actually hit, is pushing
queries down to SQL (indexed `WHERE`/`LIMIT`) instead of loading everything and filtering in JS —
not done yet (see ADR-0013 "Not done here"). The persistence layer is isolated to `loadDB`/
`saveDB`, so swapping the backend further is contained.
