<!-- See CONTRIBUTING.md for the full review standard. -->

## What & why
<!-- One paragraph: what this changes and the motivation. Link any issue. -->

## How to test
<!-- Exact steps / commands a reviewer runs to verify. -->

## Checklist
- [ ] `npm test` passes locally
- [ ] `npm run coverage:check` passes (or coverage intentionally adjusted with rationale)
- [ ] New user input is validated/sanitized server-side and escaped on render (`esc`/`jsq`/`safeHref`)
- [ ] Any new endpoint enforces auth + role + tenant ownership (no IDOR)
- [ ] Any new opportunity-returning endpoint uses `publicOpp()` for non-owners
- [ ] Security-relevant actions call `appendAudit(...)`
- [ ] No secrets, PII, or `db.json` committed
- [ ] Accessibility: interactive elements are keyboard-reachable and labelled
- [ ] Docs/ADRs updated if architecture or a control changed

## Risk & rollback
<!-- Blast radius if this is wrong, and how to revert. -->
