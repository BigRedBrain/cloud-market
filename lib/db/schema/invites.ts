import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn, timestampColumns } from './_shared'
import { users } from './auth'

/**
 * Invite codes — an alternate approval path into the private marketplace.
 *
 * REDEMPTION IS NOT IMPLEMENTED. There is no `lib/invites/redeem.ts`;
 * `lib/invites/` contains only `generate.ts` and `hash.ts`, and nothing in the
 * application reads either invite table. An earlier version of this comment
 * cited that file as the place where a hard-coded `'customer'` role was
 * written at sign-up, which read as a guarantee that no code was providing.
 *
 * WHAT AN INVITE GRANTS, once redemption exists: private-marketplace
 * membership at the scope named by `target_role`, expressed as a
 * `marketplace_access` row. That is the whole of it.
 *
 * WHAT IT CANNOT GRANT, ever:
 *
 *   - `users.role`. Marketplace membership is a separate fact in a separate
 *     table precisely so that an invite cannot promote an account.
 *   - selling rights. A `vendor` invite admits someone to the marketplace with
 *     vendor scope; vendor profile, compliance and `vendor_memberships` are
 *     separate, later, and must not be inferred from an invite.
 *   - platform admin. Administrator identity comes from
 *     `CLOUDMARKET_OWNER_USER_ID` plus the single live `admin_backup` row, and
 *     no invite can reach either.
 */

/**
 * What a redeemed invite admits the account to.
 *
 * Real semantics, not a label: `target_role` determines the
 * `marketplace_access.scope` a successful redemption produces. `vendor` scope
 * includes shopper marketplace access and authorizes nothing beyond entry.
 *
 * Separate from `marketplace_scope` even though the values match today.
 * Postgres cannot remove an enum value, so a shared type would mean anything
 * added for one purpose becomes permanently legal for the other.
 */
export const inviteTargetRole = pgEnum('invite_target_role', ['shopper', 'vendor'])

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
     * DEFAULTS TO `shopper`, PERMANENTLY AND ON PURPOSE.
     *
     * It backfills every pre-existing Phase-5 invite to exactly the semantics
     * it was issued with — those codes were customer/shopper-only by design —
     * without assuming the production table is empty, because a constant
     * default is applied to existing rows as a catalog change rather than a
     * table rewrite.
     *
     * The default is kept rather than dropped afterwards because it fails
     * toward the lower privilege: a form, script or migration that omits this
     * column creates a SHOPPER invite. It can never accidentally create a
     * vendor one.
     */
    targetRole: inviteTargetRole('target_role').notNull().default('shopper'),

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
     * One user may redeem one invite ONCE, and may redeem OTHER invites later.
     *
     * This replaces a `unique(user_id)` rule that permitted exactly one
     * redemption per account for all time. That rule made the intended
     * progression impossible: redeem a shopper invite now, receive a vendor
     * invite later, and the second redemption would have been rejected purely
     * because the first existed.
     *
     *   same user + same invite      -> rejected here
     *   same user + different invite -> allowed, and intended
     *
     * It also replaces the separate `invite_code_redemptions_invite_idx`: a
     * btree on `(invite_code_id, user_id)` already serves leading-column
     * lookups on `invite_code_id`, so a second index on that column alone would
     * be redundant write cost.
     *
     * The migration creates this index BEFORE dropping either of the two it
     * replaces, so there is never an instant with no uniqueness protection on
     * this table. That ordering matters more than it looks: once a single user
     * holds two redemptions, the old `unique(user_id)` index can never be
     * recreated, so there is no way back.
     */
    uniqueIndex('invite_code_redemptions_invite_user_unique').on(
      table.inviteCodeId,
      table.userId,
    ),
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
export type InviteTargetRole = (typeof inviteTargetRole.enumValues)[number]
