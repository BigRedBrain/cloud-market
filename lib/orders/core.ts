import 'server-only'

import { randomBytes } from 'node:crypto'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'

import type { DbExecutor } from '@/lib/auth/tokens'
import { db, schema } from '@/lib/db'
import {
  claimInventoryTransition,
  commitStock,
  releaseStock,
  reserveStock,
  restockCommitted,
  RESERVATION_TTL_MINUTES,
  type ReservationFailure,
} from '@/lib/orders/inventory'
import {
  evaluateOrderLimits,
  FALLBACK_LIMIT_RULES,
  type LimitEvaluation,
  type LimitRule,
} from '@/lib/orders/limits'
import {
  DEFAULT_EXCISE_TAX_BPS,
  DEFAULT_SALES_TAX_BPS,
  priceOrder,
  type TaxRates,
} from '@/lib/orders/pricing'

/**
 * Order lifecycle.
 *
 * TWO INVARIANTS RUN THROUGH EVERY FUNCTION HERE.
 *
 * 1. **`order_events` is the history; `orders.current_status` is a cache of
 *    it.** Both are written in the same transaction, always through
 *    `recordTransition`. If they ever disagree, the event log wins — it is the
 *    one that can answer "who cancelled this, and when".
 *
 * 2. **Every operation is idempotent.** Placement, expiry, cancellation and
 *    payment collection are all conditional UPDATEs that exactly one caller can
 *    win. A retry is not an error; it is a no-op that reports the same result as
 *    the call that succeeded.
 *
 * Totals are computed here from the catalog, never from anything the browser
 * sent. The client supplies an idempotency key and nothing else that touches
 * money.
 */

/** Short, unambiguous, no confusable characters. */
function generateOrderNumber(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return `CM-${out.slice(0, 4)}-${out.slice(4)}`
}

/**
 * Appends an event AND updates the projection, together.
 *
 * The single place `current_status` is allowed to change. Anything that sets it
 * directly would create a status with no history behind it, which is the exact
 * failure this design exists to prevent.
 */
export async function recordTransition(
  tx: DbExecutor,
  params: {
    orderId: string
    eventType: schema.OrderEventType
    fromStatus?: schema.OrderStatus | null
    toStatus?: schema.OrderStatus | null
    actorType: 'customer' | 'staff' | 'system'
    actorId?: string | null
    reason?: string | null
  },
): Promise<void> {
  await tx.insert(schema.orderEvents).values({
    orderId: params.orderId,
    eventType: params.eventType,
    fromStatus: params.fromStatus ?? null,
    toStatus: params.toStatus ?? null,
    actorType: params.actorType,
    actorId: params.actorId ?? null,
    reason: params.reason ?? null,
  })

  if (params.toStatus) {
    await tx
      .update(schema.orders)
      .set({ currentStatus: params.toStatus, updatedAt: new Date() })
      .where(eq(schema.orders.id, params.orderId))
  }
}

/**
 * The rules IN FORCE right now, falling back only when the table is empty.
 *
 * "In force" is the half-open window `[effective_from, effective_until)`, not
 * "the open row". Those differ whenever a change has been scheduled: the
 * incoming rule already exists with a future start date and an open end, while
 * the rule that should still govern today's checkout is the one whose end is
 * that future date. Selecting on `effective_until is null` would apply the new
 * cap early — which, for a legal limit, is the wrong direction to be wrong in.
 *
 * Evaluated against DATABASE time, like every other temporal comparison in this
 * phase. The rule id travels with each rule so the order line can record which
 * row authorised it.
 */
export async function loadLimitRules(): Promise<LimitRule[]> {
  const rows = await db
    .select()
    .from(schema.purchaseLimitRules)
    .where(
      and(
        sql`${schema.purchaseLimitRules.effectiveFrom} <= now()`,
        sql`(${schema.purchaseLimitRules.effectiveUntil} is null
             or ${schema.purchaseLimitRules.effectiveUntil} > now())`,
      ),
    )

  if (rows.length === 0) return FALLBACK_LIMIT_RULES

  return rows.map((row) => ({
    ruleId: row.id,
    cannabisClass: row.cannabisClass,
    equivalentGramsPerGram: Number(row.equivalentGramsPerGram),
    dailyEquivalentGramsCap: Number(row.dailyEquivalentGramsCap),
    dailyConcentrateGramsCap:
      row.dailyConcentrateGramsCap === null ? null : Number(row.dailyConcentrateGramsCap),
  }))
}

