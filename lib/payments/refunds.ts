'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { db, schema } from '@/lib/db'
import { withUpdatedAt } from '@/lib/db/schema'
import { recordAuditEvent } from '@/lib/auth/audit'
import { requireOwner } from '@/lib/auth/admin-identity'
import { reauthMessage, reauthenticate } from '@/lib/auth/reauth'
import {
  RATE_LIMITS,
  checkUserRateLimit,
  rateLimitMessage,
} from '@/lib/security/rate-limit'
import { fail, formDataToObject, ok, parseInput, type ActionResult } from '@/lib/result'
import { getAdapter } from './registry'

/**
 * Refunds — OWNER ONLY (section AI).
 *
 * WHY THE BACKUP ADMINISTRATOR IS REFUSED HERE. A refund moves real money out of
 * the business to an address chosen at the far end of the operation, and on
 * chain it is irreversible in a way a card chargeback is not. That makes it the
 * single most attractive function in this application to reach through a
 * compromised administrator session. The backup slot exists so somebody can mind
 * the store — publish products, issue invites, look at orders — not so a second
 * person can move money.
 *
 * THREE INDEPENDENT CONTROLS, and each one closes something the others do not:
 *
 *   1. `requireOwner()` — identity, from the server environment. A backup
 *      administrator, or anyone holding their session, is refused outright.
 *   2. `reauthenticate()` — the password, seconds ago, in this request. An
 *      unattended laptop with a live owner session is not enough.
 *   3. `checkUserRateLimit()` — bounded attempts, so a run of failed
 *      confirmations against the owner account cannot be ground through.
 *
 * The customer-facing side of this has no entry point at all: there is no
 * customer refund action anywhere in the codebase, and the test suite asserts
 * that a customer and a backup administrator both fail.
 */

const refundSchema = z.object({
  intentId: z.uuid('Unknown payment'),
  password: z.string().min(1, 'Confirm your password to continue'),
  /**
   * Mandatory, and not a formality. A refund with no stated reason is an
   * unexplained outbound payment in the audit log, which is exactly what an
   * auditor asks about and exactly what nobody can answer six months later.
   */
  reason: z
    .string()
    .trim()
    .min(10, 'Record why this refund is being issued')
    .max(300, 'Keep the reason under 300 characters'),
})

export async function refundPaymentAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const owner = await requireOwner()

  const parsed = parseInput(refundSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const throttle = await checkUserRateLimit({
    userId: owner.user.id,
    ...RATE_LIMITS.ownerSensitive,
  })
  if (!throttle.allowed) {
    return fail('rate_limited', rateLimitMessage(throttle.retryAfterMs))
  }

  const reauth = await reauthenticate(owner.user.id, parsed.data.password)
  if (!reauth.ok) {
    return fail('unauthenticated', reauthMessage(reauth.reason), {
      password: ['Confirmation failed'],
    })
  }

  const [intent] = await db
    .select({
      id: schema.paymentIntents.id,
      provider: schema.paymentIntents.provider,
      providerReference: schema.paymentIntents.providerReference,
      status: schema.paymentIntents.status,
      fiatAmountCents: schema.paymentIntents.fiatAmountCents,
      fiatCurrency: schema.paymentIntents.fiatCurrency,
      refundedAt: schema.paymentIntents.refundedAt,
    })
    .from(schema.paymentIntents)
    .where(eq(schema.paymentIntents.id, parsed.data.intentId))
    .limit(1)

  if (!intent) return fail('not_found', 'That payment could not be found.')

  /**
   * Idempotency, checked before the provider is called. Refunding twice is not
   * a duplicated log line, it is money sent twice.
   */
  if (intent.refundedAt !== null) {
    return fail('conflict', 'That payment has already been refunded.')
  }

  if (!['paid', 'overpaid', 'partially_paid'].includes(intent.status)) {
    return fail('conflict', 'Only a settled payment can be refunded.')
  }

  if (!intent.providerReference) {
    return fail('conflict', 'That payment was never registered with a provider.')
  }

  const adapter = getAdapter(intent.provider)
  if (!adapter) {
    return fail('conflict', 'The provider for that payment is not configured.')
  }

  /**
   * THE INTENT TO REFUND IS AUDITED BEFORE THE PROVIDER IS CALLED.
   *
   * If the provider call succeeds and our process dies before recording it, the
   * money has left and the only evidence is this row. Recording afterwards
   * would make that outcome invisible. Two events rather than one —
   * `REQUESTED` then `COMPLETED` — so a refund that started and did not finish
   * is distinguishable from one that never started, which is the distinction
   * somebody will need at exactly the wrong moment.
   */
  await recordAuditEvent({
    event: 'PAYMENT_REFUND_REQUESTED',
    userId: owner.user.id,
    sessionId: owner.sessionId,
    entityType: 'payment_intent',
    entityId: intent.id,
    summary: `refund requested — ${parsed.data.reason}`,
  })

  let refund: Awaited<ReturnType<typeof adapter.refundPayment>>
  try {
    refund = await adapter.refundPayment({
      providerReference: intent.providerReference,
      amount: { cents: intent.fiatAmountCents, currency: intent.fiatCurrency },
      reason: parsed.data.reason,
    })
  } catch (error) {
    /** Never returned to the caller: provider errors can embed credentials. */
    console.error('[payments] refund failed at provider', error)
    return fail(
      'internal_error',
      'The provider refused that refund. Nothing was sent. Check the provider dashboard before retrying.',
    )
  }

  await db
    .update(schema.paymentIntents)
    .set(withUpdatedAt({ status: 'refunded', refundedAt: new Date(), refundedBy: owner.user.id }))
    .where(eq(schema.paymentIntents.id, intent.id))

  await recordAuditEvent({
    event: 'PAYMENT_REFUND_COMPLETED',
    userId: owner.user.id,
    sessionId: owner.sessionId,
    entityType: 'payment_intent',
    entityId: intent.id,
    /** The provider's refund reference is an identifier, not a credential. */
    summary: `refund completed — provider ref ${refund.providerRefundReference}`,
  })

  revalidatePath('/admin/payments')
  return ok()
}
