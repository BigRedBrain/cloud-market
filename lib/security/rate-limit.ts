import 'server-only'

import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { headers } from 'next/headers'

import { db, schema } from '@/lib/db'
import { keyedDigest } from '@/lib/auth/audit'
import type { AuditEvent } from '@/lib/db/schema'

/**
 * Origin-based rate limiting, counted from the audit log.
 *
 * NO NEW TABLE, NO REDIS, AND THAT IS DELIBERATE.
 *
 * This project already had two throttles before this module existed, and both
 * work the same way: `checkSendThrottle` counts rows in `verification_tokens`,
 * and `reauthenticate` counts rows in `audit_log`. Neither introduced storage,
 * because the rows being counted were already being written for their own
 * reasons. A third mechanism with its own table would be a third thing to keep
 * in step, a third thing to prune, and a third thing to be wrong.
 *
 * Every event this module counts is one the application already records —
 * `FAILED_LOGIN`, `INVITE_REDEMPTION_FAILED`, `PASSWORD_RESET_REQUESTED` — and
 * `audit_log` already carries `ip_hash` and `occurred_at`. So the question
 * "how many times has this origin done this recently" is a single indexed count
 * over data that exists whether or not anyone is rate limiting.
 *
 * WHAT THIS DOES AND DOES NOT PROTECT
 *
 * This bounds ONE ORIGIN. It is the complement to the account-following limits
 * already in place — the sign-in lockout in `lib/auth/actions.ts` follows the
 * ACCOUNT, because credential stuffing rotates addresses. Neither alone is
 * sufficient: an account lockout does nothing against an attacker spraying one
 * password across ten thousand accounts from one host, and an IP limit does
 * nothing against a botnet grinding one account. Both are applied.
 *
 * It does NOT bound a distributed attack from many origins. That needs
 * infrastructure above the application — Vercel's WAF or equivalent — and is
 * recorded as a residual risk rather than pretended away here.
 */

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number }

/**
 * The caller's origin, hashed with the same key the audit log uses.
 *
 * ON TRUSTING `x-forwarded-for`: the left-most entry is attacker-controlled on
 * an arbitrary host, because anyone can send the header. It is trustworthy HERE
 * only because this application is always deployed behind Vercel's proxy, which
 * overwrites it — the same assumption `lib/auth/session.ts` documents and
 * depends on. If CloudMarket is ever hosted anywhere else, this function is the
 * first thing that has to change, and section U's warning about client-supplied
 * addresses is exactly this hazard.
 *
 * IT IS ALSO NEVER THE ONLY CONTROL. Every caller pairs it with a limit that
 * follows the account or the invite, precisely so that a spoofed or absent
 * header degrades the protection rather than removing it.
 *
 * Returns null when there is no address to key on, and every caller treats null
 * as "cannot rate limit by origin" and falls through to its other limits rather
 * than failing open OR blocking everyone.
 */
export async function clientOriginHash(): Promise<string | null> {
  try {
    const headerList = await headers()
    const raw = headerList.get('x-forwarded-for')?.split(',')[0]?.trim()
    return keyedDigest(raw ?? null)
  } catch {
    /** Outside a request scope — a job or a script. Nothing to limit. */
    return null
  }
}

/**
 * Counts recent matching audit rows for one origin and compares to a ceiling.
 *
 * `events` is a list rather than a single value because the interesting
 * questions span several: "how many registration ATTEMPTS from this origin"
 * means successes and failures together, and counting only one of them would
 * let an attacker stay under the limit by only ever succeeding, or only ever
 * failing.
 */
