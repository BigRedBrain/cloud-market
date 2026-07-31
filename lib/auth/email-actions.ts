'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { after } from 'next/server'
import { redirect } from 'next/navigation'

import { recordAuditEvent } from '@/lib/auth/audit'
import { requireUser } from '@/lib/auth/dal'
import { hashPassword } from '@/lib/auth/crypto'
import { revokeAllSessions } from '@/lib/auth/session'
import {
  checkSendThrottle,
  consumeToken,
  findConsumedToken,
  issueToken,
  MAX_SENDS_PER_DAY,
  type TokenPurpose,
} from '@/lib/auth/tokens'
import { db, schema } from '@/lib/db'
import { sendEmail } from '@/lib/email'
import { passwordResetEmail, verificationEmail } from '@/lib/email/templates'
import { clientEnv } from '@/lib/env'
import {
  fail,
  formDataToObject,
  ok,
  parseInput,
  type ActionResult,
} from '@/lib/result'
import {
  completeResetSchema,
  requestResetSchema,
} from '@/lib/auth/validation'

/**
 * Email verification and password recovery.
 *
 * TWO RULES GOVERN EVERYTHING IN THIS FILE.
 *
 * 1. AN UNAUTHENTICATED CALLER LEARNS NOTHING ABOUT WHICH ADDRESSES EXIST.
 *    `requestPasswordResetAction` returns the identical result for a real
 *    account, a nonexistent one, a suspended one, and a throttled one. Not a
 *    similar result — the same one, from the same code path, with the same
 *    redirect. Anything that varies is an oracle: status codes, wording,
 *    redirect targets, and response time all count.
 *
 * 2. LINKS ARE BUILT FROM `NEXT_PUBLIC_APP_URL`, NEVER FROM A REQUEST HEADER.
 *    `Host` and `X-Forwarded-Host` are attacker-controlled. A reset link
 *    assembled from them is a password-reset token delivered to a domain of the
 *    attacker's choosing, and the customer would see a link to their own
 *    retailer in a genuine email from us. This is the single highest-severity
 *    mistake available in this feature, and it is avoided by never having the
 *    request's opinion of its own hostname in scope.
 */

const APP_URL = clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')

const verifyUrl = (token: string) =>
  `${APP_URL}/verify-email/${encodeURIComponent(token)}`
const resetUrl = (token: string) =>
  `${APP_URL}/reset-password/${encodeURIComponent(token)}`

/**
 * Issues a token and hands the message to the transport.
 *
 * Runs inside `after()` at both call sites, so provider latency never shapes
 * the response the visitor sees. That is a security property, not a performance
 * one: "no account" returning in 20ms while "account found, token hashed, mail
 * sent" takes 400ms is a measurable enumeration oracle, and no amount of
 * matched wording hides it.
 */
