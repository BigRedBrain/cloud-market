import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
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
import { users } from './auth'
import { orders } from './orders'

/**
 * Provider-mediated payments — the crypto architecture (Phase 5).
 *
 * WHY THESE ARE NOT THE EXISTING `payments` TABLE
 *
 * `orders.ts` already defines `payments`, and it is live in production. It means
 * one specific thing: an obligation to collect CASH from a customer at handoff,
 * settled by a staff member pressing a button. It has no provider, no quote, no
 * expiry, and no concept of an amount arriving in instalments from a third party.
 *
 * Reusing it would mean widening a production table that checkout depends on,
 * and overloading a status enum whose values (`awaiting_collection`, `collected`)
 * are meaningless for an on-chain invoice. Neither is worth doing to save a name.
 * So the cash path keeps its table untouched, and provider-mediated payment gets
 * its own — which is also what makes the two independently auditable.
 *
 * WHY THERE IS NO SEPARATE `payment_attempts`
 *
 * Each row here IS an attempt. A customer whose invoice expires and who tries
 * again gets a second `payment_intents` row against the same order, with its own
 * quote, its own expiry and its own provider reference. Folding attempts into
 * the intent would have meant a parent row whose status is a summary of its
 * children — a denormalisation that has to be recomputed and can therefore be
 * wrong. The partial unique index below is what keeps "one LIVE attempt per
 * order" true without it.
 */

/**
 * Provider-neutral by construction.
 *
 * `mock` is not a placeholder that will be deleted — it is the provider the test
 * suite runs against, permanently, so that every edge case in section AG
 * (underpayment, replay, wrong network, late payment) can be exercised
 * deterministically without a live account or a testnet faucet.
 */
export const paymentProvider = pgEnum('payment_provider', ['mock', 'btcpay', 'coinbase_commerce'])

/** How the customer is paying. Separate from the provider that mediates it. */
export const paymentIntentMethod = pgEnum('payment_intent_method', ['crypto'])

/**
 * PAYMENT status, deliberately distinct from ORDER status.
 *
 * An order can be `placed` while its payment is `awaiting_payment`, and can be
 * `cancelled` while its payment is `refunded`. Collapsing the two — which is the
 * tempting shortcut — makes "paid but not yet prepared" and "prepared but not
 * yet paid" unrepresentable, and both happen constantly.
 *
 * `partially_paid` and `overpaid` are first-class rather than error states,
 * because on-chain that is simply what sometimes arrives: a customer sends from
 * an exchange that deducts a withdrawal fee, or rounds up. Silently treating
 * either as `paid` would be a loss; silently treating either as `failed` would
 * be a customer whose money is gone. Both require a human decision, and a state
 * to hold them in while it is made.
 */
export const paymentIntentStatus = pgEnum('payment_intent_status', [
  /** Created locally; the provider has not yet been called. */
  'pending',
  /** Invoice issued, address and quote live, nothing received. */
  'awaiting_payment',
  /** Something arrived, but less than quoted. Needs a decision. */
  'partially_paid',
  /** Settled at or above tolerance. The only state that finalises an order. */
  'paid',
  /** Settled above quote beyond tolerance. Needs a decision (refund the excess). */
  'overpaid',
  /** The quote window closed with nothing sufficient received. */
  'expired',
  /** The provider rejected it, or verification failed. */
  'failed',
  'cancelled',
  'refunded',
])

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: primaryKeyColumn(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    method: paymentIntentMethod('method').notNull().default('crypto'),
    provider: paymentProvider('provider').notNull(),
    status: paymentIntentStatus('status').notNull().default('pending'),

    /**
     * The provider's own id for this invoice. Nullable because the row is
     * written BEFORE the provider is called — so that a provider that responds
     * after our request times out still has a local row to reconcile against,
     * rather than creating an invoice we have no record of.
     */
    providerReference: varchar('provider_reference', { length: 200 }),

    /* ---- fiat side: the authoritative amount owed ---- */

    /**
     * Integer cents, matching every other monetary value in this schema. This is
     * what the customer actually owes; the crypto amount below is a derived
     * quote that expires.
     */
    fiatAmountCents: integer('fiat_amount_cents').notNull(),
    fiatCurrency: varchar('fiat_currency', { length: 3 }).notNull().default('USD'),

    /* ---- crypto side: all nullable, because the quote may not exist yet ---- */

    /**
     * `numeric(38, 18)` — NOT integer cents, and not a float.
     *
     * Eighteen decimal places is what an ETH wei-denominated amount needs, and
     * 38 significant digits covers it with room. A float would reintroduce
     * exactly the rounding error that `lib/money.ts` exists to prevent, on
     * values where a rounding error is a customer's money.
     */
    cryptoCurrency: varchar('crypto_currency', { length: 12 }),
    cryptoNetwork: varchar('crypto_network', { length: 40 }),
    cryptoAmountQuoted: numeric('crypto_amount_quoted', { precision: 38, scale: 18 }),
    cryptoAmountReceived: numeric('crypto_amount_received', { precision: 38, scale: 18 }),

    /** Fiat-per-crypto unit at quote time. Kept for reconciliation, never re-derived. */
    exchangeRate: numeric('exchange_rate', { precision: 38, scale: 18 }),

    /** Where the customer sends funds. Provider-custodied — see AE. */
    paymentAddress: varchar('payment_address', { length: 200 }),

    /* ---- the quote window ---- */

    quoteCreatedAt: timestamp('quote_created_at', { withTimezone: true, mode: 'date' }),

    /**
     * After this, the quoted crypto amount is no longer honoured. Enforced
     * server-side on every status read — a browser holding an expired invoice
     * open must not be able to pay it at yesterday's rate.
     */
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true, mode: 'date' }),

    /* ---- terminal timestamps ---- */

    /**
     * Set exactly once, by the webhook handler, inside the transaction that
     * moves the order. Its presence is the idempotency key for finalisation:
     * a replayed "paid" event finds it already set and does nothing.
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    expiredAt: timestamp('expired_at', { withTimezone: true, mode: 'date' }),

    /** Owner-only operation. See `lib/payments/refunds.ts`. */
    refundedAt: timestamp('refunded_at', { withTimezone: true, mode: 'date' }),
    refundedBy: uuid('refunded_by').references(() => users.id, { onDelete: 'set null' }),

    /** Why it failed, in provider terms. Never a raw provider payload. */
    failureCode: varchar('failure_code', { length: 80 }),

    ...timestampColumns,
  },
  (table) => [
    index('payment_intents_order_idx').on(table.orderId),
    index('payment_intents_status_idx').on(table.status),

    /**
     * Provider references are unique per provider, not globally — two providers
     * may legitimately both issue an invoice numbered `1`. Partial, because the
     * column is null until the provider responds.
     */
    uniqueIndex('payment_intents_provider_reference_unique')
      .on(table.provider, table.providerReference)
      .where(sql`${table.providerReference} is not null`),

    /**
     * AT MOST ONE LIVE ATTEMPT PER ORDER.
     *
     * Without this, a customer double-clicking "Pay with crypto" gets two
     * invoices for one order, pays one, and leaves the other to expire against
     * an order that is already paid — or, worse, pays both. Terminal rows
     * (expired, failed, cancelled, paid, refunded) accumulate freely, which is
     * what makes the retry story work.
     */
    uniqueIndex('payment_intents_one_live_per_order')
      .on(table.orderId)
      .where(
        sql`${table.status} in ('pending', 'awaiting_payment', 'partially_paid')`,
      ),

    check('payment_intents_fiat_amount_positive', sql`${table.fiatAmountCents} > 0`),

    /**
     * A confirmed intent must carry the status that justifies it. This is the
     * database refusing to hold "confirmed_at is set but the status says
     * failed" — a combination that would make the order-finalisation query
     * either double-count or skip, depending which column it trusted.
     */
    check(
      'payment_intents_confirmed_implies_settled',
      sql`${table.confirmedAt} is null or ${table.status} in ('paid', 'overpaid', 'refunded')`,
    ),
  ],
)

