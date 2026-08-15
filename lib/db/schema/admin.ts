import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn, timestampColumns } from './_shared'
import { users } from './auth'

/**
 * The backup administrator slot.
 *
 * CloudMarket has exactly one permanent administrator — the OWNER, identified by
 * the `CLOUDMARKET_OWNER_USER_ID` environment variable and therefore not
 * representable in, or changeable through, this database at all. This table
 * exists for the ONE optional second administrator, and for nothing else.
 *
 * WHY A SLOT AND NOT A MEMBERSHIP TABLE
 *
 * The obvious design is `admin_members(user_id, granted_at, revoked_at)` — an
 * arbitrary set of administrators, with the application promising to keep it
 * small. That promise is exactly the kind that survives code review and dies
 * quietly eighteen months later to a well-meaning bulk script, a migration, or a
 * second code path nobody remembered. "Maximum two administrators" would then be
 * a convention rather than a fact.
 *
 * So the cardinality is moved into the schema. `slot` is CHECKed to the literal
 * 1, and a partial unique index covers `slot` where `revoked_at IS NULL`. The
 * two together mean Postgres itself can hold at most one live row: a second
 * INSERT does not race, does not depend on isolation level, and does not care
 * which code path issued it — it violates a unique index and fails. Combined
 * with the owner living outside the database entirely, "never a third
 * administrator" is arithmetic rather than a rule someone has to remember.
 *
 * REVOCATION IS A TIMESTAMP, NOT A DELETE, for the same reason it is in
 * `user_permissions`: "who could administer this store between March and July"
 * is a question an auditor asks, and a deleted row cannot answer it. Revoked
 * rows accumulate freely — only the live one is constrained.
 */
export const adminBackup = pgTable(
  'admin_backup',
  {
    id: primaryKeyColumn(),

    /**
     * Always 1. Carries no information; it exists purely to give the partial
     * unique index below a constant column to bite on, which is what reduces
     * the table's live cardinality to one.
     */
    slot: integer('slot').notNull().default(1),

    /**
     * The promoted account.
     *
     * `cascade` — a backup grant describes a live capability of an account, and
     * an orphan row implying a deleted user still holds administrative access
     * would be actively misleading. The history lives in `audit_log`, whose
     * `user_id` is `set null` precisely so it survives the deletion.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Who promoted them. Always the owner — the application refuses any other
     * assigner — but recorded rather than assumed, because an audit that says
     * "the owner did it" because the code could not have done otherwise proves
     * nothing about what actually happened.
     */
    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),

    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),

    /** Why the slot was filled or emptied. Free text, written by the owner. */
    reason: text('reason'),

    ...timestampColumns,
  },
  (table) => [
    /**
     * THE INVARIANT. At most one row may have `revoked_at IS NULL`, because all
     * live rows collide on the same `slot` value.
     */
    uniqueIndex('admin_backup_single_active_slot')
      .on(table.slot)
      .where(sql`${table.revokedAt} is null`),

    /**
     * Belt to the above braces: the same account cannot hold two live grants.
     * Redundant while the slot index holds, and cheap insurance if a future
     * migration ever widens the slot.
     */
    uniqueIndex('admin_backup_active_user_unique')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),

    index('admin_backup_user_idx').on(table.userId),

    /** `slot` is decorative unless it is pinned. Pin it. */
    check('admin_backup_slot_is_one', sql`${table.slot} = 1`),
  ],
)

export const adminBackupRelations = relations(adminBackup, ({ one }) => ({
  user: one(users, { fields: [adminBackup.userId], references: [users.id] }),
}))

export type AdminBackup = typeof adminBackup.$inferSelect
export type NewAdminBackup = typeof adminBackup.$inferInsert
