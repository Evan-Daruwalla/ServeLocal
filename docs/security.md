# ServeLocal — Security & Operational Controls

This document maps each requested protection to its concrete implementation (code, test,
script, or policy). "Code" entries cite `server.js` / `public/index.html`; "Test" entries cite
`test/`; deployment-only items are marked and cross-referenced to `DEPLOY.txt`.

## Controls matrix

| # | Control | Status | Where it lives |
|---|---|---|---|
| 1 | **Input sanitization & injection prevention** | ✅ Code + Test | Server: `sstr()`/`clampNum()`/`isEmail()` sanitize at write time (titles, descriptions, messages, reviews, donations). Client: `esc()` (HTML, incl. `'`), `jsq()` (JS-string contexts), `safeHref()` (blocks `javascript:`). No SQL (JSON store). Static serving is path-traversal-safe (`serveStatic` resolves + contains to `public/`). Tests: `unit.test.js`, `integration.test.js` (leak/escape), `regression.test.js` (incl. `../` traversal → 404). |
| 2 | **AuthN, AuthZ, roles & permissions** | ✅ Code + Test | **scrypt** password hashing (`hashPasswordScrypt`/`verifyPassword`, OWASP-recommended slow KDF) with transparent migration of legacy HMAC hashes on login; **constant-time** comparisons (`timingSafeEqual`) for passwords and token signatures; **weak-password denylist** at register/change; password-change flow (`POST /api/account/password`). HMAC-JWT (`makeToken`/`verifyToken`/`getUser`); roles `student`/`org`/`admin`; `requireRole()` + per-handler ownership checks; multi-tenant isolation by `orgId`/`userId`. Tests: scrypt round-trip, weak-pw, password-change, RBAC, tenant isolation. |
| 3 | **Session management & token expiry** | ✅ Code | Configurable TTL (`TOKEN_TTL_HOURS`, default 7d); `iat`/`exp` claims; `tokenVersion` revocation; `POST /api/auth/signout-all`; suspend and password-change bump the version. Client auto-logs-out on 401. Test: `signout-all` + `password change ... revokes other sessions`. |
| 3b | **Password reset (self-service)** | ✅ Code + Test | `POST /api/auth/forgot` + `POST /api/auth/reset`: sha256-hashed single-use token, 1-hour TTL, anti-enumeration (identical 200 for known/unknown emails), throttled 3/15 min per IP+email, weak-password denylist on the new password, `tokenVersion` bump revokes all sessions, audited. `safeUser()` never serializes token fields. Tests: `test/password-reset.test.js` (5 cases). |
| 3c | **MFA (TOTP, RFC 6238)** | ✅ Code + Test | Zero-dep `lib/totp.js` (HMAC-SHA1, 6 digits, 30s, ±1 drift, constant-time compare). Enrollment: `mfa/setup` (pending secret + otpauth URI) → `mfa/enable` (live-code confirm; 8 one-time backup codes stored sha256-hashed, shown once). Login becomes two-step: password → hashed single-use 5-min ticket → `mfa/verify` (throttled 8/15 min). Disable requires a valid code and revokes all sessions. Secrets never serialized (`safeUser`). Tests: `test/mfa.test.js` (6 cases). |
| 4 | **Secrets management** | ✅ Code + Policy | `.env` loader; **prod refuses to boot on default `JWT_SECRET` or default `ADMIN_PASSWORD`** (seeded admin password is public in source); credentials printed to boot log in dev only; `.env.example`; `.gitignore` excludes `.env`/`*.pem`. Rotation notes in `.env.example` & DR doc. Test: `regression.test.js` (prod boot refused with default admin password). |
| 5 | **HTTPS / TLS / cert rotation** | ✅ Code + Deploy | Optional direct TLS via `SSL_CERT`/`SSL_KEY` (`buildServer`); HSTS header in prod; rotation = replace PEMs + restart, or terminate at proxy (Railway auto-TLS, `DEPLOY.txt` §3). |
| 6 | **Rate limiting & abuse prevention** | ✅ Code + Test | Per-IP token bucket (`rateLimit`, tighter for writes) + login throttle (8/15 min). Tests: burst → 429; load/chaos scripts exercise it. |
| 7 | **Dependency scanning & patching** | ✅ CI + Policy | Zero runtime deps (ADR-0001); `npm audit --audit-level=high` in CI; Dependabot (`.github/dependabot.yml`) for actions + npm. |
| 8 | **Multi-tenancy & data isolation** | ✅ Code + Test | Every org/student resource is filtered by owner id; `publicOpp()` strips org-internal fields (check-in codes, views, org email) from public/student responses. Tests: leak checks + inactive-listing 404. |
| 9 | **PII handling, retention & deletion** | ✅ Code + Policy | Data export (`GET /api/account/export`), right-to-erasure (`DELETE /api/account`), hourly retention purge (`retentionPurge`). Policy: `docs/privacy.md`, `docs/data-retention.md`. |
| 10 | **Regulatory compliance (GDPR / HIPAA)** | ✅ Policy + Code | GDPR controls implemented (access, portability, erasure, minimization). HIPAA: out of scope — ServeLocal handles no PHI and is not a covered entity (`docs/compliance.md`). |
| 8b | **CORS lockdown** | ✅ Code | `ALLOWED_ORIGINS` env switches CORS from permissive `*` (dev) to an exact-origin allowlist (`resolveCors`, adds `Vary: Origin`). |
| 8c | **Reduced info disclosure** | ✅ Code | `/api/health/ready` no longer exposes internal error strings; `security.txt` at `/.well-known/` (RFC 9116). |
| 11 | **Audit trails & tamper-evident logging** | ✅ Code + Test | Hash-chained `auditLog` (`appendAudit`/`verifyAuditChain`); admin-only `GET /api/admin/audit[/verify]`. Tests: chain valid + tamper detection (unit + integration). |
| 12 | **Unit / integration / e2e tests** | ✅ Tests | `test/unit.test.js` (helpers), `test/integration.test.js` (in-process HTTP e2e). `npm test`. |
| 13 | **Regression tests** | ✅ Tests | `test/regression.test.js` locks in every fix from the security audit. |
| 14 | **Load & stress testing** | ✅ Script | `scripts/loadtest.js` — concurrency, p50/p90/p99, throughput. `npm run loadtest`. |
| 15 | **Chaos / resilience testing** | ✅ Script + CI | `scripts/chaos.js` — flood, corrupt-DB recovery, graceful-shutdown durability. Runs in CI. |
| 16 | **Coverage thresholds in CI** | ✅ CI | `npm run coverage:check` enforces lines ≥50 / branches ≥70 / functions ≥30 (`--test-coverage-*`). |
| 17 | **Code review process & standards** | ✅ Policy | `CONTRIBUTING.md`, PR template, `CODEOWNERS` (required review). |
| 18 | **Error handling & graceful degradation** | ✅ Code | Central router catch → 500 (no internals leaked); failed `saveDB` keeps serving from memory and flips `/api/health/ready` to 503; corrupt DB recovers from backup/reseed on boot. |
| 19 | **Retry / backoff & idempotency** | ✅ Code + Test | Client `api()` retries idempotent calls with backoff; `Idempotency-Key` replay on mutating routes (donations/apply/checkin/waitlist/billing). Test: duplicate key applies once. |
| 20 | **Circuit breakers & fallback** | ✅ Code + Test | `makeBreaker()` wraps the external geocode call (fail-fast + cached fallback); state surfaced at `/api/health/ready`. Unit test for open/recover. |
| 21 | **Concurrency & race-condition prevention** | ✅ Code | Single-threaded handlers are atomic between awaits; persistence uses atomic temp-file + rename (no torn writes); spot-accounting recomputed on each transition with waitlist promotion. |
| 22 | **Caching strategy & invalidation** | ✅ Code | TTL read cache for `stats`/`leaderboard`/`geocode`; **every write bumps a global cache version** (no stale reads); static assets get `ETag` + `Cache-Control`, HTML always revalidates. |
| 23 | **RTO & RPO** | ✅ Policy + Code | RPO ≤ 30 min (snapshot cadence), RTO ≤ 15 min (restore script). `docs/disaster-recovery.md`. |
| 24 | **Disaster recovery plan** | ✅ Policy + Script | `scripts/backup.js` / `scripts/restore.js`; on-boot snapshot; runbook in `docs/disaster-recovery.md`. |
| 25 | **Accessibility** | ✅ Code | Skip link, `<main>` landmark, ARIA roles/labels on nav/dialogs/icon buttons, `aria-live` toast, modal focus management + restore, keyboard activation, `prefers-reduced-motion`. |
| 26 | **Architecture diagrams & ADRs** | ✅ Docs | `docs/architecture.md` (Mermaid), `docs/adr/*`. |

