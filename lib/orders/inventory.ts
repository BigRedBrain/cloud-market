import 'server-only'

import { and, eq, sql } from 'drizzle-orm'

import { schema } from '@/lib/db'
import type { DbExecutor } from '@/lib/auth/tokens'

/**
 * Inventory reservation.
 *
 * PHASE 3 RESERVED NOTHING, ON PURPOSE. A bag is browsing, and "reserved for
 * you" was a promise the schema could not back. Checkout is where that stops
 * being acceptable: an order is a promise about an object that has to exist,
 * be picked, and be handed to someone.
 *
 * TWO COUNTERS, NOT ONE.
 *
 *     available = inventory_quantity - reserved_quantity
 *
 * A hold increments `reserved_quantity`. A sale decrements BOTH. A release
 * decrements `reserved_quantity` alone. With a single counter, an expired draft
 * and a completed sale look identical afterwards, and there is no way to give
 * stock back without knowing which happened.
 *
 * EVERY MOVE IS ONE CONDITIONAL STATEMENT. The check and the write are never
 * two round trips — that gap is exactly where two customers both get the last
 * unit. `WHERE inventory_quantity - reserved_quantity >= $qty` is the check,
 * and it is inside the UPDATE.
 *
 * EVERY MOVE IS IDEMPOTENT, guarded by `orders.inventory_state`. A retried
 * release must not return stock twice; a retried commit must not consume it
 * twice. The guard is a conditional UPDATE on that column, so exactly one
 * caller can perform each transition and the rest are no-ops.
 *
 * DATABASE TIME ONLY. Expiry compares `now()` inside Postgres. An application
 * server with a drifted clock must not be able to release someone's hold early
 * or keep it alive late.
 */

/** How long a checkout draft holds stock. */
export const RESERVATION_TTL_MINUTES = 15

export type ReservationRequest = { variantId: string; quantity: number }

export type ReservationFailure = {
  variantId: string
  requested: number
  available: number
}

/**
 * Holds stock for a draft.
 *
 * Returns the lines it could NOT satisfy rather than throwing, so the caller can
 * tell the customer which item ran out — before they enter any details, not
 * after. Must run inside a transaction: a partial hold is worse than none, and
 * the caller rolls back on any failure.
 */
export async function reserveStock(
  tx: DbExecutor,
  requests: ReservationRequest[],
): Promise<ReservationFailure[]> {
  const failures: ReservationFailure[] = []

  for (const request of requests) {
    const [updated] = await tx
      .update(schema.productVariants)
      .set({
        reservedQuantity: sql`${schema.productVariants.reservedQuantity} + ${request.quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.productVariants.id, request.variantId),
          /** The check, inside the write. */
          sql`${schema.productVariants.inventoryQuantity} - ${schema.productVariants.reservedQuantity} >= ${request.quantity}`,
        ),
      )
      .returning({ reserved: schema.productVariants.reservedQuantity })

    if (!updated) {
      const [current] = await tx
        .select({
          onHand: schema.productVariants.inventoryQuantity,
          held: schema.productVariants.reservedQuantity,
        })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, request.variantId))
        .limit(1)

      failures.push({
        variantId: request.variantId,
        requested: request.quantity,
        available: current ? current.onHand - current.held : 0,
      })
    }
  }

  return failures
}

/**
 * Turns a hold into a sale: both counters down.
 *
 * Called at placement, NOT at payment. Payment is cash at handoff, so waiting
 * for it would mean stock stayed merely "held" for an order that is already
 * promised — and a promised order whose stock can expire is a promise that can
 * break while the customer drives over.
 */
export async function commitStock(
  tx: DbExecutor,
  requests: ReservationRequest[],
): Promise<void> {
  for (const request of requests) {
    await tx
      .update(schema.productVariants)
      .set({
        inventoryQuantity: sql`${schema.productVariants.inventoryQuantity} - ${request.quantity}`,
        reservedQuantity: sql`greatest(${schema.productVariants.reservedQuantity} - ${request.quantity}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(schema.productVariants.id, request.variantId))
  }
}

/**
 * Gives a hold back.
 *
 * `greatest(…, 0)` is a floor, not a fix. If the counter could go negative the
 * bug is upstream, but clamping means one accounting mistake cannot cascade
 * into phantom stock that the storefront then sells.
 */
export async function releaseStock(
  tx: DbExecutor,
  requests: ReservationRequest[],
): Promise<void> {
  for (const request of requests) {
    await tx
      .update(schema.productVariants)
      .set({
        reservedQuantity: sql`greatest(${schema.productVariants.reservedQuantity} - ${request.quantity}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(schema.productVariants.id, request.variantId))
  }
}

/**
 * Returns stock consumed by a placed order — cancellation after commit.
 *
 * Increments `inventory_quantity` without touching `reserved_quantity`, because
 * the hold was already released when the sale committed.
 */
export async function restockCommitted(
  tx: DbExecutor,
  requests: ReservationRequest[],
): Promise<void> {
  for (const request of requests) {
    await tx
      .update(schema.productVariants)
      .set({
        inventoryQuantity: sql`${schema.productVariants.inventoryQuantity} + ${request.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.productVariants.id, request.variantId))
  }
}

/**
 * Claims the right to move an order's inventory from one state to another.
 *
 * THE IDEMPOTENCY PRIMITIVE. Returns true for exactly one caller; every retry,
 * every double-submit, every racing expiry sweep gets false and does nothing.
 * The caller must treat false as "someone else already did this", not as an
 * error — that distinction is what makes a retry safe.
 */
export async function claimInventoryTransition(
  tx: DbExecutor,
  orderId: string,
  from: 'reserved' | 'committed',
  to: 'committed' | 'released',
): Promise<boolean> {
  const [claimed] = await tx
    .update(schema.orders)
    .set({ inventoryState: to, updatedAt: new Date() })
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.inventoryState, from)))
    .returning({ id: schema.orders.id })

  return Boolean(claimed)
}

/**
 * Marks a draft expired, if and only if its window has actually passed.
 *
 * `now()` is evaluated by Postgres. Passing a JavaScript `Date` here would make
 * expiry depend on whichever server happened to run the sweep.
 */
export async function claimExpiredDraft(
  tx: DbExecutor,
  orderId: string,
): Promise<boolean> {
  const [claimed] = await tx
    .update(schema.orders)
    .set({ currentStatus: 'expired', inventoryState: 'released', updatedAt: new Date() })
    .where(
      and(
        eq(schema.orders.id, orderId),
        eq(schema.orders.currentStatus, 'draft'),
        eq(schema.orders.inventoryState, 'reserved'),
        sql`${schema.orders.reservedUntil} <= now()`,
      ),
    )
    .returning({ id: schema.orders.id })

  return Boolean(claimed)
}
