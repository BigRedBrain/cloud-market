import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

import { primaryKeyColumn } from './_shared'
import { users } from './auth'

/**
 * Named permissions, granted per user, separate from `users.role`.
 *
 * WHY NOT A FOURTH ROLE
 *
 * `role` is a single enum value, so "compliance admin" as a role would force a
 * choice between administering the catalog and administering the legal caps.
 * Those are different jobs held by different people: the person who signs off a
 * purchase limit is answering to the state, not merchandising the shop.
 *
 * WHY NOT A COLUMN ON `users`
 *
 * A boolean records that someone has the permission. It does not record who
 * granted it, when, or when it was taken away — and for a permission whose
 * whole purpose is to gate a regulated decision, the grant itself is part of
 * the evidence. A revoked grant stays as a row with `revoked_at` set.
 *
 * DELIBERATELY INDEPENDENT OF `admin`
 *
 * Holding `admin` does not confer `compliance_admin`. An administrator who has
 * not been explicitly granted it gets a 403 from the purchase-limit screens,
 * which is the point: the set of people who can change a legal cap is a list
 * someone signed, not a side effect of having a broad role.
 */

export const adminPermission = pgEnum('admin_permission', [
  /**
   * Publish purchase limit rules — the daily caps enforced at checkout.
   *
   * The only permission so far. It exists as an enum rather than free text for
   * the same reason order events do: a permission checked by string comparison
   * is a permission that can be granted by typo.
   */
  'compliance_admin',

  /**
   * Classify product variants for compliance — what an item physically is, and
   * how it is measured.
   *
   * SEPARATE FROM `compliance_admin` ON PURPOSE. That permission publishes the
   * legal caps; this one decides which cap a product falls under. They are
   * different jobs held by different people — the officer who signs off a limit
   * is not usually the person handling the shelf — and combining them would
   * mean anyone who could classify a product could also change the rule it is
   * measured against.
   *
   * Also NOT implicit in `admin`. An administrator without this grant is
   * refused, exactly like a customer.
   */
  'catalog_compliance_admin',
])

export const userPermissions = pgTable(
  'user_permissions',
  {
    id: primaryKeyColumn(),

    /**
     * `cascade`, unlike most references in this schema.
     *
     * A grant describes a live capability of an account. If the account is
     * gone the capability is meaningless, and keeping an orphan row implying
     * someone still holds compliance authority would be actively misleading.
     * The HISTORY of the grant does not live here — it lives in `audit_log`,
     * whose `user_id` is `set null` precisely so it survives the deletion.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    permission: adminPermission('permission').notNull(),

    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    /** Null when granted out-of-band, by the bootstrap script. */
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Revocation is a timestamp, not a delete. "This person could publish
     * limits between March and July" is a question an auditor asks, and a
     * deleted row cannot answer it.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),

    /** Why it was granted. Free text, written by whoever authorised it. */
    reason: text('reason'),
  },
  (table) => [
    /**
     * One LIVE grant per user per permission. Revoked rows accumulate freely,
     * so the same permission can be granted, revoked and granted again without
     * losing either episode.
     */
    uniqueIndex('user_permissions_active_unique')
      .on(table.userId, table.permission)
      .where(sql`${table.revokedAt} is null`),
    index('user_permissions_user_idx').on(table.userId),
  ],
)

export type AdminPermission = (typeof adminPermission.enumValues)[number]
export type UserPermission = typeof userPermissions.$inferSelect
