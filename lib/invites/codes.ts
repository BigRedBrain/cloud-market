import 'server-only'

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { serverEnv } from '@/lib/env'

/**
 * Invite code generation, normalisation and hashing.
 *
 * ENTROPY: 140 BITS.
 *
 * The brief illustrated the format as `CM-XXXX-XXXX-XXXX-XXXX-XXXX` and
 * separately required "at least 128 bits of effective random entropy". Those two
 * things cannot both hold: twenty characters of any human-readable alphabet
 * tops out around 100 bits. The entropy figure is the security floor and the
 * format was given as an example, so the floor won and the code carries two
 * extra groups. It is longer to type than the illustration, and it is the
 * difference between a code that is merely impractical to guess and one that is
 * arithmetically out of reach.
 *
 * ALPHABET: CROCKFORD BASE32, chosen for its decode table rather than its
 * looks. It omits I, L, O and U — the first three because they are unreadable
 * next to 1 and 0, the last so that no code can accidentally spell an obscenity
 * — and, crucially, it defines what to do when a human types one anyway: I and
 * L mean 1, O means 0. That turns the most common transcription errors into
 * successful redemptions instead of support tickets. An ad-hoc alphabet that
 * merely *excludes* ambiguous characters has no such answer, and a customer who
 * types the letter O into a code containing a zero simply fails.
 *
 * 28 characters × 5 bits = 140 bits, in seven groups of four.
 */

/** Crockford Base32. Index is the value; the string is the canonical output. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const GROUPS = 7
const GROUP_SIZE = 4
const CODE_LENGTH = GROUPS * GROUP_SIZE

/** Human-facing prefix, so a code is recognisable out of context. */
const PREFIX = 'CM'

/**
 * How much of the code is stored in clear for display.
 *
 * The prefix plus ONE group — `CM-ABCD`. That reveals 20 of the 140 bits and
 * leaves 120, which is still far beyond brute force. Two groups would have been
 * prettier in the admin list and would have halved the remaining search space
 * for no operational gain.
 */
const DISPLAYED_GROUPS = 1

export type GeneratedInvite = {
  /** The complete code, shown to its creator exactly once and never stored. */
  code: string
  /** HMAC-SHA256 of the normalised code, hex. This is what goes in the database. */
  codeHash: string
  /** `CM-ABCD`. Safe to store, display and log. */
  codePrefix: string
}

/**
 * Draws `count` uniformly-distributed symbols from the 32-character alphabet.
 *
 * `randomBytes` yields 0–255, and 256 is an exact multiple of 32, so masking to
 * the low 5 bits is uniform with no modulo bias and no rejection sampling
 * needed. Worth stating explicitly because the same code written against a
 * 30-character alphabet WOULD be biased, and the bias would be invisible.
 */
function randomSymbols(count: number): string {
  const bytes = randomBytes(count)
  let out = ''
  for (let i = 0; i < count; i += 1) {
    out += ALPHABET[bytes[i] & 31]
  }
  return out
}

/**
 * Generates a fresh invite code and its stored digest.
 *
 * The raw code is returned to the caller and never persisted anywhere — not in
 * a column, not in an audit summary, not in a log line. It exists in plaintext
 * exactly twice: in the one response that renders it, and in the recipient's
 * hands.
 */
export function generateInviteCode(): GeneratedInvite {
  const symbols = randomSymbols(CODE_LENGTH)

  const groups: string[] = []
  for (let i = 0; i < GROUPS; i += 1) {
    groups.push(symbols.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE))
  }

  const code = [PREFIX, ...groups].join('-')

  return {
    code,
    codeHash: hashInviteCode(code),
    codePrefix: [PREFIX, ...groups.slice(0, DISPLAYED_GROUPS)].join('-'),
  }
}