async function issueAndSend(
  userId: string,
  email: string,
  purpose: TokenPurpose,
): Promise<void> {
  const { token } = await issueToken(userId, purpose)

  const rendered =
    purpose === 'email_verification'
      ? verificationEmail(verifyUrl(token))
      : passwordResetEmail(resetUrl(token))

  const result = await sendEmail({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })

  if (!result.ok) {
    /**
     * The transport's message can name the recipient, so it is not stored.
     * Only the fact of failure and the purpose are recorded — enough to alert
     * on, nothing that turns the audit log into a mailing list.
     */
    await recordAuditEvent({
      event: 'EMAIL_SEND_FAILED',
      userId,
      entityType: 'email',
      summary: `${purpose} delivery failed`,
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Email verification                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resends the verification email to the signed-in user's own address.
 *
 * Authenticated, and about the caller's own account, so there is no enumeration
 * surface here and the throttle can say plainly how long to wait. Being vague
 * with someone about their own account is unhelpful, not secure.
 */
export async function resendVerificationAction(
  _previous: ActionResult<void> | null,
  _formData: FormData,
): Promise<ActionResult<void>> {
  const user = await requireUser('/account/verify-email')

  if (user.emailVerifiedAt) {
    return fail('conflict', 'Your email address is already confirmed.')
  }

  const throttle = await checkSendThrottle(user.id, 'email_verification')
  if (!throttle.allowed) {
    const seconds = Math.ceil(throttle.retryAfterMs / 1000)
    return fail(
      'rate_limited',
      throttle.reason === 'cooldown'
        ? `Please wait ${seconds} second${seconds === 1 ? '' : 's'} before requesting another email.`
        : `You've requested the maximum of ${MAX_SENDS_PER_DAY} confirmation emails today. Try again tomorrow.`,
    )
  }

  await recordAuditEvent({
    event: 'EMAIL_VERIFICATION_REQUESTED',
    userId: user.id,
    entityType: 'user',
    entityId: user.id,
  })

  after(async () => {
    await issueAndSend(user.id, user.email, 'email_verification')
  })

  return ok()
}

export type VerificationOutcome =
  | { status: 'verified' }
  | { status: 'already_verified' }
  | { status: 'invalid' }
  | { status: 'expired' }

/**
 * Consumes a verification token. Called from the link's page, not a form.
 *
 * TOLERANT OF LINK SCANNERS. Corporate mail security and some clients prefetch
 * every URL in a message, which can consume the token before the human clicks.
 * When consumption fails but the token is one we issued and that account is now
 * verified, the honest answer is `already_verified` — the address really is
 * confirmed, and showing a failure would be both confusing and untrue. Nothing
 * is re-verified and no token becomes reusable; only the wording changes.
 */
export async function verifyEmailToken(token: string): Promise<VerificationOutcome> {
  const result = await consumeToken(token, 'email_verification')

  if (result.ok) {
    /**
     * `is null` in the WHERE clause makes this idempotent: the timestamp is set
     * exactly once, so a second success can never move it and the record of
     * when the address was confirmed stays true.
     */
    const [updated] = await db
      .update(schema.users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(schema.users.id, result.userId), isNull(schema.users.emailVerifiedAt)),
      )
      .returning({ id: schema.users.id })

    await recordAuditEvent({
      event: 'EMAIL_VERIFIED',
      userId: result.userId,
      entityType: 'user',
      entityId: result.userId,
    })

    return { status: updated ? 'verified' : 'already_verified' }
  }

  /**
   * The scanner case. If this token is one we issued and that account is now
   * verified, report success — the address genuinely is confirmed, and the only
   * thing that went "wrong" is that something followed the link first.
   */
  if (result.reason === 'already_consumed') {
    const owner = await findConsumedToken(token, 'email_verification')
    if (owner) {
      const [row] = await db
        .select({ verifiedAt: schema.users.emailVerifiedAt })
        .from(schema.users)
        .where(eq(schema.users.id, owner.userId))
        .limit(1)

      if (row?.verifiedAt) return { status: 'already_verified' }
    }
  }

  await recordAuditEvent({
    event: 'EMAIL_VERIFICATION_FAILED',
    entityType: 'token',
    summary: `verification token rejected: ${result.reason}`,
  })

  return { status: result.reason === 'expired' ? 'expired' : 'invalid' }
}

/* -------------------------------------------------------------------------- */
/* Password reset                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Requests a reset link.
 *
 * EVERY PATH ENDS IN THE SAME REDIRECT. Unknown address, suspended account,
 * throttled, already sent — all identical. The work that differs happens in
 * `after()`, once the response is already on its way.
 *
 * A throttled request is silently not sent. Telling the visitor "you have
 * already requested one" would confirm the address exists, which is exactly
 * what the generic response is protecting.
 */
export async function requestPasswordResetAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(requestResetSchema, formDataToObject(formData))

  /**
   * Even a malformed address gets the generic outcome. Returning a validation
   * error for "not an email" but a success page for "valid but unknown" would
   * be a small oracle, and small oracles compose.
   */
  if (!parsed.ok) redirect('/forgot-password/sent')

  const email = parsed.data.email

  after(async () => {
    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        status: schema.users.status,
      })
      .from(schema.users)
      .where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt)))
      .limit(1)

    /**
     * Recorded for every request, including ones for addresses that do not
     * exist — with `user_id` null and NOTHING identifying in the row. The log
     * shows that reset traffic is happening without becoming the enumeration
     * oracle the response refuses to be. Storing the attempted address here
     * would hand an audit-log reader exactly what the public response withholds.
     */
    await recordAuditEvent({
      event: 'PASSWORD_RESET_REQUESTED',
      userId: user?.id,
      entityType: 'user',
      entityId: user?.id,
    })

    if (!user || user.status === 'suspended') return

    const throttle = await checkSendThrottle(user.id, 'password_reset')
    if (!throttle.allowed) return

    await issueAndSend(user.id, user.email, 'password_reset')
  })

  redirect('/forgot-password/sent')
}

/**
 * Completes a reset: new password, every session destroyed, no auto sign-in.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY.
 *
 *   1. Consume the token — atomically, so a double submit cannot run twice.
 *   2. Write the new password hash.
 *   3. Destroy every session.
 *   4. Audit.
 *   5. Redirect to sign-in.
 *
 * Consuming first means a failure anywhere after it leaves the link spent
 * rather than reusable. Revoking after the password write means there is no
 * window in which the old password still works against a live session.
 *
 * NO SESSION IS CREATED. Completing a reset proves control of the mailbox; it
 * does not prove knowledge of the new password by anyone but whoever typed it.
 * Requiring a fresh sign-in keeps "every session was destroyed" true without an
 * immediate exception carved into it.
 */
export async function completePasswordResetAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(completeResetSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const result = await consumeToken(parsed.data.token, 'password_reset')

  if (!result.ok) {
    await recordAuditEvent({
      event: 'PASSWORD_RESET_FAILED',
      entityType: 'token',
      summary: `reset token rejected: ${result.reason}`,
    })
    return fail(
      'unauthenticated',
      'That reset link is no longer valid. Request a new one.',
    )
  }

  await db
    .update(schema.users)
    .set({
      passwordHash: await hashPassword(parsed.data.password),
      /** A reset also clears a lockout — the account has been recovered. */
      failedLoginAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, result.userId))

  const revoked = await revokeAllSessions(result.userId)

  await recordAuditEvent({
    event: 'SESSIONS_REVOKED',
    userId: result.userId,
    entityType: 'user',
    entityId: result.userId,
    summary: `${revoked} session(s) revoked by password reset`,
  })
  await recordAuditEvent({
    event: 'PASSWORD_RESET_COMPLETED',
    userId: result.userId,
    entityType: 'user',
    entityId: result.userId,
  })

  redirect('/sign-in?reset=done')
}
