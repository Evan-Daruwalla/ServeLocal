# ADR-0014: Extract the SPA script to /app.js (first step toward dropping CSP 'unsafe-inline')

**Status:** Accepted — both steps shipped (supersedes the "inline-everything" rationale in ADR-0007)

## Context
ADR-0007 kept `script-src 'unsafe-inline'` because the entire SPA — ~3,100 lines of JS — lived in
two inline `<script>` blocks inside `public/index.html`. That had two costs, confirmed
independently by the 2026-07-05 knowledge-graph audit:

1. **Security:** `'unsafe-inline'` neutralizes CSP as an XSS backstop. Output escaping (`esc`/
   `jsq`/`safeHref`) is the primary defense, but the backstop was documented residual risk.
2. **Opacity:** no AST tool could see inside the frontend. The graph audit produced 2 nodes for
   half the product; coverage tooling, linters, and future refactors hit the same wall.

## Decision
Split into two steps, because they carry very different risk:

1. **(This ADR, shipped)** Move both inline blocks verbatim into `public/app.js`, loaded with
   `<script src="/app.js" defer>`. `defer` executes after DOM parse, preserving the
   end-of-body-script guarantee the inline blocks relied on. Execution order of the two blocks
   (app, then the twemojify IIFE) is preserved by concatenation order. index.html: 5,000 → 1,884
   lines; app.js is served by the existing `serveStatic` with ETag + correct MIME.
2. **(Follow-up, shipped as its own focused change)** The markup contained ~271 inline event
   handlers (`onclick=` etc.), many inside generated template strings with interpolated
   arguments. All were converted to a delegated dispatch table: markup now carries a per-event
   attribute (`data-action` for click, plus `data-change`/`data-input`/`data-blur`/`data-keydown`/
   `data-mouseover`/`data-mouseout`) naming a key in a single `ACTIONS` registry in
   `public/app.js`, with arguments passed via a `data-args` JSON array (`esc(JSON.stringify([...]))`)
   and an optional boolean `data-stop`. One delegated document listener per event type dispatches
   (blur via capture, since it doesn't bubble). The new argument-escaping layer routes every
   dynamic value through `esc()` for attribute context — which retired `jsq()` at every converted
   handler site (its single-quoted-onclick-JS context no longer exists; the helper is kept as a
   documented utility). Done surface-by-surface (discover → student dash → org dash → admin →
   modals) with browser-preview verification and an XSS-escaping audit at each step. With zero
   inline handlers remaining, `'unsafe-inline'` was dropped from **script-src** (see the `CSP`
   constant in `server.js`); `style-src` keeps it because hundreds of inline `style=` attributes
   are out of scope for this ADR.

## Consequences
- The frontend is now visible to AST tooling (the knowledge graph, linters) and cacheable
  separately from the HTML shell (app.js changes don't re-download the document, and vice versa).
- `script-src` is now `'self'` with no `'unsafe-inline'`, so CSP is a real XSS backstop for scripts
  again (step 2). `style-src` still allows `'unsafe-inline'` for the remaining inline `style=`
  attributes; the comment above `CSP` in `server.js` explains the split.
- The "single-file SPA" identity becomes "single-page, two files." Nothing about the zero-build,
  zero-framework approach changes.

## Rejected alternatives
- **Bulk-converting all ~270 handlers in the same change:** rejected for the escaping-regression
  risk above.
- **CSP `'unsafe-hashes'` + per-handler hashes:** infeasible — handler strings embed dynamic
  arguments, so the hash set is unbounded.
- **Nonces:** apply to `<script>` elements, not to inline handler attributes; solves nothing here.
