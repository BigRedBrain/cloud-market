'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { revalidatePath } from 'next/cache'

import { db, schema } from '@/lib/db'
import {
  fail,
  formDataToObject,
  ok,
  parseInput,
  type ActionResult,
} from '@/lib/result'
import { withUpdatedAt } from '@/lib/db/schema'
import { mergeGuestBagIntoUser } from '@/lib/bag/merge'
import { maskInviteCode } from '@/lib/invites/codes'
import {
  GENERIC_INVITE_FAILURE,
  recordRedemptionWithin,
  redeemInviteCodeWithin,
  type RedemptionFailure,
} from '@/lib/invites/redeem'
import {
  RATE_LIMITS,
  checkOriginRateLimit,
  rateLimitMessage,
} from '@/lib/security/rate-limit'
import { recordAuditEvent, recordAuditEventWithin } from './audit'
import { equalizeTimingForMissingUser, hashPassword, verifyPassword } from './crypto'
import { issueAndSend } from './email-dispatch'
import { getActiveBackupAdminId, requireAdminIdentity, resolveOwnerUserId } from './admin-identity'
import { requireSession, requireUser } from './dal'
import {
  createSession,
  destroyCurrentSession,
  getCurrentSessionId,
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from './session'
import {
  BAG_UPDATED_FLAG,
  changePasswordSchema,
  revokeSessionSchema,
  safeRedirectPath,
  signInSchema,
  signUpSchema,
  updateProfileSchema,
  withQueryFlag,
} from './validation'

/**
 * Authentication Server Actions.
 *
 * Every action returns the standard `ActionResult` on failure and redirects on
 * success, which keeps the whole flow working without JavaScript. Server
 * Actions are a public network boundary — each one re-validates its input and
 * re-checks authorization through the DAL rather than trusting the caller.
 */

/**
 * Account lockout. Counted per account rather than per IP, because
 * credential-stuffing rotates addresses — a lockout that follows the account is
 * the one that actually protects it. Fifteen minutes is long enough to make
 * online guessing worthless and short enough that a legitimate user who
 * fat-fingered five times is not locked out of their evening.
 */
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

/**
 * One message for every sign-in failure.
 *
 * "No such account", "wrong password", and "account locked" are all reported
 * identically. Distinguishing them turns the login form into an oracle for
 * which email addresses are registered — and for a cannabis retailer, mere
 * membership in the customer list is sensitive.
 */
const GENERIC_SIGN_IN_FAILURE = 'Email or password is incorrect.'

/**
 * Control-flow signal for a refused invite, used to unwind the registration
 * transaction.
 *
 * An exception rather than a returned value because `db.transaction` rolls back
 * on a throw and commits on a return — expressing "do not commit any of this"
 * as a return value would mean remembering to roll back by hand at every future
 * exit point. It never escapes `signUpAction`, which catches it and converts it
 * into the ordinary generic `ActionResult`.
 */
class InviteRejected extends Error {
  constructor(readonly reason: RedemptionFailure) {
    super(`invite rejected: ${reason}`)
    this.name = 'InviteRejected'
  }
}

export async function signUpAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(signUpSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const { email, password, name, dateOfBirth, inviteCode } = parsed.data

  /**
   * Origin throttle, before any expensive work.
   *
   * Counts registration attempts — successes AND invite failures together — from
   * this origin in the last hour. With 140 bits of entropy in a code, guessing
   * was never a realistic threat; what this actually bounds is one host grinding
   * through candidate codes to learn whether specific ones exist, and bulk
   * account creation from a single source if a shared code leaks.
   */
  const throttle = await checkOriginRateLimit(RATE_LIMITS.signUp)
  if (!throttle.allowed) {
    return fail('rate_limited', rateLimitMessage(throttle.retryAfterMs))
  }

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1)

  if (existing.length > 0) {
    return fail(
      'conflict',
      'An account with this email already exists. Try signing in instead.',
      { email: ['This email is already registered'] },
    )
  }

  /**
   * Hashed BEFORE the transaction opens. scrypt costs ~100ms and ~33MB by
   * design, and holding a database transaction — and the row lock the invite
   * claim is about to take — open across it would serialise every concurrent
   * registration behind one password hash. The transaction below should be
   * short, and this is the one part of registration that is not.
   */
  const passwordHash = await hashPassword(password)

  /**
   * ACCOUNT CREATION AND INVITE CONSUMPTION ARE ONE ATOMIC UNIT.
   *
   * Both halves of section P depend on this transaction and neither works
   * without it:
   *
   *  - An account can never exist without a consumed invite, because the user
   *    INSERT and the invite claim commit together or not at all.
   *  - A registration that fails after the claim — duplicate email from a
   *    concurrent signup, a constraint violation, a dropped connection — rolls
   *    the increment back, so a failed attempt never burns a use.
   *
   * The claim itself is a single conditional UPDATE, which is what makes two
   * simultaneous redemptions of the FINAL use resolve to exactly one success.
   * See the header of `lib/invites/redeem.ts`.
   */
  let userId: string

  try {
    const outcome = await db.transaction(async (tx) => {
      const redemption = await redeemInviteCodeWithin(tx, inviteCode)

      if (!redemption.ok) {
        /**
         * Thrown rather than returned so the transaction unwinds. Nothing has
         * been written yet, but rolling back explicitly keeps the "no partial
         * registration" property true by construction rather than by inspection.
         */
        throw new InviteRejected(redemption.reason)
      }

      const [created] = await tx
        .insert(schema.users)
        .values({
          email,
          passwordHash,
          name,
          dateOfBirth,
          /**
           * Active, but `emailVerifiedAt` stays null. The account can browse and
           * build a cart immediately; ordering is gated on verification via
           * `requireVerifiedUser`.
           */
          status: 'active',
          /**
           * A HARD-CODED LITERAL, AND IT MUST STAY ONE.
           *
           * Not read from the form, not from the invite, not from a header,
           * not from a cookie, not from any client-reachable value. `role` is
           * not in `signUpSchema`, so a forged `role=admin` field is discarded
           * by validation before it ever reaches this object — and even if it
           * were not, it would be overwritten here.
           *
           * An invite is permission to create a CUSTOMER account. It carries no
           * privilege of any kind, and there is no such thing as an admin
           * invite, a staff invite or a backup-admin invite anywhere in this
           * application. Administrators are appointed by the owner alone,
           * through `lib/admin/backup-admin.ts`.
           */
          role: 'customer',
        })
        .returning({ id: schema.users.id })

      await recordRedemptionWithin(tx, redemption.inviteCodeId, created.id)

      /**
       * Audited inside the transaction and allowed to throw, so the record of
       * which invite created which account cannot be lost while the account
       * survives. The invite is identified by its MASKED PREFIX — the raw code
       * never reaches the audit log, or any other log.
       */
      await recordAuditEventWithin(tx, {
        event: 'INVITE_REDEEMED',
        userId: created.id,
        entityType: 'invite_code',
        entityId: redemption.inviteCodeId,
        summary: `invite ${maskInviteCode(redemption.codePrefix)} redeemed`,
      })

      return { userId: created.id }
    })

    userId = outcome.userId
  } catch (error) {
    if (error instanceof InviteRejected) {
      /**
       * Audited with the INTERNAL reason, which is useful to an operator and
       * unreachable by the customer. The customer gets one generic message for
       * every failure mode, so the form cannot be used to distinguish a code
       * that does not exist from one that is merely used up.
       */
      await recordAuditEvent({
        event: 'INVITE_REDEMPTION_FAILED',
        summary: `invite redemption refused: ${error.reason}`,
      })

      return fail('forbidden', GENERIC_INVITE_FAILURE, {
        inviteCode: ['Invalid or unavailable'],
      })
    }

    /**
     * Anything else is a genuine write failure — most likely the unique index
     * on email losing a race with a concurrent signup for the same address.
     * The invite claim rolled back with it, so the use was not spent.
     */
    return fail('conflict', 'An account with this email already exists.')
  }

  const sessionId = await createSession(userId)
  // Fold any guest bag into the brand-new account before the redirect.
  const merge = await mergeGuestBagIntoUser(userId)

  await recordAuditEvent({ event: 'ACCOUNT_CREATED', userId, sessionId })
  await recordAuditEvent({ event: 'LOGIN', userId, sessionId })

  /**
   * Dispatch the confirmation email.
   *
   * AFTER THE RESPONSE, NOT DURING IT. `after()` runs once the redirect is
   * already on its way, so a slow or unreachable provider cannot delay account
   * creation and — more importantly — cannot fail it. Someone who has just
   * typed their details, passed the age gate and had a password hashed must end
   * up with an account whatever Resend is doing; the email is a follow-up, not
   * a precondition.
   *
   * If delivery fails, `issueAndSend` discards the token it issued and audits
   * `EMAIL_SEND_FAILED`. That hands back both the 60-second cooldown and the
   * daily send budget, so the customer can use the resend button on
   * /account/verify-email immediately rather than being locked out of
   * verification by our outage.
   *
   * The request is audited HERE, before the response, so the log records the
   * intent even if the process is torn down before `after()` finishes. Delivery
   * has its own event; this one means "we decided to send", not "it arrived".
   */
  await recordAuditEvent({
    event: 'EMAIL_VERIFICATION_REQUESTED',
    userId,
    sessionId,
    entityType: 'user',
    entityId: userId,
  })

  after(async () => {
    await issueAndSend(userId, email, 'email_verification')
  })

  /**
   * Honours the same `?next=` destination sign-in does, and through the same
   * validator. A visitor who was bounced to sign-up from a deep link should land
   * back on it, and `safeRedirectPath` is what stops that becoming an open
   * redirect.
   */
  const destination = safeRedirectPath(parsed.data.next)
  redirect(
    merge.unavailable.length ? withQueryFlag(destination, BAG_UPDATED_FLAG) : destination,
  )
}

