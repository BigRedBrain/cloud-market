import 'server-only'

import { cache } from 'react'
import type { Route } from 'next'
import { forbidden, redirect } from 'next/navigation'

import type { UserRole } from '@/lib/db/schema'
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

/** Staff and admin. The fulfilment side of the app. */
export async function requireStaff(): Promise<SessionUser> {
  return requireRole('staff', 'admin')
}

/** Admin only. User administration, pricing, licensing. */
export async function requireAdmin(): Promise<SessionUser> {
  return requireRole('admin')
}

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
