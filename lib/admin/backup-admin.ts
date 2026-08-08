'use server'

import { and, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { db, schema } from '@/lib/db'
import { withUpdatedAt } from '@/lib/db/schema'
import { recordAuditEventWithin } from '@/lib/auth/audit'
import {
  getActiveBackupAdmin,
  requireOwner,
  resolveOwnerUserId,
} from '@/lib/auth/admin-identity'
import { reauthMessage, reauthenticate } from '@/lib/auth/reauth'
import {
  RATE_LIMITS,
  checkUserRateLimit,
  rateLimitMessage,
} from '@/lib/security/rate-limit'
import { fail, formDataToObject, ok, parseInput, type ActionResult } from '@/lib/result'

/**
 * The backup administrator slot — assignment and removal.
 *
 * These are the two highest-privilege writes in CloudMarket. They are the ONLY
 * way the set of people who can administer this store ever changes, because the
 * owner is pinned to an environment variable and cannot be altered from the
 * application at all.
 *
 * Every function here is `requireOwner()`, not `requireAdminIdentity()`. The
 * backup administrator is refused exactly like a customer: they cannot appoint a
 * successor, cannot appoint a second backup, cannot remove themselves from
 * oversight, and cannot touch the owner. That asymmetry is the entire point of
 * having two ranks rather than two administrators.
 *
 * THERE IS NO OWNERSHIP-TRANSFER FUNCTION HERE, and there is no UI for one
 * anywhere in the application. Transferring ownership means editing
 * `CLOUDMARKET_OWNER_USER_ID` in the deployment's environment, which requires
 * access to the hosting account. That is deliberate: a web form that can hand
 * over permanent control of the store is a web form worth attacking, and the
 * operation is rare enough that its inconvenience costs nothing.
 */

const assignSchema = z.object({
  /** The account to promote. A UUID from the search results, re-validated here. */
  userId: z.uuid('Choose an account from the search results'),
  password: z.string().min(1, 'Confirm your password to continue'),
  reason: z.string().trim().max(300).optional(),
})

const removeSchema = z.object({
  password: z.string().min(1, 'Confirm your password to continue'),
  reason: z.string().trim().max(300).optional(),
})

/**
 * Candidate search for the assignment screen.
 *
 * OWNER ONLY, even though it only reads. This returns email addresses of
 * customers matching a substring — a customer list for a private cannabis
 * storefront, which is sensitive on its own terms regardless of what it is used
 * for next.
 *
 * Only VERIFIED, ACTIVE accounts are eligible. Promoting an account whose email
 * has never been confirmed would mean granting administrative access to an
 * address nobody has proved they can read, which is the same failure as sending
 * a password reset to an unverified mailbox.
 */
export async function searchBackupCandidatesAction(
  query: string,
): Promise<ActionResult<Array<{ id: string; email: string; name: string | null }>>> {
  await requireOwner()

  const term = query.trim().toLowerCase()

  /**
   * A short query would return most of the customer base. Two characters is not
   * a search, it is a dump.
   */
  if (term.length < 3) return ok([])

  const owner = resolveOwnerUserId()

  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
        /** Verified mailboxes only — see above. */
        sql`${schema.users.emailVerifiedAt} is not null`,
        /** The owner is not a candidate to be their own backup. */
        owner.ok ? ne(schema.users.id, owner.ownerId) : undefined,
        or(
          sql`lower(${schema.users.email}) like ${`%${term}%`}`,
          sql`lower(coalesce(${schema.users.name}, '')) like ${`%${term}%`}`,
        ),
      ),
    )
    .limit(10)

  return ok(rows)
}

/**
 * Fills the single backup slot.
 *
 * THE CONCURRENCY STORY. Two owner sessions submitting different candidates at
 * the same instant both pass the "is the slot empty" read, and both attempt the
 * INSERT. Exactly one succeeds: `admin_backup_single_active_slot` is a partial
 * unique index over a constant column, so the loser violates it and is reported
 * as a conflict. The pre-check below exists to give a good message in the
 * ordinary case, NOT to enforce the invariant — the database does that, which
 * is why the promotion cannot be raced.
 */
