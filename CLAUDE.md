# ServeLocal

Volunteer platform connecting students with community service opportunities: students discover/track
service, log verified hours, and earn awards; organizations post opportunities and verify attendance.

**What this project is FOR**: it's Evan's personal/portfolio project. The point isn't just a working
app — it's a documented engineering process (ADRs, tests, an append-only build log) he can point to
for college applications. Process quality and honest documentation matter as much as the code.

**This is v1** (the zero-dependency Node app, GitHub `Evan-Daruwalla/ServeLocal`, branch `master`).
A separate production-stack rewrite (**v2**: FastAPI/SQLAlchemy/Postgres + Next.js/TypeScript/
Tailwind/shadcn) lives at `../servelocal-v2` with its own READMEs — nothing in this file applies
there. Don't port v2 conventions into v1 or vice versa.

## Start of session

Read `HANDOFF.md` (root) and the latest `docs/state_<date>.md` before making changes — they are the
source of truth for current status, known limitations, and what's deliberately deferred. Do not
re-derive project status from git archaeology when these two files answer it.

## Quick Start

```bash
node server.js        # or: npm start
```

Server runs on `http://localhost:3000` (or PORT env var). Config in `.env` (optional; see
`.env.example`). `db.sqlite` is auto-created and reseeded with demo data on first run.

## How Evan works (hard rules)

- **Surgical changes only.** Every changed line must trace to the task. Don't reformat, "improve",
  or refactor adjacent code. Match existing style even if you'd do it differently.
- **Confirm direction before big or subjective work** (architecture shifts, visual redesigns, scope
  changes). Small well-defined fixes: just do them.
- **Never gate student features.** Students are free forever. Paid plans (`PLANS` in server.js)
  apply to orgs only.
- **Don't claim deferred work is done.** The HttpOnly-cookie auth refactor and signup CAPTCHA are
  intentionally deferred (documented in `docs/security.md`). Report status honestly, including
  failures and skipped steps.
- **Zero-dependency default (ADR-0001).** Adding any dependency requires an ADR documenting the
  exception (there is exactly one so far: `better-sqlite3`, ADR-0013, required only inside
  `lib/persist.js`). Do not add packages casually.
- **One ADR per significant architectural decision** in `docs/adr/` (`docs/adr/README.md` is the
  index; 15 so far). Reference ADR numbers when touching code they govern.

## Definition of done

Work is not finished until ALL of these pass. Run them; don't assume.

1. `npm test` — full suite green (node:test; flat files in `test/`: unit / integration / regression
   / feature-specific). New behavior gets a test; bug fixes get a regression test first.
