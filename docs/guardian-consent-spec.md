# Guardian Consent Flow — Spec

> Status: **Implemented.** This is the precondition identified by the
> `/llm-council` review of the feature brainstorm (see chairman verdict, 2026-07-02): student
> registration has a 12+ floor but no ceiling, so **minors and 18+ adults both use the site as
> students**, and the platform already exposes messaging, geolocation-based distance, and
> check-in codes to minors without any guardian-consent system. This spec defines the minimum
> shippable version — not a full identity-verification product, just a verified guardian email
> on file with a hard server-side gate, applied only to accounts under 18, on the actions that
> create real-world contact with an adult-run organization.

## 1. Scope decision

**Correction from the original draft:** ServeLocal's student userbase is not exclusively
minors — registration only enforces a 12+ floor (`server.js:820-821`), with no ceiling, so
18+ adults legitimately use the site as students too. Guardian consent must be **age-gated**,
not blanket-applied.

Rule: compute age from the existing `dob` field (already collected at registration, same
calculation already used for the 12+ check) at both registration time and at every gate check
(§5). **Under 18 → guardian consent required. 18+ → never gated, no guardian fields collected,
no email sent.**

Checking age dynamically at the gate (not just once at registration) also handles the case
where a student registers as a minor and turns 18 while a guardian request is still pending —
the gate opens automatically once they're legally an adult, rather than leaving them stuck
waiting on a guardian who never responded. This is a deliberate consequence, not an edge case
to patch around.

Org accounts are unaffected.

## 2. Data model additions

Add to the student user object (`server.js:822-829`):

```js
guardianName: '',              // sstr(...,120); only collected/required if age(dob) < 18 at registration
guardianEmail: '',             // lowercased, validated with the existing EMAIL_RE; same condition
guardianConsentStatus: 'pending',  // 'not_required' | 'pending' | 'verified' | 'declined' | 'revoked'
guardianConsentTokenHash: '',      // sha256 of the one-time approval token; never store the raw token
guardianConsentTokenExpires: null, // ISO string, TTL from CONSENT_TOKEN_TTL_HOURS
guardianManageTokenHash: '',       // sha256 of a long-lived token for revoke-anytime access
guardianConsentRequestedAt: '',    // iso(), set on register and every resend
guardianConsentDecidedAt: null,    // iso(), set on approve/decline/revoke
guardianConsentIp: '',             // IP of the device that submitted the decision (audit trail)
guardianConsentUserAgent: '',      // same, for the audit trail
```

Reuse the existing hashed-token pattern already in the codebase (calendar tokens, password
reset groundwork) — never store the raw token, only its hash, and compare with
`crypto.timingSafeEqual` like every other secret comparison in `server.js` (see
`CLAUDE.md` "Passwords" section for the existing convention).

**Guardian email ≠ student email.** Reject registration if `guardianEmail.toLowerCase() ===
email.toLowerCase()` — a matching email is the most obvious self-consent bypass and costs
nothing to block.

## 3. Registration change

`POST /api/auth/register/student` (`server.js:810-835`):

The existing age check (`server.js:820-821`) already computes `age` from `dob` to enforce the
12+ floor. Reuse that same value to branch:

- **If `age >= 18`:** `guardianConsentStatus:'not_required'`. `guardianName`/`guardianEmail`
  are not required, not validated, and if the client sends them anyway (e.g. a leftover form
  field) they're ignored rather than stored — an adult's "emergency contact" is a different
  feature, not this one. No email sent, no token generated.
- **If `age < 18`:** add `guardianName`, `guardianEmail` to the required-field check. Validate
  `guardianEmail` with the existing `EMAIL_RE` / `isEmail()`. Reject if `guardianEmail ===
  email` (case-insensitive). Set `guardianConsentStatus:'pending'`, generate the one-time token
  (`crypto.randomBytes(32).toString('hex')`), store only its hash + a
  `CONSENT_TOKEN_TTL_HOURS` (default 72h) expiry, and call `sendEmail()` (already implemented,
  unused, in `server.js:598-625` via Resend) to `guardianEmail` with a link to
  `${PUBLIC_BASE_URL}/#consent/<token>`.
  `appendAudit(u.id, 'account.guardian_consent_requested', u.id, {guardianEmail})`.

Response shape is unchanged either way, but the client should read `guardianConsentStatus` off
the returned user: `not_required` → normal dashboard immediately; `pending` → the
"waiting on guardian" state (§6).

If `RESEND_API_KEY` isn't configured (dev/local), `sendEmail()` should no-op with a console log
of the consent link — same posture the codebase already takes for other unconfigured-in-dev
integrations (Stripe demo mode, etc.), so local dev isn't blocked.

## 4. New endpoints

All new consent endpoints are **rate-limited** using the existing `rateLimit()` token bucket
(write-tier caps) to prevent token-guessing/enumeration.

### `GET /api/consent/:token` — public, no auth
Look up the student by `sha256(token)` matching `guardianConsentTokenHash`, with `timingSafeEqual`.
- 404 if no match.
- 410 Gone if `guardianConsentTokenExpires` has passed, with a `code:'CONSENT_TOKEN_EXPIRED'`
  the client can use to show "ask your student to resend."
