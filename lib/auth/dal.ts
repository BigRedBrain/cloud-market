import 'server-only'

import { cache } from 'react'
import type { Route } from 'next'
import { forbidden, redirect } from 'next/navigation'
import { and, eq, isNull } from 'drizzle-orm'

import { db } from '@/lib/db'
import { userPermissions, type AdminPermission, type UserRole } from '@/lib/db/schema'
import { resolveSession, type ActiveSession, type SessionUser } from './session'

/**
 * Data Access Layer — the authorization boundary.
 *
 * Next's own guidance is explicit that Proxy must not be the authorization
 * solution: it runs on prefetches, cannot safely touch the database, and a
 * request that reaches a Server Component by any other path would bypass it
 * entirely. Authorization therefore lives here, next to the data, and every
 * protected read goes through one of these functions.
 *
 * Wrapped in React's `cache` so that a page, its layout, and any number of leaf
 * components each calling `getCurrentUser()` in the same render produce exactly
 * one session lookup.
 *
 * Never import this from a Client Component — `server-only` makes that a build
 * error rather than a leak. Resolve in a Server Component and pass a DTO down.
 */

/** Live session and user, or null. Does not redirect. */
export const getCurrentSession = cache(async (): Promise<ActiveSession | null> => {
  return resolveSession()
})

/** Current user, or null. Use when anonymous is a legitimate outcome. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await getCurrentSession()
  return session?.user ?? null
})

/**
 * Requires any signed-in user.
 *
 * `redirectTo` is carried through so a deep link survives the round trip to
 * sign-in. It is passed as a path only and validated on the way back out — an
 * open redirect here would be a phishing primitive.
 *
 * NOT wrapped in `cache()`. The guards below throw Next's control-flow signals
 * (`redirect`, `forbidden`), and memoising a function whose "result" is a
 * thrown navigation interrupt buys nothing — the expensive part, the session
 * lookup, is already deduplicated inside `getCurrentSession`.
 *
 * NOTE ON STATUS CODES: when one of these interrupts is raised after the
 * response has begun streaming, Next cannot set a 307/403 header and instead
 * embeds the navigation in the stream, so the transport status is 200. This was
 * measured, and it is framework behaviour rather than something the DAL can
 * change — removing these `cache()` wrappers did not affect it.
 *
 * It is not a security weakness: the protected component never renders, and
 * `scripts/verify-auth-e2e.mjs` asserts on *content denial* rather than status
 * for exactly this reason. Browsers follow the embedded navigation normally.
 */
export async function requireSession(redirectTo?: string): Promise<ActiveSession> {
  const session = await getCurrentSession()

  if (!session) {
    redirect(
      redirectTo
        ? (`/sign-in?next=${encodeURIComponent(redirectTo)}` as Route)
        : '/sign-in',
    )
  }

  return session
}

export async function requireUser(redirectTo?: string): Promise<SessionUser> {
  const session = await requireSession(redirectTo)
  return session.user
}

/**
 * Requires a verified email address.
 *
 * Ordering and payment gate on this. An unverified account may browse and build
 * a cart, but a licensed retailer cannot dispatch age-restricted product to an
 * address it has never confirmed reaches a real person.
 */
export async function requireVerifiedUser(): Promise<SessionUser> {
  const user = await requireUser()
  if (!user.emailVerifiedAt) redirect('/account/verify-email')
  return user
}

/**
 * Requires one of the given roles.
 *
 * Returns 403 rather than redirecting to sign-in: the user IS authenticated,
 * they simply are not permitted, and bouncing them to a login form they have
 * already completed is a confusing dead end. Roles are checked against the
 * database-backed session, so a demotion takes effect on the next request.
 */
export async function requireRole(
  ...roles: readonly UserRole[]
): Promise<SessionUser> {
  const user = await requireUser()
  if (!roles.includes(user.role)) forbidden()
  return user
}

/**
 * THERE IS DELIBERATELY NO `requireAdmin()` IN THIS MODULE ANY MORE.
 *
 * It used to be `requireRole('admin')`, and that was the whole of the admin
 * authorization story: hold the role, get the keys. Phase 5 replaced it with an
 * identity model — at most two named accounts may administer this store — and
 * leaving a role-only helper here would have left the weaker check one import
 * away from any new admin page somebody writes next year.
 *
 * Removing it rather than deprecating it was the point. Every former call site
 * became a type error, which is how the section G audit was actually performed:
 * the compiler enumerated them, not a grep that might have missed one.
 *
 * `requireStaff()` is gone for the same reason. It granted `staff` OR `admin`
 * and had no live callers; a role-based door into the admin surface with nobody
 * using it is a liability with no upside.
 *
 * Use `requireAdminIdentity()` from `lib/auth/admin-identity.ts`.
 */

/**
 * Non-redirecting permission probe, for conditionally rendering UI.
 *
 * This hides a control; it does not protect the action behind it. Every Server
 * Action and route must run its own `requireRole` — a hidden button is not an
 * authorization check.
 */
export async function hasRole(...roles: readonly UserRole[]): Promise<boolean> {
  const user = await getCurrentUser()
  return user !== null && roles.includes(user.role)
}

/* -------------------------------------------------------------------------- */
/* Named permissions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Does this user hold a live grant of `permission`?
 *
 * Read fresh from the database rather than carried on the session, so a
 * revocation takes effect on the next request instead of whenever the session
 * happens to expire. For a permission that gates a legal cap, "revoked but
 * still usable until they sign out" is not an acceptable window.
 *
 * `cache()` keeps it to one query per render even when the page, a form and a
 * nav item each ask.
 */
export const holdsPermission = cache(
  async (userId: string, permission: AdminPermission): Promise<boolean> => {
    const [row] = await db
      .select({ id: userPermissions.id })
      .from(userPermissions)
      .where(
        and(
          eq(userPermissions.userId, userId),
          eq(userPermissions.permission, permission),
          isNull(userPermissions.revokedAt),
        ),
      )
      .limit(1)

    return row !== undefined
  },
)

/**
 * `requirePermission()` HAS ALSO BEEN REMOVED, and its replacement lives in
 * `lib/auth/admin-identity.ts` as `requireAdminPermission()`.
 *
 * The old version checked the named grant and nothing else. That was correct
 * about the thing it was worrying about — an administrator without
 * `compliance_admin` must not publish a legal cap — but it quietly assumed the
 * caller was an administrator in the first place, because in practice these
 * screens were only reachable from `/admin`.
 *
 * That assumption is exactly what section H forbids. A customer who acquired a
 * `compliance_admin` row by any means would have passed this check. The
 * replacement establishes identity FIRST and reads the grant second, so the
 * permission is an addition to administrative access rather than a route into
 * it.
 *
 * `holdsPermission` below survives unchanged: it is the underlying probe, and
 * it is still the right primitive once identity has been established.
 */

/** Non-redirecting probe, for conditionally rendering a nav item. */
export async function hasPermission(permission: AdminPermission): Promise<boolean> {
  const user = await getCurrentUser()
  return user !== null && (await holdsPermission(user.id, permission))
}
