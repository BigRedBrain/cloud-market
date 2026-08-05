import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  type AnyPgColumn,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn, timestampColumns } from './_shared'
import { cannabisClass, measurementBasis, productVariants } from './catalog'
import { stores } from './stores'
import { users } from './auth'

/**
 * Orders — the point where everything stops being reversible.
 *
 * THE DEFINING DECISION, AND IT IS THE EXACT INVERSE OF THE CART'S.
 *
 * `cart_lines` store a variant id and a quantity and nothing else, because a
 * cart line is a POINTER: it means "whatever this costs now". An order line is
 * a RECORD: it means "this is what was sold, at this price, with this potency,
 * on this date". So every commercial and compliance fact is copied here at
 * placement and never read from the catalog again.
 *
 * Both rules follow from one principle — store a fact where it is a fact, and a
 * reference where it is a reference. A renamed product, a repriced variant or a
 * retired SKU must not change what an order says was sold, because that record
 * answers a refund, a receipt, and a regulator.
 *
 * MONEY IS INTEGER CENTS, EVERYWHERE. No floats reach a total. Each tax and fee
 * component is stored separately rather than derived, so a historical order can
 * be reproduced exactly even after the rates change.
 */

/* -------------------------------------------------------------------------- */
/* Enumerations — stable identifiers, never free-form strings                  */
/* -------------------------------------------------------------------------- */

/**
 * `current_status` on `orders` is a PROJECTION of `order_events`, never the
 * source of truth, and it is written in the same transaction as its event.
 */
export const orderStatus = pgEnum('order_status', [
  'draft',
  'placed',
  'preparing',
  'ready',
  'completed',
  'cancelled',
  'expired',
])

/**
 * Stable event types. A free-form string would drift the moment two people
 * spelled the same transition differently, and this table is the audit trail
 * for "who cancelled my order".
 */
export const orderEventType = pgEnum('order_event_type', [
  'DRAFT_CREATED',
  'INVENTORY_RESERVED',
  'INVENTORY_COMMITTED',
  'INVENTORY_RELEASED',
  'ORDER_PLACED',
  'ORDER_PREPARING',
  'ORDER_READY',
  'ORDER_COMPLETED',
  'ORDER_CANCELLED',
  'DRAFT_EXPIRED',
  'PAYMENT_RECORDED',
  'PAYMENT_COLLECTED',
  'AGE_VERIFIED_AT_HANDOFF',
  'COMPLIANCE_BLOCKED',
])

/** Who caused a transition. `system` covers the expiry sweep. */
export const orderActorType = pgEnum('order_actor_type', ['customer', 'staff', 'system'])

/**
 * Pickup only in this phase. The enum has room for delivery so adding it later
 * is a value, not a table rewrite — but nothing implements or exposes it.
 */
export const fulfilmentType = pgEnum('fulfilment_type', ['pickup', 'delivery'])

/**
 * Deliberately provider-neutral.
 *
 * Cannabis is federally illegal and mainstream processors prohibit it, so this
 * phase collects cash at handoff. The shape here is what an ACH provider would
 * need — a method, a processor reference, a failure code — so adding one later
 * is a new row, not a migration. Previous failed attempts survive, which is why
 * this is a table rather than a column on `orders`.
 */
export const paymentMethod = pgEnum('payment_method', ['cash', 'ach', 'debit', 'other'])

export const paymentStatus = pgEnum('payment_status', [
  /** Recorded at placement; nothing has been collected yet. */
  'awaiting_collection',
  'collected',
  'failed',
  'refunded',
  'cancelled',
])


/* -------------------------------------------------------------------------- */
/* Purchase limits — configuration, not constants in checkout code            */
/* -------------------------------------------------------------------------- */

