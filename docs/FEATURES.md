# ServeLocal — Complete Feature Inventory

> Volunteer platform connecting students (12+) with community service opportunities.
> **Free forever for students.** Revenue comes from organization Pro subscriptions and
> community supporters. This document lists *every* feature, grouped by area. Last
> generated from `server.js` (~90 API routes) and `public/index.html` (16 SPA views).

---

## 1. Roles & Accounts

| Role | What they do |
|---|---|
| **Student** | Find opportunities, apply/subscribe, log & track hours, earn awards, build a portfolio. Always free. |
| **Organization (org)** | Post opportunities, manage applicants, verify hours, message volunteers, view analytics. Free (Community) or paid (Pro). |
| **Admin** | Vet/approve organizations, handle abuse reports, inspect the tamper-evident audit log. |

**Account features**
- Student registration (name, DOB for 12+ age check, email, school, grade, location).
- Organization registration (with domain-email verification + admin review before listings go live).
- Login / logout; "sign out of all devices" (token revocation).
- Change password (with weak-password blocking) — revokes other sessions.
- Profile editing (skills, causes, school, grade, location, bio).
- **Data export** (GDPR access/portability) — download all your data as JSON.
- **Account deletion** (right to erasure) — frees event spots, records a non-PII audit entry.
- Demo accounts: `student@demo.com` / `org@demo.com` (password `demo1234`).

---

## 2. Public / Marketing Pages

- **Home** — hero, "Why ServeLocal" bento grid, supporter call-to-action banner.
- **Find Opportunities (Discover)** — searchable, filterable opportunity browser.
- **For Organizations** — value-prop bento grid + pricing link.
- **Community** — aggregate community impact stats and leaderboard.
- **Support Us / Donate** — supporter donations (DEMO mode until Stripe is configured).
- **Pricing** — Community vs. Pro plan comparison.
- **Organization landing pages** — public profile for each org with its active listings.
- **Reviews pages** — public reviews of an organization.
- **Portfolio pages** — public (opt-in) volunteer portfolio / transcript.
- **Privacy Policy** and **Terms of Service** — full legal pages, linked in footer.
- **Cookie / storage notice** — informational banner (site uses only `localStorage`, no tracking cookies).

---

## 3. Opportunities

**For students (discovery)**
- Browse all active opportunities.
- **Filters:** by skill, cause, date, and time commitment.
- **Distance / "near you":** real-time distance from the user's **live geolocation** *or* a typed ZIP code (haversine distance, privacy-rounded coordinates).
- **Featured listings** sort to the top (Pro orgs).
- Opportunity detail view (description, schedule, spots remaining, org info).
- Per-date spot availability for recurring events.
- **Bookmarks / Saved** — heart an opportunity; "Saved" tab in the student dashboard.
- **Saved searches** — save a filter set and re-run it later.

**For organizations (management)**
- Create an opportunity (One-time, Weekly, or Monthly recurring).
- Edit an opportunity.
- Deactivate (soft) / reactivate a listing.
- Permanently delete a listing.
- **View counter** — lightweight beacon feeds org analytics.
- Active-listing caps by plan (Community: 3; Pro: unlimited).

---

## 4. Applications & Scheduling

- **Apply / subscribe** to an opportunity. Three modes:
  - One-time event sign-up.
  - Recurring **subscription** (all dates).
  - Recurring **single-date** sign-up.
