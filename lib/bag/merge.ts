import 'server-only'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

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

const MAX_LINE_QUANTITY = 99

function revalidateBag() {
  revalidatePath('/bag')
  revalidatePath('/', 'layout')
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
 *  - **Idempotent.** The guest cart is marked `merged` with a pointer to its
 *    destination. A retried request — a double-submitted sign-in, a refresh, a
 *    replayed action — sees a non-active guest cart and returns immediately, so
 *    quantities cannot double. This is the property that matters most: a merge
 *    that runs twice must be indistinguishable from one that ran once.
 *  - **The guest identity is destroyed** afterwards: cookie cleared, cart no
 *    longer active. The token cannot be replayed to reach the customer's bag.
 *
 * Runs in a transaction so a failure part-way cannot leave the guest bag
 * consumed but its lines unmerged.
 */
export async function mergeGuestBagIntoUser(userId: string): Promise<{
  merged: boolean
  linesMerged: number
  cappedLines: number
}> {
  const guestCart = await findActiveBag(null)

  // No guest bag, or it belongs to a signed-in user already — nothing to do.
  if (!guestCart || guestCart.userId !== null || guestCart.status !== 'active') {
    await clearGuestCookie()
    return { merged: false, linesMerged: 0, cappedLines: 0 }
  }

  const targetCart = await findOrCreateBag(userId)

  // Defensive: never merge a cart into itself.
  if (targetCart.id === guestCart.id) {
    await clearGuestCookie()
    return { merged: false, linesMerged: 0, cappedLines: 0 }
  }

  let linesMerged = 0
  let cappedLines = 0

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
        productStatus: schema.products.status,
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
        line.active && line.deletedAt === null && line.productStatus === 'active'
      if (!purchasable || line.available === 0) continue

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
          quantity: Math.min(line.quantity, line.available, MAX_LINE_QUANTITY),
        })
        .onConflictDoUpdate({
          target: [schema.cartLines.cartId, schema.cartLines.variantId],
          set: {
            quantity: sql`least(${schema.cartLines.quantity} + ${line.quantity}, ${line.available}, ${MAX_LINE_QUANTITY})`,
            updatedAt: new Date(),
          },
        })
        .returning({ quantity: schema.cartLines.quantity })

      linesMerged += 1
      if (row && row.quantity < line.quantity) cappedLines += 1
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

  return { merged: true, linesMerged, cappedLines }
}