export async function signInAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(signInSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const { email, password, next } = parsed.data

  /**
   * ORIGIN throttle, complementing the per-ACCOUNT lockout further down.
   *
   * Neither alone is sufficient, and they fail in opposite directions. The
   * account lockout (5 attempts, 15 minutes) does nothing against password
   * spraying — one guess each against ten thousand accounts never trips it,
   * because no single account sees more than one failure. This does, because it
   * follows the source. Conversely this does nothing against a botnet grinding
   * one account from a thousand addresses, which is exactly what the lockout
   * catches.
   *
   * Reported with the SAME `rate_limited` shape a locked account produces, so
   * the two are indistinguishable to the caller and neither reveals whether the
   * address they tried actually exists.
   */
  const throttle = await checkOriginRateLimit(RATE_LIMITS.signIn)
  if (!throttle.allowed) {
    return fail('rate_limited', rateLimitMessage(throttle.retryAfterMs))
  }

  const rows = await db
    .select({
      id: schema.users.id,
      passwordHash: schema.users.passwordHash,
      status: schema.users.status,
      failedLoginAttempts: schema.users.failedLoginAttempts,
      lockedUntil: schema.users.lockedUntil,
    })
    .from(schema.users)
    .where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt)))
    .limit(1)

  const user = rows[0]

  if (!user) {
    // Spend comparable time so latency does not reveal that the account is absent.
    await equalizeTimingForMissingUser()
    await recordAuditEvent({ event: 'FAILED_LOGIN' })
    return fail('unauthenticated', GENERIC_SIGN_IN_FAILURE)
  }

  const wasLocked = Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now())

  if (wasLocked) {
    await recordAuditEvent({ event: 'FAILED_LOGIN', userId: user.id })
    return fail('rate_limited', GENERIC_SIGN_IN_FAILURE)
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash)

  if (!passwordMatches) {
    const attempts = user.failedLoginAttempts + 1
    const nowLocked = attempts >= MAX_FAILED_ATTEMPTS

    await db
      .update(schema.users)
      .set(
        withUpdatedAt({
          failedLoginAttempts: attempts,
          lockedUntil: nowLocked ? new Date(Date.now() + LOCKOUT_MS) : null,
        }),
      )
      .where(eq(schema.users.id, user.id))

    await recordAuditEvent({ event: 'FAILED_LOGIN', userId: user.id })
    if (nowLocked) {
      await recordAuditEvent({ event: 'ACCOUNT_LOCKED', userId: user.id })
    }

    return fail('unauthenticated', GENERIC_SIGN_IN_FAILURE)
  }

  /**
   * A suspended account is reported with the same generic message. Telling a
   * suspended user *why* they cannot get in invites them to work around it, and
   * tells an attacker the account exists.
   */
  if (user.status === 'suspended') {
    await recordAuditEvent({ event: 'FAILED_LOGIN', userId: user.id })
    return fail('unauthenticated', GENERIC_SIGN_IN_FAILURE)
  }

  const hadFailures = user.failedLoginAttempts > 0

  await db
    .update(schema.users)
    .set(
      withUpdatedAt({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      }),
    )
    .where(eq(schema.users.id, user.id))

  // Fresh token on every sign-in — this is what closes session fixation.
  const sessionId = await createSession(user.id)

  /**
   * Guest bag merge. Runs after the session exists so the merge is attributed
   * to a real, authenticated user, and before the redirect so the bag count is
   * already correct on the page the customer lands on.
   */
  const merge = await mergeGuestBagIntoUser(user.id)

  if (hadFailures) {
    await recordAuditEvent({ event: 'ACCOUNT_UNLOCKED', userId: user.id, sessionId })
  }
  await recordAuditEvent({ event: 'LOGIN', userId: user.id, sessionId })

  /**
   * A dropped line is the one merge result the customer must not have to
   * discover for themselves. The generic notice is carried on the redirect;
   * per-item detail is deferred, and remains recoverable from the merge outcome
   * and the `CART_MERGED` audit row.
   */
  const destination = safeRedirectPath(next)
  redirect(
    merge.unavailable.length ? withQueryFlag(destination, BAG_UPDATED_FLAG) : destination,
  )
}

