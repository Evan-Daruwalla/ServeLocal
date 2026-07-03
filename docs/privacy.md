# Privacy & PII Inventory

> **This is the internal engineering reference.** The public, user-facing policies live in
> the SPA: **Privacy Policy** at `/#privacy` and **Terms of Service** at `/#terms` (both linked
> in the site footer, source in `public/index.html` views `view-privacy` / `view-terms`).
> Keep the public Privacy Policy in sync with the PII inventory below when data handling changes.

ServeLocal is used by minors (students 12+) and therefore treats personal data conservatively:
collect the minimum needed, expose the minimum possible, and let users export or delete it.

## What we collect (PII inventory)

| Data | Purpose | Notes |
|---|---|---|
| First/last name | Identify the volunteer to organizations; verified-hour records | Public surfaces show **first name + last initial only** (leaderboard, reviews) |
| Date of birth | Age-eligibility (12+) and award tracking | Never shown publicly; used for the optional minimum-age warning |
| Email | Login, notifications | Not exposed on public endpoints; org contact email stripped by `publicOpp()` |
| School, grade, location | Matching & school leaderboard | Optional; user-editable |
| Skills, causes | Recommendations & endorsements | User-editable |
| Hours / applications / reviews | Core product records | Owned by the user; included in data export |
| Password | Authentication | Stored only as a salted HMAC-SHA-256 hash; never logged or exported |

## How data is exposed
- **Public/student endpoints** never include org-internal fields — `publicOpp()` strips
  `checkinCodes`, `views`, `orgEmail`, and internal scheduling flags.
- **Leaderboard** exposes only first name + last initial and aggregate hours.
- **Audit log** stores actor **ids** and non-PII metadata, not raw personal data.

## User rights (self-service)
- **Access / portability:** `GET /api/account/export` returns a JSON of all the user's data.
- **Erasure:** `DELETE /api/account` permanently removes the account and associated records,
  freeing any event spots and recording a non-PII deletion entry in the audit log.
- **Rectification:** profile fields are user-editable in the dashboard.

## Minimization & retention
We retain data only as long as needed — see [`data-retention.md`](./data-retention.md).

## Children's privacy
Minimum age is 12. We collect no more than necessary for service operation and award tracking,
and we never sell data. For a school/district deployment, obtain appropriate parental/guardian
consent per local law (e.g., COPPA/FERPA in the US) before onboarding students.
