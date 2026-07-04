# Handoff

## Goal

ServeLocal is a volunteer-opportunity platform (students discover/track community service, log
verified hours, earn awards; organizations post opportunities and verify attendance). It's Evan's
personal/portfolio project — the point isn't just a working app, it's a documented engineering
process (ADRs, tests, an append-only build log) he can point to for college applications. Zero
runtime dependencies (ADR-0001): pure Node.js `http`, no framework.

## Current state — Track 1 + scaling work shipped, Track 2 not started

**Last updated: 2026-07-04**

Track 1 (guardian consent — the launch precondition for a platform with minor users) is done. The
scaling work that followed (ADR-0011/0012) found the platform's real ceiling via load testing: the
whole DB was one JSON string, and V8 caps a string at ~512 MB, so `USERS=100000` used to fail
outright with `Invalid string length` — the app couldn't boot past roughly 90k users. That's now
fixed (ADR-0013): persistence moved to SQLite (`better-sqlite3`, a documented ADR-0001 exception)
and `/api/opportunities` got pagination. Verified at 100k users (763 MB DB, 0 errors) — the ceiling
is gone. Track 2 (notifications → messaging → Stripe → growth) has not started; see
`docs/roadmap.md`.

### Workstreams

| Workstream | Status | Notes |
|---|---|---|
| Guardian consent for minors (ADR-0010) | **Done** | `8a1e4fe`; tested (`test/guardian-consent.test.js`) |
| In-memory indexes (ADR-0011) | **Done** | `8a1e4fe`; tested (`test/index.test.js`) |
| Frontend editorial restyle | **Done** | `10b0d05` |
| Scaling cost optimizations (ADR-0012) | **Done** | `65ced71`; coalesced writes, indexed hot reads, bounded notifications, HTTP caching |
| `npm run bench` / `npm run loadtest:scale` tooling | **Done** | `43ef219`, `a2164d4`; repeatable before/after + real HTTP numbers |
| **SQLite migration + `/api/opportunities` pagination (ADR-0013)** | **Done** | Removes the confirmed ~90k-user JSON-string ceiling; verified at 100k users. `npm run migrate:sqlite` for existing `db.json` deployments. Committed `da9a27f`, pushed to `origin/master` |
| Real notifications (Track 2 #1) | **Not started** | See `docs/roadmap.md` |
| Shift templates + bulk messaging (Track 2 #2) | **Not started** | See `docs/roadmap.md` |
| Live Stripe billing (Track 2 #3) | **Not started** | Currently DEMO mode (ADR-0004) |
| B2B2C / school-district distribution, portfolio virality (Track 2 #4) | **Not started** | See `docs/roadmap.md` |

## Known limitations
- **In-memory-RAM ceiling not addressed** — every collection still loads fully into memory at boot
  (ADR-0013 fixed the confirmed *serialization* ceiling, not a hypothetical RAM one).
- **Frontend doesn't page past the default `limit=60`** on Discover — pagination shipped as a
  backend fix; no "load more" UI was built yet.
- Billing is DEMO mode — no real payments until Stripe keys are configured (ADR-0004).
- Two security items intentionally deferred (documented in `docs/security.md`): HttpOnly-cookie
  auth refactor and TOTP MFA.
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
  resilience job, and `npm audit`. Its "zero runtime deps" step comments/lockfile-only install will
  need updating once the SQLite migration adds a real dependency — flagging so that's not missed.