export async function signOutAction(): Promise<never> {
  // Captured before the session is destroyed — afterwards there is nothing to log.
  const session = await getCurrentSessionId()

  if (session) {
    await recordAuditEvent({
      event: 'LOGOUT',
      userId: session.userId,
      sessionId: session.sessionId,
    })
  }

  await destroyCurrentSession()
  redirect('/')
}

export async function changePasswordAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const session = await requireSession()

  const parsed = parseInput(changePasswordSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const rows = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, session.user.id))
    .limit(1)

  const current = rows[0]
  if (!current) return fail('not_found', 'Account not found.')

  if (!(await verifyPassword(parsed.data.currentPassword, current.passwordHash))) {
    return fail('unauthenticated', 'Your current password is incorrect.', {
      currentPassword: ['Incorrect password'],
    })
  }

  await db
    .update(schema.users)
    .set(withUpdatedAt({ passwordHash: await hashPassword(parsed.data.newPassword) }))
    .where(eq(schema.users.id, session.user.id))

  /**
   * Every other device is signed out. A password change is the standard
   * response to "someone else is in my account", and it is worthless if the
   * intruder's session survives it. The current session is kept — the user just
   * proved knowledge of both passwords.
   */
  await revokeOtherSessions(session.user.id, session.sessionId)

  await recordAuditEvent({
    event: 'PASSWORD_CHANGED',
    userId: session.user.id,
    sessionId: session.sessionId,
  })

  revalidatePath('/account/security')
  return ok()
}

