# ServeLocal — Roadmap

Living document. Last updated 2026-07-03. For the reasoning trail behind these decisions see
`docs/record_2026-07-02.md`; for current status see the latest `docs/state_<date>.md`.

## Track 1 — Launch precondition (must ship first)
- **Guardian consent for minors** (ADR-0010) — **DONE** (committed `8a1e4fe`). An `/llm-council`
  review concluded this is a precondition for launch, not a feature: the platform serves students,
  some are minors, and nothing that touches minors should ship ahead of verified guardian consent.

Everything in Track 2 is sequenced **behind** Track 1 being live.

## Track 2 — Growth roadmap (once Track 1 is live)
Order follows the LLM-council **Executor's** sequencing (undisputed by the other advisors):

1. **Real notifications** — replace/complete the notification surface with real delivery (in-app +
   email) so the loop that later features depend on actually reaches users.
2. **Shift templates + bulk messaging** — let orgs template recurring shifts and message applicants
   in bulk; highest-leverage org-side time-saver, and a prerequisite for org retention.
3. **Wire up live Stripe** — move billing/donations from DEMO mode (ADR-0004) to real payments.
   Sequenced after notifications/messaging because revenue matters only once orgs are active and
   retained.
4. **Expansionist growth bets — resequenced, not discarded:**
   - **B2B2C / school-district distribution** — sell/onboard at the district level so schools bring
     their students, rather than acquiring students one at a time.
   - **Portfolio virality** — students' public service portfolios/transcripts as a sharing/growth
     surface (e.g. shareable award progress, college-app-ready exports).

   These are judged the strongest growth ideas in the brainstorm and are kept intentionally — the
   only change is that they come **after** consent and the core notification/messaging/payments loop,
   not instead of them.

## Why this ordering
- Consent is a hard gate (legal/ethical), so it precedes all growth work.
- The Executor's chain builds the engagement→retention→revenue loop in dependency order before
  spending effort on top-of-funnel growth.
- The Expansionist's distribution/virality ideas have the highest ceiling but assume a working core
  loop; running them first would pour acquisition into a leaky bucket.
