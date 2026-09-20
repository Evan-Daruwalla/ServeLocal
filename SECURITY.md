# Security Policy

## Supported versions
The `master` branch is the only supported version. **v1 is frozen and is not currently
deployed** -- it is retained as the behavioural reference for the v2 rewrite.
(Corrected 2026-09-19: this line said "the deployed `main` branch"; the branch is
`master` and nothing is deployed.)

## Reporting a vulnerability

**Report privately through GitHub:** <https://github.com/Evan-Daruwalla/ServeLocal/security/advisories/new>. That channel is
private to the maintainer, needs no email address, and is the only monitored route.

Include:
- a description and impact,
- reproduction steps or a proof of concept,
- affected endpoint(s) / file(s).

Please do **not** open a public issue for security reports.

> **Corrected 2026-09-19.** This section previously said to email
> `security@servelocal.org` and carried the words "(replace with your real address)" --
> an unfilled template placeholder that shipped. That domain has no MX record and does
> not answer on port 80 or 443, so reports sent there went nowhere. **v1 is frozen**
> (see the repo root `CLAUDE.md`); it is kept as the behavioural reference for the v2
> rewrite, and the response times below are best-effort for a frozen codebase. We aim to acknowledge within
2 business days and to ship a fix or mitigation for high/critical issues within 7 days.
Coordinated disclosure is appreciated; we will credit reporters who wish to be named.

## Scope
In scope: `server.js`, `public/index.html`, auth/session handling, access control, the
calendar feed, and the audit log. Out of scope: demo-mode billing (no real payments yet),
third-party services (Resend, zippopotam.us), and denial-of-service via raw traffic volume
(rate limiting is best-effort at the app layer; absorb volumetric attacks at the edge/CDN).

## Hardening checklist for deployment
See `docs/security.md` (controls matrix) and `DEPLOY.txt` §7 (pre-deploy checklist):
strong `JWT_SECRET`, `NODE_ENV=production`, TLS, verified email domain, persistent DB volume.
