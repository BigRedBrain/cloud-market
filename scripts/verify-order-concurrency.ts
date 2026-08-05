/**
 * Concurrency and idempotency tests for checkout.
 *
 *   npx tsx --conditions=react-server scripts/verify-order-concurrency.ts
 *
 * These run against the real database and the real domain functions, because
 * the properties under test are properties of the DATABASE — a conditional
 * UPDATE claiming exactly one winner cannot be tested with mocks, and mocking
 * it would only assert that I mocked it correctly.
 *
 * DEVELOPMENT ONLY. It refuses the production fingerprint, builds its own
 * fixtures, and removes every row it creates by exact id.
 *
 * The five races:
 *
 *   1. two customers, one unit left
 *   2. two placements of the same draft at the same instant
 *   3. the expiry sweep racing a placement
 *   4. a duplicate placement request (same idempotency key)
 *   5. a duplicate cancellation
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, schema } from '../lib/db'
import {
  cancelOrder,
  createDraft,
  placeOrder,
  sweepExpiredDrafts,
} from '../lib/orders/core'

loadEnv({ path: '.env.local', quiet: true })

const PRODUCTION_FP = '2b968b3cbe06'
const fp = (u: string) =>
  createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}
if (fp(process.env.DATABASE_URL) === PRODUCTION_FP) {
  console.error('REFUSING: this is production.')
  process.exit(1)
}



let passed = 0
let failed = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`    ok    ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (t: string) => console.log(`\n${t}`)

const stamp = Date.now()
const created = {
  users: [] as string[],
  variants: [] as string[],
  products: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  stores: [] as string[],
  orders: [] as string[],
}

/**
 * Fixtures live only in this database and are removed by id at the end.
 *
 * Each call gets its own suffix because every race below needs a variant with a
 * known, untouched stock level — sharing one would make the tests depend on the
 * order they run in.
 */
let fixtureSeq = 0
async function makeFixtures(stock: number) {
  const tag = `${stamp}-${(fixtureSeq += 1)}`

  const [store] = await db
    .insert(schema.stores)
    .values({
      name: `Concurrency Store ${tag}`,
      slug: `concurrency-store-${tag}`,
      addressLine1: '1 Test Way',
      email: 'concurrency@example.invalid',
      phone: '+13135550100',
      city: 'Detroit',
      state: 'MI',
      postalCode: '48201',
      pickupEnabled: true,
      status: 'active',
      licenseNumber: `TEST-${tag}`,
      licenseType: 'adult_use_retailer',
    })
    .returning({ id: schema.stores.id })
  created.stores.push(store.id)

  const [brand] = await db
    .insert(schema.brands)
    .values({ name: `Brand ${tag}`, slug: `brand-${tag}` })
    .returning({ id: schema.brands.id })
  created.brands.push(brand.id)

  const [category] = await db
    .insert(schema.categories)
    .values({ name: `Category ${tag}`, slug: `category-${tag}` })
    .returning({ id: schema.categories.id })
  created.categories.push(category.id)

  const [product] = await db
    .insert(schema.products)
    .values({
      name: `Concurrency Product ${tag}`,
      slug: `concurrency-product-${tag}`,
      categoryId: category.id,
      brandId: brand.id,
      status: 'active',
    })
    .returning({ id: schema.products.id })
  created.products.push(product.id)

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product.id,
      sku: `CONC-${tag}`,
      label: '3.5g',
      priceCents: 4500,
      inventoryQuantity: stock,
      reservedQuantity: 0,
      active: true,
      cannabisClass: 'flower',
      weightGrams: '3.500',
      /** The compliance measurement. Without it checkout refuses the line. */
      measurementBasis: 'net_weight_grams',
      measurementValue: '3.5000',
    })
    .returning({ id: schema.productVariants.id })
  created.variants.push(variant.id)

  return { storeId: store.id, variantId: variant.id }
}

async function makeCustomer(label: string) {
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `conc.${label}.${stamp}@example.invalid`,
      passwordHash: 'x',
      dateOfBirth: '1990-01-01',
      status: 'active',
      role: 'customer',
      emailVerifiedAt: new Date(),
      name: `Concurrency ${label}`,
    })
    .returning({ id: schema.users.id })
  created.users.push(user.id)
  return user.id
}

