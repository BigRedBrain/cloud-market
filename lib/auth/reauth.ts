import 'server-only'

import { and, eq, gte, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import { recordAuditEvent } from './audit'
import { verifyPassword } from './crypto'

/**
 * Step-up re-authentication.
 *
 * A session proves that someone signed in as this account at some point. For an
 * ordinary write that is enough. For publishing a legal purchase limit it is
 * not: the session may be hours old, on an unattended laptop, or lifted from a
 * machine somebody walked away from. Re-authentication narrows the claim to
 * "the person holding this session knew the password seconds ago".
 *
 * SEPARATE FROM SIGN-IN ON PURPOSE
 *
 * Sign-in must not enumerate accounts, so it equalises timing and returns the
 * same message whether the address exists or the password was wrong. None of
 * that applies here — the account is already known, and the user is already
 * looking at their own screen. What matters instead is throttling and audit,
 * because a re-auth prompt against a known-privileged account is a much more
 * attractive thing to guess at than a login form.
 *
 * THE RESULT IS NOT A TOKEN AND NOT A COOKIE.
 *
 * It is a timestamp returned to the caller, valid only within the single action
 * that produced it. There is deliberately no "re-authenticated for the next 15
 * minutes" grace window: a grace window is a bearer credential in disguise, and
 * the whole point of the step-up is that it happens at the moment of the write,
 * in the same request that performs it.
 */

/** Throttle window and ceiling for re-authentication attempts. */
const ATTEMPT_WINDOW_MINUTES = 15
const MAX_FAILED_ATTEMPTS = 5

export type ReauthResult =
  | { ok: true; at: Date }
  | { ok: false; reason: 'incorrect' | 'throttled' | 'no_password' }

/**
 * Counts recent failures for this user, from the audit log.
 *
 * The audit log is the counter rather than a dedicated column, because the
 * failures have to be recorded anyway and a second store would be a second
 * thing to keep in step. Bounded by time, so it uses the index on
 * (user_id, occurred_at) rather than scanning.
 */
async function recentFailures(userId: string): Promise<number> {
  const since = sql`now() - interval '${sql.raw(String(ATTEMPT_WINDOW_MINUTES))} minutes'`

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.userId, userId),
        eq(schema.auditLog.event, 'COMPLIANCE_REAUTH_FAILED'),
        gte(schema.auditLog.occurredAt, since),
      ),
    )

  return row?.n ?? 0
}

/**
 * Verifies the password again for an already-authenticated user.
 *
 * Every outcome is audited, including the throttled one. A run of failures
 * against a compliance permission is exactly the signal an investigation would
 * look for, and it is worthless if only successes are recorded.
 */
export async function reauthenticate(
  userId: string,
  password: string,
): Promise<ReauthResult> {
  if (await recentFailures(userId) >= MAX_FAILED_ATTEMPTS) {
    await recordAuditEvent({
      event: 'COMPLIANCE_REAUTH_FAILED',
      userId,
      summary: 'blocked: too many recent attempts',
    })
    return { ok: false, reason: 'throttled' }
  }

  const [user] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)

  /**
   * An account with no password — created through a future SSO path — cannot
   * step up this way. Failing closed is the only safe answer; silently
   * accepting would make the permission unguarded for exactly those accounts.
   */
  if (!user?.passwordHash) {
    await recordAuditEvent({
      event: 'COMPLIANCE_REAUTH_FAILED',
      userId,
      summary: 'account has no password set',
    })
    return { ok: false, reason: 'no_password' }
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    await recordAuditEvent({
      event: 'COMPLIANCE_REAUTH_FAILED',
      userId,
      summary: 'incorrect password',
    })
    return { ok: false, reason: 'incorrect' }
  }

  const at = new Date()
  await recordAuditEvent({
    event: 'COMPLIANCE_REAUTH_SUCCEEDED',
    userId,
    summary: 'password re-verified for a compliance action',
  })

  return { ok: true, at }
}

/** Message for a failed step-up, safe to render. */
export function reauthMessage(reason: 'incorrect' | 'throttled' | 'no_password'): string {
  switch (reason) {
    case 'incorrect':
      return 'That password is not correct. Nothing was published.'
    case 'throttled':
      return `Too many failed attempts. Wait ${ATTEMPT_WINDOW_MINUTES} minutes and try again.`
    case 'no_password':
      return 'This account has no password set, so it cannot confirm a compliance change.'
  }
}
