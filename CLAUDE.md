# ServeLocal

Volunteer platform connecting students with community service opportunities.

## Quick Start

```bash
node server.js
```

Server runs on `http://localhost:3000` (or PORT env var).

## Architecture

- **Near-zero dependencies** — pure Node.js `http` module, no frameworks. One runtime dependency
  (`better-sqlite3`, ADR-0013), a documented exception to the zero-dep default (ADR-0001)
- **Single-page app** — all frontend HTML/CSS lives in `public/index.html`; the JS was extracted to
  `public/index.html` → `public/app.js` (ADR-0014, `<script src="/app.js" defer>`)
- **SQLite-backed DB (ADR-0013)** — `db.sqlite` in project root, auto-created on first run. One
  dependency (`better-sqlite3`), a documented exception to ADR-0001
- **Server** — `server.js` at project root handles API routes and static file serving

## Project Structure

```
ServeLocal website/
  server.js          # Backend — API routes, routing, static serving, domain logic
  lib/               # Extracted pure-mechanism modules (ADR-0015)
    persist.js       #   SQLite/WAL persistence (owns better-sqlite3)
    auth.js          #   scrypt hashing, weak-pw denylist, HMAC-JWT, hashToken
    totp.js          #   RFC 6238 TOTP for MFA
  public/
    index.html       # Frontend SPA shell (HTML + CSS); loads app.js
    app.js           # Entire frontend SPA JavaScript (ADR-0014)
    emoji/           # Self-hosted Twemoji PNGs (CC-BY) + manifest.json
    servelocal-logo.png  # Master brand logo (used directly as the nav/footer mark)
    *.png            # Derived brand assets: favicon-16/32, apple-touch-icon, og-image
  scripts/genbrand.js  # Regenerates derived brand PNGs from the master logo (zero-dep)
  .env               # Optional — PORT, etc.
  db.sqlite          # Auto-generated database (do not commit)
```

## Key Concepts

- **Roles**: `student` and `org` (organization)
- **Opportunities**: Created by orgs, can be One-time, Weekly, or Monthly
- **Applications**: Students apply/subscribe to opps; can be auto-approved or require approval
- **Recurring events**: Students can subscribe (all dates) or sign up for single days; can skip/exclude individual dates
- **Hours**: Auto-logged as `pending` when event dates pass; orgs verify/deny attendance (bulk verify available)
- **Awards**: Nationally recognized volunteer milestones tracked by verified hours
- **Plans**: Orgs are `free` (Community: 3 active listings) or `pro` ($19/mo: unlimited + 3 featured listings, analytics, roster export). Defined in `PLANS` in server.js. Students are free forever — never gate student features.
- **Featured**: Pro orgs pin up to 3 listings to the top of Discover (`opp.featured`)
- **Waitlist**: One-time events only; application `status:'waitlisted'`, auto-promoted FIFO when a spot frees (`promoteFromWaitlist`)
- **Analytics**: `opp.views` incremented via `POST /api/opportunities/:id/view` beacon; org dashboard reads `/api/org/analytics`
- **Billing & donations**: DEMO mode — no real payments until Stripe keys are configured (see DEPLOY.txt §9)
- **Leaderboard**: `/api/leaderboard` is public but only exposes first name + last initial
- **Check-in codes**: Orgs generate a 6-char code per event date (`opp.checkinCodes`); students redeem at `POST /api/checkin` for instantly-verified hours (requires approved signup)
- **Bookmarks**: `user.savedOpps` toggled via `PATCH /api/saved-opps/:oppId`; hearts in Discover + Saved tab in student dash
- **Deep links**: hash routing (`#discover`, `#opp/<id>`, `#org/<orgId>`, `#portfolio/<userId>`, etc.) via `routeFromHash()`; views push history with `pushHash()` — guard with `_routing` flag to avoid loops
- **Guardian consent (minors only)**: students under 18 need a verified guardian email before they can apply/message/check-in/be endorsed — `requireGuardianConsent(user)` recomputes age from `dob` live, so 18+ students are never gated and a pending minor who ages into 18 is unblocked automatically. Full spec: `docs/guardian-consent-spec.md` (ADR-0010). Public flow at `#consent/<token>` (approve/decline) and `#consent-manage/<token>` (revoke anytime — the kill switch). Existing pre-launch accounts need `npm run migrate:guardian-consent` once.