- **Auto-approve** or **requires-approval** flows (org's choice per listing).
- **Exclude / skip individual dates** on a recurring subscription.
- **Unsubscribe** from an opportunity.
- **Waitlist** (one-time events only) — join when full, **auto-promoted FIFO** the instant a spot frees.
- Org applicant management: approve / reject applications.
- "My applications" view (student) and "Applicants" view (org).
- **Calendar** of upcoming shifts; recurring events expanded into per-day entries.

---

## 5. Hours Tracking & Verification

- **Auto-logged hours** — pending entries created automatically when an event date passes.
- **Manual hour logging** (self-reported).
- **Org verification** — approve or deny attended hours from the dashboard.
- **Bulk verify** — verify many hours at once.
- **Appeals** — students can appeal a denied/disputed hour entry.
- **Check-in codes** — orgs generate a 6-char code per event date; students redeem at check-in for **instantly verified** hours (requires an approved sign-up).
- Hours history with filter tabs: **All / Verified / Pending / Self-Reported / Denied**.
- Quick-log widget.
- Hours-verification **reminder prompts** auto-sent to orgs after an event ends.

---

## 6. Awards, Portfolio & Impact

- **Awards tracking** by verified hours — milestones:
  - National Honor Society (10h)
  - President's Volunteer Service Award — Bronze / Silver / Gold (50 / 100 / 250h, ages 14–18)
  - SSL Certificate — Maryland (75h)
  - Governor's Gold Seal (100h, varies by state)
- **Goal tracker** — progress toward the next award.
- **Portfolio / transcript** — verified-hours record exportable for college & job applications; visibility toggle (public/private).
- **Endorsements** — orgs endorse a student for an opportunity; shown on the portfolio.
- **Impact dashboard** — personal totals (hours, events, causes, organizations).
- **Reviews** — students review organizations they've served with.
- **Leaderboard** — public ranking (exposes only first name + last initial + aggregate hours).
- **Community impact** — aggregate site-wide stats.

---

## 7. Messaging & Notifications

- **Per-opportunity messaging** between orgs and signed-up volunteers.
- **Notifications center** — list, unread count, mark-one-read, mark-all-read.
- **Automated reminders** (background jobs):
  - Event reminder ~24 hours before.
  - Event reminder ~1 hour before.
  - "Hours need verification" prompt to orgs after an event ends.

---

## 8. Organizations — Plans, Billing & Analytics

| | **Community** (free) | **Pro** ($19/mo) |
|---|---|---|
| Active listings | 3 | Unlimited |
| Featured listings | 0 | 3 |
| Roster export | — | ✅ |
| Analytics | basic | ✅ |

- **Featured listings** — Pro orgs pin up to 3 listings to the top of Discover.
- **Org analytics** — views, applicants, and per-listing performance.
- **Volunteer roster export** (Pro) — export the volunteer roster.
- **Plan upgrade / downgrade** (DEMO checkout until Stripe keys are configured).
- **Donations** — community supporter contributions + public donation stats (recent supporters, total raised, donor count). DEMO mode until payment keys configured.

> ⚠️ **Billing & donations run in DEMO mode** — no real payments are processed until Stripe keys are added (see `DEPLOY.txt §9`).

---

## 9. Admin & Trust/Safety

- **Organization vetting** — pending-orgs queue; approve or reject (domain-email verification + manual review).
- **All-orgs** management view.
- **Abuse reports** — users report an org; admins triage and resolve.
- **Site stats** dashboard.
- **Tamper-evident audit log** — hash-chained; admin-only viewer plus an integrity-verify endpoint.

---

## 10. Calendar & Integrations

- **Calendar feed (ICS)** — subscribe to your shifts from any calendar app.
- **Per-user calendar token** for the private feed URL.
- **"Add to calendar"** one-tap export for individual shifts.
- **Geocoding** with a circuit breaker + cached fallback for the external geocode call.

---

## 11. Onboarding & UX

- Guided **onboarding** flow for new users.
- Hash-based **deep links / routing** (`#discover`, `#opp/<id>`, `#org/<orgId>`, `#portfolio/<userId>`, `#privacy`, `#terms`, etc.) with browser history support.
- **Bento-grid** marketing layout; responsive (mobile-first), reduced-motion aware.
- **Self-hosted PNG emoji** — full Twemoji v15.1.0 set (~3.8k icons) swapped in via a DOM walker + `MutationObserver`, so every icon/flag/ZWJ sequence renders consistently across platforms.
- **PNG brand assets** derived from the master logo (favicon 16/32, apple-touch-icon, OG/Twitter share image) via a zero-dependency generator script.
- Support banner ("free forever for students → become a supporter").

---

## 12. Accessibility

- Skip link + `<main>` landmark.
- ARIA roles/labels on nav, dialogs, tabs, and icon buttons.
- `aria-live` toast announcements.
- Modal focus management + focus restore; keyboard activation throughout.
- Visible `:focus-visible` styling.
- `prefers-reduced-motion` support; 16px inputs on mobile (no iOS zoom); larger tap targets.

---

## 13. Security & Operations (infrastructure)

> Full controls matrix in [`docs/security.md`](./security.md). Highlights:

- **Auth:** scrypt password hashing (legacy HMAC auto-upgrades on login), HMAC-JWT tokens with TTL + `tokenVersion` revocation, constant-time comparisons, weak-password denylist.
- **Authorization:** roles (`student`/`org`/`admin`), per-handler ownership checks, multi-tenant isolation, `publicOpp()` strips org-internal fields from public responses.
- **Input/output safety:** server-side sanitization (`sstr`/`clampNum`/`isEmail`); client escaping (`esc`/`jsq`/`safeHref`); CSP + full security headers; **path-traversal-safe** static serving.
- **Abuse prevention:** per-IP rate limiting (token bucket) + login throttle.
- **Resilience:** atomic DB writes (temp + rename), 30-min backup snapshots, corrupt-DB recovery/reseed, graceful degradation (`/api/health` + `/api/health/ready`), circuit breaker, retry/backoff, **idempotency keys** on mutating routes.
- **Privacy/compliance:** PII minimization, hourly retention purge, GDPR export & erasure; documented HIPAA out-of-scope.
- **Secrets:** prod refuses to boot on default `JWT_SECRET` or default `ADMIN_PASSWORD`; CORS lockdown via `ALLOWED_ORIGINS`; optional direct TLS + HSTS.
- **Quality:** unit / integration / regression test suites, coverage thresholds, load & chaos scripts, CI with `npm audit`, Dependabot, zero runtime dependencies.
- **Deferred (documented, not yet built):** HttpOnly-cookie auth refactor; TOTP MFA; email-based password reset.

---

*Generated for Evan. Re-derive from `server.js` (routes) and `public/index.html` (views) if the surface changes.*
