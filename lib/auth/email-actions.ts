'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { headers } from 'next/headers'
import { after } from 'next/server'
import { redirect } from 'next/navigation'

import { recordAuditEvent } from '@/lib/auth/audit'
import { requireUser } from '@/lib/auth/dal'
import { hashPassword } from '@/lib/auth/crypto'

import {
  checkSendThrottle,
  claimTokenWithin,
  discardToken,
  findConsumedToken,
  inspectToken,
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
  confirmEmailSchema,
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
     * DELIVERY FAILED, SO THE TOKEN IS DISCARDED.
     *
     * The response already told the customer to check their inbox — it had to,
     * because saying anything else would leak whether the address exists. That
     * promise is now known to be false, and the only thing left to get right is
     * what happens when they try again.
     *
     * Issuing the token cost them one of five daily sends and started a 60s
     * cooldown. Leaving it in place would mean a provider outage locks people
     * out of recovery for a day — the throttle punishing them for our failure.
     * Removing the row returns both budgets immediately, so "try again" works
     * straight away.
     *
     * The link is dropped with it. If the message did somehow arrive despite
     * the error, its link is dead and the customer requests another; that is
     * the safe direction to be wrong in.
     *
     * No queue and no retry loop: this phase does not need one, and a queue
     * that silently retries a message we already told the customer about would
     * make the state harder to reason about, not easier.
     */
    await discardToken(token, purpose)

    /**
     * The transport's message can name the recipient, so it is not stored.
     * Only the fact of failure and the purpose are recorded — enough to alert
     * on, nothing that turns the audit log into a mailing list. `user_id` is
     * attached because by this point an account is known to exist; this event
     * is never written for an unknown address, so it cannot enumerate.
     */
    await recordAuditEvent({
      event: 'EMAIL_SEND_FAILED',
      userId,
      entityType: 'email',
      summary: `${purpose} delivery failed; token discarded so the customer can retry`,
    })
  }
}

/**
 * Test-only failure injection, for proving the transaction boundary holds.
 *
 * Item 2 of the hardening review asks for a test that forces a failure between
 * token consumption and password persistence. There is no way to provoke that
 * from outside the process, so the seam is here — and it is inert unless
 * explicitly switched on outside production.
 */
async function faultRequested(stage: 'after_consume'): Promise<boolean> {
  /**
   * THREE independent conditions, all required:
   *
   *   1. not production,
   *   2. the server was started with the seam enabled, and
   *   3. this specific request asked for it via a header.
   *
   * The header matters. An env-var-only switch fires on every request, which
   * makes the whole flow unusable and means the suite cannot test the fault and
   * the happy path in one run. Scoping it per-request keeps the seam inert for
   * everything except the one submission that opts in.
   */
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.RECOVERY_FAULT_INJECTION !== stage) return false
  const requestHeaders = await headers()
  return requestHeaders.get('x-recovery-fault') === stage
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

export type VerificationView =
  | { status: 'ready'; token: string }
  | { status: 'already_verified' }
  | { status: 'invalid' }
  | { status: 'expired' }

/**
 * READ-ONLY inspection, for the GET that the emailed link points at.
 *
 * Nothing here consumes a token and nothing here changes an account. A mail
 * scanner, link-preview bot, browser prefetcher or security appliance may open
 * that URL any number of times; each one gets a page, and the token is exactly
 * as usable afterwards as it was before.
 *
 * `already_verified` is reported when the token was legitimately spent earlier
 * and the address is confirmed, so someone reopening their own link sees the
 * truth rather than an alarming failure.
 */
