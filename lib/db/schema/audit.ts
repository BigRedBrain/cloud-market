import { index, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'

import { primaryKeyColumn } from './_shared'
import { users } from './auth'

/**
 * Security audit log.
 *
 * Append-only record of security-relevant events. Exists to answer, after the
 * fact: who got in, from where, when did it change, and what was revoked. That
 * is a compliance requirement for a licensed operator, and it is the difference
 * between "we think the account was accessed" and knowing.
 */

export const auditEvent = pgEnum('audit_event', [
  'ACCOUNT_CREATED',
  'LOGIN',
  'LOGOUT',
  'FAILED_LOGIN',
  'ACCOUNT_LOCKED',
  'ACCOUNT_UNLOCKED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'SESSION_REVOKED',
  'ACCOUNT_SUSPENDED',
])

export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryKeyColumn(),

    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    event: auditEvent('event').notNull(),

    /**
     * `set null` rather than `cascade`.
     *
     * Deleting a user must NOT erase the record that they existed and what
     * happened to their account — that would make the log useless in exactly
     * the investigation it exists for. Nullable because a FAILED_LOGIN against
     * an address with no account has no user to point at.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Deliberately NOT a foreign key. Sessions are deleted on logout and
     * revocation, and the audit row has to outlive the thing it describes —
     * a SESSION_REVOKED entry whose session id vanished with the session would
     * be worthless.
     */
    sessionId: uuid('session_id'),

    /**
     * HMAC-SHA256, hex. See `lib/auth/audit.ts` for why these are keyed rather
     * than plain hashes.
     */
    ipHash: varchar('ip_hash', { length: 64 }),
    userAgentHash: varchar('user_agent_hash', { length: 64 }),
  },
  (table) => [
    index('audit_log_user_id_idx').on(table.userId),
    index('audit_log_event_idx').on(table.event),
    index('audit_log_occurred_at_idx').on(table.occurredAt),
  ],
)

export type AuditEvent = (typeof auditEvent.enumValues)[number]
export type AuditLogRow = typeof auditLog.$inferSelect