/**
 * Daily purchase limits, as data.
 *
 * Phase 3 refused to invent a per-line cap because a limit is a legal rule with
 * merchandising and licensing weight, not a validation constant. This is where
 * it belongs: one row per class, editable without a deploy, versioned by
 * effective date so a historical order can be checked against the rule that
 * applied when it was placed.
 *
 * THE DEFAULT VALUES ARE A STARTING POINT AND NEED LEGAL CONFIRMATION. Michigan
 * adult-use is commonly stated as 2.5 oz (70.87 g) of usable marijuana per day
 * with no more than 15 g of that as concentrate. Equivalence factors for edibles
 * vary by interpretation, which is exactly why they are configuration.
 *
 * APPEND-ONLY, AND THE DATABASE ENFORCES IT.
 *
 * A row here is the rule an order was checked against. Changing one would
 * silently rewrite the basis of every order that cites it, and deleting one
 * would leave those orders citing nothing. So publishing a change INSERTS a new
 * row and closes the old one; it never updates values in place.
 *
 * Two triggers in migration 0009 make that structural rather than a convention
 * the application is trusted to keep: `purchase_limit_rules_immutable` rejects
 * any UPDATE that touches a value column, and `purchase_limit_rules_no_delete`
 * rejects every DELETE. The only mutations permitted are closing the window
 * (`effective_until`) and recording the successor (`superseded_by_rule_id`),
 * each exactly once, from null.
 *
 * `order_lines.purchase_limit_rule_id` references this table with `restrict`,
 * which is the second lock on the same door.
 */
