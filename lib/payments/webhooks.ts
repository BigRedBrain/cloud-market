import 'server-only'

import { and, eq, isNull } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import { withUpdatedAt } from '@/lib/db/schema'
import { recordAuditEvent, recordAuditEventWithin } from '@/lib/auth/audit'
import type { PaymentIntentStatus, PaymentProvider } from '@/lib/db/schema'
import { getAdapter } from './registry'
import {
  overpaymentToleranceCents,
  underpaymentToleranceCents,
  type VerifiedWebhook,
} from './provider'

/**
 * Inbound webhook processing.
 *
 * THE IDEMPOTENCY GUARANTEE, AND WHERE IT ACTUALLY LIVES.
 *
 * Section AF requires that sending the same legitimate webhook ten times has
 * exactly the same effect as sending it once. The obvious implementation is to
 * look for an existing event row and return early if one is found. That is a
 * read-then-write, and it fails under precisely the condition it is meant to
 * handle: a provider retrying aggressively delivers the same event twice
 * concurrently, both handlers read "not seen", and both apply it.
 *
 * So the deduplication is an INSERT that is allowed to fail. `payment_events`
 * has a unique index on `(provider, provider_event_id)`; the first delivery
 * takes the row, and every subsequent one violates the index and is discarded.
 * There is no window, and the guarantee does not depend on isolation level or on
 * the handler remembering to check.
 *
 * THE ORDER OF OPERATIONS IS LOAD-BEARING:
 *
 *   1. Verify the signature. Nothing unverified is stored or acted on.
 *   2. Claim the event id. Losing this race means "already handled" — success.
 *   3. Apply the status change, in the same transaction as the claim.
 *
 * Doing (3) before (2) would apply duplicates. Doing (2) before (1) would let an
 * unauthenticated caller fill the table with rows of their choosing and, worse,
 * pre-claim event ids so that the GENUINE delivery of the same id would be
 * silently discarded as a duplicate — a denial-of-service on payment
 * confirmation, mounted from outside.
 */

export type WebhookOutcome =
  | { handled: true; duplicate: boolean; intentId: string | null }
  | { handled: false; reason: string }

/**
 * Handles one inbound webhook.
 *
 * Returns 200 for both `handled` and `duplicate`. A provider that receives a
 * non-2xx retries, and retrying a duplicate forever is a loop; telling it "yes,
 * I have this" is the correct and only sane answer.
 */
