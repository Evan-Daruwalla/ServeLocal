# ADR-0010: Guardian consent is a precondition, not a feature

**Status:** Accepted

## Context
Student registration only enforces a 12+ floor (`server.js:820-821`), no ceiling — so the
student population is a mix of minors and 18+ adults, not exclusively minors. For the minors in
that population, the platform already exposes in-app messaging with adult org contacts,
real-time geolocation distance, and check-in codes — all live, with no guardian-consent system.
An `/llm-council` review of a feature brainstorm (2026-07-02) converged, independently across
all five advisors, on this being the single highest-priority gap for minor accounts: not one
item among twenty candidate features, but a blocker on building anything else that increases
exposure of minors' data or real-world contact with orgs.

## Decision
Require a verified guardian email on file before a student account **under 18** can apply to an
opportunity, message an org, redeem a check-in code, or receive an endorsement. Age is computed
from the existing `dob` field, both at registration and dynamically at every gate check, so
18+ students are never asked for guardian info and a minor who turns 18 while a request is
still pending is unblocked automatically. Gate at the narrowest choke point
(`POST /api/opportunities/:id/apply`) since messaging and check-in are already downstream of an
approved application, plus explicit defense-in-depth checks on those two routes directly.
Browsing, profile editing, and saved searches stay open — no PII is shared with an org until an
application exists, so there's no reason to block evaluation of the platform pre-consent.

Full spec: `docs/guardian-consent-spec.md`.

## Consequences
- **Pros:** closes the compliance/trust gap before any engagement or revenue feature ships;
  reuses the existing (currently unused) Resend `sendEmail()` integration and the existing
  hashed-token/audit-log/rate-limit patterns already in the codebase — no new dependencies.
- **Cons:** adds friction to signup (a second party has to respond before a student can do
  anything beyond browse); existing/demo accounts need a migration default (see spec §8);
  guardian email is self-attested, not identity-verified — same rigor level as the existing org
  domain-email verification, and should be revisited if the product ever handles data in ways
  that trigger COPPA's stricter verifiable-consent bar.
- Every other brainstormed feature that widens minors' data exposure (group volunteering, bulk
  messaging, map view, sponsor-a-cohort) is sequenced **behind** this ADR, not in parallel with
  it.
