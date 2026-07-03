# ADR-0009: scrypt password hashing with transparent migration

**Status:** Accepted (supersedes the original HMAC-SHA256 password storage)

## Context
Passwords were stored as `HMAC-SHA256(password, salt)` — a *fast* hash. If `db.json` leaked, an
attacker could brute-force passwords at GPU speed. OWASP's Password Storage guidance calls for a
slow, memory-hard KDF (Argon2id, or scrypt when Argon2 is unavailable). We must stay zero-runtime-
dependency (ADR-0001).

## Decision
Use **scrypt** via the Node standard library (`crypto.scryptSync`) — no new dependency. Stored
hashes are self-describing: `scrypt$N$r$p$salt$hash` (default N=2¹⁵ = 32768, r=8, p=1; N is
env-tunable via `SCRYPT_N`, raise in production). `verifyPassword()` handles both scrypt and legacy HMAC credentials; on a successful
login with a legacy hash, `migrateLegacyPassword()` transparently re-hashes to scrypt. All password
comparisons use `crypto.timingSafeEqual` (constant time). A small bundled denylist blocks the most
common/guessable passwords at registration and change.

## Consequences
- **Pros:** dramatically higher offline-cracking cost; no dependency; seamless migration (no forced
  reset); cost is tunable as hardware improves.
- **Cons:** login/registration now spend CPU + memory on the KDF (tens of ms); tests lower `SCRYPT_N`
  for speed. scrypt is memory-hard but Argon2id is the modern first choice — revisit if a vetted
  zero-dep Argon2 becomes available in the platform.
- Legacy hashes linger until each user next logs in; acceptable and self-healing.