/**
 * What the customer has already bought today.
 *
 * "Today" is the last 24 hours rather than a calendar day, deliberately: a
 * calendar boundary lets someone buy the daily maximum at 23:55 and again at
 * 00:05. A rolling window is the stricter reading, and with a licence at stake
 * the stricter reading is the right default. Cancelled and expired orders do
 * not count.
 */
export async function priorPurchasesToday(userId: string) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [row] = await db
    .select({
      equivalent: sql<string>`coalesce(sum(${schema.orders.totalEquivalentGrams}), 0)`,
      concentrate: sql<string>`coalesce(sum(${schema.orders.totalConcentrateGrams}), 0)`,
    })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.userId, userId),
        gte(schema.orders.placedAt, since),
        inArray(schema.orders.currentStatus, ['placed', 'preparing', 'ready', 'completed']),
      ),
    )

  return {
    equivalentGrams: Number(row?.equivalent ?? 0),
    concentrateGrams: Number(row?.concentrate ?? 0),
  }
}

/** Catalog facts for a set of variants, resolved once and snapshotted. */
async function loadVariantFacts(variantIds: string[]) {
  if (variantIds.length === 0) return []

  return db
    .select({
      variantId: schema.productVariants.id,
      sku: schema.productVariants.sku,
      label: schema.productVariants.label,
      unitPriceCents: schema.productVariants.priceCents,
      inventoryQuantity: schema.productVariants.inventoryQuantity,
      reservedQuantity: schema.productVariants.reservedQuantity,
      active: schema.productVariants.active,
      deletedAt: schema.productVariants.deletedAt,
      cannabisClass: schema.productVariants.cannabisClass,
      weightGrams: schema.productVariants.weightGrams,
      thcPercent: schema.products.thcPercent,
      cbdPercent: schema.products.cbdPercent,
      productName: schema.products.name,
      productStatus: schema.products.status,
      productDeletedAt: schema.products.deletedAt,
      categoryName: schema.categories.name,
      brandName: schema.brands.name,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
    .innerJoin(schema.categories, eq(schema.products.categoryId, schema.categories.id))
    .innerJoin(schema.brands, eq(schema.products.brandId, schema.brands.id))
    .where(inArray(schema.productVariants.id, variantIds))
}

export type DraftFailure =
  | { kind: 'empty_bag' }
  | { kind: 'no_store' }
  | { kind: 'unavailable'; items: string[] }
  | { kind: 'insufficient_stock'; failures: ReservationFailure[] }
  | { kind: 'limit_exceeded'; evaluation: LimitEvaluation }

export type DraftResult =
  | { ok: true; orderId: string; orderNumber: string }
  | { ok: false; failure: DraftFailure }

/**
 * Creates a checkout draft and holds the stock for it.
 *
 * ONE TRANSACTION. Reserving stock, writing the order and writing its lines
 * either all happen or none do — a hold with no order behind it is stock lost
 * until someone notices.
 *
 * Compliance is checked BEFORE the reservation is kept. A blocked order must
 * not leave inventory held, which is why the limit evaluation runs inside the
 * transaction and a failure rolls the whole thing back.
 */
export async function createDraft(params: {
  userId: string
  userEmail: string
  userName: string | null
  userPhone: string | null
  dateOfBirth: string | null
  cartLines: { variantId: string; quantity: number }[]
}): Promise<DraftResult> {
  if (params.cartLines.length === 0) return { ok: false, failure: { kind: 'empty_bag' } }

  const [store] = await db
    .select({ id: schema.stores.id })
    .from(schema.stores)
    .where(eq(schema.stores.pickupEnabled, true))
    .limit(1)

  if (!store) return { ok: false, failure: { kind: 'no_store' } }

  const facts = await loadVariantFacts(params.cartLines.map((l) => l.variantId))
  const byVariant = new Map(facts.map((f) => [f.variantId, f]))

  const unavailable = params.cartLines.filter((line) => {
    const fact = byVariant.get(line.variantId)
    return (
      !fact ||
      !fact.active ||
      fact.deletedAt !== null ||
      fact.productStatus !== 'active' ||
      fact.productDeletedAt !== null
    )
  })
  if (unavailable.length > 0) {
    return {
      ok: false,
      failure: {
        kind: 'unavailable',
        items: unavailable.map((l) => byVariant.get(l.variantId)?.productName ?? 'An item'),
      },
    }
  }

  const rates: TaxRates = {
    exciseBps: DEFAULT_EXCISE_TAX_BPS,
    salesBps: DEFAULT_SALES_TAX_BPS,
  }
  const priced = priceOrder(
    params.cartLines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceCents: byVariant.get(line.variantId)!.unitPriceCents,
    })),
    rates,
  )

  const rules = await loadLimitRules()
  const prior = await priorPurchasesToday(params.userId)
  const evaluation = evaluateOrderLimits(
    params.cartLines.map((line) => {
      const fact = byVariant.get(line.variantId)!
      return {
        variantId: line.variantId,
        quantity: line.quantity,
        cannabisClass: fact.cannabisClass,
        unitWeightGrams: fact.weightGrams === null ? null : Number(fact.weightGrams),
      }
    }),
    rules,
    prior,
  )

  if (!evaluation.allowed) {
    return { ok: false, failure: { kind: 'limit_exceeded', evaluation } }
  }

  let outcome: DraftResult = { ok: false, failure: { kind: 'empty_bag' } }

  await db.transaction(async (tx) => {
    /** Any previous draft is abandoned before a new one takes stock. */
    const [existing] = await tx
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(
        and(eq(schema.orders.userId, params.userId), eq(schema.orders.currentStatus, 'draft')),
      )
      .limit(1)

    if (existing) {
      await releaseDraftWithin(tx, existing.id, 'system', null, 'superseded by a new draft')
    }

    const failures = await reserveStock(
      tx,
      params.cartLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    )
    if (failures.length > 0) {
      outcome = { ok: false, failure: { kind: 'insufficient_stock', failures } }
      /** Rolls back the partial hold. */
      throw new RollbackSignal()
    }

    const orderNumber = generateOrderNumber()
    const [order] = await tx
      .insert(schema.orders)
      .values({
        orderNumber,
        userId: params.userId,
        storeId: store.id,
        currentStatus: 'draft',
        fulfilmentType: 'pickup',
        inventoryState: 'reserved',
        /** Database time, so expiry never depends on an app server's clock. */
        reservedUntil: sql`now() + interval '${sql.raw(String(RESERVATION_TTL_MINUTES))} minutes'`,
        subtotalCents: priced.subtotalCents,
        exciseTaxCents: priced.exciseTaxCents,
        salesTaxCents: priced.salesTaxCents,
        totalCents: priced.totalCents,
        exciseTaxRateBps: rates.exciseBps,
        salesTaxRateBps: rates.salesBps,
        customerEmail: params.userEmail,
        customerName: params.userName,
        customerPhone: params.userPhone,
        dateOfBirthAtPurchase: params.dateOfBirth,
        totalEquivalentGrams: String(evaluation.totalEquivalentGrams),
        totalConcentrateGrams: String(evaluation.totalConcentrateGrams),
      })
      .returning({ id: schema.orders.id, orderNumber: schema.orders.orderNumber })

    const limitByVariant = new Map(evaluation.lines.map((l) => [l.variantId, l]))

    await tx.insert(schema.orderLines).values(
      priced.lines.map((line) => {
        const fact = byVariant.get(line.variantId)!
        const limit = limitByVariant.get(line.variantId)!
        return {
          orderId: order.id,
          variantId: line.variantId,
          quantity: line.quantity,
          sku: fact.sku,
          productName: fact.productName,
          variantLabel: fact.label,
          categoryName: fact.categoryName,
          brandName: fact.brandName,
          unitPriceCents: line.unitPriceCents,
          lineSubtotalCents: line.lineSubtotalCents,
          lineExciseTaxCents: line.lineExciseTaxCents,
          lineSalesTaxCents: line.lineSalesTaxCents,
          lineTotalCents: line.lineTotalCents,
          cannabisClass: fact.cannabisClass,
          unitWeightGrams: fact.weightGrams,
          thcPercent: fact.thcPercent,
          cbdPercent: fact.cbdPercent,
          equivalentGrams: String(limit.equivalentGrams),
          concentrateGrams: String(limit.concentrateGrams),
          equivalentFactorApplied: String(limit.equivalentFactorApplied),
          /** The published rule that authorised this line's contribution. */
          purchaseLimitRuleId: limit.ruleIdApplied,
        }
      }),
    )

    await tx.insert(schema.fulfilments).values({
      orderId: order.id,
      type: 'pickup',
      storeId: store.id,
    })

    await recordTransition(tx, {
      orderId: order.id,
      eventType: 'DRAFT_CREATED',
      toStatus: 'draft',
      actorType: 'customer',
      actorId: params.userId,
    })
    await recordTransition(tx, {
      orderId: order.id,
      eventType: 'INVENTORY_RESERVED',
      actorType: 'system',
      reason: `${RESERVATION_TTL_MINUTES} minute hold`,
    })

    outcome = { ok: true, orderId: order.id, orderNumber: order.orderNumber }
  }).catch((error) => {
    if (!(error instanceof RollbackSignal)) throw error
  })

  return outcome
}

