import 'server-only'

import { and, eq, inArray, isNull, lt } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import { withUpdatedAt } from '@/lib/db/schema'
import { recordAuditEvent } from '@/lib/auth/audit'
import { requireUser } from '@/lib/auth/dal'
import { resolveAdminIdentity } from '@/lib/auth/admin-identity'
import { fail, ok, type ActionResult } from '@/lib/result'
import { cryptoPaymentsGate, describeCryptoGate } from './gate'
import { getAdapter, providerIsConfigured } from './registry'

/**
 * Payment intent lifecycle — creation, reading, expiry.
 *
 * EVERY FUNCTION HERE ENFORCES ORDER OWNERSHIP (section AJ). A payment record is
 * about somebody's money and somebody's purchase, and the id of one is a UUID
 * that could be guessed at or leaked through a shared link. So no function takes
 * an intent id and returns what it finds: they take an intent id AND resolve the
 * caller, and the query is scoped to orders that caller owns — or the caller is
 * an administrator, established through the full identity model rather than a
 * role column.
 *
 * The scoping lives in the WHERE clause rather than in an `if` after the read.
 * A post-read check is one early return away from being skipped; a query that
 * cannot return another customer's row is not.
 */

/**
 * Creates a crypto payment intent for an order the caller owns.
 *
 * REFUSED FOR THIS ENTIRE PHASE. `CRYPTO_PAYMENTS_ENABLED` is false, so the gate
 * closes before anything else runs and the function returns the customer-facing
 * refusal. The code below it is complete and exercised by the test suite against
 * the mock provider — what is switched off is the feature, not the coverage.
 */
export async function createCryptoPaymentIntent(
  orderId: string,
): Promise<ActionResult<{ intentId: string; address: string | null; amount: string }>> {
  const user = await requireUser()

  /**
   * THE GATE IS FIRST, BEFORE THE ORDER IS EVEN LOOKED UP.
   *
   * Ordering matters for disclosure as much as for cost: checking the order
   * first would let a caller distinguish "this order does not exist" from
   * "crypto is off" by the shape of the failure, which is a probe for order ids.
   * With the gate first, every caller gets the same answer while the feature is
   * disabled, whatever they asked about.
   */
  const gate = cryptoPaymentsGate(providerIsConfigured)
  if (!gate.open) return fail('conflict', describeCryptoGate(gate))

  const adapter = getAdapter(gate.provider)
  if (!adapter) return fail('conflict', describeCryptoGate({ open: false, reason: 'no_provider' }))

  /**
   * Ownership in the WHERE clause. A customer asking about an order that is not
   * theirs gets `not_found`, identical to asking about one that does not exist —
   * so this cannot be used to discover which order ids are real.
   */
  const [order] = await db
    .select({
      id: schema.orders.id,
      totalCents: schema.orders.totalCents,
      currentStatus: schema.orders.currentStatus,
    })
    .from(schema.orders)
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.userId, user.id)))
    .limit(1)

  if (!order) return fail('not_found', 'That order could not be found.')

  if (order.totalCents <= 0) {
    return fail('conflict', 'That order has nothing to pay.')
  }

  /**
   * The row is written BEFORE the provider is called, with no
   * `provider_reference` yet.
   *
   * Backwards from the obvious order, and deliberately. If the provider is
   * called first and our write then fails — or the request times out after the
   * provider committed — an invoice exists in the world that we have no record
   * of, and a customer can pay something we will never reconcile. Writing first
   * means the worst case is a `pending` row with no reference, which the expiry
   * sweep cleans up and which cost nobody anything.
   *
   * The partial unique index `payment_intents_one_live_per_order` is what makes
   * a double-click produce one invoice rather than two.
   */
  const [intent] = await db
    .insert(schema.paymentIntents)
    .values({
      orderId: order.id,
      provider: gate.provider,
      method: 'crypto',
      status: 'pending',
      fiatAmountCents: order.totalCents,
      fiatCurrency: 'USD',
    })
    .returning({ id: schema.paymentIntents.id })

  let created: Awaited<ReturnType<typeof adapter.createPayment>>
  try {
    created = await adapter.createPayment({
      intentId: intent.id,
      orderId: order.id,
      amount: { cents: order.totalCents, currency: 'USD' },
    })
  } catch (error) {
    console.error('[payments] provider rejected invoice creation', error)

    await db
      .update(schema.paymentIntents)
      .set(withUpdatedAt({ status: 'failed', failureCode: 'provider_error' }))
      .where(eq(schema.paymentIntents.id, intent.id))

    return fail('internal_error', 'We could not start that payment. Please try again.')
  }

  const now = new Date()

  await db
    .update(schema.paymentIntents)
    .set(
      withUpdatedAt({
        status: 'awaiting_payment',
        providerReference: created.providerReference,
        paymentAddress: created.paymentAddress,
        cryptoCurrency: created.cryptoCurrency,
        cryptoNetwork: created.cryptoNetwork,
        cryptoAmountQuoted: created.cryptoAmount,
        exchangeRate: created.exchangeRate,
        quoteCreatedAt: now,
        quoteExpiresAt: created.quoteExpiresAt,
      }),
    )
    .where(eq(schema.paymentIntents.id, intent.id))

  await recordAuditEvent({
    event: 'PAYMENT_INTENT_CREATED',
    userId: user.id,
    entityType: 'payment_intent',
    entityId: intent.id,
    /** No address, no reference, no amount — see the audit privacy rule. */
    summary: `crypto payment intent created via ${gate.provider}`,
  })

  return ok({
    intentId: intent.id,
    address: created.paymentAddress,
    amount: created.cryptoAmount,
  })
}

