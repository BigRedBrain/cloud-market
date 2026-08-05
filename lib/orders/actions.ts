'use server'

import { and, eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { recordAuditEvent } from '@/lib/auth/audit'
import { requireUser, requireVerifiedUser } from '@/lib/auth/dal'
import { getBag } from '@/lib/bag/core'
import { db, schema } from '@/lib/db'
import { cancelOrder, createDraft, placeOrder } from '@/lib/orders/core'
import { checkoutGate, describeGate } from '@/lib/orders/gate'
import { formatCents } from '@/lib/orders/pricing'
import {
  fail,
  formDataToObject,
  parseInput,
  type ActionResult,
} from '@/lib/result'

/**
 * Checkout actions.
 *
 * THE CLIENT SENDS NOTHING THAT TOUCHES MONEY. No price, no total, no tax, no
 * quantity beyond what is already in the bag. Every figure is computed
 * server-side from the catalog, which is the same rule the bag has enforced
 * since Phase 3 — there is simply more at stake now.
 *
 * The one thing the browser does supply is an idempotency key, and it cannot do
 * harm: it only ever causes a retry to find the order it already created.
 */

const placeSchema = z.object({
  orderId: z.uuid(),
  /** Opaque, client-generated, unique per checkout attempt. */
  idempotencyKey: z.string().min(8).max(64),
  /** The customer re-affirming their age at placement. */
  ageConfirmed: z.literal('on', { message: 'Confirm you are 21 or older to continue.' }),
})

const cancelSchema = z.object({ orderId: z.uuid() })

/**
 * Starts checkout: turns the bag into a draft and holds the stock.
 *
 * `requireVerifiedUser` is called here rather than at the bag, which is the
 * gate Phase 1 wrote and never used. Browsing and building a bag stay open to
 * an unverified account; ordering does not.
 */
export async function startCheckoutAction(
  _previous: ActionResult<void> | null,
  _formData: FormData,
): Promise<ActionResult<void>> {
  const user = await requireVerifiedUser()

  /**
   * The kill switch, before anything else.
   *
   * Checked in the ACTION, not only in the page that renders the button. A
   * Server Action is a public POST endpoint; a hidden control stops nobody who
   * can read an action id.
   */
  const gate = await checkoutGate()
  if (!gate.open) {
    await recordAuditEvent({
      event: 'CHECKOUT_BLOCKED_BY_GATE',
      userId: user.id,
      entityType: 'order',
      summary:
        gate.reason === 'sweeper_stale'
          ? `draft refused: sweeper stale (${gate.ageSeconds ?? 'unknown'}s)`
          : 'draft refused: checkout disabled',
    })
    return fail('conflict', describeGate(gate))
  }

  const bag = await getBag(user.id)

  if (bag.lines.length === 0) {
    return fail('conflict', 'Your bag is empty.')
  }

  const [details] = await db
    .select({ phone: schema.users.phone, dateOfBirth: schema.users.dateOfBirth })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1)

  const result = await createDraft({
    userId: user.id,
    userEmail: user.email,
    userName: user.name,
    userPhone: details?.phone ?? null,
    dateOfBirth: details?.dateOfBirth ?? null,
    cartLines: bag.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
    })),
  })

  if (!result.ok) {
    switch (result.failure.kind) {
      case 'empty_bag':
        return fail('conflict', 'Your bag is empty.')
      case 'no_store':
        return fail('conflict', 'No store is currently accepting pickup orders.')
      case 'unavailable':
        return fail(
          'conflict',
          `${result.failure.items.join(', ')} is no longer available. Remove it to continue.`,
        )
      case 'insufficient_stock':
        return fail(
          'conflict',
          'Someone else took the last of an item in your bag. Adjust the quantity and try again.',
        )
      case 'limit_exceeded':
        /**
         * Audited. A blocked purchase is a compliance event worth being able to
         * show a regulator, and the reason carries no personal detail.
         */
        await recordAuditEvent({
          event: 'PURCHASE_LIMIT_BLOCKED',
          userId: user.id,
          entityType: 'order',
          summary: 'daily purchase limit would be exceeded',
        })
        return fail('conflict', result.failure.evaluation.reason ?? 'Daily limit reached.')
      case 'limit_rules_unavailable':
        /**
         * Failing closed. The customer gets an apology rather than a sale,
         * because the alternative is selling without an enforceable daily cap.
         * Audited as a compliance event: this is a misconfiguration that stops
         * trade, and it must be visible to whoever can fix it.
         */
        await recordAuditEvent({
          event: 'PURCHASE_LIMIT_BLOCKED',
          userId: user.id,
          entityType: 'order',
          summary: `limit rules ${result.failure.reason}: ${result.failure.classes.join(', ')}`,
        })
        return fail(
          'conflict',
          'Checkout is unavailable for one of the items in your bag. Our team has ' +
            'been notified — please try again shortly or call the store.',
        )
    }
  }

  redirect(`/checkout/review`)
}

