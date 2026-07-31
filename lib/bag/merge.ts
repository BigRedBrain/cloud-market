import 'server-only'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { recordAuditEvent } from '@/lib/auth/audit'
import { db, schema } from '@/lib/db'
import { clearGuestCookie, findActiveBag, findOrCreateBag } from '@/lib/bag/core'

/**
 * Guest-to-customer bag merge.
 *
 * Deliberately NOT in the 'use server' actions module. It takes a userId, and a
 * Server Action export is a public network endpoint — exposing it would let any
 * caller merge an arbitrary guest bag into an arbitrary account. It is a plain
 * server function, called only from inside signInAction, where the userId has
 * just been established by authentication.
 */

function revalidateBag() {
  revalidatePath('/bag')
  revalidatePath('/', 'layout')
}

export type MergeAdjustment = {
  variantId: string
  productName: string
  label: string
  /** What the guest bag asked for. */
  requestedQuantity: number
  /** What stock allowed. Always lower than requested. */
  grantedQuantity: number
}

export type MergeUnavailable = {
  variantId: string
  productName: string
  label: string
  reason: 'out_of_stock' | 'discontinued'
}

/**
 * Structured outcome of a merge.
 *
 * An unpurchasable guest line is NOT carried into the active bag — a sold-out
 * line masquerading as buyable is worse than its absence. But the customer is
 * entitled to know something changed, so the fact is returned here rather than
 * discarded, and it survives in three further places that do not depend on the
 * caller doing anything with this value:
 *
 *   1. The guest cart is retained with `status='merged'` and its lines intact,
 *      so the original contents remain reconstructable from the database.
 *   2. A `CART_MERGED` audit row records the counts and a readable summary.
 *   3. Sign-in flags its redirect, and the destination page tells the customer
 *      their bag was updated.
 *
 * PER-ITEM messaging is deferred: naming each dropped item in the UI is a design
 * decision this phase was told not to make. `unavailable` carries the product
 * name, label and reason needed to build it later, so nothing here is ever
 * permanently unknowable.
 */
export type MergeOutcome = {
  merged: boolean
  linesMerged: number
  /** Lines whose combined quantity was reduced to fit available stock. */
  quantityAdjusted: MergeAdjustment[]
  /** Lines dropped because they cannot currently be purchased. */
  unavailable: MergeUnavailable[]
}

const NO_MERGE: MergeOutcome = {
  merged: false,
  linesMerged: 0,
  quantityAdjusted: [],
  unavailable: [],
}

/**
 * Folds a guest bag into the customer's bag on sign-in.
 *
 * RULES, and why each is what it is:
 *
 *  - **The customer's bag is preserved, never replaced.** A returning customer
 *    who added three things last week and one thing today keeps all four. The
 *    guest bag is the newcomer; it merges *in*.
 *  - **Identical variants sum**, then cap at currently available stock. Someone
 *    who added 2 as a guest and already had 3 gets 5, or whatever stock allows.
 *    Stock is the only cap; there is no per-line purchase limit.
 *  - **Idempotent.** The guest cart is marked `merged` with a pointer to its
 *    destination. A retried request — a double-submitted sign-in, a refresh, a
 *    replayed action — sees a non-active guest cart and returns immediately, so
 *    quantities cannot double. This is the property that matters most: a merge
 *    that runs twice must be indistinguishable from one that ran once.
 *  - **The guest identity is destroyed** afterwards: cookie cleared, cart no
 *    longer active. The token cannot be replayed to reach the customer's bag.
 *  - **Nothing disappears quietly.** See `MergeOutcome`.
 *
 * Runs in a transaction so a failure part-way cannot leave the guest bag
 * consumed but its lines unmerged.
 */