export async function checkOriginRateLimit(options: {
  events: readonly AuditEvent[]
  windowMs: number
  max: number
  /** Pre-computed by the caller when it already has one; read from headers otherwise. */
  originHash?: string | null
}): Promise<RateLimitVerdict> {
  const originHash =
    options.originHash === undefined ? await clientOriginHash() : options.originHash

  /** No usable origin: this control cannot apply. The caller has others. */
  if (!originHash) return { allowed: true }

  const since = new Date(Date.now() - options.windowMs)

  const [row] = await db
    .select({
      hits: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${schema.auditLog.occurredAt})`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.ipHash, originHash),
        inArray(schema.auditLog.event, [...options.events]),
        gte(schema.auditLog.occurredAt, since),
      ),
    )

  const hits = row?.hits ?? 0
  if (hits < options.max) return { allowed: true }

  /**
   * A FIXED window would let the full budget be spent again the instant the
   * clock ticks over. Deriving the retry hint from the OLDEST hit in the window
   * makes it a sliding one: the caller is told to come back when the earliest
   * attempt ages out, which is when capacity genuinely frees up.
   */
  const oldest = row?.oldest ? new Date(row.oldest).getTime() : Date.now()
  return {
    allowed: false,
    retryAfterMs: Math.max(1000, oldest + options.windowMs - Date.now()),
  }
}

/**
 * Counts recent matching audit rows for one USER.
 *
 * The account-following half of the pair. Used for the owner's high-risk
 * operations, where the thing worth bounding is not "requests from this host"
 * but "attempts against this privileged account", however they arrive.
 */
export async function checkUserRateLimit(options: {
  userId: string
  events: readonly AuditEvent[]
  windowMs: number
  max: number
}): Promise<RateLimitVerdict> {
  const since = new Date(Date.now() - options.windowMs)

  const [row] = await db
    .select({
      hits: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${schema.auditLog.occurredAt})`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.userId, options.userId),
        inArray(schema.auditLog.event, [...options.events]),
        gte(schema.auditLog.occurredAt, since),
      ),
    )

  const hits = row?.hits ?? 0
  if (hits < options.max) return { allowed: true }

  const oldest = row?.oldest ? new Date(row.oldest).getTime() : Date.now()
  return {
    allowed: false,
    retryAfterMs: Math.max(1000, oldest + options.windowMs - Date.now()),
  }
}

/* -------------------------------------------------------------------------- */
/* Policies                                                                    */
/* -------------------------------------------------------------------------- */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/**
 * The ceilings, in one place so they can be read as a policy rather than
 * discovered one call site at a time.
 *
 * Every number here is deliberately generous for a human and hostile to a
 * script. A real customer does not fail sign-in twenty times an hour; a
 * credential-stuffing run does nothing else.
 */
export const RATE_LIMITS = {
  /** Failed sign-ins from one origin. Complements the per-account lockout. */
  signIn: { events: ['FAILED_LOGIN'] as const, windowMs: 15 * MINUTE, max: 20 },

  /**
   * Registration attempts from one origin, successful or not.
   *
   * This is the invite-guessing limit as well as the signup-spam limit. With
   * 100 bits of entropy in a code, guessing was never the realistic threat —
   * but a bounded attempt rate means the arithmetic is not even worth writing
   * down, and it stops one host enumerating whether specific codes exist.
   */
  signUp: {
    events: ['ACCOUNT_CREATED', 'INVITE_REDEMPTION_FAILED'] as const,
    windowMs: HOUR,
    max: 10,
  },

  /** Password-reset requests from one origin. Per-account sends are capped separately. */
  passwordReset: {
    events: ['PASSWORD_RESET_REQUESTED'] as const,
    windowMs: HOUR,
    max: 15,
  },

  /** Email-verification sends from one origin. */
  emailVerification: {
    events: ['EMAIL_VERIFICATION_REQUESTED'] as const,
    windowMs: HOUR,
    max: 15,
  },

  /**
   * Invite creation, per administrator.
   *
   * Not an attack limit so much as a blast-radius limit: an administrator whose
   * session has been taken over should not be able to mint five hundred working
   * invites to a private storefront before anyone notices.
   */
  inviteCreation: { events: ['INVITE_CREATED'] as const, windowMs: HOUR, max: 50 },

  /**
   * Owner high-risk operations — backup admin changes, payment configuration,
   * refunds. Counted per user across both outcomes, so a run of failed
   * re-authentications against the owner account cannot be ground through.
   */
  ownerSensitive: {
    events: [
      'BACKUP_ADMIN_ASSIGNED',
      'BACKUP_ADMIN_REMOVED',
      'COMPLIANCE_REAUTH_FAILED',
      'PAYMENT_REFUND_REQUESTED',
      'PAYMENT_CONFIG_CHANGED',
    ] as const,
    windowMs: HOUR,
    max: 20,
  },
} as const

/** Human-facing message for a throttled caller. Never states the ceiling. */
export function rateLimitMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / MINUTE))
  return `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
}