/** Rolls a transaction back without turning a business outcome into an error. */
class RollbackSignal extends Error {
  constructor() {
    super('rollback')
    this.name = 'RollbackSignal'
  }
}

/**
 * Releases a draft's hold. Idempotent.
 *
 * The inventory claim is what makes the retry safe: the second caller finds the
 * state already `released` and returns stock zero times.
 */
export async function releaseDraftWithin(
  tx: DbExecutor,
  orderId: string,
  actorType: 'customer' | 'staff' | 'system',
  actorId: string | null,
  reason: string,
): Promise<boolean> {
  const claimed = await claimInventoryTransition(tx, orderId, 'reserved', 'released')
  if (!claimed) return false

  const lines = await tx
    .select({
      variantId: schema.orderLines.variantId,
      quantity: schema.orderLines.quantity,
    })
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, orderId))

  await releaseStock(tx, lines)

  await recordTransition(tx, {
    orderId,
    eventType: 'INVENTORY_RELEASED',
    toStatus: 'expired',
    actorType,
    actorId,
    reason,
  })

  return true
}

export type PlacementFailure =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'price_changed'; previousTotalCents: number; currentTotalCents: number }
  | { kind: 'unavailable'; items: string[] }
  | { kind: 'limit_exceeded'; evaluation: LimitEvaluation }

