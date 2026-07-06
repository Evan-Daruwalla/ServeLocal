# ADR-0007: Content-Security-Policy retains `unsafe-inline` for the inline SPA

**Status:** Accepted (with a planned tightening path) — partially superseded by
[ADR-0014](./0014-external-spa-script.md): the inline `<script>` blocks moved to `/app.js`
(2026-07-05); `'unsafe-inline'` now remains only for inline event handlers and `style=`.

## Context
The frontend is intentionally a single `index.html` with inline `<style>`, inline `<script>`,
inline `style=` attributes, and inline `onclick=` handlers (ADR-0001: no build step). A strict
CSP forbidding inline code would break the app. We still want CSP's other protections.

## Decision
Send a CSP that allows `'unsafe-inline'` for `script-src`/`style-src` (required by the inline
SPA) while locking down everything else: `default-src 'self'`, `connect-src 'self'`,
`img/font` limited to self + Google Fonts + `data:`, `frame-ancestors 'none'` (anti-clickjacking,
also via `X-Frame-Options: DENY`), `base-uri 'self'`, `object-src 'none'`, `form-action 'self'`.
Paired with `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and
HSTS in production.

## Consequences
- **Pros:** blocks external script injection, framing, plugin content, and off-origin form posts
  today, with no app changes; defense-in-depth with our output escaping (`esc`/`jsq`).
- **Cons:** `'unsafe-inline'` means CSP does not stop *injected inline* script — so output
  escaping remains the primary XSS defense, not CSP.
- **Tightening path:** move inline scripts to a hashed/nonce'd external bundle to drop
  `'unsafe-inline'`. Deferred to keep the no-build-step simplicity until warranted.