2. `npm run lint` — syntax check on server.js.
3. `npm run coverage:check` — must pass. The floor is whatever `coverage:check` enforces
   (package.json / ci.yml are the source of truth — don't hardcode the numbers elsewhere).
4. UI changes: verify in a live preview (load the page, exercise the change, zero console/CSP
   errors) — not just "the code looks right".
5. Security-relevant changes (auth, input handling, new endpoints, secrets): run the project
   `security-review` skill; add `appendAudit()` to any new security-relevant action.
6. Documentation cadence honored (see bottom of this file) and, for shipped batches, `HANDOFF.md`'s
   workstream table updated.

CI (`.github/workflows/ci.yml`) runs tests on Node 20.x/22.x, the coverage floor, a chaos/resilience
job, and `npm audit` — all 5 jobs must stay green.

## Architecture

- **Near-zero dependencies** — pure Node.js `http` module, no frameworks. One runtime dependency
  (`better-sqlite3`, ADR-0013), a documented exception to the zero-dep default (ADR-0001)
- **Single-page app** — shell HTML/CSS in `public/index.html`; all frontend JS lives in
  `public/app.js` (ADR-0014, loaded via `<script src="/app.js" defer>`)
- **SQLite-backed DB (ADR-0013)** — `db.sqlite` in project root, auto-created on first run
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
  scripts/           # genbrand, bench, loadtest, loadtest-scale, chaos, backup, restore, migrations
  test/              # node:test suite + _boot.js (isolated server on temp DB via DB_FILE/BACKUP_DIR)
  docs/              # record, state snapshots, roadmap, security, architecture, adr/
  HANDOFF.md         # Current status + workstream table (read at session start)
  .env.example       # Documented config knobs; never commit .env
  db.sqlite          # Auto-generated database (do not commit; db.json is the pre-ADR-0013 legacy)
```

Root also has `CONTRIBUTING.md`, `SECURITY.md`, `DEPLOY.txt` (a manual deploy runbook — the app is
NOT deployed; `https://servelocal.org` in meta tags is aspirational). Project skills: `ui-ux-pro-max`
in `.claude/skills/`; api-design, security-review, frontend-a11y, emil-design-eng, and
review-animations moved to the repo root's `../.claude/skills/` (2026-07-08) so v2 can use them too —
they still apply here. Use them when their trigger applies.

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
- **Billing & donations**: DEMO mode — no real payments until Stripe keys are configured (ADR-0004, see DEPLOY.txt §9)
- **Leaderboard**: `/api/leaderboard` is public but only exposes first name + last initial
- **Check-in codes**: Orgs generate a 6-char code per event date (`opp.checkinCodes`); students redeem at `POST /api/checkin` for instantly-verified hours (requires approved signup)
- **Bookmarks**: `user.savedOpps` toggled via `PATCH /api/saved-opps/:oppId`; hearts in Discover + Saved tab in student dash
- **Deep links**: hash routing (`#discover`, `#opp/<id>`, `#org/<orgId>`, `#portfolio/<userId>`, etc.) via `routeFromHash()`; views push history with `pushHash()` — guard with `_routing` flag to avoid loops
- **Guardian consent (minors only)**: students under 18 need a verified guardian email before they can apply/message/check-in/be endorsed — `requireGuardianConsent(user)` recomputes age from `dob` live, so 18+ students are never gated and a pending minor who ages into 18 is unblocked automatically. Full spec: `docs/guardian-consent-spec.md` (ADR-0010). Public flow at `#consent/<token>` (approve/decline) and `#consent-manage/<token>` (revoke anytime — the kill switch). Existing pre-launch accounts need `npm run migrate:guardian-consent` once.

## Frontend conventions

- **Event handling is a delegated dispatch table — never inline handlers.** No `onclick=`/`onchange=`
  attributes anywhere (that's what lets CSP `script-src` be `'self'`, ADR-0014 step 2). Markup uses
  `data-action="fnName"` (+ `data-args='["json","array"]'` for arguments, escaped via
  `esc(JSON.stringify([...]))`); handlers are registered in the `ACTIONS` registry in `app.js`, with
  one `document`-level listener per event type. Adding an inline handler reintroduces the CSP
  exception — CI won't catch it, so don't.
- **Escaping**: `esc()` for HTML (escapes `'` too), `safeHref()` for URLs (http/https only). `jsq()`
  still exists but is retired at handler sites (superseded by the data-args pattern) — don't use it
  for new code.
- **Editorial visual language**: solid color fills, tight border radii, calm/minimal motion. No
  generic-AI-site signals (no gradient-heavy hero, no glassmorphism, no bouncy animation).
- **Icons are PNG, not emoji**: a `twemojify()` walker + `MutationObserver` at the end of
  `public/app.js` swaps emoji text for self-hosted Twemoji `<img class="emoji"
  src="/emoji/<codepoint>.png">` (static + dynamic DOM). The **full** Twemoji v15.1.0 72×72 set
  (~3.8k files) lives in `public/emoji/`, so any user-generated emoji (incl. flags, ZWJ sequences,
  keycaps, skin tones) renders. Graphemes are clustered with `Intl.Segmenter`; the filename follows
  Twemoji's rule (drop `FE0F` unless ZWJ). Detection is
  `\p{Extended_Pictographic}`/`\p{Regional_Indicator}`, so non-pictographic dingbats (✓ ✕ ★ → ♡)
  naturally stay text; `©®™` are explicitly kept as text via `KEEP_TEXT`. A missing file
  `onerror`-reverts to text (cached in `MISSING`) — no allowlist to maintain. `manifest.json` is
  reference-only (not read at runtime).
- **Brand assets are PNG, derived from the master logo**: `public/servelocal-logo.png` (1024² RGBA,
  white heart on a green tile) is the source of truth and is used directly as the nav + footer mark
  (`.brand-logo`). `scripts/genbrand.js` (zero-dep, `zlib` only) regenerates `favicon-16/32.png`,
  `apple-touch-icon.png`, and the 1200×630 `og-image.png`. Replace `servelocal-logo.png` and re-run
  `node scripts/genbrand.js` to rebrand. The wordmark stays HTML text (a11y + crispness).

## Security & Ops Infrastructure (server.js)
- Full controls matrix in `docs/security.md`; architecture in `docs/architecture.md`; decisions in `docs/adr/`.
- **Request pipeline**: rate limit (`rateLimit`, per-IP token bucket) → auth (`getUser`, checks `tokenVersion`) → idempotency (`Idempotency-Key` replay via `respond()`) → handler. Security headers (CSP/HSTS/etc.) on every response via `securityHeaders()`.
- **CSP**: `script-src 'self'` — fully locked since ADR-0014 step 2 (see Frontend conventions; keep it that way). `style-src` still allows `'unsafe-inline'` for the hundreds of inline `style=` attributes (known, out of scope).
- **Persistence (ADR-0013; mechanics extracted to `lib/persist.js` per ADR-0015)**: each of the 12 `DB_COLLECTIONS` is a SQLite table (`id`/`seq` primary key + a `data` JSON-blob column per row, via `better-sqlite3` — required *only* inside `lib/persist.js`). The in-memory model is unchanged: `loadDB()` still hydrates plain `DB.<collection>` arrays and every handler still reads/writes those. `saveDB()` delegates to `persist.save()`, which flushes **incrementally** over a persistent WAL-mode handle: a per-row sha1 mirror means only changed/added/removed rows touch disk, replaced only after the transaction commits. Fallback when no healthy handle exists (first boot, corrupt-file recovery): full rewrite to a temp file + atomic rename, clearing stale `-wal`/`-shm` sidecars first. `server.js` keeps the orchestration (what to save, corrupt-file recovery from `backups/`, reseed, the `/api/health/ready` flags). `backupSnapshot()` every 30 min (RPO) calls `persist.checkpoint()` first so a bare file copy is complete. `closeDB()` (→ `persist.close()`) runs on shutdown. **`saveDBSoon()` (ADR-0012)** debounces high-frequency, low-criticality writes; any explicit `saveDB()`/shutdown flushes the pending state. Migrating an existing `db.json`: `npm run migrate:sqlite`.
- **Indexes (ADR-0011, refined by ADR-0012)**: hot lookups go through `IDX()` — Maps keyed by id (`userById`/`oppById`/`appById`/`hoursById`), foreign key (`appsByOpp`/`appsByUser`/`hoursByUser`/`notifsByUser`/`messagesByOpp`/`reviewsByOrg`/`oppsByOrg`/`endorsementsByUser`), plus `userByEmail`/`userByOrgId`. Derived state, rebuilt lazily when the `DB` ref changes or an **indexed** collection's *length* changes (structural signature) — NOT on every write, since field-only writes keep the reference-keyed Maps valid. This is safe only because the codebase never reassigns an id/FK in place nor replaces an array element in place; keep it that way. Use `IDX().xById.get(id)`, `ownedOpp(id,orgId)` for org-owned lookups, and `idxList(map,key)` for FK groups. **Never mutate the array `idxList` returns** (shared bucket / frozen empty) — spread first. `findIndex` write-path sites stay as scans. Covered by `test/index.test.js` + `test/cost-optimizations.test.js`.
- **Public-read caching (ADR-0012)**: user-agnostic GETs (opportunity list, leaderboard, stats) return via `jsonCacheable(req,res,data,key,maxAge)` — a cache-version-keyed weak ETag + short `Cache-Control` so browsers/CDNs revalidate with a 304. Only use it on responses that don't vary by user. Version-stamped static assets (`?v=`) are served immutable for a year. The opportunities handler also caches its computed page (`cacheGet`/`cacheSet`, leaderboard pattern). JSON bodies >1KB are gzipped when the client accepts it (`res._gzip`, set in `router`; handled inside `json()`).
- **Pagination (ADR-0013)**: `GET /api/opportunities` takes `limit` (default 60, max 200) / `offset`; response stays a bare array, total count in `X-Total-Count`. Discover mirrors filters into the URL hash (shareable/refresh-safe) and has Load More.
- **Password reset**: `POST /api/auth/forgot` (always-200 — no account enumeration; sha256-hashed single-use token on the user, 1h TTL, 3-req/15min throttle) → emailed `#reset/<token>` link → `POST /api/auth/reset` (weak-password checks, bumps `tokenVersion`, audited). `safeUser()` strips `resetTokenHash`/`resetTokenExpires` — keep it that way. Tests: `test/password-reset.test.js`.
- **Check-in redemption**: O(1) via `IDX().checkinCodeByStr` — entries are HINTS (codes are field mutations, invisible to the structural rebuild; the generation site `.set()`s directly) and MUST be re-validated against `opp.checkinCodes` before use. Per-user guess throttle (10 fails/15min). Tests: `test/checkin.test.js`.
- **Audit log**: `appendAudit(actor,action,target,meta)` is hash-chained + tamper-evident; admin-only at `/api/admin/audit`. Add it to any new security-relevant action.
- **Validation**: sanitize user text server-side with `sstr()`/`clampNum()`; keep escaping output with `esc`/`safeHref` on the client (see Frontend conventions).
- **Passwords (mechanics in `lib/auth.js`, ADR-0015)**: scrypt via `setPassword(user,pw)` / `verifyPassword(pw,user)` (never the old `hashPassword` for new creds — it's legacy/migration only). Legacy HMAC hashes auto-upgrade on login (`migrateLegacyPassword`). Block weak ones with `weakPassword()`. All secret comparisons use `crypto.timingSafeEqual`. Password change: `POST /api/account/password` (bumps `tokenVersion`). These + `makeToken`/`verifyToken`/`hashToken`/`b64u` live in `lib/auth.js` and are destructured at the top of server.js (config injected via `auth.init()`); `getUser`/`safeUser` stay in server.js (they need `IDX()`).
- **CORS**: `ALLOWED_ORIGINS` env locks down CORS in prod (default `*` in dev); `resolveCors(req)` sets `res._acao`, read by `json()`. Rate limits tunable via `RL_WRITE_CAP`/`RL_READ_CAP` etc. scrypt cost via `SCRYPT_N`.
- **MFA (TOTP, RFC 6238)** — zero-dep `lib/totp.js`. Enrollment `POST /api/auth/mfa/setup` (pending secret + otpauth URI) → `/enable` (live-code confirm, returns 8 one-time backup codes stored sha256-hashed). Login is two-step when `mfaEnabled`: password → hashed single-use 5-min ticket → `/mfa/verify` (throttled 8/15min via `loginAttempts` key `mfa|<id>`). `/disable` needs a valid code + bumps `tokenVersion`. Backup codes accepted once via `mfaCodeOk()`. `safeUser()` strips `mfaSecret`/`mfaPendingSecret`/`mfaBackupCodes`/`mfaLoginTokenHash`/`mfaLoginExpires` — keep it that way. Tests: `test/mfa.test.js`.
- **Notification email (Track 2 #1, partial)** — `createNotification()` also fires `sendEmail()` unless the user set `emailNotifications:false` (profile toggle, default on). `sendEmail` is a fire-and-forget dev stub without `RESEND_API_KEY`. Test: `test/notifications-email.test.js`.
- **Intentionally deferred security items** (documented in docs/security.md): the HttpOnly-cookie auth refactor, and CAPTCHA/bot-defense on signup (needs a third party). Don't claim either is done.
- **Tests**: `npm test` (node:test) — flat `test/` dir: `unit.test.js`, `integration.test.js`, `regression.test.js` + feature suites (mfa, checkin, password-reset, guardian-consent, index, cost-optimizations, notifications-email). `test/_boot.js` boots an isolated server on a temp DB via `DB_FILE`/`BACKUP_DIR` env. `npm run coverage:check` enforces the floor. Tooling: `npm run loadtest`, `npm run loadtest:scale` (`scripts/loadtest-scale.js`, real HTTP, large synthetic DB, `USERS=` to scale — see ADR-0013), `npm run chaos`, `npm run backup` / `npm run restore`. `npm run bench` (`scripts/bench.js`, `USERS=` to scale) micro-benchmarks the ADR-0012 scaling primitives (serialize / index rebuild / leaderboard / list) on a synthetic large DB — standalone, never touches the real `db.sqlite`.
- **Require-safe**: `server.js` only listens when run directly (`require.main===module`); exports `{router, buildServer, DB, helpers...}` for tests. Don't reintroduce top-level side effects.
- **Secrets**: prod refuses to boot on the default `JWT_SECRET` **or** the default `ADMIN_PASSWORD` (the seeded admin password is public in source — set `ADMIN_PASSWORD` in prod). Credentials are only printed to the boot log in dev. Config in `.env` (see `.env.example`); never commit `.env`/`db.sqlite`/`backups/`.

## Demo Credentials

- **Student**: `student@demo.com` / `demo1234`
- **Org**: `org@demo.com` / `demo1234`

## API Pattern

All routes are in `server.js` as `if (method==='GET' && p==='/api/...')` blocks. No router library.
JSON request/response via helper functions `json(res, data, status)` and `parseBody(req)`. Every new
endpoint that returns opportunities to students/public must go through `publicOpp()` (strips internal
fields: checkinCodes, views, orgEmail, etc.).

## Important Notes

- `db.sqlite` is the entire database — it resets to seed data if deleted
- `expandRecurring()` in the frontend expands weekly/monthly apps into per-day calendar entries
- Pass full app objects (not just `a.opp`) to `renderCal` so `type`, `singleDate`, `excludedDates` are preserved
- Auto-logged hours use `autoKey` field (`auto:userId:oppId:dateStr`) for deduplication
- **Known limitation**: recurring-date math mixes UTC (`toISOString().slice(0,10)`) and local times; evening events in negative-UTC-offset timezones can key occurrences to the next UTC day. A proper fix means anchoring all occurrence keys to one timezone — do not patch piecemeal.
- **Known limitation**: every collection still loads fully into memory at boot — ADR-0013 fixed the
  *serialization* ceiling (verified at 100k users), not a RAM one. If ever hit, the fix is pushing
  queries down to SQL — a separate rewrite, don't do it incidentally.

## Environment gotchas (Windows dev box)

- **Never rewrite data files (db.json legacy, JSON fixtures) with PowerShell** — its default
  UTF-16/BOM encoding corrupts emoji and multibyte content. Use Node scripts or jq.
- Inline `node -e` with arrow functions + nested quotes is flaky in this shell and can leave 0-byte
  junk files in the repo root (harmless, never commit them). Prefer a temp `.js` file or jq.
- Run `date` before writing ANY timestamp; never estimate it. Label the zone by the UTC offset
  `date` reports: **UTC-6 → CST, UTC-5 → CDT** (Central, DST-aware).

## Documentation cadence

Update `docs/record_2026-07-02.md` and `docs/state_<YYYY-MM-DD>.md` after **every meaningful
change** so they reflect current project state. This is an engineering diary of *the build* (decisions, bugs,
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
- **HANDOFF.md** (root): current status + workstream table. Update it when a batch ships or a
  workstream's status changes (it records commit hashes per batch).
- If the cadence slips (meaningful changes land without an update), catch up at the next
  opportunity and note the slip in the record (honest audit trail, not retroactively cleaned up).
- Convert relative dates ("yesterday", "last week") to absolute dates immediately — the record gets
  read months later when "yesterday" is meaningless.

**Current files:** record = `docs/record_2026-07-02.md` · latest state = `docs/state_2026-07-05.md`.