const draftFor = (userId: string, variantId: string, quantity: number) =>
  createDraft({
    userId,
    userEmail: `conc.${userId}@example.invalid`,
    userName: 'Concurrency',
    userPhone: null,
    dateOfBirth: '1990-01-01',
    cartLines: [{ variantId, quantity }],
  })

const stockOf = async (variantId: string) => {
  const [row] = await db
    .select({
      onHand: schema.productVariants.inventoryQuantity,
      held: schema.productVariants.reservedQuantity,
    })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.id, variantId))
  return row
}

async function main() {
  console.log('Checkout concurrency and idempotency')
  console.log(`database ${fp(process.env.DATABASE_URL!)} (not production)`)

  /* ============================================ 1. LAST AVAILABLE UNIT === */
  section('[1] Two customers, one unit left')
  {
    const { variantId } = await makeFixtures(1)
    const alice = await makeCustomer('alice')
    const bob = await makeCustomer('bob')

    /** Fired together. Exactly one may hold the unit. */
    const [a, b] = await Promise.all([
      draftFor(alice, variantId, 1),
      draftFor(bob, variantId, 1),
    ])
    for (const r of [a, b]) if (r.ok) created.orders.push(r.orderId)

    const winners = [a, b].filter((r) => r.ok)
    check('exactly one draft got the unit', winners.length === 1, `${winners.length} won`)

    const loser = [a, b].find((r) => !r.ok)
    check(
      'the loser is told stock ran out, not something vague',
      loser !== undefined && !loser.ok && loser.failure.kind === 'insufficient_stock',
      !loser || loser.ok ? 'no loser' : loser.failure.kind,
    )

    const stock = await stockOf(variantId)
    check('exactly one unit is held', stock.held === 1, `held ${stock.held}`)
    check('on-hand is untouched until placement', stock.onHand === 1, `${stock.onHand}`)
  }

  /* ======================================== 2. SIMULTANEOUS PLACEMENTS === */
  section('[2] Two placements of the same draft, at once')
  {
    const { variantId } = await makeFixtures(5)
    const carol = await makeCustomer('carol')
    const draft = await draftFor(carol, variantId, 2)
    if (!draft.ok) throw new Error('fixture draft failed')
    created.orders.push(draft.orderId)

    const [first, second] = await Promise.all([
      placeOrder({
        userId: carol,
        orderId: draft.orderId,
        idempotencyKey: `key-a-${stamp}`,
        actorId: carol,
      }),
      placeOrder({
        userId: carol,
        orderId: draft.orderId,
        idempotencyKey: `key-b-${stamp}`,
        actorId: carol,
      }),
    ])

    const succeeded = [first, second].filter((r) => r.ok)
    check('exactly one placement succeeded', succeeded.length === 1, `${succeeded.length}`)

    const stock = await stockOf(variantId)
    check('stock was consumed exactly once', stock.onHand === 3, `on hand ${stock.onHand}`)
    check('no hold is left dangling', stock.held === 0, `held ${stock.held}`)

    const events = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.orderEvents)
      .where(
        and(
          eq(schema.orderEvents.orderId, draft.orderId),
          eq(schema.orderEvents.eventType, 'ORDER_PLACED'),
        ),
      )
    check('exactly one ORDER_PLACED event', events[0].n === 1, `${events[0].n}`)
  }

  /* ================================ 3. DUPLICATE PLACEMENT (SAME KEY) === */
  section('[3] Duplicate placement request, same idempotency key')
  {
    const { variantId } = await makeFixtures(5)
    const dave = await makeCustomer('dave')
    const draft = await draftFor(dave, variantId, 1)
    if (!draft.ok) throw new Error('fixture draft failed')
    created.orders.push(draft.orderId)

    const key = `dupe-${stamp}`
    const first = await placeOrder({
      userId: dave,
      orderId: draft.orderId,
      idempotencyKey: key,
      actorId: dave,
    })
    const retry = await placeOrder({
      userId: dave,
      orderId: draft.orderId,
      idempotencyKey: key,
      actorId: dave,
    })

    check('the first placement succeeded', first.ok)
    check('the retry also reports success', retry.ok)
    check(
      'the retry is flagged as already placed, not a new order',
      retry.ok && retry.alreadyPlaced,
    )
    check(
      'both report the same order number',
      first.ok && retry.ok && first.orderNumber === retry.orderNumber,
    )

    const stock = await stockOf(variantId)
    check('stock moved once, not twice', stock.onHand === 4, `on hand ${stock.onHand}`)

    const orderCount = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.orders)
      .where(eq(schema.orders.userId, dave))
    check('only one order exists for the customer', orderCount[0].n === 1, `${orderCount[0].n}`)

    const payments = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, draft.orderId))
    check('exactly one payment obligation', payments[0].n === 1, `${payments[0].n}`)
  }

  /* ==================================== 4. EXPIRY RACING A PLACEMENT === */
  section('[4] The expiry sweep racing a placement')
  {
    const { variantId } = await makeFixtures(5)
    const erin = await makeCustomer('erin')
    const draft = await draftFor(erin, variantId, 2)
    if (!draft.ok) throw new Error('fixture draft failed')
    created.orders.push(draft.orderId)

    /** Force the window shut using DATABASE time, as production would. */
    await db
      .update(schema.orders)
      .set({ reservedUntil: sql`now() - interval '1 second'` })
      .where(eq(schema.orders.id, draft.orderId))

    const [placement, swept] = await Promise.all([
      placeOrder({
        userId: erin,
        orderId: draft.orderId,
        idempotencyKey: `race-${stamp}`,
        actorId: erin,
      }),
      sweepExpiredDrafts(),
    ])

    const [order] = await db
      .select({ status: schema.orders.currentStatus, inv: schema.orders.inventoryState })
      .from(schema.orders)
      .where(eq(schema.orders.id, draft.orderId))

    check(
      'the order ends up either placed or expired, never both',
      order.status === 'placed' || order.status === 'expired',
      order.status,
    )
    check(
      'an expired draft was not also placed',
      !(order.status === 'expired' && placement.ok),
      `status ${order.status}, placement ok=${placement.ok}`,
    )

    const stock = await stockOf(variantId)
    check(
      'stock accounting is consistent with the outcome',
      order.status === 'placed'
        ? stock.onHand === 3 && stock.held === 0
        : stock.onHand === 5 && stock.held === 0,
      `status ${order.status}, on hand ${stock.onHand}, held ${stock.held}, swept ${swept}`,
    )
    check('no stock is left held either way', stock.held === 0, `held ${stock.held}`)
  }

  /* ==================================== 5. DUPLICATE CANCELLATION === */
  section('[5] Duplicate cancellation')
  {
    const { variantId } = await makeFixtures(5)
    const frank = await makeCustomer('frank')
    const draft = await draftFor(frank, variantId, 3)
    if (!draft.ok) throw new Error('fixture draft failed')
    created.orders.push(draft.orderId)

    await placeOrder({
      userId: frank,
      orderId: draft.orderId,
      idempotencyKey: `cancel-${stamp}`,
      actorId: frank,
    })
    const afterPlace = await stockOf(variantId)
    check('placement consumed the stock', afterPlace.onHand === 2, `${afterPlace.onHand}`)

    const first = await cancelOrder({
      orderId: draft.orderId,
      actorType: 'customer',
      actorId: frank,
      reason: 'test',
    })
    const second = await cancelOrder({
      orderId: draft.orderId,
      actorType: 'customer',
      actorId: frank,
      reason: 'test again',
    })

    check('the first cancellation succeeded', first.ok && !first.alreadyCancelled)
    check('the second reports success without repeating the work',
      second.ok && second.alreadyCancelled)

    const stock = await stockOf(variantId)
    check('stock was returned exactly once', stock.onHand === 5, `on hand ${stock.onHand}`)
    check('no phantom hold was created', stock.held === 0, `held ${stock.held}`)

    const events = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.orderEvents)
      .where(
        and(
          eq(schema.orderEvents.orderId, draft.orderId),
          eq(schema.orderEvents.eventType, 'ORDER_CANCELLED'),
        ),
      )
    check('exactly one ORDER_CANCELLED event', events[0].n === 1, `${events[0].n}`)

    /** Simultaneous, not sequential — the harder version of the same race. */
    const { variantId: v2 } = await makeFixtures(5)
    const grace = await makeCustomer('grace')
    const d2 = await draftFor(grace, v2, 2)
    if (!d2.ok) throw new Error('fixture draft failed')
    created.orders.push(d2.orderId)
    await placeOrder({
      userId: grace,
      orderId: d2.orderId,
      idempotencyKey: `cancel2-${stamp}`,
      actorId: grace,
    })

    await Promise.all([
      cancelOrder({ orderId: d2.orderId, actorType: 'customer', actorId: grace, reason: 'a' }),
      cancelOrder({ orderId: d2.orderId, actorType: 'customer', actorId: grace, reason: 'b' }),
    ])

    const s2 = await stockOf(v2)
    check('simultaneous cancellations restock exactly once', s2.onHand === 5, `${s2.onHand}`)
  }

  /* ================================================= 6. STATE INTEGRITY === */
  section('[6] Events and projection agree')
  {
    const orders = await db
      .select({ id: schema.orders.id, status: schema.orders.currentStatus })
      .from(schema.orders)
      /**
       * inArray, not a hand-written any(). Interpolating a JS array into raw SQL
       * sends it as a tuple and Postgres rejects it — the same malformed-array
       * bug the bag suite caught in Phase 3.
       */
      .where(inArray(schema.orders.id, created.orders))

    let mismatches = 0
    for (const order of orders) {
      const [latest] = await db
        .select({ toStatus: schema.orderEvents.toStatus })
        .from(schema.orderEvents)
        .where(
          and(
            eq(schema.orderEvents.orderId, order.id),
            sql`${schema.orderEvents.toStatus} is not null`,
          ),
        )
        .orderBy(sql`${schema.orderEvents.occurredAt} desc`)
        .limit(1)
      if (latest && latest.toStatus !== order.status) mismatches += 1
    }
    check(
      'current_status matches the latest event for every order',
      mismatches === 0,
      `${mismatches} mismatched`,
    )
  }

  /* ========================================================= CLEANUP === */
  section('[7] Cleanup by exact id')
  {
    for (const id of created.orders) {
      await db.delete(schema.orderEvents).where(eq(schema.orderEvents.orderId, id))
      await db.delete(schema.orderLines).where(eq(schema.orderLines.orderId, id))
      await db.delete(schema.payments).where(eq(schema.payments.orderId, id))
      await db.delete(schema.fulfilments).where(eq(schema.fulfilments.orderId, id))
    }
    for (const id of created.orders) {
      await db.delete(schema.orders).where(eq(schema.orders.id, id))
    }
    for (const id of created.users) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, id))
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, id))
      await db.delete(schema.orders).where(eq(schema.orders.userId, id))
      await db.delete(schema.users).where(eq(schema.users.id, id))
    }
    for (const id of created.variants) {
      await db.delete(schema.productVariants).where(eq(schema.productVariants.id, id))
    }
    for (const id of created.products) {
      await db.delete(schema.products).where(eq(schema.products.id, id))
    }
    for (const id of created.categories) {
      await db.delete(schema.categories).where(eq(schema.categories.id, id))
    }
    for (const id of created.brands) {
      await db.delete(schema.brands).where(eq(schema.brands.id, id))
    }
    for (const id of created.stores) {
      await db.delete(schema.stores).where(eq(schema.stores.id, id))
    }

    const [leftover] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(sql`${schema.users.email} like ${'conc.%.' + stamp + '@example.invalid'}`)
    check('every fixture user was removed by id', leftover.n === 0, `${leftover.n} left`)
  }

  console.log('\n==========================================================')
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  console.log('==========================================================')
  process.exitCode = failed ? 1 : 0
}

void main()
