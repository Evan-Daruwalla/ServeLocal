# ADR-0008: Coarse cache invalidation by global version bump

**Status:** Accepted

## Context
A few read endpoints (`/api/stats`, `/api/leaderboard`, geocode) are recomputed often and are
read-heavy. We want caching without risking stale data after a write, and without per-entry
dependency tracking.

## Decision
Use a small in-memory TTL cache (`cacheGet`/`cacheSet`). Every successful `saveDB()` calls
`bumpCache()`, incrementing a global `_cacheVersion`; cache entries store the version they were
created under and are treated as misses once the version moves. Geocode results are cached for
24h (ZIP→coords is stable). Static assets get `ETag` + `Cache-Control`; HTML always revalidates.

## Consequences
- **Pros:** impossible to serve data from before the last write; dead-simple; no invalidation
  bugs from missed dependencies; bounded memory (cleared when large).
- **Cons:** coarse — any write invalidates *all* cached reads, so cache hit-rate drops on
  write-heavy workloads. Acceptable given current read/write ratio; revisit with per-key
  invalidation or a shared cache if write volume grows.
