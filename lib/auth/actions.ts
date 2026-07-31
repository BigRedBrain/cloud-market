'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { redirect } from 'next/navigation'
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
import { equalizeTimingForMissingUser, hashPassword, verifyPassword } from './crypto'
import { requireAdmin, requireSession, requireUser } from './dal'
import {
  createSession,
  destroyCurrentSession,
  revokeOtherSessions,
  revokeSession,
} from './session'
import {
  changePasswordSchema,
  revokeSessionSchema,
  safeRedirectPath,
  signInSchema,
  signUpSchema,
  updateProfileSchema,
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

export async function signUpAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(signUpSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const { email, password, name, dateOfBirth } = parsed.data

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

  const passwordHash = await hashPassword(password)

  let userId: string
  try {
    const [created] = await db
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        name,
        dateOfBirth,
        /**
         * Active, but `emailVerifiedAt` stays null. The account can browse and
         * build a cart immediately; ordering is gated on verification via
         * `requireVerifiedUser`. Email delivery is not yet configured — see
         * AUTHENTICATION.md.
         */
        status: 'active',
        role: 'customer',
      })
      .returning({ id: schema.users.id })
    userId = created.id
  } catch {
    // Unique-index violation from a concurrent signup for the same address.
    return fail('conflict', 'An account with this email already exists.')
  }

  await createSession(userId)
  redirect('/account')
}

export async function signInAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(signInSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const { email, password, next } = parsed.data

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
    return fail('unauthenticated', GENERIC_SIGN_IN_FAILURE)
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return fail('rate_limited', GENERIC_SIGN_IN_FAILURE)
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash)

  if (!passwordMatches) {
    const attempts = user.failedLoginAttempts + 1
    await db
      .update(schema.users)
      .set(
        withUpdatedAt({
          failedLoginAttempts: attempts,
          lockedUntil:
            attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
        }),
      )
      .where(eq(schema.users.id, user.id))

    return fail('unauthenticated', GENERIC_SIGN_IN_FAILURE)
  }

  /**
   * A suspended account is reported with the same generic message. Telling a
   * suspended user *why* they cannot get in invites them to work around it, and
   * tells an attacker the account exists.
   */
  if (user.status === 'suspended') {
    return fail('unauthenticated', GENERIC_SIGN_IN_FAILURE)
  }

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
  await createSession(user.id)
  redirect(safeRedirectPath(next))
}

export async function signOutAction(): Promise<never> {
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

  revalidatePath('/account/security')
  return ok()
}

export async function revokeOtherSessionsAction(): Promise<ActionResult<void>> {
  const session = await requireSession()
  await revokeOtherSessions(session.user.id, session.sessionId)

  revalidatePath('/account/security')
  return ok()
}

/**
 * Admin-only role change.
 *
 * Kept here rather than in an admin module so that every write to `role` lives
 * beside the checks that guard it. Guarded by `requireAdmin` via the DAL, and
 * it revokes the target's sessions so a demotion takes effect immediately
 * rather than whenever their session next expires.
 */
export async function setUserRoleAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

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

  await db
    .update(schema.users)
    .set(withUpdatedAt({ role: nextRole as schema.UserRole }))
    .where(eq(schema.users.id, targetUserId))

  // A demotion must not wait for the old session to expire.
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, targetUserId))

  revalidatePath('/admin/users')
  return ok()
}
