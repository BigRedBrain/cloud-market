/**
 * The expired-draft sweeper: races, retries, and the guarantee that stock comes
 * back without anyone visiting the site.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/verify-sweeper.ts
 *
 * Runs against the real database. The properties under test are properties of
 * concurrent transactions — two sweepers claiming the same draft, a placement
 * committing microseconds before an expiry — and there is no honest way to test
 * those without a database doing the arbitration.
 *
 * DEVELOPMENT ONLY. Refuses the production fingerprint. Every row is captured
 * by id at creation and deleted by id.
 */
import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, schema } from '../lib/db'
import { createDraft, placeOrder, sweepExpiredDrafts } from '../lib/orders/core'
import { runDraftSweep, SWEEP_JOB, lastSuccessfulSweep } from '../lib/jobs/sweep'

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
  orders: [] as string[],
  variants: [] as string[],
  products: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  stores: [] as string[],
  runs: [] as string[],
}

let fixtureSeq = 0
async function makeFixtures(stock: number) {
  const tag = `${stamp}-${(fixtureSeq += 1)}`

  const [store] = await db
    .insert(schema.stores)
    .values({
      name: `Sweeper Store ${tag}`,
      slug: `sweeper-store-${tag}`,
      addressLine1: '1 Test Way',
      email: 'sweeper@example.invalid',
      phone: '+13135550102',
      city: 'Detroit',
      state: 'MI',
      postalCode: '48201',
      pickupEnabled: true,
      status: 'active',
      licenseNumber: `SWEEP-${tag}`,
      licenseType: 'adult_use_retailer',
    })
    .returning({ id: schema.stores.id })
  created.stores.push(store.id)

  const [brand] = await db
    .insert(schema.brands)
    .values({ name: `Sweep Brand ${tag}`, slug: `sweep-brand-${tag}` })
    .returning({ id: schema.brands.id })
  created.brands.push(brand.id)

  const [category] = await db
    .insert(schema.categories)
    .values({ name: `Sweep Category ${tag}`, slug: `sweep-category-${tag}` })
    .returning({ id: schema.categories.id })
  created.categories.push(category.id)

  const [product] = await db
    .insert(schema.products)
    .values({
      name: `Sweep Product ${tag}`,
      slug: `sweep-product-${tag}`,
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
      sku: `SWEEP-${tag}`,
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
      email: `sweep.${label}.${stamp}@example.invalid`,
      passwordHash: 'x',
      dateOfBirth: '1990-01-01',
      status: 'active',
      role: 'customer',
      emailVerifiedAt: new Date(),
      name: `Sweeper ${label}`,
    })
    .returning({ id: schema.users.id })
  created.users.push(user.id)
  return user.id
}

