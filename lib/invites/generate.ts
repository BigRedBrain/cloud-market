import { randomInt } from 'node:crypto'

import {
  INVITE_ALPHABET,
  INVITE_GROUP_COUNT,
  INVITE_GROUP_SIZE,
  INVITE_PREFIX,
  hashInviteCode,
  inviteCodePrefix,
} from './hash'

/**
 * Invite code generation.
 *
 * Produces the code, its digest and its clear-text prefix together, because
 * those three values are only ever useful as a set: the row stores the digest
 * and the prefix, and the plaintext is returned once to whoever created it and
 * then deliberately forgotten.
 *
 * NOT WIRED. Nothing calls this yet — there is no admin invite tool and no
 * redemption path. It exists so Batch 1 can be reviewed in isolation.
 */

export type GeneratedInvite = {
  /**
   * The formatted code, e.g. `CM-4F2X-9TQP-...`. Show this once. It cannot be
   * recovered afterwards — the digest is one-way and nothing else stores it.
   */
  code: string
  /** HMAC-SHA256 hex digest for `invite_codes.code_hash`. */
  codeHash: string
  /** Clear-text fragment for `invite_codes.code_prefix`, e.g. `CM-4F2X`. */
  codePrefix: string
}

/**
 * 100 bits of entropy: five groups of four Crockford Base32 characters, each
 * character worth five bits.
 *
 * `randomInt` rather than `Math.random` — this is a credential, and it is also
 * rejection-sampled internally, so a 32-character alphabet drawn from a range
 * that is a power of two carries no modulo bias.
 */
export function generateInviteCode(): GeneratedInvite {
  const groups: string[] = []

  for (let g = 0; g < INVITE_GROUP_COUNT; g += 1) {
    let group = ''
    for (let c = 0; c < INVITE_GROUP_SIZE; c += 1) {
      group += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]
    }
    groups.push(group)
  }

  const code = `${INVITE_PREFIX}-${groups.join('-')}`

  return {
    code,
    codeHash: hashInviteCode(code),
    codePrefix: inviteCodePrefix(code),
  }
}

/**
 * Masked form for operator-facing lists: `CM-4F2X-••••-••••-••••-••••`.
 *
 * Built from the stored prefix alone, so it can be rendered from a row without
 * the code ever having been retained.
 */
export function maskInviteCode(codePrefix: string): string {
  const masked = Array.from(
    { length: INVITE_GROUP_COUNT - 1 },
    () => '•'.repeat(INVITE_GROUP_SIZE),
  )
  return [codePrefix, ...masked].join('-')
}
