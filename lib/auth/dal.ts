import 'server-only'

import { cache } from 'react'
import type { Route } from 'next'
import { forbidden, redirect } from 'next/navigation'
import { and, eq, isNull } from 'drizzle-orm'

import { db } from '@/lib/db'
import { adminBackup, userPermissions, type AdminPermission, type UserRole } from '@/lib/db/schema'
import {
  auditEventForFailure,
  auditEventForOwnerConfig,
  resolveAdminIdentity,
  type AdminIdentity,
  type AdminIdentityFailure,
  type AdminIdentityResolution,
  type OwnerConfigFault,
} from './admin-identity'
import { recordAuditEvent } from './audit'
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
 * Requires a named permission. 403 when absent.
 *
 * DELIBERATELY DOES NOT ACCEPT `admin` AS A SUBSTITUTE. An administrator who
 * has not been granted `compliance_admin` is refused here exactly like a
 * customer would be. The people who may change a legal cap are a list somebody
 * signed, and the whole value of that list is that it is shorter than the list
 * of administrators.
 *
 * The account must still be a real, verified, signed-in user — the permission
 * is an addition to authentication, never a replacement for it.
 */
export async function requirePermission(
  permission: AdminPermission,
): Promise<SessionUser> {
  const user = await requireUser()
  if (!(await holdsPermission(user.id, permission))) forbidden()
  return user
}

/** Non-redirecting probe, for conditionally rendering a nav item. */
export async function hasPermission(permission: AdminPermission): Promise<boolean> {
  const user = await getCurrentUser()
  return user !== null && (await holdsPermission(user.id, permission))
}

/* ==========================================================================
 * Administrator identity — configured owner + the single backup slot
 * ==========================================================================
 *
 * NOT WIRED. NOTHING BELOW CHANGES WHAT ANY USER CAN REACH TODAY.
 *
 * `requireAdmin()` above is untouched and remains the only guard on /admin.
 * These two functions have no call sites outside their own test. Swapping
 * `requireAdmin()` for `requireAdminIdentity()` is a separate, production-
 * impacting step that requires rehearsal against the real production owner id
 * and an explicit go-ahead — because the moment it lands, every account holding
 * `users.role = 'admin'` that is neither the configured owner nor the live
 * backup loses administrative access.
 *
 * THE MODEL. Migration 0017 documented it and the database already enforces
 * the ceiling; the application never implemented it. An administrator is:
 *
 *   1. the user id in `CLOUDMARKET_OWNER_USER_ID`, or
 *   2. the user in the one live `admin_backup` row (`revoked_at IS NULL`).
 *
 * That is the whole list. THERE IS NO `users.role` FALLBACK, deliberately: the
 * point of anchoring the owner in the environment is that no database write —
 * no compromised admin screen, no stray migration, no seed script — can mint an
 * administrator. Adding a role fallback "so nobody gets locked out" would give
 * the entire property back.
 */

/**
 * The live backup administrator's user id, or null when the slot is empty.
 *
 * `LIMIT 1` is a belt to the database's braces: `admin_backup_single_active_slot`
 * is a partial unique index over a CHECK-pinned constant column, so more than
 * one live row cannot exist. The limit means that even if that guarantee were
 * ever dropped, this returns one deterministic answer rather than throwing.
 */
async function lookupLiveBackupUserId(): Promise<string | null> {
  const [row] = await db
    .select({ userId: adminBackup.userId })
    .from(adminBackup)
    .where(isNull(adminBackup.revokedAt))
    .limit(1)

  return row?.userId ?? null
}

/**
 * The shared resolution. Both entry points below go through this one call, so
 * the silent probe and the enforcing guard cannot drift into disagreeing about
 * who is an administrator — which is the failure mode that produces a nav item
 * leading to a 403, or worse, the reverse.
 *
 * Cached, and safe to cache precisely because `resolveAdminIdentity` is
 * side-effect free: it writes nothing and throws no navigation interrupt. A
 * render where the guard and the probe both run performs one backup lookup.
 *
 * Not exported. The resolution type carries a `SessionUser` and a failure
 * reason; callers get the narrowed shape appropriate to what they asked.
 */
const resolveAdminIdentityCached = cache(
  async (): Promise<AdminIdentityResolution> =>
    resolveAdminIdentity(await getCurrentUser(), lookupLiveBackupUserId),
)

/**
 * Non-redirecting probe: is the current user an administrator, and which kind?
 *
 * For rendering — showing an admin link, labelling a session as owner or
 * backup. Returns null for anonymous, for a signed-in non-administrator, and
 * for a broken owner configuration alike.
 *
 * WRITES NO AUDIT EVENTS, EVER. A probe fires on ordinary page renders for
 * ordinary visitors, and `null` is its ordinary answer. Recording
 * `ADMIN_ACCESS_DENIED` here would fill the security log with rows describing
 * nothing but a nav item that was not drawn, and bury the real ones.
 * `OWNER_IDENTITY_MISCONFIGURED` is withheld for the same reason: a
 * misconfiguration is a real incident, but re-reporting it on every render of
 * every page is not how it should surface. Enforcement audits belong in
 * `requireAdminIdentity()`; configuration health belongs in a deliberate check.
 *
 * NOT AN AUTHORIZATION BOUNDARY. Rendering decisions only — anything that
 * actually exposes admin data must call `requireAdminIdentity()`.
 */
export async function getAdminIdentity(): Promise<AdminIdentity | null> {
  const resolution = await resolveAdminIdentityCached()
  return resolution.status === 'authorized' ? resolution.identity : null
}