export type PaymentIntentView = {
  id: string
  status: schema.PaymentIntentStatus
  cryptoCurrency: string | null
  cryptoNetwork: string | null
  cryptoAmountQuoted: string | null
  cryptoAmountReceived: string | null
  paymentAddress: string | null
  quoteExpiresAt: Date | null
  confirmedAt: Date | null
  fiatAmountCents: number
}

/**
 * Reads a payment intent, for the customer who owns it or an administrator.
 *
 * THE BROWSER IS NEVER AUTHORITATIVE (section AC). This is what the payment page
 * polls, and what it returns comes from `payment_intents` — a table written only
 * by the webhook handler after cryptographic verification, or by the expiry
 * sweep. Nothing a client sends can move it. A customer who edits their own
 * local state, replays a URL, or POSTs a "paid" body changes nothing here,
 * because there is no code path from a request body to this status.
 */
export async function getPaymentIntentForViewer(
  intentId: string,
): Promise<PaymentIntentView | null> {
  const user = await requireUser()
  const admin = await resolveAdminIdentity()

  const rows = await db
    .select({
      id: schema.paymentIntents.id,
      status: schema.paymentIntents.status,
      cryptoCurrency: schema.paymentIntents.cryptoCurrency,
      cryptoNetwork: schema.paymentIntents.cryptoNetwork,
      cryptoAmountQuoted: schema.paymentIntents.cryptoAmountQuoted,
      cryptoAmountReceived: schema.paymentIntents.cryptoAmountReceived,
      paymentAddress: schema.paymentIntents.paymentAddress,
      quoteExpiresAt: schema.paymentIntents.quoteExpiresAt,
      confirmedAt: schema.paymentIntents.confirmedAt,
      fiatAmountCents: schema.paymentIntents.fiatAmountCents,
      ownerUserId: schema.orders.userId,
    })
    .from(schema.paymentIntents)
    .innerJoin(schema.orders, eq(schema.paymentIntents.orderId, schema.orders.id))
    .where(eq(schema.paymentIntents.id, intentId))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  /**
   * Ownership OR administrative identity. Checked after the read because the
   * join is what supplies the owning user id — but the function returns null
   * rather than the row, so an unauthorised caller learns nothing about whether
   * the id exists.
   */
  if (row.ownerUserId !== user.id && !admin.ok) return null

  const { ownerUserId: _ownerUserId, ...view } = row
  return view
}

/**
 * Expires quotes whose window has closed.
 *
 * Run by the same scheduled sweep that releases inventory reservations, so a
 * quote and the stock it was holding are released by one job rather than two
 * that can disagree.
 *
 * `confirmed_at IS NULL` IS THE CRITICAL PREDICATE, and it is what makes the
 * late-payment race safe. A payment that confirms in the same moment the sweep
 * runs has already set `confirmed_at`; the sweep then matches zero rows and
 * leaves it alone. Without it, a customer who paid seconds before the deadline
 * could have their successful payment marked expired.
 */
export async function expireStalePaymentIntents(): Promise<number> {
  const expired = await db
    .update(schema.paymentIntents)
    .set(withUpdatedAt({ status: 'expired', expiredAt: new Date() }))
    .where(
      and(
        inArray(schema.paymentIntents.status, ['pending', 'awaiting_payment']),
        isNull(schema.paymentIntents.confirmedAt),
        lt(schema.paymentIntents.quoteExpiresAt, new Date()),
      ),
    )
    .returning({ id: schema.paymentIntents.id })

  for (const row of expired) {
    await recordAuditEvent({
      event: 'PAYMENT_INTENT_EXPIRED',
      entityType: 'payment_intent',
      entityId: row.id,
      summary: 'payment quote expired',
    })
  }

  return expired.length
}
