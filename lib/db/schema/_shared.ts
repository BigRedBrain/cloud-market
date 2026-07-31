import { sql } from 'drizzle-orm'
import { timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Column primitives shared by every table.
 *
 * Keeping these in one place guarantees that primary keys, auditing columns and
 * money representation stay identical across the schema as it grows through the
 * later phases.
 */

/** Standard surrogate primary key. */
export const primaryKeyColumn = () => uuid('id').primaryKey().defaultRandom()

/**
 * Created/updated auditing columns.
 *
 * `updatedAt` is maintained by the application layer via `withUpdatedAt()` on
 * writes. A database trigger is deliberately avoided so that the behaviour is
 * visible in application code and testable without a live database.
 */
export const timestampColumns = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
}

/**
 * Soft-delete marker. Cannabis operations are record-retention regulated, so
 * rows that represent regulated activity are retired rather than deleted.
 */
export const softDeleteColumns = {
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
}

/** Spread into any `.set()` payload to keep `updated_at` accurate. */
export function withUpdatedAt<T extends Record<string, unknown>>(
  values: T,
): T & { updatedAt: Date } {
  return { ...values, updatedAt: new Date() }
}
