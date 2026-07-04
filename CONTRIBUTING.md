# Contributing to ServeLocal

## Principles
- **Surgical changes.** Touch only what the task requires; match the surrounding style.
- **Simplicity first.** Minimum code that solves the problem; no speculative abstraction.
- **Zero runtime dependencies.** Do not add npm runtime deps without an ADR (see ADR-0001).

## Local workflow
```bash
node server.js              # run the app at http://localhost:3000
npm test                    # unit + integration + regression
npm run coverage:check      # enforce coverage floor
npm run loadtest            # latency/throughput under load
npm run chaos               # resilience checks
npm run backup              # snapshot db.sqlite
```

## Definition of done (every PR)
1. `npm test` and `npm run coverage:check` pass.
2. New user input is **sanitized server-side** (`sstr`/`clampNum`) and **escaped on render**
   (`esc`/`jsq`/`safeHref`). Never interpolate raw user text into an inline `onclick`.
3. New endpoints enforce **auth + role + tenant ownership**. Any endpoint returning
   opportunities to non-owners must pass them through `publicOpp()`.
4. Security-relevant actions call `appendAudit(actor, action, target, meta)`.
5. New interactive UI is **keyboard-reachable and labelled** (see ADR-0007 / accessibility).
6. Tests added: a regression test for any bug fix; integration coverage for new endpoints.
7. No secrets, PII, or `db.sqlite` committed (`.gitignore` enforces this).
8. Docs/ADRs updated if architecture or a control changed.

## Code review standard
- At least one **CODEOWNERS** approval is required (enable branch protection).
- Reviewers verify the checklist above, run the PR locally for non-trivial changes, and
  confirm the "How to test" steps in the PR description actually work.
- Security-sensitive changes (`server.js`, auth, access control) get extra scrutiny and,
  where feasible, a second reviewer.

## Commit / PR hygiene
- Small, focused PRs with a clear "what & why" and a rollback note.
- Reference the issue. Keep the diff reviewable; split large changes.
