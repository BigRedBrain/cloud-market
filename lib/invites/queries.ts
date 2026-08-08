import 'server-only'

import { desc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { db, schema } from '@/lib/db'
import { requireAdminIdentity } from '@/lib/auth/admin-identity'
import { maskInviteCode } from './codes'
import { inviteStatus, type InviteStatus } from './status'

/**
 * Read model for `/admin/invites`.
 *
 * GUARDED HERE, NOT ONLY IN THE PAGE. Every function in this module calls
 * `requireAdminIdentity()` before it queries, so the authorization travels with
 * the data access rather than sitting in the component that happens to render
 * it today. A future route handler or Server Action that imports these cannot
 * forget the check, because there is no version of them without it.
 *
 * NOTHING HERE CAN RETURN A USABLE CODE. `code_hash` is never selected, and the
 * only code-shaped value that leaves this module is the masked prefix.
 */

export type InviteListRow = {
  id: string
  maskedCode: string
  label: string | null
  status: InviteStatus
  maxUses: number
  useCount: number
  expiresAt: Date | null
  createdAt: Date
  createdByEmail: string | null
  deactivatedAt: Date | null
  lastRedeemedAt: Date | null
}

export async function listInvites(): Promise<InviteListRow[]> {
  await requireAdminIdentity()

  const creator = alias(schema.users, 'creator')

  const rows = await db
    .select({
      id: schema.inviteCodes.id,
      codePrefix: schema.inviteCodes.codePrefix,
      label: schema.inviteCodes.label,
      maxUses: schema.inviteCodes.maxUses,
      useCount: schema.inviteCodes.useCount,
      expiresAt: schema.inviteCodes.expiresAt,
      createdAt: schema.inviteCodes.createdAt,
      deactivatedAt: schema.inviteCodes.deactivatedAt,
      createdByEmail: creator.email,

      /**
       * Correlated subquery rather than a join plus GROUP BY. The list is
       * small, and this keeps the row shape flat — a join would multiply rows
       * by redemption and need collapsing again.
       */
      lastRedeemedAt: sql<Date | null>`(
        select max(r.redeemed_at)
        from invite_code_redemptions r
        where r.invite_code_id = ${schema.inviteCodes.id}
      )`,
    })
    .from(schema.inviteCodes)
    .leftJoin(creator, eq(schema.inviteCodes.createdBy, creator.id))
    .orderBy(desc(schema.inviteCodes.createdAt))
    .limit(200)

  const now = new Date()

  return rows.map((row) => ({
    id: row.id,
    maskedCode: maskInviteCode(row.codePrefix),
    label: row.label,
    status: inviteStatus(
      {
        deactivatedAt: row.deactivatedAt,
        expiresAt: row.expiresAt,
        useCount: row.useCount,
        maxUses: row.maxUses,
      },
      now,
    ),
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    createdByEmail: row.createdByEmail,
    deactivatedAt: row.deactivatedAt,
    lastRedeemedAt: row.lastRedeemedAt ? new Date(row.lastRedeemedAt) : null,
  }))
}

export type InviteRedemptionRow = {
  id: string
  email: string
  name: string | null
  redeemedAt: Date
}

/**
 * Redemption history for one invite.
 *
 * Returns customer email addresses, which is why it is behind the same guard as
 * everything else here. "Who used this code" is a reasonable operational
 * question and also a customer list for a private cannabis storefront.
 */
export async function listInviteRedemptions(
  inviteId: string,
): Promise<InviteRedemptionRow[]> {
  await requireAdminIdentity()

  return db
    .select({
      id: schema.inviteCodeRedemptions.id,
      email: schema.users.email,
      name: schema.users.name,
      redeemedAt: schema.inviteCodeRedemptions.redeemedAt,
    })
    .from(schema.inviteCodeRedemptions)
    .innerJoin(schema.users, eq(schema.inviteCodeRedemptions.userId, schema.users.id))
    .where(eq(schema.inviteCodeRedemptions.inviteCodeId, inviteId))
    .orderBy(desc(schema.inviteCodeRedemptions.redeemedAt))
    .limit(500)
}
