# ServeLocal

Volunteer platform connecting students with community service opportunities.
Free forever for students; orgs can upgrade to a paid Pro plan for unlimited
listings, featured placement, and analytics.

## Quick Start

```bash
node server.js
```

Server runs on `http://localhost:3000` (or the `PORT` env var).

## Architecture

- **Zero dependencies** — pure Node.js `http` module, no npm packages, no
  frameworks.
- **Single-page app** — the entire frontend (HTML + CSS + JS) lives in
  `public/index.html`.
- **File-based DB** — `db.json` in the project root, auto-created on first
  run, with periodic snapshot backups.
- **Server** — `server.js` handles all API routes, auth, and static file
  serving; routes are hand-written `if (method===... && p===...)` blocks,
  no router library.

See [`docs/architecture.md`](docs/architecture.md) for the full design,
[`docs/security.md`](docs/security.md) and [`docs/adr/`](docs/adr/) for the
security model and architecture decisions, and
[`CLAUDE.md`](CLAUDE.md) for the detailed feature/API reference and
conventions.

## Testing

```bash
npm test                # node:test
npm run test:coverage   # with coverage
npm run loadtest        # scripts/loadtest.js
npm run chaos           # scripts/chaos.js
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).