export async function assignBackupAdminAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const owner = await requireOwner()

  const parsed = parseInput(assignSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const throttle = await checkUserRateLimit({
    userId: owner.user.id,
    ...RATE_LIMITS.ownerSensitive,
  })
  if (!throttle.allowed) {
    return fail('rate_limited', rateLimitMessage(throttle.retryAfterMs))
  }

  /**
   * RECENT PASSWORD PROOF, at the moment of the write.
   *
   * A session proves somebody signed in as the owner at some point — possibly
   * hours ago, possibly on a laptop they walked away from. Appointing a second
   * administrator on that evidence alone is not good enough. `reauthenticate`
   * narrows the claim to "the person holding this session knew the password
   * seconds ago", and it audits every outcome including the throttled one.
   */
  const reauth = await reauthenticate(owner.user.id, parsed.data.password)
  if (!reauth.ok) {
    return fail('unauthenticated', reauthMessage(reauth.reason), {
      password: ['Confirmation failed'],
    })
  }

  if (await getActiveBackupAdmin()) {
    return fail(
      'conflict',
      'A backup administrator is already assigned. Remove the existing one first — there is only one slot.',
    )
  }

  const [target] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      status: schema.users.status,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, parsed.data.userId))
    .limit(1)

  /** Re-validated server-side; the search result is a hint, never a warrant. */
  if (!target || target.deletedAt !== null) {
    return fail('not_found', 'That account no longer exists.')
  }
  if (target.status !== 'active') {
    return fail('conflict', 'That account is not active.')
  }
  if (target.emailVerifiedAt === null) {
    return fail(
      'conflict',
      'That account has not verified its email address, so it cannot be given administrative access.',
    )
  }
  if (target.id === owner.user.id) {
    return fail('conflict', 'You are the owner. You cannot also hold the backup slot.')
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.adminBackup).values({
        userId: target.id,
        assignedBy: owner.user.id,
        reason: parsed.data.reason ?? null,
      })

      /**
       * The role is set to `admin` as well as the slot being filled.
       *
       * Both facts are required by `requireAdminIdentity`, and writing them in
       * one transaction is what stops them disagreeing. A slot occupant whose
       * role stayed `customer` would be an administrator the guard silently
       * refuses — access that appears to have been granted and has not been,
       * which is the worst kind of bug to debug at 2am.
       */
      await tx
        .update(schema.users)
        .set(withUpdatedAt({ role: 'admin' }))
        .where(eq(schema.users.id, target.id))

      /**
       * Audited INSIDE the transaction and allowed to throw. If the audit write
       * fails, the promotion rolls back with it. An administrator appointed with
       * no record of who appointed them, when, or why is precisely the artefact
       * this log exists to make impossible — better to refuse the change than
       * to make it unaccountably.
       */
      await recordAuditEventWithin(tx, {
        event: 'BACKUP_ADMIN_ASSIGNED',
        userId: owner.user.id,
        sessionId: owner.sessionId,
        entityType: 'user',
        entityId: target.id,
        summary: `backup administrator assigned: ${target.email}${
          parsed.data.reason ? ` — ${parsed.data.reason}` : ''
        }`,
      })
    })
  } catch (error) {
    /**
     * The unique index did its job — another session filled the slot between
     * the check above and this INSERT. Reported as a conflict rather than a
     * 500, because it is a legitimate outcome of two people working at once.
     */
    if (isUniqueViolation(error)) {
      return fail(
        'conflict',
        'A backup administrator was assigned by another session just now. Reload to see the current state.',
      )
    }
    throw error
  }

  /**
   * Existing sessions for the promoted account are left alone ON PURPOSE. This
   * is a promotion, not a demotion: there is no stale privilege to invalidate,
   * the account's next request simply resolves more access than its last one
   * did. Signing someone out to give them MORE access would be theatre.
   */

  revalidatePath('/admin/security/admin-access')
  return ok()
}