/**
 * The webhook ledger — every event a provider has ever sent us.
 *
 * THIS TABLE IS THE IDEMPOTENCY MECHANISM. The handler's first action is to
 * INSERT here; the unique index on (provider, provider_event_id) means a
 * duplicate delivery loses that race and is discarded before it can touch an
 * order. Sending the same legitimate webhook ten times therefore has exactly the
 * same effect as sending it once (AF), and that property is enforced by Postgres
 * rather than by the handler remembering to check.
 *
 * Rows are written for REJECTED events too — bad signature, unknown reference,
 * replayed timestamp. A webhook endpoint under attack looks like a burst of
 * rejections, and an endpoint that only logs successes cannot show that.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: primaryKeyColumn(),

    /**
     * Nullable, and `set null` on delete. An event that arrives for an unknown
     * or already-deleted reference must still be recorded — that is precisely
     * the event worth investigating.
     */
    paymentIntentId: uuid('payment_intent_id').references(() => paymentIntents.id, {
      onDelete: 'set null',
    }),

    provider: paymentProvider('provider').notNull(),

    /** The provider's event id — the deduplication key. */
    providerEventId: varchar('provider_event_id', { length: 200 }).notNull(),

    /** The provider's own event name, unmapped. Free text: it is their vocabulary. */
    eventType: varchar('event_type', { length: 80 }).notNull(),

    /** Did we act on it, and if not, why not. */
    accepted: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    rejectionReason: varchar('rejection_reason', { length: 120 }),

    /**
     * The provider's timestamp, used for replay rejection. Distinct from
     * `receivedAt`: a replayed event has an old signed timestamp and a fresh
     * arrival time, and telling them apart is the whole point.
     */
    providerTimestamp: timestamp('provider_timestamp', { withTimezone: true, mode: 'date' }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    /**
     * The verified payload, for reconciliation and dispute.
     *
     * STORED ONLY AFTER SIGNATURE VERIFICATION PASSES, and scrubbed of provider
     * credentials by the adapter before it gets here. An unverified payload is
     * attacker-controlled data, and persisting it verbatim would make this table
     * a place to park whatever an attacker wanted us to store.
     */
    payload: jsonb('payload'),

    notes: text('notes'),
  },
  (table) => [
    /** The idempotency guarantee. */
    uniqueIndex('payment_events_provider_event_unique').on(
      table.provider,
      table.providerEventId,
    ),
    index('payment_events_intent_idx').on(table.paymentIntentId),
    index('payment_events_received_idx').on(table.receivedAt),
  ],
)

export const paymentIntentsRelations = relations(paymentIntents, ({ one, many }) => ({
  order: one(orders, { fields: [paymentIntents.orderId], references: [orders.id] }),
  events: many(paymentEvents),
}))

export const paymentEventsRelations = relations(paymentEvents, ({ one }) => ({
  intent: one(paymentIntents, {
    fields: [paymentEvents.paymentIntentId],
    references: [paymentIntents.id],
  }),
}))

export type PaymentIntent = typeof paymentIntents.$inferSelect
export type NewPaymentIntent = typeof paymentIntents.$inferInsert
export type PaymentEvent = typeof paymentEvents.$inferSelect
export type PaymentProvider = (typeof paymentProvider.enumValues)[number]
export type PaymentIntentStatus = (typeof paymentIntentStatus.enumValues)[number]
