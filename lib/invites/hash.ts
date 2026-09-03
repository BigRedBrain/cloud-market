import { createHmac } from 'node:crypto'

import { serverEnv } from '@/lib/env'

/**
 * Invite code hashing.
 *
 * The `invite_codes` table stores `code_hash` and never the code itself — the
 * same rule session and verification tokens follow. This module is the only
 * place that turns a code into that digest, so the normalisation rules and the
 * keying cannot drift between the writer and the reader.
 *
 * KEYED, NOT PLAIN. `INVITE_CODE_PEPPER` is a server-only secret that never
 * goes near the database. A plain SHA-256 is only as strong as its input's
 * entropy; the pepper means an attacker holding a dump of `invite_codes` is
 * still missing a secret and cannot begin a search at all.
 *
 * NOT WIRED. Nothing calls this yet. Redemption is deliberately not implemented
 * here — see the Batch 1 note in the Phase B report.
 */

/**
 * Crockford Base32: no I, L, O or U.
 *
 * Chosen because invite codes get read down a phone and typed by hand. The
 * excluded letters are the ones that get confused with 1, 0 and each other, and
 * U is dropped so a random draw cannot spell something unfortunate.
 */
export const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `CM-` plus five groups of four, e.g. `CM-4F2X-9TQP-...`. */
export const INVITE_PREFIX = 'CM'
export const INVITE_GROUP_SIZE = 4
export const INVITE_GROUP_COUNT = 5

/**
 * Fold a human-typed code back to its canonical form before hashing.
 *
 * Someone reading a code off a card will lower-case it, lose the dashes, add a
 * space, or type O for 0. All of those must produce the same digest as the code
 * that was issued, or a valid invite fails for a cosmetic reason.
 *
 * The ambiguous-character mapping is one-directional and safe precisely because
 * I, L, O and U are not in the alphabet — nothing legitimate can collide.
 */
export function normalizeInviteCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
}

/**
 * Strip the leading `INVITE_PREFIX` from a normalised code, if it is there.
 *
 * Normalisation removes the dash that separated `CM` from the first group, so a
 * normalised full code reads `CM4F2X9TQP…`. Slicing the first group off that
 * directly yields `CM4F`, and re-prefixing produces `CM-CM4F` — the prefix
 * doubled, and four characters of real entropy silently dropped.
 *
 * Checking `startsWith` rather than a fixed length is deliberate: it makes the
 * function idempotent, so feeding an already-computed prefix (`CM-4F2X`) back
 * in returns the same value instead of mangling it. A body whose own first
 * group begins with the prefix letters (`CM-CMAB-…`) also survives, because the
 * leading `CM` is consumed and `CMAB` remains.
 *
 * The one input this cannot disambiguate is a bare body — no `CM-` — that
 * itself starts with `CM`. That is not a shape `generateInviteCode()` produces,
 * so it is accepted as the cost of handling every real case correctly.
 */
function stripInvitePrefix(normalized: string): string {
  return normalized.startsWith(INVITE_PREFIX)
    ? normalized.slice(INVITE_PREFIX.length)
    : normalized
}

/**
 * The clear-text fragment stored alongside the digest, e.g. `CM-4F2X`.
 *
 * Deliberately just the first group. It lets an operator tell two invites apart
 * in a list without the table ever holding enough of the code to be useful:
 * 20 bits here leaves the remaining 80 bits of entropy untouched.
 *
 * Returns an empty string for input too short to have a first group, so a
 * malformed submission cannot produce a misleading prefix.
 */
export function inviteCodePrefix(raw: string): string {
  const body = stripInvitePrefix(normalizeInviteCode(raw))
  if (body.length < INVITE_GROUP_SIZE) return ''
  return `${INVITE_PREFIX}-${body.slice(0, INVITE_GROUP_SIZE)}`
}

/**
 * HMAC-SHA256 of the normalised code, hex. Always 64 characters, which is
 * exactly the width of `invite_codes.code_hash`.
 *
 * Throws when the pepper is absent rather than falling back to an unkeyed
 * digest. A silent downgrade would write hashes that look right, verify fine
 * against each other, and quietly lose the property the column exists for.
 */
export function hashInviteCode(raw: string): string {
  const pepper = serverEnv().INVITE_CODE_PEPPER
  if (!pepper) {
    throw new Error(
      'INVITE_CODE_PEPPER is not configured. Invite hashing is unavailable.',
    )
  }

  return createHmac('sha256', pepper)
    .update(normalizeInviteCode(raw))
    .digest('hex')
}

/** Whether invite hashing can run in this environment. */
export function inviteHashingConfigured(): boolean {
  return Boolean(serverEnv().INVITE_CODE_PEPPER)
}