/**
 * Empties the backup slot.
 *
 * The reverse of assignment, plus one thing assignment does not need: every
 * session belonging to the removed account is destroyed. Removal is a response
 * to something having changed — a person leaving, or worse — and a version of it
 * that leaves the removed party administering the store until their cookie
 * happens to expire is not a removal at all.
 */
export async function removeBackupAdminAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const owner = await requireOwner()

  const parsed = parseInput(removeSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const throttle = await checkUserRateLimit({
    userId: owner.user.id,
    ...RATE_LIMITS.ownerSensitive,
  })
  if (!throttle.allowed) {
    return fail('rate_limited', rateLimitMessage(throttle.retryAfterMs))
  }

  const reauth = await reauthenticate(owner.user.id, parsed.data.password)
  if (!reauth.ok) {
    return fail('unauthenticated', reauthMessage(reauth.reason), {
      password: ['Confirmation failed'],
    })
  }

  const existing = await getActiveBackupAdmin()
  if (!existing) {
    return fail('not_found', 'There is no backup administrator to remove.')
  }

  await db.transaction(async (tx) => {
    /**
     * Scoped by `revoked_at IS NULL` as well as by id, so a double submission
     * cannot revoke an already-revoked row a second time and overwrite who did
     * it and when.
     */
    await tx
      .update(schema.adminBackup)
      .set(
        withUpdatedAt({
          revokedAt: new Date(),
          revokedBy: owner.user.id,
          reason: parsed.data.reason ?? existing.reason,
        }),
      )
      .where(
        and(
          eq(schema.adminBackup.id, existing.id),
          isNull(schema.adminBackup.revokedAt),
        ),
      )

    /**
     * BACK TO CUSTOMER, NOT DELETED, NOT SUSPENDED.
     *
     * The person is losing administrative access, not their account. They keep
     * their order history, their addresses and their ability to shop — all of
     * which is regulated record-retention data that must survive this operation
     * regardless. Section F's "return the account to customer" is exactly this.
     */
    await tx
      .update(schema.users)
      .set(withUpdatedAt({ role: 'customer' }))
      .where(eq(schema.users.id, existing.userId))

    /**
     * Every session, including any the removed administrator is using right
     * now. `resolveSession` would still authenticate them as a customer on the
     * next request, and `requireAdminIdentity` would refuse them — but relying
     * on that alone would leave a live, previously-privileged session in
     * existence, and there is no reason to.
     */
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, existing.userId))

    await recordAuditEventWithin(tx, {
      event: 'BACKUP_ADMIN_REMOVED',
      userId: owner.user.id,
      sessionId: owner.sessionId,
      entityType: 'user',
      entityId: existing.userId,
      summary: `backup administrator removed: ${existing.email}${
        parsed.data.reason ? ` — ${parsed.data.reason}` : ''
      }`,
    })
  })

  revalidatePath('/admin/security/admin-access')
  return ok()
}

/**
 * Postgres unique-violation detection.
 *
 * Matched on SQLSTATE `23505` rather than on the message text, which is
 * localised and version-dependent. Written defensively because the driver wraps
 * errors and the code can arrive on the error or on its `cause`.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false

  const code = (error as { code?: unknown }).code
  if (code === '23505') return true

  const cause = (error as { cause?: unknown }).cause
  if (typeof cause === 'object' && cause !== null) {
    return (cause as { code?: unknown }).code === '23505'
  }

  return false
}

/**
 * Read model for the owner's security screen.
 *
 * Exported from this module so the page has exactly one import for both reading
 * and writing the slot, and so the `requireOwner()` gate on the read cannot be
 * forgotten by a future caller who only wanted to display something.
 */
export async function getAdminAccessOverview(): Promise<{
  ownerUserId: string | null
  ownerEmail: string | null
  ownerConfigured: boolean
  backup: Awaited<ReturnType<typeof getActiveBackupAdmin>>
}> {
  const identity = await requireOwner()
  const owner = resolveOwnerUserId()

  return {
    ownerUserId: owner.ok ? owner.ownerId : null,
    ownerEmail: identity.user.email,
    ownerConfigured: owner.ok,
    backup: await getActiveBackupAdmin(),
  }
}
