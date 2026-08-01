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
  /* --- Authentication (Phase 1) --------------------------------------- */
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

  /* --- CMS and marketing (Phase 2.5) ----------------------------------- */
  'CAMPAIGN_CREATED',
  'CAMPAIGN_UPDATED',
  'CAMPAIGN_PUBLISHED',
  'CAMPAIGN_ARCHIVED',
  'COLLECTION_CREATED',
  'COLLECTION_UPDATED',
  'COLLECTION_PUBLISHED',
  'BADGE_CREATED',
  'BADGE_UPDATED',
  'PRODUCT_FEATURED',
  'PRODUCT_BADGED',
  'HERO_UPDATED',
  'HOMEPAGE_SECTION_UPDATED',
  'HOMEPAGE_SECTION_PUBLISHED',
  'ANNOUNCEMENT_PUBLISHED',
  'MEDIA_UPLOADED',
  'MEDIA_REPLACED',
  'MEDIA_ARCHIVED',
  'BRAND_ASSET_UPDATED',

  /* --- Bag (Phase 3) ---------------------------------------------------- */
  'CART_MERGED',

  /**
   * --- Account recovery (Phase 3.5) -------------------------------------
   *
   * PRIVACY RULE FOR EVERY EVENT BELOW: no raw token, no reset link, no
   * password, no API key, and no email address ever reaches `summary` or any
   * other column. `PASSWORD_RESET_REQUESTED` in particular is written for
   * addresses that do not exist, with `user_id` NULL and nothing identifying in
   * the row — so the log records that a request happened without becoming the
   * account-enumeration oracle the response itself refuses to be.
   */
  'EMAIL_VERIFICATION_REQUESTED',
  'EMAIL_VERIFIED',
  'EMAIL_VERIFICATION_FAILED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET_COMPLETED',
  'PASSWORD_RESET_FAILED',
  'SESSIONS_REVOKED',
  /** Transport-level delivery failure. Operational, not security. */
  'EMAIL_SEND_FAILED',
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

    /**
     * What the event was about — "campaign", "collection", "media" — and its
     * id. Deliberately NOT a foreign key: the log has to outlive the row it
     * describes, and an ARCHIVED or deleted campaign must not take its own
     * audit history with it. Both nullable, because auth events have no entity.
     */
    entityType: varchar('entity_type', { length: 40 }),
    entityId: uuid('entity_id'),

    /**
     * Small human-readable summary — "Weekend Sale → published". Enough to read
     * the log without joining to a row that may no longer exist.
     */
    summary: varchar('summary', { length: 300 }),
  },
  (table) => [
    index('audit_log_user_id_idx').on(table.userId),
    index('audit_log_event_idx').on(table.event),
    index('audit_log_occurred_at_idx').on(table.occurredAt),
    index('audit_log_entity_idx').on(table.entityType, table.entityId),
  ],
)

export type AuditEvent = (typeof auditEvent.enumValues)[number]
export type AuditLogRow = typeof auditLog.$inferSelect