export const purchaseLimitRules = pgTable(
  'purchase_limit_rules',
  {
    id: primaryKeyColumn(),

    cannabisClass: cannabisClass('cannabis_class').notNull(),

    /**
     * Monotonic per class, starting at 1. Not a surrogate key — it exists so a
     * compliance officer can say "version 3 of the concentrate rule" out loud,
     * and so the history reads as a sequence rather than a pile of timestamps.
     */
    version: integer('version').notNull().default(1),

    /**
     * DEPRECATED — retained only so historical rows remain readable.
     *
     * A single decimal "grams per gram" cannot express the conversions the CRA
     * guidance actually requires. Liquid infused product converts at
     * 28.349523125 / 36 grams per fluid ounce, which is not a terminating
     * decimal: any fixed-scale column stores an approximation, and an
     * approximation in a legal cap is a number that is wrong in a direction
     * nobody chose. Replaced by the exact numerator/denominator pair below.
     *
     * Nullable now. New rows leave it null; old rows keep whatever they had.
     */
    equivalentGramsPerGram: numeric('equivalent_grams_per_gram', {
      precision: 10,
      scale: 4,
    }),

    /**
     * THE CONVERSION, AS AN EXACT RATIO.
     *
     * `usable_equivalent_grams = measurement_value × numerator / denominator`,
     * evaluated in `bigint` rational arithmetic with no rounding until the
     * result is written down. Stored as two integers because that is the only
     * representation in which 28.349523125/36 is exact.
     *
     *   flower           1 / 1                       (grams, 1:1)
     *   concentrate      1 / 1                       (grams, 1:1)
     *   infused_solid    1 / 16                      (16 oz finished = 1 oz usable)
     *   infused_liquid   28349523125 / 36000000000   (36 fl oz = 1 oz usable)
     *   immature_plant   0 / 1                       (counted separately)
     *   non_cannabis     0 / 1                       (explicitly exempt)
     *
     * A zero numerator is legitimate ONLY for the two classes above, and
     * publication is refused for any other class that tries it — a zero
     * conversion on a cannabis class means unlimited sales.
     */
    equivalenceNumerator: numeric('equivalence_numerator', { precision: 30, scale: 0 }),
    equivalenceDenominator: numeric('equivalence_denominator', { precision: 30, scale: 0 }),

    /**
     * The measurement basis this conversion expects.
     *
     * Checked against the variant's basis before any arithmetic happens. A
     * fluid-ounce measurement fed through a mass ratio is off by a factor of
     * more than two and nothing else in the row would disagree with it.
     */
    expectedBasis: measurementBasis('expected_basis'),

    /**
     * THE THREE CAPS, ENFORCED INDEPENDENTLY. A basket must pass every one.
     *
     * Not folded into a single weighted total, deliberately: 15 g of
     * concentrate is inside the 2.5 oz usable ceiling and still illegal, and a
     * combined score cannot express that. Renamed from `daily_*` because adult-
     * use limits apply PER TRANSACTION under the CRA guidance, not over a
     * rolling window — the old name described an enforcement model that was
     * simply wrong.
     */
    /**
     * Scale 11, not 5, so 2.5 oz fits EXACTLY.
     *
     * An ounce is 28.349523125 g, so the cap is 70.87380781250 g. At five
     * decimal places that stores as 70.87381 — two micrograms ABOVE the legal
     * maximum, which is the wrong direction to round a cap, and it also made
     * the seed script non-idempotent because the value it wrote back never
     * matched the value it had written.
     */
    usableEquivalentCapGrams: numeric('usable_equivalent_cap_grams', {
      precision: 18,
      scale: 11,
    }),
    concentrateCapGrams: numeric('concentrate_cap_grams', { precision: 18, scale: 11 }),
    immaturePlantCapUnits: integer('immature_plant_cap_units'),

    /** Legacy names, kept readable for rows published before the reshape. */
    dailyEquivalentGramsCap: numeric('daily_equivalent_grams_cap', {
      precision: 10,
      scale: 3,
    }),
    dailyConcentrateGramsCap: numeric('daily_concentrate_grams_cap', {
      precision: 10,
      scale: 3,
    }),

    /**
     * Identifies the calculation this rule was written for.
     *
     * Bumped when the SHAPE of the arithmetic changes, not when a number does —
     * a number change is a new rule version. Snapshotted onto every order line
     * so a historical check can be reproduced by the code that made it rather
     * than by whatever the code has since become.
     */
    calculationVersion: integer('calculation_version').notNull().default(1),

    /**
     * The window this rule governs: `[effective_from, effective_until)`.
     *
     * Half-open on purpose. A rule that ends at exactly the instant its
     * successor begins leaves no gap and no overlap, so "which rule applied at
     * time T" has exactly one answer for every T.
     *
     * `effective_from` may be in the FUTURE — that is how a change is scheduled
     * for a date counsel has specified. A scheduled rule is not yet in force;
     * `currentlyEffective` compares both ends against database time.
     */
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    effectiveUntil: timestamp('effective_until', { withTimezone: true, mode: 'date' }),

    /* --- Provenance: who changed this, when, and why --------------------- */

    /**
     * Required for anything published through the admin screen. Nullable only
     * because the rows seeded before this table was versioned genuinely have no
     * author — inventing one would be worse than recording the absence.
     */
    changeReason: text('change_reason'),

    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    /**
     * When the publisher last proved their password, at publish time.
     *
     * Stored rather than merely checked, because "an authenticated session made
     * this change" and "the person holding the session re-proved who they were
     * seconds beforehand" are different claims, and only the second one is worth
     * anything when the change is contested months later.
     */
    reauthenticatedAt: timestamp('reauthenticated_at', {
      withTimezone: true,
      mode: 'date',
    }),

    /* --- The chain ------------------------------------------------------- */

    /**
     * Doubly linked, deliberately. `supersedes_rule_id` is written at insert
     * and never changes; `superseded_by_rule_id` is written once when this row
     * is closed. Either direction alone would be reconstructible from
     * timestamps, but only if no two rules for a class ever shared an instant —
     * and a chain that depends on that is a chain that breaks under a clock
     * adjustment.
     *
     * `restrict` on both: a rule cited by another rule cannot be removed, which
     * is a third guard on top of the delete trigger and the order-line FK.
     */
    supersedesRuleId: uuid('supersedes_rule_id').references(
      (): AnyPgColumn => purchaseLimitRules.id,
      { onDelete: 'restrict' },
    ),
    supersededByRuleId: uuid('superseded_by_rule_id').references(
      (): AnyPgColumn => purchaseLimitRules.id,
      { onDelete: 'restrict' },
    ),

    notes: text('notes'),

    ...timestampColumns,
  },
  (table) => [
    /**
     * One OPEN rule per class.
     *
     * Open means `effective_until is null` — the end of the chain, not
     * necessarily the rule in force. Scheduling a future change closes the
     * current rule at the future instant, so the invariant holds continuously
     * while a change is pending.
     */
    uniqueIndex('purchase_limit_rules_active_class')
      .on(table.cannabisClass)
      .where(sql`${table.effectiveUntil} is null`),
    index('purchase_limit_rules_class_idx').on(table.cannabisClass),
    /** History reads chronologically per class. */
    index('purchase_limit_rules_history_idx').on(table.cannabisClass, table.effectiveFrom),
    uniqueIndex('purchase_limit_rules_class_version').on(table.cannabisClass, table.version),
  ],
)

/* -------------------------------------------------------------------------- */
/* Orders                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where inventory currently sits for this order.
 *
 * Tracked ON THE ORDER rather than inferred, because every transition has to be
 * idempotent: a retried release must not return stock twice, and a retried
 * commit must not consume it twice. Each move is a conditional UPDATE keyed on
 * the current value, so exactly one caller can perform it.
 */
export const inventoryState = pgEnum('inventory_state', [
  'reserved',
  'committed',
  'released',
])

