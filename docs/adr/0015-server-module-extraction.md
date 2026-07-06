# ADR-0015: Extract pure mechanism from server.js into lib/ modules

**Status:** Accepted

## Context
The 2026-07-05 knowledge-graph audit measured `server.js` as the codebase's dominant coupling
hotspot: betweenness 0.063 (nearly 2× the next node), degree 112, and a Louvain community-cohesion
score of 0.052 — the graph's own "should this be split?" signal. One ~3,000-line file owned
persistence, auth crypto, HTTP helpers, routing, email, billing, and audit. Nothing was *broken*
(74 tests green), but every new feature widened the same file and the mixing made the storage
engine and crypto primitives untestable in isolation.

## Decision
Extract the two most self-contained, lowest-coupling clusters the graph identified — the ones that
are **pure mechanism** with no dependence on request state or the in-memory `DB` object — into
`lib/`, and leave everything that touches `DB`, `IDX()`, or routing in `server.js`. Zero new
dependencies; plain CommonJS `require()`.

- **`lib/persist.js`** — SQLite mechanics (ADR-0013): table schema, the WAL live handle, the
  per-row sha1 mirror, incremental flush, temp-file+rename fallback, WAL checkpoint, backup read.
  It owns the storage engine; `better-sqlite3` is now required *only* here. `server.js` keeps the
  orchestration: what to load/save (the `DB` object), corrupt-file recovery, reseed, and the
  `/api/health/ready` health flags. Config (the collection list) is injected via `persist.init()`.
- **`lib/auth.js`** — password hashing (scrypt + legacy HMAC verify/migrate), the weak-password
  denylist, HMAC-JWT `makeToken`/`verifyToken`, `b64u`, and `hashToken`. Pure crypto: no `DB`, no
  request. The JWT secret and token TTL are injected once via `auth.init()` so `server.js` remains
  the only place that parses env and refuses prod boot on default secrets.
- **`lib/totp.js`** — RFC 6238 TOTP (added with the MFA feature, ADR nod here for completeness).

`getUser()` and `safeUser()` deliberately **stayed** in `server.js`: they depend on `IDX()` and
this app's user field shapes, not just primitives — moving them would drag domain state into a
"pure mechanism" module and re-create the coupling this ADR is removing.

## Consequences
- `better-sqlite3` and the scrypt/JWT primitives are now unit-testable and mockable in isolation;
  the storage engine could be swapped by reimplementing one small module's interface.
- `server.js` shrank by ~230 lines and no longer references `new Database` or `crypto.scrypt*`
  directly. The module boundary is the injected-config seam (`init()`), keeping env parsing and
  prod-boot policy in one place.
- The public `module.exports` surface is unchanged — the moved functions are re-exported by
  destructuring at the top of `server.js` — so `test/_boot.js` and every existing test still import
  `srv.makeToken`, `srv.verifyPassword`, `srv.saveDB`, etc. exactly as before. Verified: 74 tests +
  3/3 chaos green after the move.
- This is a first pass, not a full decomposition. HTTP-response helpers (`json`/`jsonCacheable`/
  `serveStatic`) and the router itself remain in `server.js`; extracting those is a larger,
  higher-risk change (the router is the request pipeline) left for a future ADR if the file keeps
  growing.

## Rejected alternatives
- **Full relational/DDD rewrite:** out of proportion to the problem and against the project's
  small-surgical-change ethos. This ADR targets exactly the two clusters the graph flagged.
- **Moving `getUser`/`safeUser` too:** would re-introduce `DB`/`IDX` coupling into `lib/` — the
  opposite of the goal.