- 200 with minimal, non-sensitive context only: `{studentFirstName, studentLastInitial}` —
  never the student's email, DOB, school, or location. The guardian doesn't need an account to
  see this.

### `POST /api/consent/:token` — public, no auth
Body: `{decision: 'approve'|'decline', relationship?: string}`.
- Same token lookup/expiry rules as GET.
- On `approve`: set `guardianConsentStatus:'verified'`, `guardianConsentDecidedAt`, capture
  `guardianConsentIp`/`guardianConsentUserAgent` from the request, clear the one-time token
  hash (single use), **generate the separate long-lived `guardianManageToken`** and include its
  link in the confirmation email so the guardian can revoke later without re-registering.
  `createNotification(student.id, 'guardian_consent_verified', ...)`.
- On `decline`: set `guardianConsentStatus:'declined'`, same audit/notification pattern. Student
  account remains but stays permanently gated (see §5) until support/admin intervenes — no
  auto-retry loop.
- `appendAudit('guardian:'+studentId, 'account.guardian_consent_decided', studentId,
  {decision, ip})` — actor is not a platform user, so prefix the audit actor id to keep the
  hash-chained log's actor field meaningful without inventing a guardian account.

### `GET/POST /api/consent/manage/:manageToken` — public, no auth
Same lookup pattern against `guardianManageTokenHash`. Lets a guardian **revoke** consent at
any time, not just decide once. `POST {action:'revoke'}` sets
`guardianConsentStatus:'revoked'`, re-applies the same gate as `declined`, and notifies the
student. This is the "kill switch" the council's peer review flagged as missing from every
original brainstorm response.

### `POST /api/account/consent/resend` — authenticated (student)
Regenerates the one-time token (invalidating the old one) and resends. Cooldown: reuse the
login-throttle pattern (`server.js:587-591`) keyed on user id, e.g. 1 resend per 5 minutes, to
stop notification spam toward the guardian.

### `GET /api/admin/consent/pending` — admin only
Mirrors the existing `/api/admin/orgs/pending` pattern (`server.js:1758`). Lists students whose
`guardianConsentStatus` has been `pending` for longer than N days, so stuck signups are visible
the same way stuck org applications already are. Gives admin a support queue instead of a black
hole.

## 5. The gate (server-side enforcement)

Add a single helper. Age is recomputed from `dob` on every call (not read from a stored
boolean) so a student who ages into adulthood while a request is still pending is unblocked
automatically, without needing a background job or a login-time re-check:

```js
function requireGuardianConsent(user) {
  if (user.role !== 'student') return null; // orgs/admin unaffected
  const age = (Date.now()-new Date(user.dob))/(365.25*864e5);
  if (age >= 18) return null; // adults are never gated, regardless of stored status
  if (user.guardianConsentStatus === 'verified') return null;
  return { error: 'Guardian approval is required before you can do this.',
           code: 'GUARDIAN_CONSENT_REQUIRED' };
}
```

Call it at the top of every handler that creates real-world contact with an org, returning 403
with the helper's payload if non-null:

- **`POST /api/opportunities/:id/apply`** (`server.js:1185`) — the actual commitment to show up
  in person. This is the primary gate: applications can never reach `approved` for an
  unconsented student, which transitively blocks messaging (`server.js:1598-1642`, already
  keyed on `status==='approved'`) and check-in redemption (`server.js:2276`, already requires
  an approved application) without touching either of those handlers directly.
- **`POST /api/messages/:oppId`** (`server.js:1612`) — add explicitly anyway, as defense in
  depth, not because the apply-gate leaves a gap today. Cheap insurance against a future change
  loosening the approved-application requirement.
- **`POST /api/checkin`** (`server.js:2276`) — same defense-in-depth reasoning.
- **`POST /api/endorsements`** (`server.js:1958`) — an org endorsing a student is another
  adult↔minor record; gate it too.

**Explicitly NOT gated:** browsing/searching opportunities, profile editing, saved searches,
bookmarking (`savedOpps`), awards/goal viewing. Nothing here shares the student's PII with an
org or creates real-world contact, so a pending student can still fully evaluate the platform
before a guardian responds — no reason to block that.

**Client-side geolocation:** `useMyLocation()` never sends coordinates to the server (distance
math is client-side against opportunity lat/lng per the existing feature), so there's no
server-side gate to add. Spec: hide/disable the "Use my location" button client-side while
`guardianConsentStatus !== 'verified'`, same as any other pending-gated UI affordance — this is
a UX nicety, not a security boundary, and should be documented as such rather than implied to
be enforced.

## 6. Frontend

- **Registration form** (student branch of `openAuth('register')`): add "Parent/Guardian Name"
  and "Parent/Guardian Email" fields, both required, with the same inline validation pattern
  used for existing fields.
- **Pending-consent state**: after registering, route to the dashboard as normal but with a
  persistent, non-dismissible banner (similar treatment to the existing support banner) reading
  "We emailed **[guardianName]** for approval — you can browse opportunities now, but can't sign
  up for one until they respond," plus a "Resend email" button wired to
  `POST /api/account/consent/resend`.