export async function updateProfileAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const user = await requireUser()

  const parsed = parseInput(updateProfileSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  await db
    .update(schema.users)
    .set(withUpdatedAt({ name: parsed.data.name, phone: parsed.data.phone ?? null }))
    .where(eq(schema.users.id, user.id))

  revalidatePath('/account')
  return ok()
}

export async function revokeSessionAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const session = await requireSession()

  const parsed = parseInput(revokeSessionSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  if (parsed.data.sessionId === session.sessionId) {
    return fail(
      'conflict',
      'That is the device you are using now. Use sign out instead.',
    )
  }

  // Scoped to the owner, so one user cannot revoke another's session by id.
  await revokeSession(session.user.id, parsed.data.sessionId)

  await recordAuditEvent({
    event: 'SESSION_REVOKED',
    userId: session.user.id,
    sessionId: parsed.data.sessionId,
  })

  revalidatePath('/account/security')
  return ok()
}

/**
 * Signature matches `useActionState` so the action can be passed to it
 * directly. Wrapping it in an inline client-side arrow — which is what this
 * used to be — produced a form with no server-action fields, so the button
 * silently did nothing without JavaScript while every other form on the site
 * degraded correctly. Caught by the end-to-end suite.
 */
export async function revokeOtherSessionsAction(): Promise<ActionResult<void>> {
  const session = await requireSession()

  /**
   * Enumerated first so each revoked session gets its own audit row. A single
   * "revoked everything" entry would lose which devices were actually ended,
   * which is the detail an investigation needs.
   */
  const existing = await listSessions(session.user.id)

  await revokeOtherSessions(session.user.id, session.sessionId)

  for (const revoked of existing) {
    if (revoked.id === session.sessionId) continue
    await recordAuditEvent({
      event: 'SESSION_REVOKED',
      userId: session.user.id,
      sessionId: revoked.id,
    })
  }

  revalidatePath('/account/security')
  return ok()
}

/**
 * Admin-only suspension and reinstatement.
 *
 * Suspension deletes every session for the target immediately. `resolveSession`
 * also rejects suspended users on read, so the two mechanisms are belt and
 * braces: even a session created in the same instant is dead on its next
 * request.
 */
