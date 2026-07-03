# ServeLocal

Volunteer platform connecting students with community service opportunities.

## Quick Start

```bash
node server.js
```

Server runs on `http://localhost:3000` (or PORT env var).

## Architecture

- **Zero dependencies** — pure Node.js `http` module, no npm, no frameworks
- **Single-page app** — all frontend HTML/CSS/JS lives in `public/index.html`
- **File-based DB** — `db.json` in project root, auto-created on first run
- **Server** — `server.js` at project root handles API routes and static file serving

## Project Structure

```
ServeLocal website/
  server.js          # Backend — API routes, auth, static serving
  public/
    index.html       # Entire frontend SPA (HTML + CSS + JS)
    emoji/           # Self-hosted Twemoji PNGs (CC-BY) + manifest.json
    servelocal-logo.png  # Master brand logo (used directly as the nav/footer mark)
    *.png            # Derived brand assets: favicon-16/32, apple-touch-icon, og-image
  scripts/genbrand.js  # Regenerates derived brand PNGs from the master logo (zero-dep)
  .env               # Optional — PORT, etc.
  db.json            # Auto-generated database (do not commit)
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

## Security & Ops Infrastructure (server.js, zero-dep)
- Full controls matrix in `docs/security.md`; architecture in `docs/architecture.md`; decisions in `docs/adr/`.
- **Request pipeline**: rate limit (`rateLimit`, per-IP token bucket) → auth (`getUser`, checks `tokenVersion`) → idempotency (`Idempotency-Key` replay via `respond()`) → handler. Security headers (CSP/HSTS/etc.) on every response via `securityHeaders()`.
- **Persistence**: `saveDB()` is atomic (temp + rename) and calls `bumpCache()`. Corrupt `db.json` recovers from `backups/` (newest) or reseeds on boot, then rewrites a healthy file. `backupSnapshot()` every 30 min (RPO).
- **Audit log**: `appendAudit(actor,action,target,meta)` is hash-chained + tamper-evident; admin-only at `/api/admin/audit`. Add it to any new security-relevant action.
- **Validation**: sanitize user text server-side with `sstr()`/`clampNum()`; keep escaping output with `esc`/`jsq`/`safeHref` on the client.
- **Passwords**: scrypt via `setPassword(user,pw)` / `verifyPassword(pw,user)` (never the old `hashPassword` for new creds — it's legacy/migration only). Legacy HMAC hashes auto-upgrade on login (`migrateLegacyPassword`). Block weak ones with `weakPassword()`. All secret comparisons use `crypto.timingSafeEqual`. Password change: `POST /api/account/password` (bumps `tokenVersion`).
- **CORS**: `ALLOWED_ORIGINS` env locks down CORS in prod (default `*` in dev); `resolveCors(req)` sets `res._acao`, read by `json()`. Rate limits tunable via `RL_WRITE_CAP`/`RL_READ_CAP` etc. scrypt cost via `SCRYPT_N`.
- **Two security items intentionally deferred** (documented in docs/security.md): HttpOnly-cookie auth refactor and TOTP MFA. Don't claim they're done.
- **Tests**: `npm test` (node:test) — `test/unit|integration|regression`. `test/_boot.js` boots an isolated server on a temp DB via `DB_FILE`/`BACKUP_DIR` env. `npm run coverage:check` enforces the floor. `scripts/loadtest.js`, `scripts/chaos.js`, `scripts/backup.js`, `scripts/restore.js`.
- **Require-safe**: `server.js` only listens when run directly (`require.main===module`); exports `{router, buildServer, DB, helpers...}` for tests. Don't reintroduce top-level side effects.
- **Secrets**: prod refuses to boot on the default `JWT_SECRET` **or** the default `ADMIN_PASSWORD` (the seeded admin password is public in source — set `ADMIN_PASSWORD` in prod). Credentials are only printed to the boot log in dev. Config in `.env` (see `.env.example`); never commit `.env`/`db.json`/`backups/`.

## Demo Credentials

- **Student**: `student@demo.com` / `demo1234`
- **Org**: `org@demo.com` / `demo1234`

## API Pattern

All routes are in `server.js` as `if (method==='GET' && p==='/api/...')` blocks. No router library. JSON request/response via helper functions `json(res, data, status)` and `parseBody(req)`.

## Important Notes

- `db.json` is the entire database — it resets to seed data if deleted
- `expandRecurring()` in the frontend expands weekly/monthly apps into per-day calendar entries
- Pass full app objects (not just `a.opp`) to `renderCal` so `type`, `singleDate`, `excludedDates` are preserved
- Auto-logged hours use `autoKey` field (`auto:userId:oppId:dateStr`) for deduplication
- **Known limitation**: recurring-date math mixes UTC (`toISOString().slice(0,10)`) and local times; evening events in negative-UTC-offset timezones can key occurrences to the next UTC day. A proper fix means anchoring all occurrence keys to one timezone — do not patch piecemeal.
- Security helpers: `esc()` (HTML, escapes `'` too), `jsq()` (user strings inside single-quoted onclick JS), `safeHref()` (http/https only). Server-side `publicOpp()` strips internal fields (checkinCodes, views, orgEmail, etc.) from every student/public opportunity response — keep using it on any new endpoint that returns opportunities.
- **Icons are PNG, not emoji**: a `twemojify()` walker + `MutationObserver` at the end of `index.html` swaps emoji text for self-hosted Twemoji `<img class="emoji" src="/emoji/<codepoint>.png">` (static + dynamic DOM). The **full** Twemoji v15.1.0 72×72 set (~3.8k files) lives in `public/emoji/`, so any user-generated emoji (incl. flags, ZWJ sequences, keycaps, skin tones) renders. Graphemes are clustered with `Intl.Segmenter`; the filename follows Twemoji's rule (drop `FE0F` unless ZWJ). Detection is `\p{Extended_Pictographic}`/`\p{Regional_Indicator}`, so non-pictographic dingbats (✓ ✕ ★ → ♡) naturally stay text; `©®™` are explicitly kept as text via `KEEP_TEXT`. A missing file `onerror`-reverts to text (cached in `MISSING`) — no allowlist to maintain. `manifest.json` is reference-only (not read at runtime).
- **Brand assets are PNG, derived from the master logo**: `public/servelocal-logo.png` (1024² RGBA, white heart on a green tile) is the source of truth and is used directly as the nav + footer mark (`.brand-logo`). `scripts/genbrand.js` (zero-dep, `zlib` only — it decodes the master PNG, box-filter downscales, and composites) regenerates `favicon-16/32.png`, `apple-touch-icon.png`, and the 1200×630 `og-image.png`. Replace `servelocal-logo.png` and re-run `node scripts/genbrand.js` to rebrand. The wordmark stays HTML text (a11y + crispness). Head wires `<link rel=icon>`, `apple-touch-icon`, theme-color, OG/Twitter meta (canonical URL `https://servelocal.org`).