export const orders = pgTable(
  'orders',
  {
    id: primaryKeyColumn(),

    /** Short, human-sayable. Support reads it aloud; the UUID is not for people. */
    orderNumber: varchar('order_number', { length: 20 }).notNull(),

    /**
     * `restrict`, NOT cascade. An order must outlive the account that placed it
     * — it is a financial and regulatory record, and deleting a customer must
     * not erase what was sold to them.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    currentStatus: orderStatus('current_status').notNull().default('draft'),
    fulfilmentType: fulfilmentType('fulfilment_type').notNull().default('pickup'),

    inventoryState: inventoryState('inventory_state').notNull().default('reserved'),

    /**
     * DATABASE TIME, not application time. Comparing a client's clock — or an
     * application server's — against a reservation window invites a drifted
     * node to release stock early or hold it late. Every expiry comparison is
     * `now()` inside Postgres.
     */
    reservedUntil: timestamp('reserved_until', { withTimezone: true, mode: 'date' }),

    /**
     * Supplied by the client and unique per user. Two submissions of the same
     * checkout carry the same key, so the second finds the first order instead
     * of creating another.
     */
    idempotencyKey: varchar('idempotency_key', { length: 64 }),

    /* ---- money, all integer cents, all snapshots ---- */
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    exciseTaxCents: integer('excise_tax_cents').notNull().default(0),
    salesTaxCents: integer('sales_tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),

    /** The rates actually applied, so an old order reproduces exactly. */
    exciseTaxRateBps: integer('excise_tax_rate_bps').notNull().default(0),
    salesTaxRateBps: integer('sales_tax_rate_bps').notNull().default(0),

    /* ---- customer snapshot ---- */
    customerEmail: varchar('customer_email', { length: 255 }).notNull(),
    customerName: varchar('customer_name', { length: 120 }),
    customerPhone: varchar('customer_phone', { length: 32 }),

    /* ---- compliance ---- */
    /** The claim on file at placement. NOT verification. */
    dateOfBirthAtPurchase: date('date_of_birth_at_purchase'),
    /**
     * Set only when a staff member confirms government photo ID at handoff.
     * This is the legally load-bearing check; the stored date of birth is a
     * claim the customer typed.
     */
    idVerifiedAt: timestamp('id_verified_at', { withTimezone: true, mode: 'date' }),
    idVerifiedBy: uuid('id_verified_by').references(() => users.id, {
      onDelete: 'set null',
    }),

    /**
     * The three independent totals the check compared against the three caps,
     * snapshotted so the decision can be reproduced without re-deriving it.
     *
     * `total_equivalent_grams` keeps its name and now holds the usable-marijuana
     * equivalent under the 1:1 rules; `total_immature_plants` is new because
     * plants are a count, not a weight, and were previously not represented at
     * all.
     */
    totalEquivalentGrams: numeric('total_equivalent_grams', { precision: 12, scale: 5 }),
    totalConcentrateGrams: numeric('total_concentrate_grams', { precision: 12, scale: 5 }),
    totalImmaturePlants: integer('total_immature_plants').notNull().default(0),

    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),

    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('orders_order_number_unique').on(table.orderNumber),
    /**
     * The idempotency guarantee, enforced by the database rather than by
     * application discipline. A retried placement collides here instead of
     * creating a second order.
     */
    uniqueIndex('orders_user_idempotency_unique')
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    /** One open draft per customer — the same shape as one active cart. */
    uniqueIndex('orders_one_draft_per_user')
      .on(table.userId)
      .where(sql`${table.currentStatus} = 'draft'`),
    index('orders_user_id_idx').on(table.userId),
    index('orders_status_idx').on(table.currentStatus),
    index('orders_placed_at_idx').on(table.placedAt),
    /** Drives the expiry sweep. */
    index('orders_reserved_until_idx').on(table.reservedUntil),
  ],
)

/* -------------------------------------------------------------------------- */
/* Order lines — the record, not the pointer                                   */
/* -------------------------------------------------------------------------- */

