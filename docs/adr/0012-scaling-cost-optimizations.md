# ADR-0012: Server-cost optimizations for large user counts

**Status:** Accepted

## Context
The store is a single JSON file loaded fully into memory; `saveDB()` serialises the *entire*
database and rewrites it on every mutation (ADR-0002), and any write rebuilds all in-memory indexes
on next access (ADR-0011). At low volume this is fine, but a code review flagged several paths that
scale their cost with traffic or history rather than with useful work — the things that would drive
per-request CPU, disk I/O, and RAM (and therefore instance size / bill) up at large user counts:

1. **The view beacon rewrote the whole DB on every page view.** `POST /api/opportunities/:id/view`
   did `opp.views++; saveDB()` — the highest-frequency, lowest-value event triggering a full-DB
   serialise + index rebuild.
2. **Every write forced a full index rebuild**, including field-only writes (marking a notification
   read, a status change) that can't actually invalidate reference-keyed index Maps.
3. **N+1 scans in hot public reads.** The opportunity list did `applications.filter` and
   `opportunities.filter` *inside* a `map` over every listing; the leaderboard did an
   `hours.filter` per student — and its result was never actually cached (a `cacheGet` with no
   matching `cacheSet`).
4. **Unbounded growth** of `notifications` inflating both RAM and every serialise.
5. **Static assets and public reads weren't cacheable** beyond the emoji set.

## Decision
Targeted, backward-compatible changes — no new dependency, no change to the storage model itself
(that's ADR-0002's ceiling, reconsidered separately):

- **Coalesced writes (`saveDBSoon()`).** High-frequency, low-criticality writes (view counts,
  notification read-flags) mark the DB dirty and flush on a short debounce (`SAVE_DEBOUNCE_MS`,
  default 2 s) instead of serialising per write. Any explicit `saveDB()` — including the
  graceful-shutdown flush — persists the pending state, so the only loss window is at-most-one debounce
  of view ticks on a hard crash (acceptable for a page-view counter).
- **Structural-signature index rebuilds.** `IDX()` now rebuilds only when the DB object is swapped or
  an *indexed* collection's length changes, not on every cache-version bump. The indexes are Maps of
  object references grouped by id/FK; a field mutation keeps every reference and grouping valid, and
  the codebase never reassigns an id/FK in place nor replaces an array element in place (verified),
  so a per-collection length signature is a sufficient, self-maintaining trigger. Read-cache
  invalidation is unchanged (still every write) — only index rebuilds are decoupled.
- **Indexed hot reads.** The opportunity-list and leaderboard N+1 scans now go through the existing
  `appsByOpp` / `oppsByOrg` / `hoursByUser` indexes; the leaderboard result is now actually cached.
- **Bounded notifications.** `retentionPurge()` caps notifications per user to the most recent
  `MAX_NOTIF_PER_USER` (default 200) on top of the existing read-older-than-90-days purge.
- **HTTP caching.** `jsonCacheable()` adds a weak ETag (keyed on the global cache version) +
  short `Cache-Control` to public, user-agnostic reads (opportunity list, leaderboard, stats) so
  browsers/CDNs revalidate with a 304. Version-stamped static assets (`?v=`) now get the same
  year-long immutable caching the emoji set already had, so a CDN/reverse proxy can serve the bulk of
  static traffic off the app server.

## Consequences
- **Pros:** the per-view full-DB write is gone; field-only writes no longer rebuild indexes; the two
  hottest public reads are O(1)-grouped and HTTP-cacheable; notification growth is bounded; static
  traffic is CDN-offloadable. All backward-compatible (response shapes unchanged; list stays an array).
- **Cons / limits:** coalesced writes trade a tiny crash-loss window on view counts for far fewer
  disk writes. The index signature is per-collection *length*; a hypothetical equal-count
  add+remove within one collection inside a single synchronous handler (before the next `IDX()` read)
  would not trigger a rebuild — no such pattern exists in the codebase today, and any DB swap or
  differing-length write repairs it. Public-read `Cache-Control: public` bounds freshness by `max-age`
  (15–30 s), acceptable for discovery/leaderboard.
- **Not done here (deliberately):** the audit log, verified hours, and messages are security-/record-
  critical and are *not* truncated — bounding those means archival-with-chain-preservation, a
  separate decision. The JSON-whole-DB write model (ADR-0002) remains the real ceiling; `node:sqlite`
  is the first thing to weigh before genuine scale.