- **Blocked-action handling**: any API call that returns `code:'GUARDIAN_CONSENT_REQUIRED'`
  should surface a specific modal ("Ask [guardianName] to check their email") instead of the
  generic error toast — reuse the existing modal/toast infra (`openM`, `esc()` for any
  interpolated name).
- **New public view `#consent/:token`**: no login required, no nav chrome needed (similar
  isolation to how `/#privacy` and `/#terms` render). Shows student first name + last initial,
  a plain-language explanation of what ServeLocal is, and Approve/Decline buttons calling
  `POST /api/consent/:token`. On approve, show the manage-link so the guardian can bookmark it.
- **New public view `#consent-manage/:token`**: same shell, single "Revoke consent" action with
  a confirm step.
- **Notifications**: student gets an in-app notification (existing `createNotification`
  pipeline) on both approve and decline/revoke.

## 7. Audit trail

Every state transition goes through `appendAudit()`, consistent with the existing hash-chained
log (`docs/security.md` control #11):

- `account.guardian_consent_requested` (register, resend)
- `account.guardian_consent_decided` (approve/decline, with decision + ip in `meta`)
- `account.guardian_consent_revoked`

This gives a tamper-evident record of exactly when and from where consent was granted or pulled
— the "who consented, when" answer the council flagged as currently missing for the platform as
a whole.

## 8. Rollout / migration

The seeded demo student (`student@demo.com`, `dob:'2007-03-15'` — 19 years old as of this
writing) already falls on the adult side of the age gate, so it needs no changes: on next boot
after this ships, a migration script (`scripts/migrate-guardian-consent.js`, following the
pattern of `scripts/backup.js`) can backfill `guardianConsentStatus:'not_required'` for any
existing user whose current age is 18+, with zero disruption.

For existing **minor** accounts created before this ships, the same migration script sets
`guardianConsentStatus:'legacy_pending'` (behaves identically to `pending` at the gate, §5, but
is distinguishable in the admin queue from a freshly-registered pending state). Those students
see the pending-consent banner on next login and must supply a real guardian email before they
can apply/message/check-in again — but a migration script only needs to *set the status*, not
retroactively invent a guardian email that was never collected, so this is a safe default even
though it adds friction for anyone caught by it.

## 9. New env vars

Add to `.env.example`, following the existing convention:

```
# Guardian consent
CONSENT_TOKEN_TTL_HOURS=72       # one-time approval-link validity
PUBLIC_BASE_URL=http://localhost:3000   # used to build consent links in emails
RESEND_API_KEY=                  # already exists — now actually used
```

## 10. Test plan (`test/`)

New `test/guardian-consent.test.js`, following the existing `_boot.js` isolated-server pattern:

- Register a minor (`dob` implying age < 18) without `guardianEmail` → 400.
- Register a minor with `guardianEmail === email` → 400.
- Register a minor → `guardianConsentStatus==='pending'` on the returned user.
- Register an 18+ user (any `dob` giving age ≥ 18) with no guardian fields at all → 201,
  `guardianConsentStatus==='not_required'`, and `apply` succeeds immediately with no
  consent step.
- A `pending` minor whose `dob` now implies age ≥ 18 (simulate via a back-dated `dob` in the
  test fixture) → gate passes despite the stored `pending` status — proves the dynamic
  age-recheck in `requireGuardianConsent` actually unblocks aged-out accounts.
- `POST /api/opportunities/:id/apply` while pending → 403 `GUARDIAN_CONSENT_REQUIRED`.
- `GET /api/consent/:token` with wrong token → 404; with expired token → 410.
- `POST /api/consent/:token {decision:'approve'}` → status becomes `verified`; apply now
  succeeds; token is single-use (second POST with the same token → 404).
- `POST /api/consent/:token {decision:'decline'}` → status `declined`; apply still 403.
- `POST /api/account/consent/resend` twice within cooldown → 429; old token invalidated by new
  one.
- `POST /api/consent/manage/:manageToken {action:'revoke'}` after a prior approval → status
  `revoked`; apply now 403 again (kill-switch works after the fact, not just pre-approval).
- Regression: audit chain includes every transition and still verifies
  (`GET /api/admin/audit/verify`).

## 11. Explicitly out of scope for this spec

- Real identity verification of the guardian (this is email-based consent, not notarized/ID
  verification — matches the rigor level of the existing org domain-email verification, which
  is also self-attested).
- COPPA's stricter "verifiable parental consent" mechanisms (credit card, signed form, video
  call) required for operators collecting data from under-13s for *behavioral advertising or
  data sale* — ServeLocal does neither, but if that changes, this spec's email-link consent
  would need to be upgraded, not just extended.
- SMS/phone-based guardian contact — email only, matching the platform's existing
  email-only ADR-implicit posture (Resend is the only messaging integration in the codebase).

---

*Companion: see `docs/adr/0010-guardian-consent-precondition.md` for the one-paragraph decision
record — that a student account cannot reach `guardianConsentStatus:'verified'`-gated actions
without this flow is treated as a precondition for the product, not a backlog feature.*