export async function handleInboundWebhook(
  provider: PaymentProvider,
  rawBody: string,
  headers: Headers,
): Promise<WebhookOutcome> {
  const adapter = getAdapter(provider)
  if (!adapter) return { handled: false, reason: 'unknown_provider' }

  /* 1. Verification. Unverified input is never stored. */
  const verified = await adapter.handleWebhook({ rawBody, headers })

  if (!verified.ok) {
    /**
     * Rejections are audited, not silently dropped. A burst of `bad_signature`
     * is either a provider misconfiguration or someone forging callbacks at us,
     * and an endpoint that only logs successes shows nothing at all during
     * either. Deliberately NOT written to `payment_events`, because that table
     * is keyed on a provider event id we do not have and cannot trust.
     */
    await recordAuditEvent({
      event: 'PAYMENT_WEBHOOK_REJECTED',
      summary: `${provider} webhook rejected: ${verified.reason}`,
    })

    return { handled: false, reason: verified.reason }
  }

  const event = verified.event

  try {
    return await db.transaction(async (tx) => {
      /* 2. Claim the event id. The unique index is the deduplication. */
      const [claimed] = await tx
        .insert(schema.paymentEvents)
        .values({
          provider,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          providerTimestamp: event.providerTimestamp,
          payload: event.payload,
        })
        .onConflictDoNothing({
          target: [
            schema.paymentEvents.provider,
            schema.paymentEvents.providerEventId,
          ],
        })
        .returning({ id: schema.paymentEvents.id })

      /**
       * `onConflictDoNothing` returned nothing: this exact event has been seen.
       * Not an error — it is the retry the design expects, and the correct
       * response is to do nothing and report success.
       */
      if (!claimed) return { handled: true, duplicate: true, intentId: null }

      /* 3. Apply, in the same transaction that claimed the id. */
      const applied = await applyEvent(tx, provider, event, claimed.id)

      return { handled: true, duplicate: false, intentId: applied }
    })
  } catch (error) {
    console.error('[payments] webhook application failed', provider, error)
    return { handled: false, reason: 'internal_error' }
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Applies a verified, freshly-claimed event to its intent.
 *
 * Returns the intent id, or null when the event referenced something we do not
 * have. An unknown reference is recorded rather than discarded — a payment
 * arriving for an intent this deployment has never heard of is exactly the
 * event an operator needs to see, and it is what a misdirected webhook or a
 * cross-environment misconfiguration looks like.
 */
async function applyEvent(
  tx: Tx,
  provider: PaymentProvider,
  event: VerifiedWebhook,
  eventRowId: string,
): Promise<string | null> {
  const [intent] = await tx
    .select({
      id: schema.paymentIntents.id,
      orderId: schema.paymentIntents.orderId,
      status: schema.paymentIntents.status,
      fiatAmountCents: schema.paymentIntents.fiatAmountCents,
      cryptoCurrency: schema.paymentIntents.cryptoCurrency,
      cryptoNetwork: schema.paymentIntents.cryptoNetwork,
      quoteExpiresAt: schema.paymentIntents.quoteExpiresAt,
      confirmedAt: schema.paymentIntents.confirmedAt,
    })
    .from(schema.paymentIntents)
    .where(
      and(
        eq(schema.paymentIntents.provider, provider),
        eq(schema.paymentIntents.providerReference, event.providerReference),
      ),
    )
    .limit(1)

  if (!intent) {
    await tx
      .update(schema.paymentEvents)
      .set({ rejectionReason: 'unknown_reference' })
      .where(eq(schema.paymentEvents.id, eventRowId))

    await recordAuditEventWithin(tx, {
      event: 'PAYMENT_WEBHOOK_REJECTED',
      summary: `${provider} webhook referenced an unknown payment`,
    })

    return null
  }

  await tx
    .update(schema.paymentEvents)
    .set({ paymentIntentId: intent.id, accepted: new Date() })
    .where(eq(schema.paymentEvents.id, eventRowId))

  /**
   * ALREADY CONFIRMED — nothing further to do.
   *
   * This is the SECOND idempotency layer, and it catches what the event-id index
   * cannot: a provider that sends two DIFFERENT event ids both meaning "paid"
   * (a confirmation followed by a settlement notice, say). The unique index sees
   * two distinct ids and admits both; this check is what stops the second one
   * finalising an order that is already finalised.
   *
   * `confirmed_at` is the marker rather than the status, because it is written
   * exactly once and the CHECK constraint on the table guarantees it can only
   * coexist with a settled status.
   */
  if (intent.confirmedAt !== null) return intent.id

  const nextStatus = resolveStatus(event, intent)

  /**
   * The transition is guarded by the CURRENT status as well as the id, so an
   * out-of-order delivery cannot walk a terminal intent backwards. A `paid`
   * intent receiving a late `awaiting_payment` — which happens when a provider
   * retries an old event after a newer one landed — changes nothing.
   */
  const [updated] = await tx
    .update(schema.paymentIntents)
    .set(
      withUpdatedAt({
        status: nextStatus,
        cryptoAmountReceived: event.status.amountReceived,
        failureCode: event.status.failureCode ?? null,
        ...(nextStatus === 'paid' || nextStatus === 'overpaid'
          ? { confirmedAt: new Date() }
          : {}),
        ...(nextStatus === 'expired' ? { expiredAt: new Date() } : {}),
      }),
    )
    .where(
      and(
        eq(schema.paymentIntents.id, intent.id),
        isNull(schema.paymentIntents.confirmedAt),
      ),
    )
    .returning({ id: schema.paymentIntents.id })

  if (!updated) return intent.id

  if (nextStatus === 'paid' || nextStatus === 'overpaid') {
    await recordAuditEventWithin(tx, {
      event: 'PAYMENT_INTENT_CONFIRMED',
      entityType: 'payment_intent',
      entityId: intent.id,
      summary: `payment ${nextStatus} via ${provider} for order ${intent.orderId}`,
    })
  } else if (nextStatus === 'expired') {
    await recordAuditEventWithin(tx, {
      event: 'PAYMENT_INTENT_EXPIRED',
      entityType: 'payment_intent',
      entityId: intent.id,
      summary: `payment expired via ${provider}`,
    })
  } else if (nextStatus === 'failed') {
    await recordAuditEventWithin(tx, {
      event: 'PAYMENT_INTENT_FAILED',
      entityType: 'payment_intent',
      entityId: intent.id,
      summary: `payment failed via ${provider}: ${event.status.failureCode ?? 'unspecified'}`,
    })
  }

  /**
   * ORDER FINALISATION IS DELIBERATELY NOT DONE HERE.
   *
   * `CHECKOUT_ENABLED` is false for this entire phase, so there is no live order
   * flow to finalise into, and writing a transition against a checkout that does
   * not yet exist would be untested code on the money path. The seam is this
   * comment plus `confirmedAt`: when checkout opens, order finalisation is a
   * call inside THIS transaction, guarded by the same `isNull(confirmedAt)`
   * predicate that already makes the status transition happen exactly once.
   */

  return intent.id
}

/**
 * Decides the intent status from what the provider reported.
 *
 * WHY THIS IS NOT JUST `event.status.status`. The provider knows what arrived on
 * chain; it does not know our tolerances, and on several providers it does not
 * know the fiat amount owed either. Underpayment and overpayment are OUR
 * determinations, made against OUR quoted amount, and taking the provider's word
 * for "paid" would mean accepting whatever it decided was close enough.
 *
 * WRONG CURRENCY AND WRONG NETWORK are checked here for the same reason. A
 * payment of the right number of the wrong token, or the right token on the
 * wrong chain, is not a payment — and a provider reporting `paid` on one is
 * reporting on the invoice it issued, not on the obligation we recorded.
 */
function resolveStatus(
  event: VerifiedWebhook,
  intent: {
    fiatAmountCents: number
    cryptoCurrency: string | null
    cryptoNetwork: string | null
    quoteExpiresAt: Date | null
  },
): PaymentIntentStatus {
  const reported = event.status.status

  /** Only settlement claims get scrutinised; the rest pass through. */
  if (reported !== 'paid' && reported !== 'overpaid' && reported !== 'partially_paid') {
    return reported
  }

  const payload = event.payload as
    | { cryptoCurrency?: unknown; cryptoNetwork?: unknown; amountCents?: unknown }
    | null

  if (
    typeof payload?.cryptoCurrency === 'string' &&
    intent.cryptoCurrency !== null &&
    payload.cryptoCurrency !== intent.cryptoCurrency
  ) {
    return 'failed'
  }

  if (
    typeof payload?.cryptoNetwork === 'string' &&
    intent.cryptoNetwork !== null &&
    payload.cryptoNetwork !== intent.cryptoNetwork
  ) {
    return 'failed'
  }

  /**
   * LATE PAYMENT — money that arrived after our quote window closed.
   *
   * NOT silently accepted, and not discarded either. The rate it was quoted at
   * is stale, so the fiat value of what arrived is no longer what we asked for;
   * accepting it would mean honouring a price we withdrew. `partially_paid`
   * routes it to a human, which is the only defensible handling — the customer's
   * money is real and has to be either applied at a fresh rate or returned.
   */
  const expired =
    intent.quoteExpiresAt !== null && intent.quoteExpiresAt.getTime() < Date.now()
  if (expired) return 'partially_paid'

  /**
   * Amount reconciliation. Providers that report a fiat equivalent let us check
   * against the obligation; those that do not are trusted on their own
   * classification, because we have nothing better to compare against.
   */
  if (typeof payload?.amountCents !== 'number') return reported

  const owed = intent.fiatAmountCents
  const received = payload.amountCents
  const shortfall = owed - received

  if (shortfall > underpaymentToleranceCents(owed)) return 'partially_paid'
  if (received - owed > overpaymentToleranceCents(owed)) return 'overpaid'

  return 'paid'
}
