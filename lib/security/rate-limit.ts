import 'server-only'

import { and, eq, gte, sql } from 'drizzle-orm'

import { keyedDigest } from '@/lib/auth/audit'
import { db } from '@/lib/db'
import * as schema from '@/lib/db/schema'
import type { AuditEvent } from '@/lib/db/schema'

/**
 * Origin rate limiting, counted from rows this system already writes.
 *
 * No Redis, no rate-limit table, no new infrastructure — the same approach
 * `checkSendThrottle` and `reauthenticate` already take. `audit_log` records
 * `(ip_hash, event, occurred_at)` for every attempt, and migration 0017 shipped
 * `audit_log_rate_limit_idx` on exactly those three columns, in that
 * selectivity order, partial on `ip_hash IS NOT NULL`. This module is the
 * consumer that index was built for.
 *
 * READ ONLY. Nothing here writes, and nothing here throws on a limit — it
 * returns a verdict and lets the caller decide. Recording the attempt is the
 * caller's job, via `recordAuditEvent`, which is what makes the next call
 * count it.
 *
 * NOT WIRED. No call sites yet. Attaching this to sign-in, password reset or
 * invite redemption changes what those endpoints do to a real visitor, so it is
 * deliberately held back — see the Batch 2 note in the Phase B report.
 *
 * WHAT THIS IS NOT. Counting audit rows is a coarse, best-effort control. It is
 * per-origin, so it does nothing against a distributed attempt, and it inherits
 * whatever `ip_hash` the request carried. It raises the cost of guessing; it is
 * not a substitute for high-entropy secrets, and the invite format's 100 bits
 * remains the real defence.
 */

export type RateLimitVerdict =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number; attempts: number }

export type RateLimitPolicy = {
  /** How many attempts from one origin are tolerated inside the window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

/**
 * Default policies, named rather than passed as loose numbers so a limit cannot
 * be widened by a typo at one call site while staying tight at another.
 *
 * These are proposals, not yet in force anywhere.
 */
export const RATE_LIMIT_POLICIES = {
  /**
   * Invite redemption. Tight on purpose: a code is 100 bits, so a legitimate
   * person needs one or two attempts and an attacker needs far more than any
   * window will give them.
   */
  inviteRedemption: { limit: 10, windowMs: 60 * 60 * 1000 },

  /** Failed sign-in from one origin. */
  signIn: { limit: 20, windowMs: 15 * 60 * 1000 },

  /** Application submission, once applications exist. */
  applicationSubmission: { limit: 5, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimitPolicy>

/**
 * How many times has this origin triggered `event` inside the window?
 *
 * `ipAddress` is hashed here rather than accepted pre-hashed, so a caller
 * cannot accidentally pass a raw address into a column that must only ever hold
 * digests.
 *
 * A null or empty address returns `allowed` with no counting. That is the
 * deliberate choice: audit rows written outside a request scope carry no
 * origin, and the partial index excludes them, so there is nothing to count.
 * Failing open here matters — the alternative would lock out every visitor
 * whose address the platform did not forward.
 */
export async function checkOriginRateLimit(
  ipAddress: string | null,
  event: AuditEvent,
  policy: RateLimitPolicy,
): Promise<RateLimitVerdict> {
  const ipHash = keyedDigest(ipAddress)
  if (!ipHash) return { allowed: true, remaining: policy.limit }

  const since = new Date(Date.now() - policy.windowMs)

  const [row] = await db
    .select({
      attempts: sql<number>`count(*)::int`,
      earliest: sql<Date | null>`min(${schema.auditLog.occurredAt})`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.ipHash, ipHash),
        eq(schema.auditLog.event, event),
        gte(schema.auditLog.occurredAt, since),
      ),
    )

  const attempts = row?.attempts ?? 0

  if (attempts < policy.limit) {
    return { allowed: true, remaining: policy.limit - attempts }
  }

  /*
   * Retry-after is measured from the OLDEST attempt still inside the window,
   * because that is the one that will age out first and free a slot. Measuring
   * from the newest would extend the block every time someone tried again,
   * which turns a rate limit into an indefinite lockout.
   */
  const earliest = row?.earliest ? row.earliest.getTime() : Date.now()
  const retryAfterMs = Math.max(0, earliest + policy.windowMs - Date.now())

  return { allowed: false, retryAfterMs, attempts }
}
