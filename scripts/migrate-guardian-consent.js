#!/usr/bin/env node
// One-time backfill for accounts created before the guardian-consent flow shipped
// (see docs/guardian-consent-spec.md §8, ADR-0010). Existing student accounts have
// no guardianConsentStatus field at all; this gives every one of them a default:
//   - 18+ today                 -> 'not_required' (never gated, matches new registrants)
//   - under 18                  -> 'legacy_pending' (gated like a fresh 'pending'
//                                   registration, but distinguishable in the admin
//                                   queue from students who registered post-launch)
// Safe to run more than once — already-migrated users (guardianConsentStatus set)
// are left untouched.
// Usage: npm run migrate:guardian-consent   (or  node scripts/migrate-guardian-consent.js)
const srv = require('../server.js');
srv.loadDB();

function studentAge(dob) { return (Date.now() - new Date(dob)) / (365.25 * 864e5); }

let notRequired = 0, legacyPending = 0, skipped = 0;
for (const u of srv.DB.users) {
  if (u.role !== 'student') continue;
  if (u.guardianConsentStatus) { skipped++; continue; } // already migrated or newly registered

  const isMinor = studentAge(u.dob) < 18;
  u.guardianName = u.guardianName || '';
  u.guardianEmail = u.guardianEmail || '';
  u.guardianConsentTokenHash = u.guardianConsentTokenHash || '';
  u.guardianConsentTokenExpires = u.guardianConsentTokenExpires || null;
  u.guardianManageTokenHash = u.guardianManageTokenHash || '';
  u.guardianConsentDecidedAt = u.guardianConsentDecidedAt || null;
  u.guardianConsentIp = u.guardianConsentIp || '';
  u.guardianConsentUserAgent = u.guardianConsentUserAgent || '';

  if (isMinor) {
    u.guardianConsentStatus = 'legacy_pending';
    u.guardianConsentRequestedAt = u.guardianConsentRequestedAt || new Date().toISOString();
    legacyPending++;
  } else {
    u.guardianConsentStatus = 'not_required';
    u.guardianConsentRequestedAt = u.guardianConsentRequestedAt || '';
    notRequired++;
  }
}

if (notRequired || legacyPending) {
  srv.appendAudit('system', 'migration.guardian_consent_backfill', '', { notRequired, legacyPending, skipped });
  srv.saveDB();
}

console.log(`✅ Guardian consent migration complete: ${notRequired} set to not_required, ${legacyPending} set to legacy_pending, ${skipped} already had a status.`);
if (legacyPending > 0) {
  console.log(`⚠️  ${legacyPending} existing minor account(s) now require a guardian email before they can apply/message/check-in again — they'll see the pending-consent banner on next login.`);
}