export async function inspectVerificationToken(token: string): Promise<VerificationView> {
  const result = await inspectToken(token, 'email_verification')

  if (result.usable) return { status: 'ready', token }

  if (result.reason === 'already_consumed' || result.reason === 'superseded') {
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

  return { status: result.reason === 'expired' ? 'expired' : 'invalid' }
}

/**
 * Confirms the address. THE ONLY PLACE VERIFICATION STATE CHANGES.
 *
 * Reached by an explicit POST from a form the customer submitted, so nothing
 * that merely opens the URL can trigger it.
 *
 * ONE TRANSACTION. Consuming the token and setting `email_verified_at` commit
 * together or not at all. Were the update to fail after the claim, the rollback
 * puts the token back — a customer must never be left holding a spent link and
 * an unverified address.
 *
 * The claim is also what serialises concurrent submits: two simultaneous POSTs
 * run the same conditional UPDATE, exactly one matches a row, and the other
 * gets nothing.
 */
export async function confirmEmailAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(confirmEmailSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const injectFault = await faultRequested('after_consume')
  let verifiedUserId: string | null = null

  try {
    verifiedUserId = await db.transaction(async (tx) => {
      const claimed = await claimTokenWithin(tx, parsed.data.token, 'email_verification')
      if (!claimed) return null

      if (injectFault) throw new Error('injected fault after token consumption')

      /**
       * `is null` keeps this idempotent: the timestamp is written once, so the
       * record of when the address was confirmed can never be moved later.
       */
      await tx
        .update(schema.users)
        .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.users.id, claimed.userId), isNull(schema.users.emailVerifiedAt)))

      return claimed.userId
    })
  } catch {
    /**
     * Rolled back, so the token is unconsumed and the account unchanged. The
     * customer's link still works and retrying is safe — which is precisely
     * what the transaction boundary exists to guarantee.
     */
    await recordAuditEvent({
      event: 'EMAIL_VERIFICATION_FAILED',
      entityType: 'token',
      summary: 'verification rolled back; token remains usable',
    })
    return fail('internal_error', 'Something went wrong confirming your email. Please try again.')
  }

  if (!verifiedUserId) {
    await recordAuditEvent({
      event: 'EMAIL_VERIFICATION_FAILED',
      entityType: 'token',
      summary: 'verification token rejected at confirmation',
    })
    return fail('unauthenticated', 'That confirmation link is no longer valid.')
  }

  await recordAuditEvent({
    event: 'EMAIL_VERIFIED',
    userId: verifiedUserId,
    entityType: 'user',
    entityId: verifiedUserId,
  })

  /** A clean URL with no token in it. See ACCOUNT-RECOVERY.md §3. */
  redirect('/sign-in?verified=1')
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

  /**
   * Hashed BEFORE the transaction opens. scrypt is deliberately slow — holding
   * a database transaction open for the duration would pin a connection for no
   * reason and widen the window in which the row is locked.
   */
  const passwordHash = await hashPassword(parsed.data.password)

  const injectFault = await faultRequested('after_consume')
  let outcome: { userId: string; revoked: number } | null = null

  try {
    outcome = await db.transaction(async (tx) => {
      const claimed = await claimTokenWithin(tx, parsed.data.token, 'password_reset')
      if (!claimed) return null

      if (injectFault) throw new Error('injected fault after token consumption')

      await tx
        .update(schema.users)
        .set({
          passwordHash,
          /** A reset also clears a lockout — the account has been recovered. */
          failedLoginAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, claimed.userId))

      /**
       * Session revocation joins the same transaction. If the password write
       * committed but revocation did not, an intruder's session would survive a
       * reset performed specifically to evict them — the one outcome this flow
       * exists to prevent.
       */
      const removed = await tx
        .delete(schema.sessions)
        .where(eq(schema.sessions.userId, claimed.userId))
        .returning({ id: schema.sessions.id })

      return { userId: claimed.userId, revoked: removed.length }
    })
  } catch {
    /**
     * ROLLED BACK AS ONE UNIT. The token is unconsumed, the password unchanged,
     * the sessions intact. The customer's link still works, so they are not
     * stranded holding a spent link and an old password they came here because
     * they could not use.
     */
    await recordAuditEvent({
      event: 'PASSWORD_RESET_FAILED',
      entityType: 'token',
      summary: 'reset rolled back; token remains usable',
    })
    return fail('internal_error', 'Something went wrong. Your reset link still works — please try again.')
  }

  if (!outcome) {
    await recordAuditEvent({
      event: 'PASSWORD_RESET_FAILED',
      entityType: 'token',
      summary: 'reset token rejected at completion',
    })
    return fail(
      'unauthenticated',
      'That reset link is no longer valid. Request a new one.',
    )
  }

  await recordAuditEvent({
    event: 'SESSIONS_REVOKED',
    userId: outcome.userId,
    entityType: 'user',
    entityId: outcome.userId,
    summary: `${outcome.revoked} session(s) revoked by password reset`,
  })
  await recordAuditEvent({
    event: 'PASSWORD_RESET_COMPLETED',
    userId: outcome.userId,
    entityType: 'user',
    entityId: outcome.userId,
  })

  /** A clean URL: the token never appears in the destination. */
  redirect('/sign-in?reset=done')
}