/**
 * Places the order.
 *
 * Everything is revalidated inside `placeOrder` before anything commits. A
 * price change stops the placement and tells the customer the new figure rather
 * than charging it.
 */
export async function placeOrderAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const user = await requireVerifiedUser()

  /**
   * Placement is gated too, not just draft creation.
   *
   * A draft created while checkout was open must not be placeable after the
   * switch is thrown — that is the situation the switch exists for, and letting
   * fifteen minutes of in-flight drafts through would defeat it.
   */
  const gate = await checkoutGate()
  if (!gate.open) {
    await recordAuditEvent({
      event: 'CHECKOUT_BLOCKED_BY_GATE',
      userId: user.id,
      entityType: 'order',
      summary:
        gate.reason === 'sweeper_stale'
          ? `placement refused: sweeper stale (${gate.ageSeconds ?? 'unknown'}s)`
          : 'placement refused: checkout disabled',
    })
    return fail('conflict', describeGate(gate))
  }

  const parsed = parseInput(placeSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const result = await placeOrder({
    userId: user.id,
    orderId: parsed.data.orderId,
    idempotencyKey: parsed.data.idempotencyKey,
    actorId: user.id,
  })

  if (!result.ok) {
    switch (result.failure.kind) {
      case 'not_found':
        return fail('not_found', 'That checkout is no longer available.')
      case 'expired':
        return fail(
          'conflict',
          'Your checkout timed out and the items were released. Start again from your bag.',
        )
      case 'price_changed':
        return fail(
          'conflict',
          `Prices changed while you were checking out — the total is now ` +
            `${formatCents(result.failure.currentTotalCents)}. Review and place the order again.`,
        )
      case 'unavailable':
        return fail(
          'conflict',
          `${result.failure.items.join(', ')} sold out while you were checking out.`,
        )
      case 'limit_exceeded':
        await recordAuditEvent({
          event: 'PURCHASE_LIMIT_BLOCKED',
          userId: user.id,
          entityType: 'order',
          entityId: parsed.data.orderId,
          summary: 'daily purchase limit would be exceeded at placement',
        })
        return fail('conflict', result.failure.evaluation.reason ?? 'Daily limit reached.')
      case 'limit_rules_unavailable':
        await recordAuditEvent({
          event: 'PURCHASE_LIMIT_BLOCKED',
          userId: user.id,
          entityType: 'order',
          entityId: parsed.data.orderId,
          summary: `limit rules ${result.failure.reason} at placement: ${result.failure.classes.join(', ')}`,
        })
        return fail(
          'conflict',
          'We cannot complete this order right now. Your items are still held — ' +
            'please try again shortly or call the store.',
        )
    }
  }

  await recordAuditEvent({
    event: 'ORDER_PLACED',
    userId: user.id,
    entityType: 'order',
    entityId: result.orderId,
    summary: result.alreadyPlaced ? 'placement retried; already placed' : 'order placed',
  })

  /** Clearing the bag is deliberate: the order now owns those lines. */
  if (!result.alreadyPlaced) {
    const [cart] = await db
      .select({ id: schema.carts.id })
      .from(schema.carts)
      .where(and(eq(schema.carts.userId, user.id), eq(schema.carts.status, 'active')))
      .limit(1)
    if (cart) {
      await db.delete(schema.cartLines).where(eq(schema.cartLines.cartId, cart.id))
      await db
        .update(schema.carts)
        .set({ status: 'converted', updatedAt: new Date() })
        .where(eq(schema.carts.id, cart.id))
    }
  }

  redirect(`/orders/${result.orderNumber}`)
}

/** Customer-initiated cancellation. Idempotent; a second click is harmless. */
export async function cancelOrderAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const user = await requireUser()

  const parsed = parseInput(cancelSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const [order] = await db
    .select({ id: schema.orders.id, orderNumber: schema.orders.orderNumber })
    .from(schema.orders)
    .where(
      and(eq(schema.orders.id, parsed.data.orderId), eq(schema.orders.userId, user.id)),
    )
    .limit(1)

  if (!order) return fail('not_found', 'That order could not be found.')

  const result = await cancelOrder({
    orderId: order.id,
    actorType: 'customer',
    actorId: user.id,
    reason: 'cancelled by customer',
  })

  if (!result.ok) {
    return fail('conflict', 'That order can no longer be cancelled. Call the store.')
  }

  if (!result.alreadyCancelled) {
    await recordAuditEvent({
      event: 'ORDER_CANCELLED',
      userId: user.id,
      entityType: 'order',
      entityId: order.id,
    })
  }

  redirect(`/orders/${order.orderNumber}`)
}