export type PlacementResult =
  | { ok: true; orderId: string; orderNumber: string; alreadyPlaced: boolean }
  | { ok: false; failure: PlacementFailure }

/**
 * Places a draft. The one operation that must be exactly-once.
 *
 * REVALIDATES EVERYTHING FIRST — availability, prices, limits — because the
 * draft may be fifteen minutes old and the customer is about to be committed to
 * a number. If the total moved, placement STOPS and shows them rather than
 * quietly charging something they did not agree to.
 *
 * Then, in one transaction: claim the draft, convert the hold into a sale,
 * record the payment obligation, and write the events. The claim is a
 * conditional UPDATE on `current_status = 'draft'`, so a double-submitted form
 * produces one order and one no-op.
 *
 * A compliance failure here rolls back completely: no placed order, and the
 * hold is left intact for the customer to fix their basket, not stranded.
 */
export async function placeOrder(params: {
  userId: string
  orderId: string
  idempotencyKey: string
  actorId: string
}): Promise<PlacementResult> {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.id, params.orderId), eq(schema.orders.userId, params.userId)))
    .limit(1)

  if (!order) return { ok: false, failure: { kind: 'not_found' } }

  /**
   * A retry of a placement that already succeeded. Reported as success with
   * `alreadyPlaced`, because from the customer's side it did.
   */
  if (order.currentStatus !== 'draft') {
    if (order.idempotencyKey === params.idempotencyKey && order.placedAt) {
      return {
        ok: true,
        orderId: order.id,
        orderNumber: order.orderNumber,
        alreadyPlaced: true,
      }
    }
    return { ok: false, failure: { kind: 'expired' } }
  }

  /** Database time. Never `Date.now()` against a stored timestamp. */
  const [stillValid] = await db
    .select({ ok: sql<boolean>`${schema.orders.reservedUntil} > now()` })
    .from(schema.orders)
    .where(eq(schema.orders.id, params.orderId))

  if (!stillValid?.ok) return { ok: false, failure: { kind: 'expired' } }

  const lines = await db
    .select({
      variantId: schema.orderLines.variantId,
      quantity: schema.orderLines.quantity,
    })
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, params.orderId))

  const facts = await loadVariantFacts(lines.map((l) => l.variantId))
  const byVariant = new Map(facts.map((f) => [f.variantId, f]))

  const gone = lines.filter((line) => {
    const fact = byVariant.get(line.variantId)
    return (
      !fact ||
      !fact.active ||
      fact.deletedAt !== null ||
      fact.productStatus !== 'active' ||
      fact.productDeletedAt !== null
    )
  })
  if (gone.length > 0) {
    return {
      ok: false,
      failure: {
        kind: 'unavailable',
        items: gone.map((l) => byVariant.get(l.variantId)?.productName ?? 'An item'),
      },
    }
  }

  const rates: TaxRates = {
    exciseBps: order.exciseTaxRateBps,
    salesBps: order.salesTaxRateBps,
  }
  const repriced = priceOrder(
    lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceCents: byVariant.get(line.variantId)!.unitPriceCents,
    })),
    rates,
  )

  if (repriced.totalCents !== order.totalCents) {
    return {
      ok: false,
      failure: {
        kind: 'price_changed',
        previousTotalCents: order.totalCents,
        currentTotalCents: repriced.totalCents,
      },
    }
  }

  const rules = await loadLimitRules()
  const prior = await priorPurchasesToday(params.userId)
  const evaluation = evaluateOrderLimits(
    lines.map((line) => {
      const fact = byVariant.get(line.variantId)!
      return {
        variantId: line.variantId,
        quantity: line.quantity,
        cannabisClass: fact.cannabisClass,
        unitWeightGrams: fact.weightGrams === null ? null : Number(fact.weightGrams),
      }
    }),
    rules,
    prior,
  )

  if (!evaluation.allowed) {
    return { ok: false, failure: { kind: 'limit_exceeded', evaluation } }
  }

  let result: PlacementResult = { ok: false, failure: { kind: 'expired' } }

  await db.transaction(async (tx) => {
    /** The exactly-once claim. */
    const [claimed] = await tx
      .update(schema.orders)
      .set({
        currentStatus: 'placed',
        idempotencyKey: params.idempotencyKey,
        placedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.orders.id, params.orderId), eq(schema.orders.currentStatus, 'draft')),
      )
      .returning({ id: schema.orders.id, orderNumber: schema.orders.orderNumber })

    if (!claimed) return // lost the race; the winner placed it

    /**
     * Re-snapshot the compliance basis at the moment of placement.
     *
     * A draft may have been created under one version of a rule and placed
     * under its successor — the window is only fifteen minutes, but a scheduled
     * change can land inside it, and that is precisely the case worth getting
     * right. The evaluation above already used the rule in force NOW, so the
     * line must record that rule and not the one the draft was built with.
     *
     * This is the only write to these columns after placement. Once the order
     * leaves `draft` its rule id is fixed, which is what makes "existing orders
     * keep their original rule" true rather than aspirational.
     */
    for (const line of evaluation.lines) {
      await tx
        .update(schema.orderLines)
        .set({
          equivalentGrams: String(line.equivalentGrams),
          concentrateGrams: String(line.concentrateGrams),
          equivalentFactorApplied: String(line.equivalentFactorApplied),
          purchaseLimitRuleId: line.ruleIdApplied,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.orderLines.orderId, params.orderId),
            eq(schema.orderLines.variantId, line.variantId),
          ),
        )
    }

    await tx
      .update(schema.orders)
      .set({
        totalEquivalentGrams: String(evaluation.totalEquivalentGrams),
        totalConcentrateGrams: String(evaluation.totalConcentrateGrams),
        updatedAt: new Date(),
      })
      .where(eq(schema.orders.id, params.orderId))

    const committed = await claimInventoryTransition(
      tx,
      params.orderId,
      'reserved',
      'committed',
    )
    if (committed) await commitStock(tx, lines)

    /**
     * The payment obligation, recorded at placement and collected at handoff.
     * The partial unique index permits only one open payment per order, so a
     * retry cannot create a second obligation.
     */
    await tx
      .insert(schema.payments)
      .values({
        orderId: params.orderId,
        method: 'cash',
        status: 'awaiting_collection',
        amountCents: order.totalCents,
      })
      .onConflictDoNothing()

    await recordTransition(tx, {
      orderId: params.orderId,
      eventType: 'ORDER_PLACED',
      fromStatus: 'draft',
      toStatus: 'placed',
      actorType: 'customer',
      actorId: params.actorId,
    })
    await recordTransition(tx, {
      orderId: params.orderId,
      eventType: 'INVENTORY_COMMITTED',
      actorType: 'system',
    })
    await recordTransition(tx, {
      orderId: params.orderId,
      eventType: 'PAYMENT_RECORDED',
      actorType: 'system',
      reason: 'cash due at pickup',
    })

    result = {
      ok: true,
      orderId: claimed.id,
      orderNumber: claimed.orderNumber,
      alreadyPlaced: false,
    }
  })

  return result
}

