import 'server-only'

import { cache } from 'react'
import { forbidden } from 'next/navigation'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '@/lib/db'
import { serverEnv } from '@/lib/env'
import type { AdminPermission } from '@/lib/db/schema'
import { recordAuditEvent } from './audit'
import {
  decideAdminAccess,
  type AdminDenialReason,
  type AdminRank,
} from './admin-decision'
import { getCurrentSession } from './dal'
import type { ActiveSession, SessionUser } from './session'

/**
 * WHO MAY ADMINISTER CLOUD MARKET.
 *
 * This module is the single authority on that question, and the answer is a
 * closed set of at most two people:
 *
 *   OWNER   — identified by the `CLOUDMARKET_OWNER_USER_ID` environment
 *             variable. Not stored in the database, not editable through the
 *             application, not transferable through any UI. Changing it
 *             requires access to the deployment's secrets.
 *
 *   BACKUP  — the single optional occupant of the `admin_backup` slot, which
 *             the database will not allow to hold more than one live row.
 *
 * There is deliberately no third case, and no fallback.
 *
 * WHY `users.role = 'admin'` IS NOT SUFFICIENT ON ITS OWN
 *
 * A role is a column. Columns get written — by a future admin screen, a repair
 * script, a migration, a compromised session belonging to somebody who already
 * had *some* write access. If holding `role = 'admin'` were enough to
 * administer the store, then every one of those paths would be a privilege
 * escalation, and the security of the whole admin surface would rest on nobody
 * ever writing that column by mistake.
 *
 * So the role is treated as a NECESSARY BUT INSUFFICIENT condition. The
 * authoritative check is identity: is this account the one named in the server's
 * environment, or the one occupying the single backup slot? An attacker who
 * flips their own role to `admin` gains exactly nothing, because their id
 * matches neither. This is asserted directly by the test suite.
 *
 * WHY NAMED PERMISSIONS ARE NOT SUFFICIENT EITHER
 *
 * `compliance_admin` and `catalog_compliance_admin` are CAPABILITIES, granted to
 * an administrator to let them do a specific regulated job. They were never
 * intended to be a way IN. `requireAdminPermission` below therefore checks
 * identity first and the grant second, so a customer who somehow acquired every
 * permission row in the table still gets a 403 at the door.
 *
 * FAIL-CLOSED IS THE DEFAULT AND IS NOT NEGOTIABLE
 *
 * If `CLOUDMARKET_OWNER_USER_ID` is absent, or is not a UUID, every function
 * here denies every caller — including the owner. The alternative, falling back
 * to `role = 'admin'`, would mean a deployment that forgot one environment
 * variable silently downgrades to the weaker model it was written to replace,
 * which is the worst possible failure mode: invisible, and only discovered
 * afterwards.
 */

/**
 * The verdict logic lives in `./admin-decision.ts`, which has NO imports at all.
 *
 * This module imports `next/navigation` for `forbidden()`, and that single
 * import drags in React's client router context — enough to make anything that
 * imports this file unusable outside a rendering runtime. Keeping the pure
 * decision separate is what lets `scripts/verify-phase-5-authz.mts` drive it
 * across the full cross-product of role, status, ownership and slot state.
 */
export {
  decideAdminAccess,
  type AdminCandidate,
  type AdminDenialReason,
  type AdminRank,
  type AdminVerdict,
  type OwnerResolution,
} from './admin-decision'

export type AdminIdentity = {
  user: SessionUser
  sessionId: string
  rank: AdminRank
  /** Convenience for the many owner-only branches. `rank === 'owner'`. */
  isOwner: boolean
}

/**
 * Strict parse of the owner id.
 *
 * `lib/env.ts` accepts this as a loose optional string on purpose — a typo here
 * must not stop customers from browsing and signing in. The strict validation
 * lives here instead, at the point where it decides something, and its failure
 * scope is admin access alone.
 */
const ownerIdSchema = z.uuid()

export function resolveOwnerUserId():
  | { ok: true; ownerId: string }
  | { ok: false; reason: 'owner_env_missing' | 'owner_env_malformed' } {
  const raw = serverEnv().CLOUDMARKET_OWNER_USER_ID?.trim()

  if (!raw) return { ok: false, reason: 'owner_env_missing' }

  const parsed = ownerIdSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'owner_env_malformed' }

  return { ok: true, ownerId: parsed.data }
}

