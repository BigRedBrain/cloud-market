/**
 * Database identity constants, in one place.
 *
 * PURE AND IMPORT-SAFE. No environment reads, no network, no database, no
 * side effects of any kind — just frozen values and two predicates. Every
 * guard in this repository imports it, including ones that run before any
 * connection is opened, so it must stay that way.
 *
 * WHY IT EXISTS
 *
 * A truncated fingerprint of the production database was hand-copied into
 * eighteen scripts. When production moved endpoints, all eighteen kept
 * refusing a database that no longer existed and stopped refusing the one that
 * did — silently, because a guard that never fires looks exactly like a guard
 * that is working. Refusal behaviour is not something to maintain by
 * find-and-replace.
 *
 * `.mjs` and not `.mts` deliberately: most consumers are `.mjs` scripts invoked
 * by plain `node`, which cannot load TypeScript. The `.ts` consumers run under
 * tsx and import this happily.
 *
 * FINGERPRINTS, NEVER HOSTNAMES. This file is committed. A truncated SHA-256
 * identifies a database to somebody who already knows it, and hands a target to
 * nobody who does not.
 */

/**
 * The CURRENT production database, hashed under the full-hostname scheme:
 * `sha256(new URL(connectionString).hostname).slice(0, 12)`.
 *
 * This is the value `/api/health` publishes live. Verified 2026-08-21.
 *
 * If it stops matching what the deployed application reports, THIS CONSTANT IS
 * WRONG — not the application. Update it here and nowhere else.
 */
export const PRODUCTION_HOST_FINGERPRINT = 'ef3471c4ec76'

/**
 * Fingerprints that USED to be production.
 *
 * Kept and still refused. A retired endpoint is not a safe write target: a
 * stale `.env.local`, an old shell export, or a forgotten deployment variable
 * can still point at one, and "it is not production any more" is not something
 * a test-data script should be betting on. Removing an entry here can only
 * weaken the guard, so entries are added and never deleted.
 *
 *   2b968b3cbe06 — cloudmarket.cc production before 2026-08-21.
 */
export const RETIRED_PRODUCTION_HOST_FINGERPRINTS = Object.freeze(['2b968b3cbe06'])

/**
 * Every host fingerprint a development or verification script must refuse to
 * write to. Current production first.
 */
export const PRODUCTION_HOST_FINGERPRINTS = Object.freeze([
  PRODUCTION_HOST_FINGERPRINT,
  ...RETIRED_PRODUCTION_HOST_FINGERPRINTS,
])

/**
 * Known development databases, full-hostname scheme.
 *
 * NOT RE-VERIFIED as part of the production-fingerprint correction — these are
 * carried forward exactly as they were. They are used only to REFUSE a
 * development target where an isolated copy was required, so a stale entry
 * here fails safe (an unnecessary refusal) rather than unsafe.
 */
export const DEVELOPMENT_HOST_FINGERPRINTS = Object.freeze([
  'eec6912eb35b',
  '3c503c1409d2',
])

/**
 * The development endpoint under the endpoint-id scheme: the hostname's first
 * label with `-pooler` stripped. Same provenance and same caveat as above.
 */
export const DEVELOPMENT_ENDPOINT_FINGERPRINT = 'a5d81ac199d8'

/**
 * Is this host fingerprint production — current OR retired?
 *
 * The predicate rather than an equality test against a single constant, so a
 * caller cannot accidentally check only the current one and let a retired
 * endpoint through.
 */
export function isProductionHostFingerprint(fingerprint) {
  return PRODUCTION_HOST_FINGERPRINTS.includes(fingerprint)
}

/** Is this host fingerprint a known development database? */
export function isDevelopmentHostFingerprint(fingerprint) {
  return DEVELOPMENT_HOST_FINGERPRINTS.includes(fingerprint)
}