/**
 * Cancels a placed order and returns its stock. Idempotent.
 *
 * A second cancellation finds the status already terminal and reports success
 * without restocking again — the same principle as a retried release.
 */
export async function cancelOrder(params: {
  orderId: string
  actorType: 'customer' | 'staff' | 'system'
  actorId: string | null
  reason: string
}): Promise<{ ok: boolean; alreadyCancelled: boolean }> {
  let alreadyCancelled = false
  let ok = false

  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.orders)
      .set({ currentStatus: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.orders.id, params.orderId),
          inArray(schema.orders.currentStatus, ['placed', 'preparing', 'ready']),
        ),
      )
      .returning({ id: schema.orders.id })

    if (!claimed) {
      const [current] = await tx
        .select({ status: schema.orders.currentStatus })
        .from(schema.orders)
        .where(eq(schema.orders.id, params.orderId))
        .limit(1)
      alreadyCancelled = current?.status === 'cancelled'
      ok = alreadyCancelled
      return
    }

    const released = await claimInventoryTransition(tx, params.orderId, 'committed', 'released')
    if (released) {
      const lines = await tx
        .select({
          variantId: schema.orderLines.variantId,
          quantity: schema.orderLines.quantity,
        })
        .from(schema.orderLines)
        .where(eq(schema.orderLines.orderId, params.orderId))
      await restockCommitted(tx, lines)
    }

    await tx
      .update(schema.payments)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(schema.payments.orderId, params.orderId),
          eq(schema.payments.status, 'awaiting_collection'),
        ),
      )

    await recordTransition(tx, {
      orderId: params.orderId,
      eventType: 'ORDER_CANCELLED',
      toStatus: 'cancelled',
      actorType: params.actorType,
      actorId: params.actorId,
      reason: params.reason,
    })
    await recordTransition(tx, {
      orderId: params.orderId,
      eventType: 'INVENTORY_RELEASED',
      actorType: 'system',
      reason: 'order cancelled',
    })

    ok = true
  })

  return { ok, alreadyCancelled }
}