export async function mergeGuestBagIntoUser(userId: string): Promise<MergeOutcome> {
  const guestCart = await findActiveBag(null)

  // No guest bag, or it belongs to a signed-in user already — nothing to do.
  if (!guestCart || guestCart.userId !== null || guestCart.status !== 'active') {
    await clearGuestCookie()
    return NO_MERGE
  }

  const targetCart = await findOrCreateBag(userId)

  // Defensive: never merge a cart into itself.
  if (targetCart.id === guestCart.id) {
    await clearGuestCookie()
    return NO_MERGE
  }

  let linesMerged = 0
  const quantityAdjusted: MergeAdjustment[] = []
  const unavailable: MergeUnavailable[] = []

  await db.transaction(async (tx) => {
    /**
     * Re-read the guest cart INSIDE the transaction and require it to still be
     * active. Two concurrent sign-ins race here; the first flips it to `merged`
     * and the second finds nothing to do.
     */
    const [claimed] = await tx
      .update(schema.carts)
      .set({
        status: 'merged',
        mergedIntoCartId: targetCart.id,
        mergedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.carts.id, guestCart.id), eq(schema.carts.status, 'active')))
      .returning({ id: schema.carts.id })

    if (!claimed) return // lost the race; the winner is doing the merge

    const guestLines = await tx
      .select({
        variantId: schema.cartLines.variantId,
        quantity: schema.cartLines.quantity,
        available: schema.productVariants.inventoryQuantity,
        active: schema.productVariants.active,
        deletedAt: schema.productVariants.deletedAt,
        label: schema.productVariants.label,
        productStatus: schema.products.status,
        productDeletedAt: schema.products.deletedAt,
        productName: schema.products.name,
      })
      .from(schema.cartLines)
      .innerJoin(
        schema.productVariants,
        eq(schema.cartLines.variantId, schema.productVariants.id),
      )
      .innerJoin(
        schema.products,
        eq(schema.productVariants.productId, schema.products.id),
      )
      .where(eq(schema.cartLines.cartId, guestCart.id))

    for (const line of guestLines) {
      const purchasable =
        line.active &&
        line.deletedAt === null &&
        line.productStatus === 'active' &&
        line.productDeletedAt === null

      /**
       * Unpurchasable lines are omitted from the active bag but RECORDED, so the
       * change is visible rather than silent. The distinction between "sold out"
       * and "discontinued" is kept because they mean different things to a
       * customer: one may come back, the other will not.
       */
      if (!purchasable || line.available === 0) {
        unavailable.push({
          variantId: line.variantId,
          productName: line.productName,
          label: line.label,
          reason: purchasable ? 'out_of_stock' : 'discontinued',
        })
        continue
      }

      /**
       * Sum then cap, atomically. `least()` runs in the database so the combined
       * quantity can never exceed stock even if the target line changed between
       * this loop's iterations.
       */
      const [row] = await tx
        .insert(schema.cartLines)
        .values({
          cartId: targetCart.id,
          variantId: line.variantId,
          quantity: Math.min(line.quantity, line.available),
        })
        .onConflictDoUpdate({
          target: [schema.cartLines.cartId, schema.cartLines.variantId],
          set: {
            quantity: sql`least(${schema.cartLines.quantity} + ${line.quantity}, ${line.available})`,
            updatedAt: new Date(),
          },
        })
        .returning({ quantity: schema.cartLines.quantity })

      linesMerged += 1
      if (row && row.quantity < line.quantity) {
        quantityAdjusted.push({
          variantId: line.variantId,
          productName: line.productName,
          label: line.label,
          requestedQuantity: line.quantity,
          grantedQuantity: row.quantity,
        })
      }
    }

    // The guest cart's own lines are left in place, attached to the now-`merged`
    // cart. They are never read again (reads require status='active') and they
    // keep the merge auditable.
    await tx
      .update(schema.carts)
      .set({ lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.carts.id, targetCart.id))
  })

  await clearGuestCookie()
  revalidateBag()

  const outcome: MergeOutcome = { merged: true, linesMerged, quantityAdjusted, unavailable }

  /**
   * Durable record. The in-memory outcome is returned for immediate use, but a
   * caller that ignores it must not make the change unknowable — so the counts
   * and a readable summary go to the audit log, which already outlives the rows
   * it describes.
   */
  await recordAuditEvent({
    event: 'CART_MERGED',
    userId,
    entityType: 'cart',
    entityId: targetCart.id,
    summary:
      `merged ${linesMerged} line(s)` +
      (quantityAdjusted.length ? `, ${quantityAdjusted.length} reduced to stock` : '') +
      (unavailable.length ? `, ${unavailable.length} unavailable and omitted` : ''),
  })

  return outcome
}
