# ADR-0013: SQLite persistence (replaces the whole-JSON-file store)

**Status:** Accepted

## Context
ADR-0012's load testing confirmed the ceiling ADR-0002 flagged as a future migration point:
`saveDB()` called a single `JSON.stringify(DB)`, producing one JS string that V8 caps at ~512MB
(~90k users at this record shape). `USERS=100000 npm run loadtest:scale` failed outright with
`Invalid string length` — the app could neither write nor load its DB past that point. The same
load test also found `/api/opportunities` response-size-bound: it returned every active listing
uncached (~0.5MB/response at 10k users, ~1.5GB moved across a 3,000-request run).

## Decision
Two changes, shipped together since the same load test found both:

1. **Swap only the persistence FORMAT, not the in-memory model.** Each of the 12 `DB_COLLECTIONS`
   gets its own SQLite table (`id`/`seq` primary key + a `data` JSON-blob column per row), via
   `better-sqlite3` — a real npm dependency, a deliberate, documented exception to ADR-0001 (Evan
   explicitly authorized dependencies for this migration, preferring something light/easy to set
   up). `better-sqlite3` was chosen over the built-in `node:sqlite` because the latter is still
   experimental and only ships from Node 22.5+, which would have dropped this project's Node 20.x
   CI leg. `loadDB()`/`saveDB()`/`backupSnapshot()`/`restoreFromBackup()` are the ONLY functions
   that changed — every `DB.<collection>` array, the whole `IDX()` layer, and all of the request
   handlers are untouched, because none of them cared what format the data came from. This is
   deliberately **not** a full relational rewrite (no per-request SQL queries, no move of business
   logic into SQL) — it targets the exact thing ADR-0012 confirmed breaks the app, with the
   smallest, best-tested change that fixes it.
2. **Pagination on `/api/opportunities`.** `limit` (default 60, max 200) / `offset` query params,
   applied after the featured-pin sort (so featured listings across the whole result set still win
   a slot) and before the per-listing badge computation (so uncomputed pages don't cost anything).
   The response shape is unchanged — still a bare array, no caller needs to change — and the total
   count travels in a new `X-Total-Count` header for a future "load more".

## Consequences
- **Pros:** the confirmed `Invalid string length` ceiling is gone — verified at 100k users (763MB
  DB, 0 errors; see Measured impact). Atomic-write semantics are preserved (temp file + rename);
  backup/restore keep working, just against `.sqlite` snapshots instead of `.json`. Response bytes
  moved by the load test dropped ~47× (pagination). Every business-logic file is untouched — this
  is the lowest-risk version of "migrate to SQLite" available.
- **Cons:** a real dependency now exists (native binding; an ADR-0001 exception, scoped to this one
  concern). The in-memory working set is still the full DB — every row still loads into
  `DB.<collection>` arrays at boot — so this fixes the confirmed *serialization* ceiling, not a
  hypothetical RAM ceiling. `db.json` backups made before this migration are JSON-format and are
  **not** read by the new backup/restore path (see Migration below).
- **Migration:** existing `db.json` deployments are not silently discarded. `npm run migrate:sqlite`
  (`scripts/migrate-to-sqlite.js`) does a one-time `db.json` → `db.sqlite` conversion via the same
  `saveDB()` path, guarded against overwriting an existing `db.sqlite` unless `--force`.
- **Not done here (deliberately):** pushing queries down to SQL (indexed `WHERE`/`LIMIT` at the DB
  layer instead of loading everything into memory and filtering in JS) would additionally bound RAM
  and enable true DB-level pagination — a bigger, separate rewrite touching every handler, not
  justified until the in-memory-RAM ceiling (not the confirmed serialization ceiling) is actually
  hit. The frontend's Discover view does not yet page past the default `limit=60` — no "load more"
  UI was built (out of scope for a backend persistence/pagination fix); a DB with more than 60
  active listings only shows the first page until that's added.
- Supersedes ADR-0002 for the on-disk format only; ADR-0002's in-memory-model reasoning ("whole
  store fits in memory for fast reads") is still accurate and unchanged.

## Measured impact
Reproduce with `npm run loadtest:scale` (`USERS=` env, same synthetic-corpus methodology as
ADR-0012), now run against the SQLite-backed + paginated server:

| Metric (10k users) | ADR-0012 (JSON-file, indexed) | ADR-0013 (SQLite + pagination) |
|---|---:|---:|
| `/api/opportunities` single-shot | 38 ms | **3.9 ms** |
| Throughput (3k reqs @ concurrency 50) | ~80 req/s | **1,445 req/s** |
| p50 / p99 latency | ~620 / ~820 ms | **34 / 46 ms** |
| Response bytes moved (3k reqs) | ~1.5 GB | **32 MB** |

**100k users — the case that used to fail outright:** `USERS=100000 npm run loadtest:scale` now
completes cleanly: 763 MB DB, 3,000/3,000 requests OK (0 errors, 0 rate-limited), 130 req/s,
`/api/opportunities` single-shot 19.4 ms. The confirmed ADR-0012 ceiling (`Invalid string length`
past ~90k users) is gone.

The response-bytes drop is entirely pagination (60 items/response instead of every active listing);
the throughput/latency gains are dominated by no longer serializing the whole DB per save. This is
one combined measurement, not a controlled ablation of the two changes — but both were shipped
together because both were found by the same load test and both fix the same class of problem
(unbounded response cost as user count grows).