/**
 * Collects the cash and completes the order. Idempotent, staff-only.
 *
 * `recipientIdChecked` is not a formality: the stored date of birth is a claim
 * the customer typed, and the physical check at handoff is the one that
 * actually satisfies the licence. Completion refuses without it.
 */
export async function collectPaymentAndComplete(params: {
  orderId: string
  staffId: string
  idChecked: boolean
}): Promise<{ ok: boolean; reason?: string; alreadyCollected: boolean }> {
  if (!params.idChecked) {
    return { ok: false, reason: 'id_not_checked', alreadyCollected: false }
  }

  let alreadyCollected = false
  let ok = false

  await db.transaction(async (tx) => {
    const [payment] = await tx
      .update(schema.payments)
      .set({
        status: 'collected',
        collectedAt: new Date(),
        collectedBy: params.staffId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.payments.orderId, params.orderId),
          eq(schema.payments.status, 'awaiting_collection'),
        ),
      )
      .returning({ id: schema.payments.id })

    if (!payment) {
      const [existing] = await tx
        .select({ status: schema.payments.status })
        .from(schema.payments)
        .where(eq(schema.payments.orderId, params.orderId))
        .orderBy(desc(schema.payments.createdAt))
        .limit(1)
      alreadyCollected = existing?.status === 'collected'
      ok = alreadyCollected
      if (!alreadyCollected) return
    }

    await tx
      .update(schema.fulfilments)
      .set({
        handedOffAt: new Date(),
        handedOffBy: params.staffId,
        recipientIdChecked: true,
        updatedAt: new Date(),
      })
      .where(eq(schema.fulfilments.orderId, params.orderId))

    const [completed] = await tx
      .update(schema.orders)
      .set({
        currentStatus: 'completed',
        completedAt: new Date(),
        idVerifiedAt: new Date(),
        idVerifiedBy: params.staffId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.orders.id, params.orderId),
          inArray(schema.orders.currentStatus, ['placed', 'preparing', 'ready']),
        ),
      )
      .returning({ id: schema.orders.id })

    if (completed) {
      await recordTransition(tx, {
        orderId: params.orderId,
        eventType: 'PAYMENT_COLLECTED',
        actorType: 'staff',
        actorId: params.staffId,
      })
      await recordTransition(tx, {
        orderId: params.orderId,
        eventType: 'AGE_VERIFIED_AT_HANDOFF',
        actorType: 'staff',
        actorId: params.staffId,
        reason: 'government photo ID checked',
      })
      await recordTransition(tx, {
        orderId: params.orderId,
        eventType: 'ORDER_COMPLETED',
        toStatus: 'completed',
        actorType: 'staff',
        actorId: params.staffId,
      })
      ok = true
    }
  })

  return { ok, alreadyCollected }
}

