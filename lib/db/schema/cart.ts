import { relations, sql } from 'drizzle-orm'
import {
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
import { productVariants } from './catalog'
import { users } from './auth'

/**
 * Shopping bag.
 *
 * THE DEFINING DECISION — there is no price column here.
 *
 * A cart line stores a variant id and a quantity, and nothing else. Price is
 * re-read from `product_variants` on every render and every mutation, so the
 * bag always shows what the item costs *now*. A `price_cents` column on the
 * line would be a snapshot, and a snapshot is a promise: it says "this is what
 * you will pay". The bag is not entitled to make that promise — only the order
 * is. Snapshots belong at the checkout boundary, where they are written once,
 * immutably, alongside the payment intent.
 *
 * The practical consequence is that a price change is a *display* concern here,
 * not a data-integrity one. There is no reconciliation, no stale-price
 * detection, and no way for a client to influence the total: the client never
 * sends a price, so there is nothing to tamper with.
 *
 * INVENTORY IS VALIDATED, NEVER RESERVED. Quantity is capped at what is
 * available at the moment of the write, but holding a variant in a bag reserves
 * nothing. Two customers can each hold the last unit. That is deliberate for
 * this phase and is surfaced honestly in the UI rather than hidden behind a
 * reassuring "reserved for you" that the schema cannot back.
 *
 * LIFECYCLE IS ON THE CART, NOT INFERRED FROM ITS LINES. Four columns carry it:
 *
 *   `status`           — where the cart is in its life (see `cartStatus`).
 *   `created_at`       — when it came into existence.
 *   `updated_at`       — when the row itself last changed.
 *   `last_activity_at` — when the customer last did something to it.
 *
 * `last_activity_at` exists specifically so that a future cleanup job never has
 * to reason about `max(cart_lines.updated_at)`. That inference breaks in the
 * exact case cleanup cares about: a cart emptied to zero lines has no line
 * timestamps at all, and would look either brand new or infinitely old
 * depending on how the query handles the null. An indexed column on the cart
 * answers "abandoned since when" directly, for a cart with lines and a cart
 * without.
 *
 * No cleanup job exists yet, and none is implied. These columns make one
 * writable later as a query rather than a migration.
 */

/**
 * `active`   — the customer's live bag. At most one per owner.
 * `merged`   — a guest bag folded into a customer bag; retained, not deleted,
 *              so the merge is idempotent and auditable.
 * `converted`— reserved for the future order boundary. Unused this phase.
 * `abandoned`— reserved for future recovery campaigns. Unused this phase.
 */
export const cartStatus = pgEnum('cart_status', [
  'active',
  'merged',
  'converted',
  'abandoned',
])

export const carts = pgTable(
  'carts',
  {
    id: primaryKeyColumn(),

    /**
     * Guest identity. SHA-256 of an opaque 256-bit token that lives only in the
     * visitor's cookie.
     *
     * Hashed at rest for the same reason session tokens are: a database
     * disclosure must not hand over other people's bags. And because the token
     * is random rather than derived, cart ids are never guessable or
     * enumerable — the primary key is a UUID and is never exposed to a client.
     *
     * Null once the bag belongs to a signed-in customer.
     */
    guestTokenHash: varchar('guest_token_hash', { length: 64 }),

    /**
     * Owner. Null for a guest bag.
     *
     * `cascade`: deleting a user removes their bag. A bag holds intent, not
     * history — the order record is what must survive, and that lives elsewhere.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

    status: cartStatus('status').notNull().default('active'),

    /**
     * Set when this bag was merged into another. Makes the merge idempotent:
     * a retried request sees the pointer already set and does nothing, so
     * quantities cannot double.
     */
    mergedIntoCartId: uuid('merged_into_cart_id'),
    mergedAt: timestamp('merged_at', { withTimezone: true, mode: 'date' }),

    /**
     * Touched on every mutation. Drives guest-bag expiry and, later, abandoned
     * cart recovery — which needs no schema change, only a query.
     */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('carts_guest_token_hash_unique').on(table.guestTokenHash),
    /**
     * At most ONE active bag per customer, enforced by the database rather than
     * by application discipline. This is the invariant the merge depends on:
     * without it a race could leave a customer with two active bags and no
     * defined answer for which one is theirs.
     */
    uniqueIndex('carts_one_active_per_user')
      .on(table.userId)
      .where(sql`${table.status} = 'active' and ${table.userId} is not null`),
    index('carts_user_id_idx').on(table.userId),
    index('carts_status_idx').on(table.status),
    index('carts_last_activity_idx').on(table.lastActivityAt),
  ],
)

export const cartLines = pgTable(
  'cart_lines',
  {
    id: primaryKeyColumn(),

    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),

    /**
     * Lines reference a VARIANT, never a product. The variant is the
     * purchasable unit — it carries the SKU, the price and the stock. A line
     * pointing at a product could not express "3.5g" versus "28g".
     *
     * `restrict`: a variant that is in someone's bag must not vanish from under
     * them. Retiring a variant is a soft delete, which the read layer handles.
     */
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),

    /**
     * Positive integer. Zero is not a quantity — removing an item deletes the
     * line, so a zero row can never linger and silently render as an empty
     * entry. Enforced by a check constraint in the migration.
     */
    quantity: integer('quantity').notNull(),

    ...timestampColumns,
  },
  (table) => [
    /**
     * One line per variant per bag. Adding a variant already present increments
     * the existing line instead of creating a second one, and the database
     * guarantees it — so two concurrent adds cannot produce duplicate lines.
     */
    uniqueIndex('cart_lines_cart_variant_unique').on(table.cartId, table.variantId),
    index('cart_lines_cart_id_idx').on(table.cartId),
    index('cart_lines_variant_id_idx').on(table.variantId),
  ],
)

export const cartsRelations = relations(carts, ({ many, one }) => ({
  lines: many(cartLines),
  user: one(users, { fields: [carts.userId], references: [users.id] }),
}))

export const cartLinesRelations = relations(cartLines, ({ one }) => ({
  cart: one(carts, { fields: [cartLines.cartId], references: [carts.id] }),
  variant: one(productVariants, {
    fields: [cartLines.variantId],
    references: [productVariants.id],
  }),
}))

export type Cart = typeof carts.$inferSelect
export type CartLine = typeof cartLines.$inferSelect
export type CartStatus = (typeof cartStatus.enumValues)[number]