## Security & Ops Infrastructure (server.js, zero-dep)
- Full controls matrix in `docs/security.md`; architecture in `docs/architecture.md`; decisions in `docs/adr/`.
- **Request pipeline**: rate limit (`rateLimit`, per-IP token bucket) → auth (`getUser`, checks `tokenVersion`) → idempotency (`Idempotency-Key` replay via `respond()`) → handler. Security headers (CSP/HSTS/etc.) on every response via `securityHeaders()`.
- **Persistence (ADR-0013; mechanics extracted to `lib/persist.js` per ADR-0015)**: each of the 12 `DB_COLLECTIONS` is a SQLite table (`id`/`seq` primary key + a `data` JSON-blob column per row, via `better-sqlite3` — required *only* inside `lib/persist.js` now). The in-memory model is unchanged: `loadDB()` still hydrates plain `DB.<collection>` arrays and every handler still reads/writes those. `saveDB()` delegates to `persist.save()`, which flushes **incrementally** over a persistent WAL-mode handle: a per-row sha1 mirror means only changed/added/removed rows touch disk, replaced only after the transaction commits. Fallback when no healthy handle exists (first boot, corrupt-file recovery): full rewrite to a temp file + atomic rename, clearing stale `-wal`/`-shm` sidecars first. `server.js` keeps the orchestration (what to save, corrupt-file recovery from `backups/`, reseed, the `/api/health/ready` flags). `backupSnapshot()` every 30 min (RPO) calls `persist.checkpoint()` first so a bare file copy is complete. `closeDB()` (→ `persist.close()`) runs on shutdown. **`saveDBSoon()` (ADR-0012)** debounces high-frequency, low-criticality writes; any explicit `saveDB()`/shutdown flushes the pending state. Migrating an existing `db.json`: `npm run migrate:sqlite`.
- **Indexes (ADR-0011, refined by ADR-0012)**: hot lookups go through `IDX()` — Maps keyed by id (`userById`/`oppById`/`appById`/`hoursById`), foreign key (`appsByOpp`/`appsByUser`/`hoursByUser`/`notifsByUser`/`messagesByOpp`/`reviewsByOrg`/`oppsByOrg`/`endorsementsByUser`), plus `userByEmail`/`userByOrgId`. Derived state, rebuilt lazily when the `DB` ref changes or an **indexed** collection's *length* changes (structural signature) — NOT on every write, since field-only writes keep the reference-keyed Maps valid. This is safe only because the codebase never reassigns an id/FK in place nor replaces an array element in place; keep it that way. Use `IDX().xById.get(id)`, `ownedOpp(id,orgId)` for org-owned lookups, and `idxList(map,key)` for FK groups. **Never mutate the array `idxList` returns** (shared bucket / frozen empty) — spread first. `findIndex` write-path sites stay as scans. Covered by `test/index.test.js` + `test/cost-optimizations.test.js`.
- **Public-read caching (ADR-0012)**: user-agnostic GETs (opportunity list, leaderboard, stats) return via `jsonCacheable(req,res,data,key,maxAge)` — a cache-version-keyed weak ETag + short `Cache-Control` so browsers/CDNs revalidate with a 304. Only use it on responses that don't vary by user. Version-stamped static assets (`?v=`) are served immutable for a year. The opportunities handler also caches its computed page (`cacheGet`/`cacheSet`, leaderboard pattern). JSON bodies >1KB are gzipped when the client accepts it (`res._gzip`, set in `router`; handled inside `json()`).
- **Password reset**: `POST /api/auth/forgot` (always-200 — no account enumeration; sha256-hashed single-use token on the user, 1h TTL, 3-req/15min throttle) → emailed `#reset/<token>` link → `POST /api/auth/reset` (weak-password checks, bumps `tokenVersion`, audited). `safeUser()` strips `resetTokenHash`/`resetTokenExpires` — keep it that way. Tests: `test/password-reset.test.js`.
- **Check-in redemption**: O(1) via `IDX().checkinCodeByStr` — entries are HINTS (codes are field mutations, invisible to the structural rebuild; the generation site `.set()`s directly) and MUST be re-validated against `opp.checkinCodes` before use. Per-user guess throttle (10 fails/15min). Tests: `test/checkin.test.js`.
- **Audit log**: `appendAudit(actor,action,target,meta)` is hash-chained + tamper-evident; admin-only at `/api/admin/audit`. Add it to any new security-relevant action.
- **Validation**: sanitize user text server-side with `sstr()`/`clampNum()`; keep escaping output with `esc`/`jsq`/`safeHref` on the client.
- **Passwords (mechanics in `lib/auth.js`, ADR-0015)**: scrypt via `setPassword(user,pw)` / `verifyPassword(pw,user)` (never the old `hashPassword` for new creds — it's legacy/migration only). Legacy HMAC hashes auto-upgrade on login (`migrateLegacyPassword`). Block weak ones with `weakPassword()`. All secret comparisons use `crypto.timingSafeEqual`. Password change: `POST /api/account/password` (bumps `tokenVersion`). These + `makeToken`/`verifyToken`/`hashToken`/`b64u` live in `lib/auth.js` and are destructured at the top of server.js (config injected via `auth.init()`); `getUser`/`safeUser` stay in server.js (they need `IDX()`).
- **CORS**: `ALLOWED_ORIGINS` env locks down CORS in prod (default `*` in dev); `resolveCors(req)` sets `res._acao`, read by `json()`. Rate limits tunable via `RL_WRITE_CAP`/`RL_READ_CAP` etc. scrypt cost via `SCRYPT_N`.
- **MFA (TOTP, RFC 6238)** — zero-dep `lib/totp.js`. Enrollment `POST /api/auth/mfa/setup` (pending secret + otpauth URI) → `/enable` (live-code confirm, returns 8 one-time backup codes stored sha256-hashed). Login is two-step when `mfaEnabled`: password → hashed single-use 5-min ticket → `/mfa/verify` (throttled 8/15min via `loginAttempts` key `mfa|<id>`). `/disable` needs a valid code + bumps `tokenVersion`. Backup codes accepted once via `mfaCodeOk()`. `safeUser()` strips `mfaSecret`/`mfaPendingSecret`/`mfaBackupCodes`/`mfaLoginTokenHash`/`mfaLoginExpires` — keep it that way. Tests: `test/mfa.test.js`.
- **Notification email (Track 2 #1, partial)** — `createNotification()` also fires `sendEmail()` unless the user set `emailNotifications:false` (profile toggle, default on). `sendEmail` is a fire-and-forget dev stub without `RESEND_API_KEY`. Test: `test/notifications-email.test.js`.
- **One security item intentionally deferred** (documented in docs/security.md): the HttpOnly-cookie auth refactor. Don't claim it's done. (TOTP MFA shipped 2026-07-05.)
- **CSP still allows `script-src 'unsafe-inline'`** — ADR-0014 moved the SPA script to `/app.js` but ~270 inline `onclick=` handlers remain, so the exception stays until they become a dispatch table (spun-off follow-up). See the comment above `CSP` in server.js.
- **Tests**: `npm test` (node:test) — `test/unit|integration|regression`. `test/_boot.js` boots an isolated server on a temp DB via `DB_FILE`/`BACKUP_DIR` env. `npm run coverage:check` enforces the floor. `scripts/loadtest.js`, `scripts/loadtest:scale` (real HTTP, large synthetic DB, `USERS=` to scale — see ADR-0013), `scripts/chaos.js`, `scripts/backup.js`, `scripts/restore.js`. `npm run bench` (`scripts/bench.js`, `USERS=` to scale) micro-benchmarks the ADR-0012 scaling primitives (serialize / index rebuild / leaderboard / list) on a synthetic large DB — standalone, never touches the real `db.sqlite`.
- **Require-safe**: `server.js` only listens when run directly (`require.main===module`); exports `{router, buildServer, DB, helpers...}` for tests. Don't reintroduce top-level side effects.
- **Secrets**: prod refuses to boot on the default `JWT_SECRET` **or** the default `ADMIN_PASSWORD` (the seeded admin password is public in source — set `ADMIN_PASSWORD` in prod). Credentials are only printed to the boot log in dev. Config in `.env` (see `.env.example`); never commit `.env`/`db.sqlite`/`backups/`.

## Demo Credentials

- **Student**: `student@demo.com` / `demo1234`
- **Org**: `org@demo.com` / `demo1234`

## API Pattern

All routes are in `server.js` as `if (method==='GET' && p==='/api/...')` blocks. No router library. JSON request/response via helper functions `json(res, data, status)` and `parseBody(req)`.

## Important Notes

- `db.sqlite` is the entire database — it resets to seed data if deleted
- `expandRecurring()` in the frontend expands weekly/monthly apps into per-day calendar entries
- Pass full app objects (not just `a.opp`) to `renderCal` so `type`, `singleDate`, `excludedDates` are preserved
- Auto-logged hours use `autoKey` field (`auto:userId:oppId:dateStr`) for deduplication
- **Known limitation**: recurring-date math mixes UTC (`toISOString().slice(0,10)`) and local times; evening events in negative-UTC-offset timezones can key occurrences to the next UTC day. A proper fix means anchoring all occurrence keys to one timezone — do not patch piecemeal.
- Security helpers: `esc()` (HTML, escapes `'` too), `jsq()` (user strings inside single-quoted onclick JS), `safeHref()` (http/https only). Server-side `publicOpp()` strips internal fields (checkinCodes, views, orgEmail, etc.) from every student/public opportunity response — keep using it on any new endpoint that returns opportunities.
- **Icons are PNG, not emoji**: a `twemojify()` walker + `MutationObserver` at the end of `public/app.js` swaps emoji text for self-hosted Twemoji `<img class="emoji" src="/emoji/<codepoint>.png">` (static + dynamic DOM). The **full** Twemoji v15.1.0 72×72 set (~3.8k files) lives in `public/emoji/`, so any user-generated emoji (incl. flags, ZWJ sequences, keycaps, skin tones) renders. Graphemes are clustered with `Intl.Segmenter`; the filename follows Twemoji's rule (drop `FE0F` unless ZWJ). Detection is `\p{Extended_Pictographic}`/`\p{Regional_Indicator}`, so non-pictographic dingbats (✓ ✕ ★ → ♡) naturally stay text; `©®™` are explicitly kept as text via `KEEP_TEXT`. A missing file `onerror`-reverts to text (cached in `MISSING`) — no allowlist to maintain. `manifest.json` is reference-only (not read at runtime).
- **Brand assets are PNG, derived from the master logo**: `public/servelocal-logo.png` (1024² RGBA, white heart on a green tile) is the source of truth and is used directly as the nav + footer mark (`.brand-logo`). `scripts/genbrand.js` (zero-dep, `zlib` only — it decodes the master PNG, box-filter downscales, and composites) regenerates `favicon-16/32.png`, `apple-touch-icon.png`, and the 1200×630 `og-image.png`. Replace `servelocal-logo.png` and re-run `node scripts/genbrand.js` to rebrand. The wordmark stays HTML text (a11y + crispness). Head wires `<link rel=icon>`, `apple-touch-icon`, theme-color, OG/Twitter meta (canonical URL `https://servelocal.org`).

## Documentation cadence

Update `docs/record_2026-07-02.md` and `docs/state_<YYYY-MM-DD>.md` **every 3 prompts** to
reflect current project state. This is an engineering diary of *the build* (decisions, bugs,
how understanding evolved), not application/logistics tracking.

- **Record** (`docs/record_2026-07-02.md`): chronological, append-only build log. Every entry is
  timestamped (date + approx time, e.g. "2026-07-03 14:20"). For each meaningful change, capture:
    - **WHAT** changed (feature, fix, refactor)
    - **WHY** — what problem it solved, what tradeoff was weighed
    - **HOW** — the approach taken, especially if non-obvious or if an earlier approach was tried
      and abandoned
    - Any **bug** found + root cause + fix (these make the best essay material — they show real
      debugging, not just feature-add)

  Never edit or delete a past entry. If something logged turns out wrong, add a NEW entry
  correcting it and reference the old one — the trail of "I thought X, then learned Y" is itself
  valuable narrative material. Append as new dated sections, never rewrite history. If a file is
  renamed, note it at every old reference so links don't silently break.
- **State** (`docs/state_<YYYY-MM-DD>.md`): always-current snapshot of where the project stands
  (architecture, what's done, what's in progress, known limitations). Create a NEW dated file when
  the architecture or scope shifts significantly; mark the old one
  "SUPERSEDED — see state_<new-date>.md" at the top instead of deleting it.
- If the cadence slips (>3 prompts without an update), catch up at the next prompt and note in the
  record how many prompts it slipped by (honest audit trail, not retroactively cleaned up).
- Convert relative dates ("yesterday", "last week") to absolute dates immediately — the record gets
  read months later when "yesterday" is meaningless.

**Current files:** record = `docs/record_2026-07-02.md` · latest state = `docs/state_2026-07-05.md`.