/**
 * Canonicalises whatever the customer typed.
 *
 * Applied identically at issue time and at redemption time — which is the whole
 * requirement, since the digest is taken over the normalised form. Any
 * divergence between the two would make every code un-redeemable.
 *
 * Handles: lower case, missing or excess hyphens, spaces pasted from an email
 * client, a leading `CM` the customer did or did not include, and the Crockford
 * confusions (I/L → 1, O → 0).
 */
export function normaliseInviteCode(input: string): string {
  const upper = input.toUpperCase()

  let out = ''
  for (const character of upper) {
    /** Separators and whitespace carry no information. */
    if (character === '-' || character === ' ' || character === '\t') continue

    if (character === 'I' || character === 'L') {
      out += '1'
      continue
    }
    if (character === 'O') {
      out += '0'
      continue
    }

    out += character
  }

  /**
   * Drop a leading `CM`, present or not. The prefix is branding, not entropy,
   * and accepting it either way means a customer can paste the code with or
   * without it.
   */
  if (out.startsWith(PREFIX)) out = out.slice(PREFIX.length)

  return out
}

/**
 * HMAC-SHA256 of the normalised code, keyed with the server-only pepper.
 *
 * A KEYED digest, not a bare hash. The pepper lives in the environment and never
 * goes near the database, so an attacker holding a dump of `invite_codes` cannot
 * verify a candidate code against it at all — they are missing a secret that was
 * never stored alongside the data. With 140 bits of entropy the codes were
 * already out of brute-force reach; this makes an offline attack impossible
 * rather than merely infeasible.
 *
 * A FAST hash is correct here, exactly as it is for session tokens and unlike
 * for passwords: the input already carries 140 bits of entropy, so there is
 * nothing to slow an attacker down over. scrypt would cost us 100ms per
 * redemption and buy nothing.
 *
 * THROWS when the pepper is absent. Invite issuance and redemption fail closed —
 * the alternative, hashing with an empty key, would produce digests that verify
 * fine and are worthless, and nobody would notice until a dump leaked.
 */
export function hashInviteCode(code: string): string {
  const pepper = serverEnv().INVITE_CODE_PEPPER

  if (!pepper) {
    throw new Error(
      'INVITE_CODE_PEPPER is not configured. Invite codes cannot be issued or redeemed.',
    )
  }

  return createHmac('sha256', pepper).update(normaliseInviteCode(code)).digest('hex')
}

/** Is the invite subsystem configured at all? Used to fail closed with a clear message. */
export function isInviteSystemConfigured(): boolean {
  return Boolean(serverEnv().INVITE_CODE_PEPPER)
}

/**
 * Constant-time digest comparison.
 *
 * The database lookup is by indexed equality on the hash, so this is not on the
 * hot path — it exists for the verification helpers in the test suite, where a
 * timing-variable comparison would be a bad example for anyone who copied it.
 */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/**
 * `CM-ABCD-••••-••••-••••-••••-••••-••••` — what the admin list shows.
 *
 * Built from the stored prefix alone. There is deliberately no function
 * anywhere in this codebase that reconstructs a full code from the database,
 * because there is no data in the database from which to reconstruct one.
 */
export function maskInviteCode(codePrefix: string): string {
  const hidden = Array.from({ length: GROUPS - DISPLAYED_GROUPS }, () => '••••')
  return [codePrefix, ...hidden].join('-')
}

/**
 * Shape check before touching the database.
 *
 * Rejects obvious rubbish without a query, but is deliberately NOT the
 * authority on validity — a well-formed code that does not exist and a
 * malformed one produce the same generic failure to the customer, so this
 * cannot be used to probe the format.
 */
export function looksLikeInviteCode(input: string): boolean {
  const normalised = normaliseInviteCode(input)
  if (normalised.length !== CODE_LENGTH) return false

  for (const character of normalised) {
    if (!ALPHABET.includes(character)) return false
  }

  return true
}

/** Exported for the test suite's entropy assertion. */
export const INVITE_CODE_ENTROPY_BITS = CODE_LENGTH * 5
