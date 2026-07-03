# Security Policy

## Supported versions
The deployed `main` branch is the only supported version.

## Reporting a vulnerability
Email **security@servelocal.org** (replace with your real address) with:
- a description and impact,
- reproduction steps or a proof of concept,
- affected endpoint(s) / file(s).

Please do **not** open a public issue for security reports. We aim to acknowledge within
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
