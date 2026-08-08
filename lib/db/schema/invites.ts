import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn, timestampColumns } from './_shared'
import { users } from './auth'

/**
 * Invite codes — the only way to create a CloudMarket account.
 *
 * The storefront is private and invite-only, so this table is the registration
 * gate. An invite grants exactly one thing: permission to create a CUSTOMER
 * account. It does not, and cannot, carry a role, a permission, or any other
 * privilege — see `lib/invites/redeem.ts`, where the `role` written at sign-up
 * is the hard-coded literal `'customer'` and is never read from the invite or
 * from anything the browser sent.
 */

export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: primaryKeyColumn(),

    /**
     * HMAC-SHA256 of the normalised code, keyed with the server-only
     * `INVITE_CODE_PEPPER`. Hex, 64 chars.
     *
     * THE RAW CODE IS NEVER STORED, anywhere, in any column — the same rule that
     * applies to session and verification tokens. It exists in plaintext exactly
     * twice: in the response that renders it once to its creator, and in the
     * recipient's hands. A disclosure of this table therefore yields no usable
     * invite.
     *
     * KEYED RATHER THAN A PLAIN HASH. The digest is keyed for the same reason
     * `audit_log.ip_hash` is: a plain SHA-256 is only as strong as the input's
     * entropy, and while 100 bits is far out of brute-force reach today, the
     * pepper means an attacker holding the table alone cannot even begin — they
     * are missing a secret that never went near the database.
     */
    codeHash: varchar('code_hash', { length: 64 }).notNull(),

    /**
     * The leading group of the code — `CM-ABCD` — kept in clear so the admin
     * list can show `CM-ABCD-••••-••••-••••` and an operator can tell two
     * invites apart when someone asks about "the one starting ABCD".
     *
     * Deliberately short. It is 20 bits of the code, which leaves the remaining
     * 80 bits of entropy intact even if this column leaks entirely.
     */
    codePrefix: varchar('code_prefix', { length: 12 }).notNull(),

    /** Operator's note — "Nov flyer", "Jess's referral". Never the code. */
    label: varchar('label', { length: 120 }),

    /**
     * Usage budget. `max_uses` of 1 is a personal invite; higher is a shared
     * campaign code.
     *
     * THERE IS NO STORED `status` COLUMN, ON PURPOSE. The four statuses the
     * admin panel shows — ACTIVE, EXHAUSTED, EXPIRED, DEACTIVATED — are all
     * derivable from these columns, and `lib/invites/status.ts` derives them.
     * A stored status would be a fifth fact that has to be kept in step with
     * the four that actually decide whether redemption succeeds, and the day it
     * drifts is the day an invite reads ACTIVE in the UI while the redemption
     * path refuses it, or worse, the reverse. The authoritative condition lives
     * in exactly one place: the WHERE clause in `redeemInviteCode`.
     */
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),

    /** Null means it never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),

    /**
     * Manual kill switch. Set means the invite is dead regardless of remaining
     * uses; clearing it is not offered, because "un-deactivate" would let a code
     * an operator believed was dead come back to life. The replacement flow
     * issues a NEW code instead.
     */
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true, mode: 'date' }),
    deactivatedBy: uuid('deactivated_by').references(() => users.id, {
      onDelete: 'set null',
    }),

    /**
     * `set null` — deleting the administrator who issued an invite must not
     * delete the invite, and must not delete the record of the accounts created
     * through it.
     */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('invite_codes_code_hash_unique').on(table.codeHash),
    index('invite_codes_created_by_idx').on(table.createdBy),
    index('invite_codes_created_at_idx').on(table.createdAt),

    /**
     * The usage budget, enforced by the database rather than only by the UPDATE
     * that increments it.
     *
     * `redeemInviteCode` already guards this with a conditional UPDATE whose
     * WHERE clause re-checks `use_count < max_uses`, which is what makes
     * concurrent redemption of the final use safe. This CHECK is the backstop
     * for every OTHER path — a future admin screen, a repair script, a
     * migration — because "an invite can never be used more times than it was
     * issued for" is a property of the data, not of one code path.
     */
    check('invite_codes_max_uses_positive', sql`${table.maxUses} >= 1`),
    check(
      'invite_codes_use_count_within_budget',
      sql`${table.useCount} >= 0 and ${table.useCount} <= ${table.maxUses}`,
    ),
  ],
)

/**
 * Who used which invite.
 *
 * Kept separate from `invite_codes.use_count` rather than derived from it: the
 * count is what redemption locks and increments atomically, and this is the
 * evidence of what that count means. Both are written in the same transaction,
 * so they cannot disagree.
 */
export const inviteCodeRedemptions = pgTable(
  'invite_code_redemptions',
  {
    id: primaryKeyColumn(),

    /**
     * `cascade` is deliberately NOT used. An invite is never deleted (deactivation
     * is a timestamp), so this cannot orphan — and `restrict` makes any future
     * attempt to hard-delete an invite that has created real accounts fail loudly
     * rather than quietly erasing the provenance of those accounts.
     */
    inviteCodeId: uuid('invite_code_id')
      .notNull()
      .references(() => inviteCodes.id, { onDelete: 'restrict' }),

    /**
     * `cascade` — if the account is erased, the record that this invite created
     * *that specific account* goes with it. The fact that a redemption happened
     * survives in `use_count` and in `audit_log`, neither of which is affected.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One account is created by one invite, once. Also the last line of defence
     * against a redemption being double-recorded.
     */
    uniqueIndex('invite_code_redemptions_user_unique').on(table.userId),
    index('invite_code_redemptions_invite_idx').on(table.inviteCodeId),
  ],
)

export const inviteCodesRelations = relations(inviteCodes, ({ many, one }) => ({
  redemptions: many(inviteCodeRedemptions),
  creator: one(users, { fields: [inviteCodes.createdBy], references: [users.id] }),
}))

export const inviteCodeRedemptionsRelations = relations(
  inviteCodeRedemptions,
  ({ one }) => ({
    invite: one(inviteCodes, {
      fields: [inviteCodeRedemptions.inviteCodeId],
      references: [inviteCodes.id],
    }),
    user: one(users, {
      fields: [inviteCodeRedemptions.userId],
      references: [users.id],
    }),
  }),
)

export type InviteCode = typeof inviteCodes.$inferSelect
export type NewInviteCode = typeof inviteCodes.$inferInsert
export type InviteCodeRedemption = typeof inviteCodeRedemptions.$inferSelect