/**
 * The current occupant of the backup slot, or null.
 *
 * Read fresh from the database on every request rather than carried on the
 * session, so that removing a backup administrator takes effect on their NEXT
 * REQUEST rather than whenever their session happens to expire. Removal is a
 * response to something having gone wrong; a version of it that leaves the
 * removed party administering the store for another week is not a removal.
 *
 * `cache()` keeps it to one query per render even when a layout, a page and
 * three components each ask.
 */
export const getActiveBackupAdminId = cache(async (): Promise<string | null> => {
  const [row] = await db
    .select({ userId: schema.adminBackup.userId })
    .from(schema.adminBackup)
    .where(isNull(schema.adminBackup.revokedAt))
    .limit(1)

  return row?.userId ?? null
})

/**
 * The full backup record, for the owner's management screen.
 *
 * Joined to `users` so the screen can show the operator WHO they are about to
 * remove. Showing a bare UUID and asking someone to confirm an irreversible
 * privilege change is how the wrong account gets removed.
 */
export async function getActiveBackupAdmin(): Promise<{
  id: string
  userId: string
  email: string
  name: string | null
  assignedAt: Date
  assignedBy: string | null
  reason: string | null
} | null> {
  const [row] = await db
    .select({
      id: schema.adminBackup.id,
      userId: schema.adminBackup.userId,
      email: schema.users.email,
      name: schema.users.name,
      assignedAt: schema.adminBackup.assignedAt,
      assignedBy: schema.adminBackup.assignedBy,
      reason: schema.adminBackup.reason,
    })
    .from(schema.adminBackup)
    .innerJoin(schema.users, eq(schema.adminBackup.userId, schema.users.id))
    .where(isNull(schema.adminBackup.revokedAt))
    .limit(1)

  return row ?? null
}

/**
 * Non-throwing resolution. Gathers the facts, then defers to
 * `decideAdminAccess` for the verdict.
 */
export async function resolveAdminIdentity(): Promise<
  { ok: true; identity: AdminIdentity } | { ok: false; reason: AdminDenialReason }
> {
  /* 1. A valid server-side session. */
  const session: ActiveSession | null = await getCurrentSession()
  if (!session) return { ok: false, reason: 'no_session' }

  /**
   * 2. The user id and status come from `resolveSession`, which reads them from
   * the database on every request and has already rejected suspended and
   * soft-deleted accounts. The `active` check is re-asserted inside
   * `decideAdminAccess` rather than trusted, because this is the check that
   * matters most and it should not depend on the internals of another module
   * staying the way they are today.
   */
  const { user } = session
  const owner = resolveOwnerUserId()

  /**
   * The backup slot is read ONLY when it could change the answer. A caller who
   * is already the owner, or who fails on role or status, never triggers the
   * query — which keeps the common admin request to one lookup.
   */
  const needsBackupLookup =
    user.status === 'active' && user.role === 'admin' && owner.ok && user.id !== owner.ownerId

  const backupUserId = needsBackupLookup ? await getActiveBackupAdminId() : null

  const verdict = decideAdminAccess({ user, owner, backupUserId })

  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  return {
    ok: true,
    identity: {
      user,
      sessionId: session.sessionId,
      rank: verdict.rank,
      isOwner: verdict.rank === 'owner',
    },
  }
}

/**
 * Records a refusal.
 *
 * Split out because both the throwing and non-throwing guards need it, and
 * because the two environment failures deserve a distinct event: a burst of
 * `ADMIN_ACCESS_DENIED` is somebody probing, whereas a single
 * `OWNER_IDENTITY_MISCONFIGURED` is a deployment mistake locking out a
 * legitimate operator. Reading the same event for both would hide the second
 * inside the noise of the first, and they need completely different responses.
 */