export const orderLines = pgTable(
  'order_lines',
  {
    id: primaryKeyColumn(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    /**
     * `restrict`: a variant that has been sold must not vanish. The snapshot
     * below means the order still reads correctly even so, but the link is
     * worth keeping intact for reporting.
     */
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),

    quantity: integer('quantity').notNull(),

    /* ---- commercial snapshot ---- */
    sku: varchar('sku', { length: 64 }).notNull(),
    productName: varchar('product_name', { length: 200 }).notNull(),
    variantLabel: varchar('variant_label', { length: 80 }).notNull(),
    categoryName: varchar('category_name', { length: 120 }),
    brandName: varchar('brand_name', { length: 120 }),
    unitPriceCents: integer('unit_price_cents').notNull(),
    lineSubtotalCents: integer('line_subtotal_cents').notNull(),
    /** Tax allocated to this line. The order's tax is the sum of these. */
    lineExciseTaxCents: integer('line_excise_tax_cents').notNull().default(0),
    lineSalesTaxCents: integer('line_sales_tax_cents').notNull().default(0),
    lineTotalCents: integer('line_total_cents').notNull(),

    /* ---- compliance snapshot ---- */
    cannabisClass: cannabisClass('cannabis_class').notNull().default('other'),
    unitWeightGrams: numeric('unit_weight_grams', { precision: 10, scale: 3 }),
    thcPercent: numeric('thc_percent', { precision: 5, scale: 2 }),
    cbdPercent: numeric('cbd_percent', { precision: 5, scale: 2 }),
    /**
     * The line's contribution to the daily limit, and the factor used to get
     * there. Stored so a check can be reproduced after the rules change.
     */
    equivalentGrams: numeric('equivalent_grams', { precision: 10, scale: 3 })
      .notNull()
      .default('0'),
    concentrateGrams: numeric('concentrate_grams', { precision: 10, scale: 3 })
      .notNull()
      .default('0'),
    equivalentFactorApplied: numeric('equivalent_factor_applied', {
      precision: 10,
      scale: 4,
    }),

    /**
     * WHICH RULE ROW THIS LINE WAS CHECKED AGAINST.
     *
     * The factor above says what arithmetic was done; this says on whose
     * authority. Together they make the check reproducible: the reason the rule
     * had that value, who published it and why is one join away, and it stays
     * correct after the rule is superseded because the id never moves.
     *
     * `restrict` is load-bearing. It is the database refusing to delete a rule
     * that an order depends on, independently of the trigger and independently
     * of anything the application believes. Nullable for lines written before
     * this column existed, and for classes with no rule at all.
     */
    purchaseLimitRuleId: uuid('purchase_limit_rule_id').references(
      () => purchaseLimitRules.id,
      { onDelete: 'restrict' },
    ),

    /* --- the compliance decision, reproducible from the row alone -------- */

    /**
     * What was measured, how much of it, and in what unit — copied from the
     * variant at the moment of the check.
     *
     * Without the basis and the unit, `measurement_value` is a bare number and
     * "4" could be four grams, four fluid ounces or four plants. The three
     * columns together are what makes a historical line re-checkable rather
     * than merely re-readable.
     */
    measurementBasis: measurementBasis('measurement_basis'),
    measurementValue: numeric('measurement_value', { precision: 12, scale: 4 }),
    measurementUnit: varchar('measurement_unit', { length: 16 }),

    /**
     * The line's contribution to each independent cap.
     *
     * `usable_equivalent_grams` is what `concentrate_grams` used to be summed
     * into via a weighted factor; they are now separate figures because the
     * caps are separate. A concentrate line populates both — 10 g of
     * concentrate is 10 g toward the usable ceiling and 10 g toward its own.
     */
    usableEquivalentGrams: numeric('usable_equivalent_grams', {
      precision: 12,
      scale: 5,
    }),
    immaturePlantCount: integer('immature_plant_count').notNull().default(0),

    /**
     * The exact ratio applied, and which calculation applied it.
     *
     * `equivalent_factor_applied` above is a decimal and therefore lossy for
     * the liquid conversion. These two reproduce it exactly.
     */
    equivalenceNumerator: numeric('equivalence_numerator', { precision: 30, scale: 0 }),
    equivalenceDenominator: numeric('equivalence_denominator', { precision: 30, scale: 0 }),
    calculationVersion: integer('calculation_version'),

    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('order_lines_order_variant_unique').on(table.orderId, table.variantId),
    index('order_lines_order_id_idx').on(table.orderId),
    index('order_lines_variant_id_idx').on(table.variantId),
  ],
)

/* -------------------------------------------------------------------------- */
/* Order events — append only                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The history. Never updated, never deleted.
 *
 * `orders.current_status` is a cache of the latest transition, written in the
 * same transaction as the event that caused it. If the two ever disagree, this
 * table wins — it is the one that can answer "who cancelled this, and when".
 */
