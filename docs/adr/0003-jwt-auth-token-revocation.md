# ADR-0003: Stateless HMAC-JWT auth with tokenVersion revocation

**Status:** Accepted

## Context
We need authentication without a server-side session store (ADR-0002 keeps state minimal), but
stateless tokens are hard to revoke before expiry.

## Decision
Issue compact HMAC-SHA-256 JWTs (`makeToken`) carrying `sub`, `role`, `iat`, `exp`, and `tv`
(token version). `getUser()` verifies the signature and expiry **and** checks that `tv` matches
the user's current `tokenVersion`. Bumping a user's `tokenVersion` (on `signout-all`, or on
suspend) instantly invalidates all their existing tokens. TTL is configurable
(`TOKEN_TTL_HOURS`, default 7 days). The same secret signs the calendar-feed HMAC.

## Consequences
- **Pros:** no session store; immediate revocation when needed; short blast radius via TTL.
- **Cons:** revocation requires a DB field bump (acceptable); rotating `JWT_SECRET` invalidates
  every session and calendar subscription (documented in `.env.example` and the DR doc).
- The client treats any `401` on an authenticated call as session expiry and logs out.
