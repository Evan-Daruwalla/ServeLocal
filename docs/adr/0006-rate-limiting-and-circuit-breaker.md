# ADR-0006: In-memory rate limiting and circuit breaker

**Status:** Accepted

## Context
We need abuse prevention (brute force, scraping, accidental floods) and protection from a slow
or failing external dependency (the geocode upstream), without adding infrastructure (Redis) or
dependencies (ADR-0001).

## Decision
- **Rate limiting:** a per-IP token bucket (`rateLimit`) — generous for reads, tighter for
  writes — plus a dedicated login throttle (8 failures / 15 min per email+IP). Returns `429`
  with `Retry-After`. Buckets are evicted when idle.
- **Circuit breaker:** `makeBreaker()` wraps the external geocode call. After N failures it
  opens (fail-fast for a cooldown), recovering on the next success; results are cached. The
  breaker state is surfaced at `/api/health/ready`.

## Consequences
- **Pros:** zero infra; immediate protection; observable via health endpoint and load/chaos
  scripts.
- **Cons:** state is per-process and in-memory — multiple instances each have their own limits,
  and limits reset on restart. For multi-instance production, terminate volumetric attacks at
  the edge/CDN and (optionally) move counters to a shared store. Client trust of
  `X-Forwarded-For` assumes a single trusted proxy hop.