/** Audit summaries. Fixed strings — never interpolate the configured value. */
const ADMIN_IDENTITY_DENIAL_SUMMARY: Record<AdminIdentityFailure, string> = {
  not_signed_in: 'Anonymous request to an administrator-only resource',
  owner_not_configured:
    'CLOUDMARKET_OWNER_USER_ID is not set; owner authorization is unavailable and the requester is not the backup administrator',
  owner_malformed:
    'CLOUDMARKET_OWNER_USER_ID is not a valid UUID; owner authorization is unavailable and the requester is not the backup administrator',
  not_an_administrator:
    'Signed-in user is neither the configured owner nor the live backup administrator',
}

/** Summaries for the degraded-but-working case: backup in, owner variable broken. */
const OWNER_CONFIG_FAULT_SUMMARY: Record<OwnerConfigFault, string> = {
  owner_not_configured:
    'Backup administrator authorized while CLOUDMARKET_OWNER_USER_ID is not set; owner authorization is unavailable',
  owner_malformed:
    'Backup administrator authorized while CLOUDMARKET_OWNER_USER_ID is not a valid UUID; owner authorization is unavailable',
}

/**
 * Requires the configured owner or the live backup administrator. 403 otherwise.
 *
 * NOT WRAPPED IN `cache()`, following the same rule as the guards above: this
 * function's failure result is a thrown `forbidden()`, and memoising a thrown
 * control-flow signal buys nothing. The costly part — the session lookup and
 * the backup query — is already deduplicated inside `resolveAdminIdentityCached`.
 *
 * FAILS CLOSED, BUT NOT FURTHER THAN IT HAS TO. A broken owner variable removes
 * owner authorization only; the live backup administrator is still admitted,
 * because the backup slot exists so that losing the owner is recoverable from
 * inside the product rather than requiring a deploy.
 *
 * AUTHENTICATION IS A SEPARATE STEP FROM AUTHORIZATION HERE, and the two must
 * not be collapsed — see the comment on the first line of the body.
 */
export async function requireAdminIdentity(): Promise<AdminIdentity> {
  /*
   * ANONYMOUS REQUESTS REDIRECT TO SIGN-IN; THEY DO NOT GET A 403.
   *
   * This call is what makes that true, and it is not redundant with the
   * resolver's own `not_signed_in` branch. That branch ends in `forbidden()`
   * like every other denial, so relying on it would mean a signed-out
   * administrator opening /admin gets a "forbidden" page instead of a login
   * form — a dead end offering no way forward. `requireAdmin()`, which this
   * will eventually replace, redirects via `requireRole` -> `requireUser` ->
   * `requireSession`, and that boundary has to survive the swap unchanged.
   *
   * Deliberately `requireUser()` and not `requireVerifiedUser()`: `requireRole`
   * does not gate on email verification either, and quietly adding a
   * verification requirement at the cutover would be a second behaviour change
   * smuggled in beside the first.
   *
   * Costs nothing. `requireSession` reads `getCurrentSession()`, which is
   * `cache()`-wrapped and is the same lookup the resolution below already
   * performs, so a render pays for one session read however many guards run.
   */
  await requireUser()

  const resolution = await resolveAdminIdentityCached()

  if (resolution.status === 'authorized') {
    /*
     * A SUCCESSFUL request can still carry a configuration incident: the backup
     * administrator is in, the owner variable is unusable, and the platform is
     * now one revoked row away from having no administrators at all. Nothing
     * else reports this — the request works, so no denial is logged — which is
     * exactly why it is recorded here rather than left to be noticed.
     *
     * NOISE WARNING FOR THE CUTOVER: while the platform sits in this state,
     * every admin page load by the backup writes one of these. That is the same
     * de-duplication problem described at the denial below, and it wants the
     * same answer — a configuration-health check that reports once, rather than
     * a row per render. Do not solve it by dropping the event.
     */
    if (resolution.ownerConfig !== 'ok') {
      const event = auditEventForOwnerConfig(resolution.ownerConfig)
      if (event !== null) {
        await recordAuditEvent({
          event,
          userId: resolution.identity.user.id,
          entityType: 'admin_identity',
          entityId: resolution.identity.user.id,
          summary: OWNER_CONFIG_FAULT_SUMMARY[resolution.ownerConfig],
        })
      }
    }

    return resolution.identity
  }

  /*
   * `not_signed_in` maps to null and is not recorded.
   *
   * It should be unreachable: `requireUser()` at the top of this function
   * redirects an anonymous request before anything here runs. It is handled
   * anyway as a fail-closed backstop — if the two reads ever disagree, or if
   * someone removes that call, the outcome is still a denial rather than an
   * accidental grant. Nothing is written for it because there is no actor to
   * attribute the row to, and the request never reached an authorization
   * decision worth logging.
   *
   * NOTE: this does NOT assume some earlier guard authenticated the caller.
   * `requireAdminIdentity()` is safe to use as the only guard on a route, and
   * an earlier draft of this comment claimed otherwise.
   *
   * FUTURE CUTOVER HOOK — NOT IMPLEMENTED HERE, BY DESIGN. Once this guard is
   * live, every denied request writes a row, and a scanner sweeping /admin/*
   * can inflate `audit_log` through it. De-duplicating or throttling those
   * writes needs a TRUSTED origin, since a client-supplied forwarding header
   * can be forged both to evade a limit and to poison another origin's counter.
   * `lib/security/rate-limit.ts` is built and unwired; wiring it belongs to the
   * cutover, together with deciding what a trusted origin is on Vercel.
   */
  const event = auditEventForFailure(resolution.detail)
  if (event !== null) {
    await recordAuditEvent({
      event,
      userId: resolution.user?.id ?? null,
      entityType: 'admin_identity',
      /* uuid column — only ever a real user id, never the configured value. */
      entityId: resolution.user?.id ?? null,
      summary: ADMIN_IDENTITY_DENIAL_SUMMARY[resolution.detail],
    })
  }

  forbidden()
}