## Threat model (summary)

- **Assets:** student PII (name, DOB, school), verified-hours records, org accounts, auth secret.
- **Primary threats & mitigations:**
  - *Stored XSS* → output escaping (`esc`/`jsq`) + input sanitization + CSP.
  - *IDOR / data leakage* → ownership checks on every resource + `publicOpp()` field stripping.
  - *Privilege escalation* → `requireRole()` + role checks; suspend revokes tokens.
  - *Credential stuffing / brute force* → login throttle + global rate limit.
  - *Token theft / replay* → short TTL + `tokenVersion` revocation; HTTPS/HSTS in prod.
  - *Fraudulent hours* → check-in codes are server-only (never serialized to students); hours need org verification or a valid in-person code.
  - *Tampering with records* → hash-chained audit log detects after-the-fact edits.
  - *Path traversal / arbitrary file read* → `serveStatic` resolves each request path and requires containment within `public/` (blocks `GET /../db.json`, `/../.env`, etc.). Regression-tested in `test/regression.test.js`.
  - *Data loss* → atomic writes + 30-min snapshots + restore runbook.

## Consciously deferred (residual risk, documented)

These were evaluated and deferred deliberately — each is a model-changing effort with its own
risk, not an oversight:

- **JWT in `localStorage` → HttpOnly cookie + in-memory access token.** OWASP prefers not storing
  session tokens in `localStorage`. We mitigate the underlying XSS heavily (output escaping +
  CSP), so this is residual risk. Moving to an HttpOnly refresh cookie changes the auth model and
  reintroduces CSRF handling; tracked as a future task.
- **CAPTCHA / bot-defense on signup.** Needs a third-party service; deferred. (Password reset and
  MFA/TOTP — formerly listed here — shipped 2026-07-04/05: see controls 3b and 3c.)

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md) at the repo root.