export const orderEvents = pgTable(
  'order_events',
  {
    id: primaryKeyColumn(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    eventType: orderEventType('event_type').notNull(),
    fromStatus: orderStatus('from_status'),
    toStatus: orderStatus('to_status'),

    actorType: orderActorType('actor_type').notNull(),
    /** Null for `system`, and for a customer action taken without a session. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),

    /** Readable, and free of anything sensitive. */
    reason: varchar('reason', { length: 300 }),

    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('order_events_order_id_idx').on(table.orderId),
    index('order_events_occurred_at_idx').on(table.occurredAt),
    index('order_events_type_idx').on(table.eventType),
  ],
)

/* -------------------------------------------------------------------------- */
/* Payments                                                                    */
/* -------------------------------------------------------------------------- */

export const payments = pgTable(
  'payments',
  {
    id: primaryKeyColumn(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    method: paymentMethod('method').notNull().default('cash'),
    status: paymentStatus('status').notNull().default('awaiting_collection'),
    amountCents: integer('amount_cents').notNull(),

    /** Opaque provider id. Unused for cash; present so ACH needs no migration. */
    processorReference: varchar('processor_reference', { length: 200 }),
    failureCode: varchar('failure_code', { length: 80 }),

    /**
     * Idempotency for collection. A retried "mark collected" finds this already
     * set and changes nothing, rather than recording a second payment.
     */
    collectedAt: timestamp('collected_at', { withTimezone: true, mode: 'date' }),
    collectedBy: uuid('collected_by').references(() => users.id, { onDelete: 'set null' }),

    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    ...timestampColumns,
  },
  (table) => [
    index('payments_order_id_idx').on(table.orderId),
    index('payments_status_idx').on(table.status),
    /**
     * At most ONE payment awaiting collection per order. Failed and refunded
     * attempts accumulate freely — that history is the reason this is a table —
     * but two live obligations for one order is a bug.
     */
    uniqueIndex('payments_one_open_per_order')
      .on(table.orderId)
      .where(sql`${table.status} = 'awaiting_collection'`),
  ],
)

/* -------------------------------------------------------------------------- */
/* Fulfilments                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pickup only in this phase.
 *
 * The delivery columns are deliberately ABSENT rather than present-and-unused.
 * An address column nobody writes is an invitation to write to it, and delivery
 * carries municipal rules, radius checks and driver records that belong to
 * their own phase. `fulfilment_type` is the seam; adding delivery adds columns
 * then, with the rules that make them safe.
 */
export const fulfilments = pgTable(
  'fulfilments',
  {
    id: primaryKeyColumn(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    type: fulfilmentType('type').notNull().default('pickup'),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /** Set at handoff, by the staff member who checked the ID. */
    handedOffAt: timestamp('handed_off_at', { withTimezone: true, mode: 'date' }),
    handedOffBy: uuid('handed_off_by').references(() => users.id, { onDelete: 'set null' }),
    recipientIdChecked: boolean('recipient_id_checked').notNull().default(false),

    ...timestampColumns,
  },
  (table) => [
    uniqueIndex('fulfilments_order_unique').on(table.orderId),
    index('fulfilments_store_id_idx').on(table.storeId),
  ],
)

/* -------------------------------------------------------------------------- */

export const ordersRelations = relations(orders, ({ many, one }) => ({
  lines: many(orderLines),
  events: many(orderEvents),
  payments: many(payments),
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  store: one(stores, { fields: [orders.storeId], references: [stores.id] }),
}))

export const orderLinesRelations = relations(orderLines, ({ one }) => ({
  order: one(orders, { fields: [orderLines.orderId], references: [orders.id] }),
  variant: one(productVariants, {
    fields: [orderLines.variantId],
    references: [productVariants.id],
  }),
}))

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}))

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}))

export const fulfilmentsRelations = relations(fulfilments, ({ one }) => ({
  order: one(orders, { fields: [fulfilments.orderId], references: [orders.id] }),
}))

export type Order = typeof orders.$inferSelect
export type OrderLine = typeof orderLines.$inferSelect
export type OrderEvent = typeof orderEvents.$inferSelect
export type Payment = typeof payments.$inferSelect
export type Fulfilment = typeof fulfilments.$inferSelect
export type PurchaseLimitRule = typeof purchaseLimitRules.$inferSelect
export type OrderStatus = (typeof orderStatus.enumValues)[number]
export type OrderEventType = (typeof orderEventType.enumValues)[number]
export type CannabisClass = (typeof cannabisClass.enumValues)[number]
