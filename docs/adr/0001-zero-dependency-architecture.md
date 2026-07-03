# ADR-0001: Zero npm runtime dependencies

**Status:** Accepted

## Context
ServeLocal is a small, security-sensitive app used by minors. Supply-chain attacks via
transitive npm dependencies are a leading risk, and dependency churn adds review burden.

## Decision
The server and SPA use **only the Node.js standard library and browser built-ins** — no npm
runtime dependencies. The frontend is a single `index.html` (no build step). New runtime deps
require a new ADR justifying the trade-off.

## Consequences
- **Pros:** minimal attack surface; `npm audit` is trivially clean; no build/transpile step;
  trivial to read and audit end-to-end; fast cold start.
- **Cons:** we re-implement small utilities (JWT, rate limiter, cache, circuit breaker) that a
  library would provide; some ergonomic features (a router, an ORM) are hand-rolled.
- Dev-only tooling is allowed but kept at zero today (tests use the built-in `node:test`).