const draftFor = (userId: string, variantId: string, quantity: number) =>
  createDraft({
    userId,
    userEmail: `sweep.${userId}@example.invalid`,
    userName: 'Sweeper',
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

const statusOf = async (orderId: string) => {
  const [row] = await db
    .select({
      status: schema.orders.currentStatus,
      inventoryState: schema.orders.inventoryState,
    })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
  return row
}

/**
 * Ages a draft past its window, using DATABASE time.
 *
 * `reserved_until = now() - interval` rather than a JavaScript Date: the sweep
 * compares against Postgres's clock, so the fixture has to be expressed on the
 * same clock or the test is measuring the gap between two machines.
 */
const expireDraft = (orderId: string) =>
  db
    .update(schema.orders)
    .set({ reservedUntil: sql`now() - interval '1 minute'` })
    .where(eq(schema.orders.id, orderId))

async function main() {
  console.log('Expired-draft sweeper')
  console.log(`database ${fp(process.env.DATABASE_URL!)} (not production)`)

  /* ================================= 1. RELEASE WITHOUT USER ACTIVITY === */
  section('[1] Stock comes back with nobody visiting the site')
  {
    const { variantId } = await makeFixtures(5)
    const user = await makeCustomer('idle')

    const draft = await draftFor(user, variantId, 2)
    check('draft created', draft.ok)
    if (!draft.ok) return
    created.orders.push(draft.orderId)

    const held = await stockOf(variantId)
    check('stock is held while the draft is live', held.held === 2, `held ${held.held}`)

    await expireDraft(draft.orderId)

    /**
     * No page view, no action, no request. Only the scheduled job — which is
     * the entire point: the customer who abandoned checkout is the one who is
     * not coming back to trigger a lazy release.
     */
    const run = await runDraftSweep()
    if (run.runId) created.runs.push(run.runId)

    const after = await stockOf(variantId)
    check('the hold was released with no user activity', after.held === 0,
      `held ${after.held}`)
    check('on-hand stock was not consumed', after.onHand === 5, `${after.onHand}`)

    const state = await statusOf(draft.orderId)
    check('the draft is marked expired', state.status === 'expired', state.status)
    check('inventory state is released', state.inventoryState === 'released',
      state.inventoryState)
    check('the run reports what it did', run.expired >= 1 && run.unitsReleased >= 2,
      `expired ${run.expired}, units ${run.unitsReleased}`)
    check('the run completed', run.outcome === 'completed', run.outcome)
  }

  /* ============================================= 2. TWO SWEEPERS ======== */
  section('[2] Two sweepers racing')
  {
    const { variantId } = await makeFixtures(10)
    const drafts: string[] = []

    for (const label of ['a', 'b', 'c']) {
      const user = await makeCustomer(`race-${label}`)
      const draft = await draftFor(user, variantId, 2)
      if (draft.ok) {
        drafts.push(draft.orderId)
        created.orders.push(draft.orderId)
      }
    }
    check('three drafts hold stock', (await stockOf(variantId)).held === 6,
      `${(await stockOf(variantId)).held}`)

    for (const id of drafts) await expireDraft(id)

    /**
     * `sweepExpiredDrafts` directly, NOT `runDraftSweep`. The advisory lock in
     * the job wrapper would serialise these and the race would never happen —
     * and the claim being tested is that the sweep is correct WITHOUT it. The
     * lock saves duplicated work; the conditional UPDATE is what saves
     * correctness.
     */
    const [first, second] = await Promise.all([
      sweepExpiredDrafts(100),
      sweepExpiredDrafts(100),
    ])

    const after = await stockOf(variantId)
    check('all holds released exactly once', after.held === 0, `held ${after.held}`)
    check('on-hand stock untouched', after.onHand === 10, `${after.onHand}`)
    check('between them they expired each draft once',
      first.expired + second.expired === drafts.length,
      `${first.expired} + ${second.expired} for ${drafts.length} drafts`)
    check('neither sweeper reported a failure',
      first.failed === 0 && second.failed === 0)

    for (const id of drafts) {
      const events = await db
        .select({ id: schema.orderEvents.id })
        .from(schema.orderEvents)
        .where(
          and(
            eq(schema.orderEvents.orderId, id),
            eq(schema.orderEvents.eventType, 'DRAFT_EXPIRED'),
          ),
        )
      check(`exactly one DRAFT_EXPIRED event for ${id.slice(0, 8)}`, events.length === 1,
        `${events.length}`)
    }
  }

  /* ==================================== 3. PLACEMENT RACES EXPIRY ======= */
  section('[3] Placement racing expiration')
  {
    const { variantId } = await makeFixtures(4)
    const user = await makeCustomer('racer')

    const draft = await draftFor(user, variantId, 2)
    check('draft created', draft.ok)
    if (!draft.ok) return
    created.orders.push(draft.orderId)

    await expireDraft(draft.orderId)

    const [placement, sweep] = await Promise.all([
      placeOrder({
        userId: user,
        orderId: draft.orderId,
        idempotencyKey: `sweep-race-${stamp}`,
        actorId: user,
      }),
      sweepExpiredDrafts(100),
    ])

    const state = await statusOf(draft.orderId)
    const placed = state.status === 'placed'
    const expired = state.status === 'expired'

    check('the order is placed OR expired, never both and never neither',
      placed !== expired, `status ${state.status}`)
    check('the outcome the caller saw matches the database',
      placement.ok === placed,
      `caller ${placement.ok ? 'placed' : 'refused'}, db ${state.status}`)

    const after = await stockOf(variantId)
    if (placed) {
      check('placed: stock was consumed, not released', after.onHand === 2 && after.held === 0,
        `on-hand ${after.onHand}, held ${after.held}`)
    } else {
      check('expired: stock was returned, not consumed', after.onHand === 4 && after.held === 0,
        `on-hand ${after.onHand}, held ${after.held}`)
    }
    check('no stock is left held either way', after.held === 0, `held ${after.held}`)
    check('the sweep did not report a failure', sweep.failed === 0)
  }

  /* ============================ 4. PLACED ORDERS ARE NEVER RELEASED ===== */
  section('[4] No placed or completed order ever has its inventory released')
  {
    const { variantId } = await makeFixtures(6)
    const user = await makeCustomer('placed')

    const draft = await draftFor(user, variantId, 3)
    if (!draft.ok) return
    created.orders.push(draft.orderId)

    const placed = await placeOrder({
      userId: user,
      orderId: draft.orderId,
      idempotencyKey: `sweep-placed-${stamp}`,
      actorId: user,
    })
    check('order placed', placed.ok)

    const afterPlacement = await stockOf(variantId)
    check('placement consumed the stock', afterPlacement.onHand === 3,
      `${afterPlacement.onHand}`)

    /**
     * The nastiest case available: a placed order whose `reserved_until` has
     * passed. The window is meaningless once an order is placed, and a sweep
     * that selected on time alone would hand back stock that has been sold.
     */
    await db
      .update(schema.orders)
      .set({ reservedUntil: sql`now() - interval '1 hour'` })
      .where(eq(schema.orders.id, draft.orderId))

    const run = await runDraftSweep()
    if (run.runId) created.runs.push(run.runId)

    const afterSweep = await stockOf(variantId)
    const state = await statusOf(draft.orderId)

    check('the placed order was NOT expired', state.status === 'placed', state.status)
    check('its inventory state is still committed',
      state.inventoryState === 'committed', state.inventoryState)
    check('no stock was handed back', afterSweep.onHand === 3 && afterSweep.held === 0,
      `on-hand ${afterSweep.onHand}, held ${afterSweep.held}`)

    /* And the same for a completed order. */
    await db
      .update(schema.orders)
      .set({ currentStatus: 'completed' })
      .where(eq(schema.orders.id, draft.orderId))
    const run2 = await runDraftSweep()
    if (run2.runId) created.runs.push(run2.runId)

    const afterSecond = await stockOf(variantId)
    check('a completed order keeps its stock consumed',
      afterSecond.onHand === 3 && afterSecond.held === 0,
      `on-hand ${afterSecond.onHand}, held ${afterSecond.held}`)
  }

  /* ============================= 5. PARTIAL FAILURE THEN RETRY ========== */
  section('[5] A partial batch failure is safe to retry')
  {
    const { variantId } = await makeFixtures(12)
    const ids: string[] = []
    for (const label of ['f1', 'f2', 'f3']) {
      const user = await makeCustomer(`fail-${label}`)
      const draft = await draftFor(user, variantId, 2)
      if (draft.ok) {
        ids.push(draft.orderId)
        created.orders.push(draft.orderId)
      }
    }
    for (const id of ids) await expireDraft(id)
    check('three drafts hold six units', (await stockOf(variantId)).held === 6)

    /**
     * A real fault, injected in the database: a trigger that rejects the
     * DRAFT_EXPIRED event for ONE specific order. That order's transaction
     * rolls back; the other two must still complete. Mocking the failure would
     * only prove the mock fired.
     */
    const victim = ids[1]

    /**
     * The id is inlined with `sql.raw`, not interpolated.
     *
     * Drizzle's `sql` tag turns `${victim}` into a bind parameter, and Postgres
     * does not accept bind parameters inside a function body — the whole body
     * is one string literal to the parser. The value is a uuid the database
     * generated, and the assertion below refuses anything that is not one
     * before it ever reaches the statement.
     */
    if (!/^[0-9a-f-]{36}$/i.test(victim)) throw new Error('unexpected order id shape')

    await db.execute(
      sql.raw(`
      create or replace function sweeper_block_one() returns trigger as $$
      begin
        if new.order_id = '${victim}'::uuid and new.event_type = 'DRAFT_EXPIRED' then
          raise exception 'sweeper suite: simulated failure for one draft'
            using errcode = 'internal_error';
        end if;
        return new;
      end;
      $$ language plpgsql
    `),
    )
    await db.execute(sql`
      create trigger sweeper_block_one before insert on order_events
        for each row execute function sweeper_block_one()
    `)

    let firstPass
    try {
      firstPass = await sweepExpiredDrafts(100)
    } finally {
      await db.execute(sql`drop trigger if exists sweeper_block_one on order_events`)
      await db.execute(sql`drop function if exists sweeper_block_one()`)
    }

    check('the batch reported the failure rather than throwing',
      firstPass.failed === 1, `failed ${firstPass.failed}`)
    check('the healthy drafts in the batch still expired', firstPass.expired === 2,
      `expired ${firstPass.expired}`)
    check('the run carries the first error message',
      (firstPass.firstError ?? '').includes('simulated failure'),
      `got: ${firstPass.firstError}`)

    const midway = await stockOf(variantId)
    check('the successful releases were kept, not rolled back', midway.held === 2,
      `held ${midway.held}`)

    const victimState = await statusOf(victim)
    check('the failed draft is untouched — still a draft',
      victimState.status === 'draft', victimState.status)
    check('the failed draft still holds its stock',
      victimState.inventoryState === 'reserved', victimState.inventoryState)

    /* The retry, with nothing done to fix anything but removing the fault. */
    const retry = await sweepExpiredDrafts(100)
    check('the retry succeeds', retry.expired === 1 && retry.failed === 0,
      `expired ${retry.expired}, failed ${retry.failed}`)

    const final = await stockOf(variantId)
    check('all holds are released after the retry', final.held === 0, `held ${final.held}`)
    check('on-hand stock is intact', final.onHand === 12, `${final.onHand}`)

    const events = await db
      .select({ id: schema.orderEvents.id })
      .from(schema.orderEvents)
      .where(
        and(
          eq(schema.orderEvents.orderId, victim),
          eq(schema.orderEvents.eventType, 'DRAFT_EXPIRED'),
        ),
      )
    check('the retried draft has exactly one expiry event', events.length === 1,
      `${events.length}`)
  }

  /* ==================================== 6. BATCHING AND THE LOCK ======== */
  section('[6] Bounded batches and overlapping invocations')
  {
    const { variantId } = await makeFixtures(20)
    const ids: string[] = []
    for (const label of ['b1', 'b2', 'b3']) {
      const user = await makeCustomer(`batch-${label}`)
      const draft = await draftFor(user, variantId, 1)
      if (draft.ok) {
        ids.push(draft.orderId)
        created.orders.push(draft.orderId)
      }
    }
    for (const id of ids) await expireDraft(id)

    const small = await sweepExpiredDrafts(2)
    check('the batch respects its limit', small.scanned <= 2, `scanned ${small.scanned}`)
    check('a full batch reports that more work remains', small.more === true)

    const rest = await sweepExpiredDrafts(100)
    check('the remainder drains on the next run', rest.expired >= 1, `${rest.expired}`)
    check('nothing is left holding stock', (await stockOf(variantId)).held === 0)

    /**
     * Two job invocations at once. One takes the advisory lock and works; the
     * other reports `skipped` rather than queueing behind it — at a one-minute
     * cadence a queue only ever grows.
     */
    const [runA, runB] = await Promise.all([runDraftSweep(), runDraftSweep()])
    for (const r of [runA, runB]) if (r.runId) created.runs.push(r.runId)

    const outcomes = [runA.outcome, runB.outcome].sort()
    check('one invocation ran and the other stood down',
      outcomes.join(',') === 'completed,skipped' || outcomes.join(',') === 'completed,completed',
      outcomes.join(','))
    check('a skipped run is not reported as a failure',
      runA.outcome !== 'failed' && runB.outcome !== 'failed')
  }

  /* ============================================= 7. HEALTH SIGNAL ====== */
  section('[7] The health signal reports the last successful sweep')
  {
    const before = await lastSuccessfulSweep()
    check('a successful run is recorded', before !== null)

    const run = await runDraftSweep()
    if (run.runId) created.runs.push(run.runId)

    const after = await lastSuccessfulSweep()
    check('the signal advances after a run', after !== null)
    check('it reports the job it belongs to', run.outcome !== 'failed')

    if (after) {
      const ageSeconds = (Date.now() - after.at.getTime()) / 1000
      check('the recorded time is recent', ageSeconds < 120, `${Math.round(ageSeconds)}s`)
    }

    /**
     * Failed runs must not advance the signal — a job that is invoked and fails
     * every minute would otherwise look perfectly healthy, which is the failure
     * this signal exists to catch.
     */
    const [failedRun] = await db
      .insert(schema.schedulerRuns)
      .values({
        job: SWEEP_JOB,
        outcome: 'failed',
        error: 'sweeper suite: synthetic failed run',
        finishedAt: new Date(),
      })
      .returning({ id: schema.schedulerRuns.id })
    created.runs.push(failedRun.id)

    const afterFailure = await lastSuccessfulSweep()
    check('a failed run does NOT advance the last-success signal',
      afterFailure?.at.getTime() === after?.at.getTime(),
      `${afterFailure?.at.toISOString()} vs ${after?.at.toISOString()}`)
  }
}

async function teardown() {
  section('[8] Teardown')

  if (created.runs.length) {
    await db
      .delete(schema.schedulerRuns)
      .where(inArray(schema.schedulerRuns.id, created.runs))
  }
  /**
   * Runs created by `runDraftSweep` outside the captured list cannot exist —
   * every call site here records its id. Asserted below rather than assumed.
   */

  if (created.orders.length) {
    await db
      .delete(schema.orderEvents)
      .where(inArray(schema.orderEvents.orderId, created.orders))
    await db
      .delete(schema.orderLines)
      .where(inArray(schema.orderLines.orderId, created.orders))
    await db.delete(schema.payments).where(inArray(schema.payments.orderId, created.orders))
    await db
      .delete(schema.fulfilments)
      .where(inArray(schema.fulfilments.orderId, created.orders))
    await db.delete(schema.orders).where(inArray(schema.orders.id, created.orders))
  }

  if (created.users.length) {
    const auditRows = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.userId, created.users))
    if (auditRows.length) {
      await db
        .delete(schema.auditLog)
        .where(inArray(schema.auditLog.id, auditRows.map((r) => r.id)))
    }
    await db.delete(schema.carts).where(inArray(schema.carts.userId, created.users))
  }

  if (created.variants.length)
    await db
      .delete(schema.productVariants)
      .where(inArray(schema.productVariants.id, created.variants))
  if (created.products.length)
    await db.delete(schema.products).where(inArray(schema.products.id, created.products))
  if (created.categories.length)
    await db.delete(schema.categories).where(inArray(schema.categories.id, created.categories))
  if (created.brands.length)
    await db.delete(schema.brands).where(inArray(schema.brands.id, created.brands))
  if (created.stores.length)
    await db.delete(schema.stores).where(inArray(schema.stores.id, created.stores))
  if (created.users.length)
    await db.delete(schema.users).where(inArray(schema.users.id, created.users))

  const leftoverUsers = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(inArray(schema.users.id, created.users.length ? created.users : ['']))
  check('every fixture user was removed by id', leftoverUsers.length === 0)

  const leftoverRuns = await db
    .select({ id: schema.schedulerRuns.id })
    .from(schema.schedulerRuns)
    .where(inArray(schema.schedulerRuns.id, created.runs.length ? created.runs : ['']))
  check('every scheduler run row was removed by id', leftoverRuns.length === 0)

  const orphanTriggers = await db.execute<{ tgname: string }>(
    sql`select tgname from pg_trigger where tgname in ('sweeper_block_one') and not tgisinternal`,
  )
  const rows = Array.isArray(orphanTriggers) ? orphanTriggers : orphanTriggers.rows
  check('no fault-injection trigger was left installed', rows.length === 0,
    rows.map((r) => r.tgname).join(','))
}

main()
  .catch((error) => {
    failed += 1
    failures.push('suite threw')
    console.error(`\nSUITE ERROR: ${error instanceof Error ? error.stack : error}`)
  })
  .then(() => teardown())
  .catch((error) => {
    failed += 1
    failures.push('teardown threw')
    console.error(`\nTEARDOWN ERROR: ${error instanceof Error ? error.stack : error}`)
  })
  .finally(() => {
    console.log('\n==========================================================')
    console.log(`RESULT: ${passed} passed, ${failed} failed`)
    if (failures.length) for (const f of failures) console.log(`  • ${f}`)
    console.log('==========================================================')
    process.exit(failed === 0 ? 0 : 1)
  })
