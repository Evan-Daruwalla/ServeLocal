# ADR-0004: Demo-mode billing until Stripe is configured

**Status:** Accepted (interim)

## Context
ServeLocal's revenue model (org Pro plans, donations) keeps the product free for students, but
payment processing requires Stripe keys, a webhook endpoint, and PCI considerations not yet set
up.

## Decision
Ship the full billing/donation UX in **demo mode**: `POST /api/billing/upgrade` and
`POST /api/donations` record state and flag `demo:true` without collecting money. The
production cutover (Checkout Sessions, signature-verified webhooks, raw-body handling for the
webhook route) is specified step-by-step in `DEPLOY.txt` §9.

## Consequences
- **Pros:** the entire flow (limits, featured listings, analytics gating) is testable now; no
  payment-secret handling or PCI scope yet.
- **Cons:** demo upgrades/donations are not real; copy must clearly say "demo." Plan state is
  set directly in the route today; under Stripe it must be set from the webhook, not the
  request handler.
- Idempotency-Key support is already wired on these routes so the Stripe retry model drops in.
