'use server'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getCurrentUser } from '@/lib/auth/dal'
import { db, schema } from '@/lib/db'
import {
  findActiveBag,
  findOrCreateBag,
  resolvePurchasableVariant,
  touchBag,
} from '@/lib/bag/core'
import {
  fail,
  formDataToObject,
  ok,
  parseInput,
  type ActionResult,
} from '@/lib/result'

/**
 * Bag mutations.
 *
 * THE INPUT CONTRACT IS DELIBERATELY TINY: a variant id and a quantity. No
 * price, no product name, no stock figure. There is no field a tampered request
 * could use to influence a total, because the total is never derived from
 * anything the client sends — a malicious payload carrying `priceCents: 1` has
 * nothing to bind to.
 *
 * Every mutation re-reads price and inventory from the catalog. Validation on a
 * previous request is never carried forward: stock can change between two
 * clicks, so it is checked on each one.
 */

/**
 * Technical bound, NOT a business rule.
 *
 * `quantity` is a Postgres `integer`, so a request above int4's range would be
 * a database error rather than a validation failure. This rejects it cleanly at
 * the edge and does nothing else — the real cap is available inventory, applied
 * in SQL below.
 *
 * There is deliberately no per-line purchase limit here. A limit like "max 5 per
 * customer" is a business rule with legal and merchandising weight (Michigan
 * imposes daily purchase limits on adult-use cannabis), and inventing one in the
 * validation layer would bury a policy decision where nobody would find it.
 * See CART.md for the future purchase-limit capability.
 */
const INT4_MAX = 2_147_483_647

const variantId = z.uuid('Unknown item')
const quantity = z.coerce
  .number()
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(INT4_MAX, 'Quantity is too large')

const addSchema = z.object({ variantId, quantity: quantity.default(1) })
const updateSchema = z.object({ lineId: z.uuid(), quantity })
const removeSchema = z.object({ lineId: z.uuid() })

function revalidateBag() {
  revalidatePath('/bag')
  revalidatePath('/', 'layout')
}

/**
 * Caps a requested quantity at what the catalog currently reports.
 *
 * Returns the granted amount plus whether it was reduced, so the caller can
 * tell the customer rather than silently giving them less than they asked for.
 */
function capToInventory(requested: number, available: number) {
  const granted = Math.max(0, Math.min(requested, available))
  return { granted, capped: granted < requested }
}

/* -------------------------------------------------------------------------- */

export async function addToBagAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(addSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const variant = await resolvePurchasableVariant(parsed.data.variantId)
  if (!variant) {
    // Covers unknown, inactive, soft-deleted, and draft/archived-product cases
    // with one message — the customer does not need to know which.
    return fail('not_found', 'That item is no longer available.')
  }
  if (variant.inventoryQuantity === 0) {
    return fail('conflict', `${variant.productName} (${variant.label}) is sold out.`)
  }

  const user = await getCurrentUser()
  const cart = await findOrCreateBag(user?.id ?? null)

  /**
   * Upsert against the (cart_id, variant_id) unique index.
   *
   * Two concurrent adds of the same variant cannot create two lines: the second
   * conflicts and increments instead. `least(..., available)` applies the
   * inventory cap INSIDE the statement, so the check and the write are one
   * atomic operation rather than a read-then-write with a gap in the middle.
   */
  const [row] = await db
    .insert(schema.cartLines)
    .values({
      cartId: cart.id,
      variantId: variant.id,
      quantity: Math.min(parsed.data.quantity, variant.inventoryQuantity),
    })
    .onConflictDoUpdate({
      target: [schema.cartLines.cartId, schema.cartLines.variantId],
      set: {
        quantity: sql`least(${schema.cartLines.quantity} + ${parsed.data.quantity}, ${variant.inventoryQuantity})`,
        updatedAt: new Date(),
      },
    })
    .returning({ quantity: schema.cartLines.quantity })

  await touchBag(cart.id)
  revalidateBag()

  if (row && row.quantity < parsed.data.quantity) {
    return fail(
      'conflict',
      `Only ${row.quantity} of ${variant.productName} (${variant.label}) available — we've added what we can.`,
    )
  }
  return ok()
}

export async function updateBagQuantityAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(updateSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const user = await getCurrentUser()
  const cart = await findActiveBag(user?.id ?? null)
  if (!cart) return fail('not_found', 'Your bag is empty.')

  /**
   * Scoped to the caller's own cart. A line id from someone else's bag simply
   * does not match, so it is a miss rather than an authorization hole — the
   * same shape as session revocation in Phase 1.
   */
  const [line] = await db
    .select({ id: schema.cartLines.id, variantId: schema.cartLines.variantId })
    .from(schema.cartLines)
    .where(
      and(eq(schema.cartLines.id, parsed.data.lineId), eq(schema.cartLines.cartId, cart.id)),
    )
    .limit(1)

  if (!line) return fail('not_found', 'That item is no longer in your bag.')

  const variant = await resolvePurchasableVariant(line.variantId)
  if (!variant) {
    await db.delete(schema.cartLines).where(eq(schema.cartLines.id, line.id))
    revalidateBag()
    return fail('conflict', 'That item is no longer available and has been removed.')
  }

  const { granted, capped } = capToInventory(parsed.data.quantity, variant.inventoryQuantity)

  if (granted === 0) {
    await db.delete(schema.cartLines).where(eq(schema.cartLines.id, line.id))
    await touchBag(cart.id)
    revalidateBag()
    return fail('conflict', `${variant.productName} (${variant.label}) is sold out.`)
  }

  await db
    .update(schema.cartLines)
    .set({ quantity: granted, updatedAt: new Date() })
    .where(eq(schema.cartLines.id, line.id))

  await touchBag(cart.id)
  revalidateBag()

  return capped
    ? fail('conflict', `Only ${granted} available — quantity adjusted.`)
    : ok()
}

export async function removeFromBagAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = parseInput(removeSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const user = await getCurrentUser()
  const cart = await findActiveBag(user?.id ?? null)
  if (!cart) return fail('not_found', 'Your bag is empty.')

  await db
    .delete(schema.cartLines)
    .where(
      and(eq(schema.cartLines.id, parsed.data.lineId), eq(schema.cartLines.cartId, cart.id)),
    )

  await touchBag(cart.id)
  revalidateBag()
  return ok()
}
