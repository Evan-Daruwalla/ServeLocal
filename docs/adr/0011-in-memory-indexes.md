# ADR-0011: In-memory indexes over the JSON store

**Status:** Accepted

## Context
The database is a single JSON file loaded fully into memory as arrays (ADR-0002). Every
lookup was an `Array.find` / `Array.filter` — O(n) per lookup, and the hot request handlers do
several. `getUser()` alone (one `DB.users.find` by id) runs on every authenticated request; the
opportunity handlers each open with a `DB.opportunities.find` by id; org dashboards and the data
export do N+1 scans (`applications.filter` inside a `map` over opportunities). As the row counts
grow this is the dominant per-request cost, and it's pure waste — the keys are known.

## Decision
Add a lazily-built in-memory index layer (`IDX()` / `idxList()` in `server.js`): `Map`s keyed by
primary key (`userById`, `oppById`, `appById`, `hoursById`), by the common foreign keys
(`appsByOpp`, `appsByUser`, `hoursByUser`, `notifsByUser`, `messagesByOpp`, `reviewsByOrg`,
`oppsByOrg`, `endorsementsByUser`), and by `userByEmail` / `userByOrgId`.

The indexes are **derived state**, not a second source of truth. They are rebuilt lazily when
either (a) the `DB` object reference changes (load / seed / restore / test swap) or (b) any write
bumps `_cacheVersion` — the *same* coarse invalidation the read cache already uses (ADR-0008). So
an index can never return state older than the last `saveDB()`. Handlers read only via `IDX()`
and never hold the returned maps across a write.

Only the hot read paths and pure primary-key lookups were converted. `findIndex` sites (which
need the array position for in-place mutation) and rare scans (consent-token-hash lookup, a
couple of `senderId`/`userId` export filters with no matching index) were left as linear scans —
converting them would add churn or a low-value index for no meaningful gain.

## Consequences
- **Pros:** the per-request lookups that used to be O(n) are O(1); the org-dashboard and export
  N+1 scans collapse to grouped lookups. No new dependency — just `Map`s and the existing
  cache-version hook. Correctness is covered by `test/index.test.js` (index vs. linear-scan
  agreement, write-invalidation, DB-swap rebuild) on top of the existing integration suite, which
  already exercises every converted path.
- **Cons:** any write rebuilds all indexes on next access (O(n) once per write). That's fine while
  reads dominate writes; if that ever inverts, move to incremental index maintenance at the
  mutation sites. The coarse "rebuild everything on any write" also means a burst of unrelated
  writes re-materializes indexes that didn't change — acceptable at this scale, revisit if the DB
  grows large enough that a full rebuild is itself slow (at which point ADR-0002's flat-JSON store
  is the thing to reconsider first).
- **Invariant to preserve:** never mutate the array returned by `idxList()` in place (it's the
  shared index bucket, or a frozen empty singleton) — spread it first if you need to sort/mutate.