async function auditDenial(reason: AdminDenialReason): Promise<void> {
  const misconfigured =
    reason === 'owner_env_missing' || reason === 'owner_env_malformed'

  /**
   * An anonymous request to an admin URL is the single most common event on any
   * public deployment — every scanner on the internet tries `/admin`. Auditing
   * those would bury the signal that matters (an AUTHENTICATED account being
   * refused) under megabytes of noise.
   */
  if (reason === 'no_session') return

  const session = await getCurrentSession()

  await recordAuditEvent({
    event: misconfigured ? 'OWNER_IDENTITY_MISCONFIGURED' : 'ADMIN_ACCESS_DENIED',
    userId: session?.user.id ?? null,
    sessionId: session?.sessionId ?? null,
    summary: misconfigured
      ? `admin access denied: CLOUDMARKET_OWNER_USER_ID ${
          reason === 'owner_env_missing' ? 'is not set' : 'is not a valid UUID'
        }`
      : `admin access denied: ${reason}`,
  })
}

/**
 * THE GUARD. Every administrative page, action and route handler starts here.
 *
 * Raises Next's `forbidden()` interrupt on refusal, which renders
 * `app/forbidden.tsx` with a real 403 rather than redirecting to sign-in. The
 * caller IS authenticated — bouncing them to a login form they have already
 * completed is a confusing dead end, and a 403 is the honest answer.
 *
 * Deliberately NOT wrapped in `cache()`: its "result" on the unhappy path is a
 * thrown navigation interrupt, which there is no value in memoising. The
 * expensive parts — the session lookup and the backup-slot read — are already
 * deduplicated inside `getCurrentSession` and `getActiveBackupAdminId`.
 */
export async function requireAdminIdentity(): Promise<AdminIdentity> {
  const result = await resolveAdminIdentity()

  if (!result.ok) {
    await auditDenial(result.reason)
    forbidden()
  }

  return result.identity
}

/**
 * Owner only. The backup administrator is refused here exactly like a customer.
 *
 * Gates everything in section AI and section F: filling or emptying the backup
 * slot, crypto provider configuration, and refunds. The common thread is that
 * these are the operations by which an administrator could either entrench
 * themselves or move money, and the person who owns the business is the only one
 * who should be able to do either.
 */
export async function requireOwner(): Promise<AdminIdentity> {
  const identity = await requireAdminIdentity()

  if (!identity.isOwner) {
    await recordAuditEvent({
      event: 'ADMIN_ACCESS_DENIED',
      userId: identity.user.id,
      sessionId: identity.sessionId,
      summary: 'owner-only operation attempted by backup administrator',
    })
    forbidden()
  }

  return identity
}

/**
 * Valid admin identity AND a named permission grant. Both, in that order.
 *
 * This is the correct composition described in section H, and it replaces the
 * old `requirePermission`, which checked only the grant. Under the old shape a
 * customer holding a `compliance_admin` row — however they came by it — reached
 * the purchase-limit screens. Now they are refused at the identity check and the
 * grant is never even read.
 *
 * The grant remains genuinely independent of the role: an administrator who has
 * not been granted `compliance_admin` is still refused, because the set of
 * people who may change a legal cap is a list somebody signed, and the whole
 * value of that list is that it is shorter than the list of administrators.
 */
export async function requireAdminPermission(
  permission: AdminPermission,
): Promise<AdminIdentity> {
  const identity = await requireAdminIdentity()

  const [grant] = await db
    .select({ id: schema.userPermissions.id })
    .from(schema.userPermissions)
    .where(
      and(
        eq(schema.userPermissions.userId, identity.user.id),
        eq(schema.userPermissions.permission, permission),
        isNull(schema.userPermissions.revokedAt),
      ),
    )
    .limit(1)

  if (!grant) {
    await recordAuditEvent({
      event: 'ADMIN_ACCESS_DENIED',
      userId: identity.user.id,
      sessionId: identity.sessionId,
      summary: `missing named permission: ${permission}`,
    })
    forbidden()
  }

  return identity
}

/**
 * Non-redirecting probe, for deciding whether to render a nav item.
 *
 * THIS HIDES A CONTROL; IT DOES NOT PROTECT THE ACTION BEHIND IT. Every page,
 * Server Action and route handler runs its own `requireAdminIdentity` — a hidden
 * button has never been an authorization check, and treating one as such is how
 * an admin surface ends up protected by CSS.
 */
export async function isAdminIdentity(): Promise<boolean> {
  return (await resolveAdminIdentity()).ok
}

/** Non-redirecting owner probe, for the same purpose. */
export async function isOwnerIdentity(): Promise<boolean> {
  const result = await resolveAdminIdentity()
  return result.ok && result.identity.isOwner
}