export async function setUserStatusAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const { user: admin } = await requireAdminIdentity()

  const input = formDataToObject(formData)
  const targetUserId = String(input.userId ?? '')
  const nextStatus = String(input.status ?? '')

  if (!schema.userStatus.enumValues.includes(nextStatus as schema.UserStatus)) {
    return fail('validation_error', 'Unknown status.')
  }

  if (targetUserId === admin.id) {
    return fail('conflict', 'You cannot suspend your own account.')
  }

  /**
   * THE OWNER CANNOT BE SUSPENDED THROUGH THE WEBSITE.
   *
   * `requireAdminIdentity` requires `status === 'active'`, so suspending the
   * owner would lock the only permanent administrator out of their own store —
   * and because reinstating them is itself an administrative action, there would
   * be no way back in through the application at all. Without this check, a
   * backup administrator (or anyone who took over their session) could end the
   * owner's access permanently with a single form post.
   *
   * Checked against the ENVIRONMENT rather than a role column, so it holds even
   * if the owner's row has already been tampered with.
   */
  const owner = resolveOwnerUserId()
  if (owner.ok && targetUserId === owner.ownerId) {
    return fail('forbidden', 'The owner account cannot be suspended.')
  }

  await db
    .update(schema.users)
    .set(withUpdatedAt({ status: nextStatus as schema.UserStatus }))
    .where(eq(schema.users.id, targetUserId))

  if (nextStatus === 'suspended') {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, targetUserId))
    await recordAuditEvent({ event: 'ACCOUNT_SUSPENDED', userId: targetUserId })
  }

  revalidatePath('/admin/users')
  return ok()
}

/**
 * Administrative role change — for `customer` and `staff` ONLY.
 *
 * THIS IS NO LONGER A WAY TO CREATE AN ADMINISTRATOR, and it is no longer a way
 * to unmake one. Both directions are refused below, and both refusals close a
 * real hole that existed while this was a plain `requireAdmin()` + free-text
 * role write:
 *
 *  - PROMOTION. Writing `role = 'admin'` here would not by itself grant access,
 *    because `requireAdminIdentity` also demands the account be the owner or the
 *    backup-slot occupant. But it would collide with the two-admin database
 *    trigger, and it would litter the user table with accounts that LOOK
 *    administrative to anyone reading it. Promotion has exactly one door:
 *    the owner-only backup-admin flow.
 *
 *  - DEMOTION. This is the sharper one. `requireAdminIdentity` requires
 *    `role === 'admin'`, so a backup administrator who set the OWNER's role to
 *    `customer` would lock the owner out of their own store — permanently,
 *    since every route back in is an admin route. That is a complete privilege
 *    inversion available to the less-privileged of the two administrators, and
 *    it is refused explicitly rather than left to the identity model to absorb.
 *
 * The target's sessions are still revoked, so a `staff` demotion takes effect on
 * their next request rather than whenever their session happens to expire.
 */
export async function setUserRoleAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const { user: admin } = await requireAdminIdentity()

  const input = formDataToObject(formData)
  const targetUserId = String(input.userId ?? '')
  const nextRole = String(input.role ?? '')

  if (!schema.userRole.enumValues.includes(nextRole as schema.UserRole)) {
    return fail('validation_error', 'Unknown role.')
  }

  if (targetUserId === admin.id) {
    return fail(
      'conflict',
      'You cannot change your own role. Ask another admin to do it.',
    )
  }

  if (nextRole === 'admin') {
    return fail(
      'forbidden',
      'Administrators are not created here. The owner assigns the single backup administrator from Security → Admin access.',
    )
  }

  /**
   * Neither administrator may be demoted through this action. The owner is
   * protected because demotion locks them out; the backup is protected because
   * an account holding the slot while carrying `role = 'customer'` is an
   * inconsistent state that `requireAdminIdentity` would silently refuse, making
   * a live backup administrator mysteriously stop working. Removing a backup is
   * done properly — and audited — through the owner-only removal flow, which
   * resets the role as part of the same transaction.
   */
  const owner = resolveOwnerUserId()
  if (owner.ok && targetUserId === owner.ownerId) {
    return fail('forbidden', 'The owner account role cannot be changed.')
  }

  if (targetUserId === (await getActiveBackupAdminId())) {
    return fail(
      'forbidden',
      'This account holds the backup administrator slot. Remove it from Security → Admin access first.',
    )
  }

  await db
    .update(schema.users)
    .set(withUpdatedAt({ role: nextRole as schema.UserRole }))
    .where(eq(schema.users.id, targetUserId))

  // A demotion must not wait for the old session to expire.
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, targetUserId))

  revalidatePath('/admin/users')
  return ok()
}