/**
 * Releases every draft whose window has passed.
 *
 * Safe to run concurrently with itself and with a placement: each order is
 * claimed by a conditional UPDATE, so a draft being placed at the same moment
 * is either placed or expired, never both.
 */
export async function sweepExpiredDrafts(): Promise<number> {
  const expired = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.currentStatus, 'draft'),
        eq(schema.orders.inventoryState, 'reserved'),
        sql`${schema.orders.reservedUntil} <= now()`,
      ),
    )

  let released = 0
  for (const order of expired) {
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(schema.orders)
        .set({ currentStatus: 'expired', updatedAt: new Date() })
        .where(
          and(
            eq(schema.orders.id, order.id),
            eq(schema.orders.currentStatus, 'draft'),
            sql`${schema.orders.reservedUntil} <= now()`,
          ),
        )
        .returning({ id: schema.orders.id })

      if (!claimed[0]) return

      const inventoryClaimed = await claimInventoryTransition(
        tx,
        order.id,
        'reserved',
        'released',
      )
      if (inventoryClaimed) {
        const lines = await tx
          .select({
            variantId: schema.orderLines.variantId,
            quantity: schema.orderLines.quantity,
          })
          .from(schema.orderLines)
          .where(eq(schema.orderLines.orderId, order.id))
        await releaseStock(tx, lines)
      }

      await recordTransition(tx, {
        orderId: order.id,
        eventType: 'DRAFT_EXPIRED',
        fromStatus: 'draft',
        toStatus: 'expired',
        actorType: 'system',
        reason: 'reservation window elapsed',
      })
      released += 1
    })
  }

  return released
}
