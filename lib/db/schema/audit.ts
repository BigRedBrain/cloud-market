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

  /* --- Checkout and orders (Phase 4) ------------------------------------
   *
   * The operational history of an order lives in `order_events`. These are
   * the SECURITY and COMPLIANCE record: who was blocked by a purchase limit,
   * whose ID was checked, whose money was taken. Same privacy rule as every
   * event above — no address, no payment reference, no personal detail in
   * summaries.
   */
  'ORDER_PLACED',
  'ORDER_CANCELLED',
  'ORDER_COMPLETED',
  'PAYMENT_RECORDED',
  'PAYMENT_COLLECTED',
  'INVENTORY_RESERVED',
  'INVENTORY_COMMITTED',
  'INVENTORY_RELEASED',
  'PURCHASE_LIMIT_BLOCKED',
  'AGE_VERIFIED_AT_HANDOFF',

  /* --- Compliance administration (Phase 4.1) ---------------------------
   *
   * Publishing a purchase limit changes the legal cap the storefront
   * enforces. It is the highest-consequence write a human can make in this
   * application, and every attempt at it — successful or not — leaves a row.
   *
   * A blocked attempt matters as much as a successful one: repeated
   * re-authentication failures against this permission are what an intrusion
   * looks like from the outside.
   */
  'PERMISSION_GRANTED',
  'PERMISSION_REVOKED',
  'COMPLIANCE_REAUTH_SUCCEEDED',
  'COMPLIANCE_REAUTH_FAILED',
  'PURCHASE_LIMIT_RULE_PUBLISHED',
  'PURCHASE_LIMIT_RULE_SUPERSEDED',
  'PURCHASE_LIMIT_RULE_REJECTED',

  /* --- Catalog compliance (Phase 4.4) -----------------------------------
   *
   * Classifying a variant decides which legal cap it counts against, so a
   * change here moves the same numbers a rule change does — just from the
   * other direction. The summary carries the BEFORE and AFTER values and the
   * operator's stated reason, so the log answers "what did it used to be"
   * without a separate history table.
   *
   * Written inside the same transaction as the catalog write. A failed audit
   * rolls the classification back.
   */
  'CATALOG_COMPLIANCE_CHANGED',
  'CATALOG_COMPLIANCE_REJECTED',
  'CHECKOUT_BLOCKED_BY_GATE',

  /* --- Administrative identity (Phase 5) --------------------------------
   *
   * There are at most two administrators, and one of them cannot be changed
   * through the application at all. That makes filling or emptying the single
   * backup slot the highest-privilege write in the system — it is the only way
   * the set of people who can administer this store ever changes.
   *
   * DENIED attempts are recorded as loudly as successful ones. An
   * `ADMIN_ACCESS_DENIED` burst against /admin/security is what an attempted
   * privilege escalation looks like from the outside, and a log that only
   * records successes would show nothing at all during one.
   */
  'BACKUP_ADMIN_ASSIGNED',
  'BACKUP_ADMIN_REMOVED',
  'ADMIN_ACCESS_DENIED',
  'OWNER_IDENTITY_MISCONFIGURED',

  /* --- Invites (Phase 5) -------------------------------------------------
   *
   * PRIVACY RULE: the raw code never appears in `summary` or any other column,
   * on any of these events. The masked prefix (`CM-ABCD-••••`) is what gets
   * written, which is enough to identify which invite an entry is about without
   * the log becoming a place to harvest working invites.
   */
  'INVITE_CREATED',
  'INVITE_DEACTIVATED',
  'INVITE_REDEEMED',
  'INVITE_REDEMPTION_FAILED',

  /* --- Payments (Phase 5) ------------------------------------------------
   *
   * Configuration and refunds are owner-only, and both are audited with the
   * reason the operator gave. Webhook rejections are audited because a run of
   * them is either a provider misconfiguration or someone forging callbacks,
   * and both need to be visible.
   */
  'PAYMENT_INTENT_CREATED',
  'PAYMENT_INTENT_CONFIRMED',
  'PAYMENT_INTENT_EXPIRED',
  'PAYMENT_INTENT_FAILED',
  'PAYMENT_WEBHOOK_REJECTED',
  'PAYMENT_REFUND_REQUESTED',
  'PAYMENT_REFUND_COMPLETED',
  'PAYMENT_CONFIG_CHANGED',
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
