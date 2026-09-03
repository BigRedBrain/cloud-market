import { relations, sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'

import { primaryKeyColumn, timestampColumns } from './_shared'
import { users } from './auth'

/**
 * Customer notifications.
 *
 * ONE ROW IS ONE MESSAGE TO ONE ACCOUNT. `user_id` is the only thing that says
 * who may see it, and it is NOT NULL for that reason: a notification with no
 * owner is a notification with no reader, and there is no "broadcast" row here
 * that a query would have to special-case into everyone's list. Fan-out, when
 * something needs it, writes one row per recipient.
 *
 * READ STATE IS A TIMESTAMP, NOT A BOOLEAN. `read_at` answers "unread?" as
 * `read_at is null` and also answers "when", which a boolean throws away for no
 * saving. It has NO DEFAULT on purpose — a default of `now()` would mark every
 * notification read at the moment it was created, which is the exact opposite of
 * what an insert means.
 *
 * IDEMPOTENT MARKING IS THE APPLICATION'S JOB, AND THE COLUMN SUPPORTS IT. A
 * mark-read update writes `coalesce(read_at, now())`, so marking an
 * already-read notification again is a no-op on the value rather than a silent
 * rewrite of when the customer actually read it. Nothing here enforces that;
 * it is stated so the column's nullability is not later "tidied up".
 *
 * NO SOFT DELETE. Unlike the regulated tables, a notification is not a record of
 * regulated activity — it is a message about one. Retiring it would leave rows
 * that every query has to remember to exclude, and forgetting once shows a
 * customer something that was supposed to be gone. Deletion is deletion.
 *
 * NO ENUM. A `type`/`category` column is deliberately absent: there is no second
 * reader of it yet, and a Postgres enum is a type whose values cannot be removed.
 * The kind of thing a notification is can be added when something actually
 * branches on it.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryKeyColumn(),

    /**
     * `cascade` — an erased account keeps no notifications. There is nothing in
     * a notification that survives its recipient: it is a copy of something the
     * account was told, and the underlying facts (orders, audit entries) live in
     * their own tables and are unaffected by this one.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Bounded because it is rendered in a list row, not a page. */
    title: varchar('title', { length: 200 }).notNull(),

    /**
     * Optional detail. NULL and the empty string are not the same thing here:
     * NULL means "the title is the whole message", which is a shape the UI
     * renders differently, so the column is nullable rather than
     * `NOT NULL DEFAULT ''`.
     */
    body: text('body'),

    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),

    ...timestampColumns,
  },
  (table) => [
    /**
     * The list query, exactly: one customer's notifications, newest first. The
     * leading `user_id` is also what backs the foreign key — Postgres does not
     * index a referencing column automatically — so this one index serves both
     * the read path and cascading deletes.
     *
     * Stored ascending. A btree scans backwards at the same cost, so a separate
     * DESC index would earn nothing and cost every write.
     */
    index('notifications_user_created_idx').on(table.userId, table.createdAt),

    /**
     * The bell count, and nothing else.
     *
     * PARTIAL ON PURPOSE. The unread rows are the small, hot minority: once a
     * customer has read a notification it never re-enters this index, so the
     * index stays proportional to what is actually unread rather than to
     * everything the account has ever been sent. A full index on `user_id`
     * would have to be maintained for every read row forever to answer a
     * question none of them can be part of the answer to.
     */
    index('notifications_user_unread_idx')
      .on(table.userId)
      .where(sql`${table.readAt} is null`),
  ],
)

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}))

export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
