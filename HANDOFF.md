# Handoff

## Goal

ServeLocal is a volunteer-opportunity platform (students discover/track community service, log
verified hours, earn awards; organizations post opportunities and verify attendance). It's Evan's
personal/portfolio project — the point isn't just a working app, it's a documented engineering
process (ADRs, tests, an append-only build log) he can point to for college applications. Zero
runtime dependencies (ADR-0001): pure Node.js `http`, no framework.

## Current state — Track 1 + scaling work shipped, Track 2 not started

**Last updated: 2026-07-05**

Track 1 (guardian consent — the launch precondition for a platform with minor users) is done. The
scaling work that followed (ADR-0011/0012) found the platform's real ceiling via load testing: the
whole DB was one JSON string, and V8 caps a string at ~512 MB, so `USERS=100000` used to fail
outright with `Invalid string length` — the app couldn't boot past roughly 90k users. That's now
fixed (ADR-0013): persistence moved to SQLite (`better-sqlite3`, a documented ADR-0001 exception)
and `/api/opportunities` got pagination. Verified at 100k users (763 MB DB, 0 errors) — the ceiling
is gone. A 2026-07-05 knowledge-graph audit (`/graphify`) then drove a five-item batch: notification
email delivery (the first slice of Track 2 #1), TOTP MFA, extracting the SPA script to `/app.js`
(ADR-0014), and splitting `server.js` into `lib/` modules (ADR-0015). The rest of Track 2 (messaging
→ Stripe → growth) has not started; see `docs/roadmap.md`.

### Workstreams

| Workstream | Status | Notes |
|---|---|---|
| Guardian consent for minors (ADR-0010) | **Done** | `8a1e4fe`; tested (`test/guardian-consent.test.js`) |
| In-memory indexes (ADR-0011) | **Done** | `8a1e4fe`; tested (`test/index.test.js`) |
| Frontend editorial restyle | **Done** | `10b0d05` |
| Scaling cost optimizations (ADR-0012) | **Done** | `65ced71`; coalesced writes, indexed hot reads, bounded notifications, HTTP caching |
| `npm run bench` / `npm run loadtest:scale` tooling | **Done** | `43ef219`, `a2164d4`; repeatable before/after + real HTTP numbers |
| **SQLite migration + `/api/opportunities` pagination (ADR-0013)** | **Done** | Removes the confirmed ~90k-user JSON-string ceiling; verified at 100k users. `npm run migrate:sqlite` for existing `db.json` deployments. Committed `da9a27f`, pushed to `origin/master` |
| **Security/perf batch (2026-07-04)** | **Done** | WAL-incremental writes, gzip JSON, opportunities page cache, password reset flow, check-in throttle + O(1) index, Discover URL state + Load More. 66 tests. 100k users: 130 → 4,167 req/s. Committed `05abeb9`, pushed to `origin/master` |
| **CI fix: install deps in coverage & chaos jobs (2026-07-05)** | **Done** | The SQLite migration made `better-sqlite3` a real runtime dep; the `coverage` and `resilience` jobs skipped `npm install` and crashed on `Cannot find module 'better-sqlite3'` (only those two failed — `test` jobs already installed). Added the install step to both; also bumped `actions/checkout`/`setup-node` to `@v5` to clear the Node 20 deprecation warning. All 5 jobs green. Committed `a7dda9f` + `5d3a852`, pushed to `origin/master` |
| **Graph-audit batch (2026-07-05)** | **Done** | Five items from a `/graphify` audit: (1) fixed stale `docs/security.md`; (2) notification email delivery + per-user opt-out toggle; (3) zero-dep TOTP MFA (`lib/totp.js`, `test/mfa.test.js`); (4) extracted SPA JS to `public/app.js`, ADR-0014 (CSP `unsafe-inline` still in place — ~270 inline handlers remain, follow-up task spun off); (5) split `server.js` → `lib/persist.js` + `lib/auth.js`, ADR-0015. 74 tests, chaos 3/3, preview verified. **Uncommitted** as of this update |
| Real notifications (Track 2 #1) | **Partial** | Email delivery on every in-app notification (opt-out toggle) shipped 2026-07-05. Real-time push / digests / preference granularity not done. See `docs/roadmap.md` |
| Shift templates + bulk messaging (Track 2 #2) | **Not started** | See `docs/roadmap.md` |
| Live Stripe billing (Track 2 #3) | **Not started** | Currently DEMO mode (ADR-0004) |
| B2B2C / school-district distribution, portfolio virality (Track 2 #4) | **Not started** | See `docs/roadmap.md` |

## Known limitations
- **In-memory-RAM ceiling not addressed** — every collection still loads fully into memory at boot
  (ADR-0013 fixed the confirmed *serialization* ceiling, not a hypothetical RAM one).
- Billing is DEMO mode — no real payments until Stripe keys are configured (ADR-0004).
- One security item intentionally deferred (documented in `docs/security.md`): the HttpOnly-cookie
  auth refactor. (TOTP MFA shipped 2026-07-05; CAPTCHA/bot-defense on signup still deferred — needs a
  third-party.)
- CSP still allows `script-src 'unsafe-inline'` — ADR-0014 moved the SPA script out of the HTML but
  ~270 inline event handlers remain; converting them to a dispatch table (to drop the exception) is a
  spun-off follow-up task, deliberately not bundled into this batch for XSS-regression safety.
- Recurring-date math mixes UTC and local time; needs a single-timezone anchor fix.
- Audit log / verified hours / messages are intentionally not truncated (record integrity);
  bounding them at real scale needs archival-with-chain-preservation (a future ADR).
- Not deployed to production. `https://servelocal.org` in meta tags is aspirational.

## Documentation
- `docs/record_2026-07-02.md` — append-only, timestamped build log (the "why" and "how", including
  abandoned approaches and bugs found). Never edited retroactively.
- `docs/state_2026-07-03.md` — current architecture/status snapshot. New dated file when scope
  shifts; old ones marked superseded.
- `docs/roadmap.md` — Track 1/Track 2 living roadmap and the reasoning behind the ordering.
- `docs/adr/` — one ADR per significant architectural decision (`docs/adr/README.md` is the index).
- `CLAUDE.md` — architecture reference + the "Documentation cadence" rule tying the above together.

## What I couldn't determine from this repo (Evan should fill in)
- No deployment target/host is configured or mentioned anywhere in the repo (`DEPLOY.txt` reads as
  a manual runbook, not a live deployment) — unclear if/when this actually goes live.
- No external issue tracker, project board, or design tool reference exists in the repo (confirmed
  by an earlier session's search) — all planning lives in `docs/roadmap.md` and the record.
- No hard deadline or target date for Track 1 launch or any Track 2 item is stated anywhere.
- CI (`.github/workflows/ci.yml`) runs tests (Node 20.x/22.x), a coverage-floor check, a chaos/
  resilience job, and `npm audit`. The coverage and chaos jobs now `npm install` before running
  (they load `server.js`, which requires `better-sqlite3` since ADR-0013); the `security` job stays
  lockfile-only since it only runs `npm audit`. Actions pinned to `@v5`.
