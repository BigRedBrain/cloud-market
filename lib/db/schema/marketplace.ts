import { relations } from 'drizzle-orm'
import { pgEnum, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { primaryKeyColumn, timestampColumns } from './_shared'
import { users } from './auth'

/**
 * Private-marketplace access.
 *
 * DELIBERATELY NOT `users.role` OR `users.status`. Those columns describe what
 * an account IS to the storefront — customer, staff, admin; pending, active,
 * suspended — and reusing either for marketplace membership would mean one
 * value carrying two unrelated meanings, with every future change to one
 * silently changing the other. Membership is a separate fact and gets its own
 * row. Nothing in this module reads either column.
 *
 * `shopper` rather than `customer` is intentional, and the vocabulary gap is
 * load-bearing: code that has to say `shopper` cannot reach for `customer` by
 * muscle memory. Do not "fix" the inconsistency.
 *
 * ONE ROW PER USER. `scope = 'vendor'` semantically INCLUDES shopper
 * marketplace access; it is not a second row, and this is not a permission
 * matrix. A shopper who later redeems a vendor invite has this row's `scope`
 * updated — which is exactly what the relaxed redemption uniqueness in
 * `./invites` exists to permit.
 *
 * VENDOR SCOPE DOES NOT AUTHORIZE SELLING. It grants entry to the private
 * marketplace and nothing more. Listing, inventory, pricing and payout rights
 * depend on `vendors` + `vendor_memberships` + compliance, none of which exist
 * yet, and none of which may be inferred from this table.
 *
 * IT ALSO NEVER GRANTS PLATFORM ADMIN. Administrator identity comes from
 * `CLOUDMARKET_OWNER_USER_ID` plus the single live `admin_backup` row, and no
 * value of `scope` can reach either. A vendor is not an administrator.
 *
 * NOT WIRED. Nothing reads this table — no gate, no catalog query, no route.
 *
 * EMPTY ON PURPOSE AFTER THIS MIGRATION, AND THAT IS SAFE ONLY WHILE IT IS
 * UNREAD. No existing account receives a row here, and nobody is locked out,
 * because nothing consults it. That safety ends the moment enforcement is
 * wired. Before private-catalog enforcement is switched on, a separate
 * production-reviewed backfill must identify the explicitly grandfathered
 * accounts and grant them `scope = 'shopper', status = 'active'`. That
 * population MUST NOT be inferred from `users.role` or `users.status`, and
 * enforcement must not be considered until the resulting access population has
 * been inspected and verified.
 */

export const marketplaceScope = pgEnum('marketplace_scope', ['shopper', 'vendor'])

/**
 * Stored rather than derived, which is a deliberate departure from
 * `invite_codes` — that table derives its four statuses from timestamps and
 * argues against a stored status at length.
 *
 * The difference is reversibility. Invite deactivation is terminal, so
 * timestamps derive cleanly. `suspended -> active` is not terminal, and
 * deriving it would mean clearing the very marker that recorded the
 * suspension. History for these transitions belongs in `audit_log`, written by
 * the actions that cause them — which is why no audit values are added for
 * them yet: they arrive with the mutations that emit them, not before.
 */
export const marketplaceAccessStatus = pgEnum('marketplace_access_status', [
  'active',
  'suspended',
  'revoked',
])

export const marketplaceAccess = pgTable(
  'marketplace_access',
  {
    id: primaryKeyColumn(),

    /**
     * `cascade` — an erased account keeps no membership row. That a grant
     * happened survives in `audit_log`, which is unaffected by user deletion.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * No default, on purpose. Every grant must state its intent explicitly;
     * there is no sensible value to assume when a caller forgets to say
     * whether it is admitting a shopper or a vendor.
     */
    scope: marketplaceScope('scope').notNull(),

    status: marketplaceAccessStatus('status').notNull().default('active'),

    ...timestampColumns,
  },
  (table) => [
    /**
     * One membership per account, enforced by the database rather than only by
     * the code that inserts. It is also what makes the shopper -> vendor
     * upgrade an UPDATE instead of an accidental second row.
     *
     * Doubles as the index backing the `user_id` foreign key — Postgres does
     * not create one automatically for a referencing column.
     *
     * THERE IS DELIBERATELY NO INDEX ON `status`. Nothing queries this table
     * yet, so its selectivity cannot be measured, and a plain btree on a
     * three-value column where nearly every row will be `active` costs writes
     * and earns nothing. Add one when a real admin query exists to measure it
     * against.
     */
    uniqueIndex('marketplace_access_user_unique').on(table.userId),
  ],
)

export const marketplaceAccessRelations = relations(marketplaceAccess, ({ one }) => ({
  user: one(users, { fields: [marketplaceAccess.userId], references: [users.id] }),
}))

export type MarketplaceAccess = typeof marketplaceAccess.$inferSelect
export type NewMarketplaceAccess = typeof marketplaceAccess.$inferInsert
export type MarketplaceScope = (typeof marketplaceScope.enumValues)[number]
export type MarketplaceAccessStatus = (typeof marketplaceAccessStatus.enumValues)[number]
