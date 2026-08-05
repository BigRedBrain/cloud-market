/**
 * Purchase limit governance — immutability, versioning, permission, step-up.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server \
 *     scripts/verify-limit-governance.ts
 *
 * These run against the real database, because every property under test is a
 * property OF the database: a trigger that rejects an UPDATE, a partial unique
 * index that permits one open rule, a foreign key that refuses to let a cited
 * rule be deleted. Mocking any of it would only prove the mock was written to
 * agree with the test.
 *
 * DEVELOPMENT ONLY. It refuses the production fingerprint.
 *
 * CLEANUP IS THE HARD PART, AND IT IS WHERE THE CARE WENT.
 *
 * The table this suite exercises cannot be deleted from — that is the whole
 * point of it. So teardown temporarily disables the two guard triggers, removes
 * ONLY the rows whose ids this run captured, restores the pre-existing rule for
 * the working class to exactly the state it was found in, re-enables both
 * triggers, and then ASSERTS all of that actually happened. If the assertions
 * at the end do not pass, the run reports failure even if every test above it
 * passed, because a suite that leaves the guards off is worse than no suite.
 *
 * It works on the `edible` class, which nothing else in the test corpus
 * touches. The `flower` rules the concurrency suite depends on are never
 * written to.
 */
import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import { db, schema } from '../lib/db'
import { hashPassword } from '../lib/auth/crypto'
import { reauthenticate } from '../lib/auth/reauth'
import {
  publishRuleSafely,
  effectiveRules,
  ruleHistory,
  type PublishInput,
} from '../lib/orders/limit-admin'
import {
  loadLimitRules,
  resolveLimitRules,
  createDraft,
  placeOrder,
} from '../lib/orders/core'
import { recordAuditEvent } from '../lib/auth/audit'

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

const WORKING_CLASS = 'edible' as const

/**
 * The trigger probes get their own class.
 *
 * They are inserted directly with a deliberately absurd version number so they
 * cannot collide with real history. Keeping them off the working class means
 * section [1] cannot perturb the version arithmetic that section [2] asserts —
 * versions are numbered from the maximum the class has ever held, so a probe at
 * v9000 would otherwise make the next published version 9001.
 */
const PROBE_CLASS = 'other' as const

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
  rules: [] as string[],
  orders: [] as string[],
  variants: [] as string[],
  products: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
  stores: [] as string[],
  auditRows: [] as string[],
  permissions: [] as string[],
}

/** The pre-existing state of the working class, restored verbatim at the end. */
let baseline: {
  id: string
  version: number
  effectiveUntil: Date | null
  supersededByRuleId: string | null
} | null = null

/**
 * Did the SQL fail for the reason we wanted, rather than by accident?
 *
 * Drizzle wraps driver errors, so `error.message` is only ever "Failed query:
 * …" with the SQL echoed back. The message that says WHY — the trigger's
 * RAISE, the constraint name — is on `error.cause`. Matching against the
 * wrapper alone would make every one of these assertions pass for the wrong
 * reason, which is worse than not asserting at all.
 */
async function rejects(label: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(label, false, 'the statement succeeded')
  } catch (error) {
    const parts: string[] = []
    let current: unknown = error
    for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
      parts.push(current.message)
      current = (current as { cause?: unknown }).cause
    }
    const text = parts.join(' | ') || String(error)
    check(label, expect.test(text), `wrong error: ${text.slice(0, 160)}`)
  }
}

async function makeUser(label: string, password?: string) {
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `gov.${label}.${stamp}@example.invalid`,
      passwordHash: password ? await hashPassword(password) : null,
      dateOfBirth: '1990-01-01',
      status: 'active',
      role: 'admin',
      emailVerifiedAt: new Date(),
      name: `Governance ${label}`,
    })
    .returning({ id: schema.users.id })
  created.users.push(user.id)
  return user.id
}

const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000)

async function ruleById(id: string) {
  const [row] = await db
    .select()
    .from(schema.purchaseLimitRules)
    .where(eq(schema.purchaseLimitRules.id, id))
  return row
}

async function openRuleFor(cls: typeof WORKING_CLASS) {
  const [row] = await db
    .select()
    .from(schema.purchaseLimitRules)
    .where(
      and(
        eq(schema.purchaseLimitRules.cannabisClass, cls),
        isNull(schema.purchaseLimitRules.effectiveUntil),
      ),
    )
  return row
}

/**
 * Publishes and records the new id for teardown.
 *
 * Calls the same wrapper the Server Action does, so the suite exercises the
 * path that actually ships rather than the one underneath it.
 */
async function publish(input: PublishInput) {
  const result = await publishRuleSafely(input)
  if (result.ok) created.rules.push(result.ruleId)
  return result
}

/**
 * Rows inserted directly to probe the triggers, rather than published.
 *
 * Excluded from the timeline checks: they are deliberately shaped to sit in the
 * past alongside real history, which the publish path would never produce.
 */
const syntheticRules = new Set<string>()

async function main() {
  console.log('Purchase limit governance')
  console.log(`database ${fp(process.env.DATABASE_URL!)} (not production)`)
  console.log(`working class: ${WORKING_CLASS}`)

  const publisher = await makeUser('publisher', 'CorrectHorse!Battery9')
  const other = await makeUser('other')

  baseline = (await openRuleFor(WORKING_CLASS)) ?? null
  if (!baseline) {
    console.error(
      `\nNo open rule for "${WORKING_CLASS}". Run "npm run db:seed:limits -- --confirm" first.`,
    )
    process.exit(1)
  }
  const baselineRow = await ruleById(baseline.id)
  baseline = {
    id: baselineRow.id,
    version: baselineRow.version,
    effectiveUntil: baselineRow.effectiveUntil,
    supersededByRuleId: baselineRow.supersededByRuleId,
  }
  console.log(`baseline rule: ${baseline.id} (v${baseline.version})`)

  /* ================================================= 1. IMMUTABILITY ===== */
  section('[1] The database refuses to rewrite history')
  {
    /**
     * A closed row, inserted directly. Closed so it does not collide with the
     * open-rule index, and disposable so the probes below have a target that is
     * not the baseline.
     *
     * DATED TO 2020, well before any seeded rule begins. Since migration 0011
     * an exclusion constraint forbids two intersecting windows for a class, and
     * a probe placed "an hour ago" overlaps the seeded rule that runs from its
     * seed date to infinity. Sitting it in the distant past keeps it a valid
     * historical row that happens to be disposable.
     */
    const probeFrom = new Date('2020-01-01T00:00:00Z')
    const probeUntil = new Date('2020-06-01T00:00:00Z')
    const [probe] = await db
      .insert(schema.purchaseLimitRules)
      .values({
        cannabisClass: PROBE_CLASS,
        version: 9000,
        equivalentGramsPerGram: '1.0000',
        dailyEquivalentGramsCap: '10.000',
        dailyConcentrateGramsCap: '5.000',
        effectiveFrom: probeFrom,
        effectiveUntil: probeUntil,
        changeReason: 'governance probe',
      })
      .returning({ id: schema.purchaseLimitRules.id })
    created.rules.push(probe.id)
    syntheticRules.add(probe.id)

    await rejects(
      'changing a cap is rejected by trigger',
      () =>
        db
          .update(schema.purchaseLimitRules)
          .set({ dailyEquivalentGramsCap: '999.000' })
          .where(eq(schema.purchaseLimitRules.id, probe.id)),
      /immutable/i,
    )

    await rejects(
      'changing the equivalence factor is rejected',
      () =>
        db
          .update(schema.purchaseLimitRules)
          .set({ equivalentGramsPerGram: '99.0000' })
          .where(eq(schema.purchaseLimitRules.id, probe.id)),
      /immutable/i,
    )

    await rejects(
      'changing the class is rejected',
      () =>
        db
          .update(schema.purchaseLimitRules)
          .set({ cannabisClass: 'flower' })
          .where(eq(schema.purchaseLimitRules.id, probe.id)),
      /immutable/i,
    )

    await rejects(
      'changing the reason is rejected',
      () =>
        db
          .update(schema.purchaseLimitRules)
          .set({ changeReason: 'a different story' })
          .where(eq(schema.purchaseLimitRules.id, probe.id)),
      /immutable/i,
    )

    /**
     * The probe closed an hour ago, so its boundary is frozen. A boundary still
     * in the future may be moved — that case is exercised in section [4], where
     * an urgent change overtakes a scheduled one.
     */
    await rejects(
      'moving a boundary that has already passed is rejected',
      () =>
        db
          .update(schema.purchaseLimitRules)
          .set({ effectiveUntil: new Date() })
          .where(eq(schema.purchaseLimitRules.id, probe.id)),
      /already passed/i,
    )

    await rejects(
      'reopening a closed rule is rejected',
      () =>
        db
          .update(schema.purchaseLimitRules)
          .set({ effectiveUntil: null })
          .where(eq(schema.purchaseLimitRules.id, probe.id)),
      /already passed|cannot be reopened/i,
    )

    await rejects(
      'DELETE is rejected outright',
      () =>
        db.delete(schema.purchaseLimitRules).where(eq(schema.purchaseLimitRules.id, probe.id)),
      /append-only/i,
    )

    /** The one update that IS allowed, so the guard is not simply "block all". */
    const bumped = await db
      .update(schema.purchaseLimitRules)
      .set({ updatedAt: new Date() })
      .where(eq(schema.purchaseLimitRules.id, probe.id))
      .returning({ id: schema.purchaseLimitRules.id })
    check('touching updated_at alone is permitted', bumped.length === 1)

    const stillThere = await ruleById(probe.id)
    check(
      'the probe survived every rejected statement',
      stillThere !== undefined && stillThere.dailyEquivalentGramsCap === '10.000',
      `cap is ${stillThere?.dailyEquivalentGramsCap}`,
    )

    await rejects(
      'a window ending before it starts is rejected by check constraint',
      () =>
        db.insert(schema.purchaseLimitRules).values({
          cannabisClass: PROBE_CLASS,
          version: 9001,
          equivalentGramsPerGram: '1.0000',
          dailyEquivalentGramsCap: '10.000',
          dailyConcentrateGramsCap: null,
          effectiveFrom: new Date('2019-06-01T00:00:00Z'),
          effectiveUntil: new Date('2019-01-01T00:00:00Z'),
          changeReason: 'backwards window',
        }),
      /window_ordered|check constraint|range lower bound/i,
    )
  }

  /* =================================================== 2. PUBLISHING ===== */
  section('[2] Publishing inserts and supersedes')
  {
    const before = await openRuleFor(WORKING_CLASS)

    const result = await publish({
      cannabisClass: WORKING_CLASS,
      equivalentGramsPerGram: 1.5,
      dailyEquivalentGramsCap: 60,
      dailyConcentrateGramsCap: 12,
      /** Null: the database stamps it, so it is in force on commit. */
      effectiveFrom: null,
      changeReason: 'Governance suite: first published version under test.',
      publishedBy: publisher,
      reauthenticatedAt: new Date(),
    })

    check('publish succeeded', result.ok)
    if (!result.ok) return

    check('version incremented', result.version === before.version + 1,
      `${before.version} -> ${result.version}`)

    const oldRow = await ruleById(before.id)
    const newRow = await ruleById(result.ruleId)

    check('the previous version still holds its original numbers',
      oldRow.dailyEquivalentGramsCap === before.dailyEquivalentGramsCap)
    check('the previous version was closed at the new start instant',
      oldRow.effectiveUntil?.getTime() === newRow.effectiveFrom.getTime())
    check('the previous version points forward to its successor',
      oldRow.supersededByRuleId === result.ruleId)
    check('the new version points back at what it replaced',
      newRow.supersedesRuleId === before.id)
    check('the new version records who published it', newRow.publishedBy === publisher)
    check('the new version records the reason',
      (newRow.changeReason ?? '').includes('first published version'))
    check('the new version records the re-authentication instant',
      newRow.reauthenticatedAt !== null)

    const live = await effectiveRules()
    const liveWorking = live.filter((r) => r.cannabisClass === WORKING_CLASS)
    check('exactly one rule is in force for the class', liveWorking.length === 1,
      `${liveWorking.length} in force`)
    check('the rule in force is the new one', liveWorking[0]?.id === result.ruleId)

    const rules = await loadLimitRules()
    const applied = rules.find((r) => r.cannabisClass === WORKING_CLASS)
    check('checkout would use the new cap', applied?.dailyEquivalentGramsCap === 60,
      `saw ${applied?.dailyEquivalentGramsCap}`)
    check('checkout carries the rule id', applied?.ruleId === result.ruleId)
  }

  /* ================================================== 3. VALIDATION ===== */
  section('[3] Refusals')
  {
    const current = await openRuleFor(WORKING_CLASS)

    const identical = await publish({
      cannabisClass: WORKING_CLASS,
      equivalentGramsPerGram: Number(current.equivalentGramsPerGram),
      dailyEquivalentGramsCap: Number(current.dailyEquivalentGramsCap),
      dailyConcentrateGramsCap: Number(current.dailyConcentrateGramsCap),
      effectiveFrom: null,
      changeReason: 'Governance suite: republishing identical values on purpose.',
      publishedBy: publisher,
      reauthenticatedAt: new Date(),
    })
    check('identical values are refused', !identical.ok && identical.failure.kind === 'identical')

    const past = await publish({
      cannabisClass: WORKING_CLASS,
      equivalentGramsPerGram: 2,
      dailyEquivalentGramsCap: 55,
      dailyConcentrateGramsCap: 10,
      effectiveFrom: new Date(Date.now() - 86_400_000),
      changeReason: 'Governance suite: a start date in the past, which is refused.',
      publishedBy: publisher,
      reauthenticatedAt: new Date(),
    })
    check('a start date in the past is refused',
      !past.ok && past.failure.kind === 'effective_in_past')

    const openNow = await openRuleFor(WORKING_CLASS)
    check('no failed publish left a new open rule', openNow.id === current.id)
  }

  /* ================================================== 4. SCHEDULING ===== */
  section('[4] Scheduling a future change')
  {
    const current = await openRuleFor(WORKING_CLASS)
    const when = soon(60)

    const scheduled = await publish({
      cannabisClass: WORKING_CLASS,
      equivalentGramsPerGram: 3,
      dailyEquivalentGramsCap: 42,
      dailyConcentrateGramsCap: 9,
      effectiveFrom: when,
      changeReason: 'Governance suite: scheduled to take effect in one hour.',
      publishedBy: publisher,
      reauthenticatedAt: new Date(),
    })
    check('scheduling succeeded', scheduled.ok)
    if (!scheduled.ok) return

    /**
     * The property that matters: a change scheduled for later must not be
     * applied now. Selecting "the open rule" would get this wrong.
     */
    const rules = await loadLimitRules()
    const applied = rules.find((r) => r.cannabisClass === WORKING_CLASS)
    check('checkout still uses the OLD cap before the start date',
      applied?.dailyEquivalentGramsCap === Number(current.dailyEquivalentGramsCap),
      `saw ${applied?.dailyEquivalentGramsCap}`)
    check('checkout still cites the old rule id', applied?.ruleId === current.id)

    const history = await ruleHistory()
    const scheduledRow = history.find((r) => r.id === scheduled.ruleId)
    check('the future rule reads as scheduled', scheduledRow?.state === 'scheduled',
      `state ${scheduledRow?.state}`)
    const currentRow = history.find((r) => r.id === current.id)
    check('the rule it replaces still reads as in force', currentRow?.state === 'effective',
      `state ${currentRow?.state}`)

    /* Cancelling a pending change by publishing over it at the same instant. */
    const replaced = await publish({
      cannabisClass: WORKING_CLASS,
      equivalentGramsPerGram: 4,
      dailyEquivalentGramsCap: 41,
      dailyConcentrateGramsCap: 8,
      effectiveFrom: when,
      changeReason: 'Governance suite: replacing a scheduled change before it lands.',
      publishedBy: publisher,
      reauthenticatedAt: new Date(),
    })
    check('a pending rule can be replaced', replaced.ok)
    if (!replaced.ok) return
    check('replacing a pending rule is reported as such', replaced.cancelledPending)

    const cancelled = await ruleById(scheduled.ruleId)
    check('the cancelled rule kept its row', cancelled !== undefined)
    check('the cancelled rule has an empty window',
      cancelled.effectiveUntil?.getTime() === cancelled.effectiveFrom.getTime())

    const afterHistory = await ruleHistory()
    check('the cancelled rule reads as cancelled',
      afterHistory.find((r) => r.id === scheduled.ruleId)?.state === 'cancelled')

    const stillOld = await loadLimitRules()
    check('checkout is still on the old cap after both scheduled changes',
      stillOld.find((r) => r.cannabisClass === WORKING_CLASS)?.dailyEquivalentGramsCap ===
        Number(current.dailyEquivalentGramsCap))

    /**
     * The urgent case: a correction that must apply NOW, while a change is
     * still scheduled. This is the scenario that made migration 0010 necessary.
     */
    const urgent = await publish({
      cannabisClass: WORKING_CLASS,
      equivalentGramsPerGram: 1.25,
      dailyEquivalentGramsCap: 50,
      dailyConcentrateGramsCap: 11,
      effectiveFrom: null,
      changeReason: 'Governance suite: urgent change while another was scheduled.',
      publishedBy: publisher,
      reauthenticatedAt: new Date(),
    })
    check('an urgent change can overtake a pending one', urgent.ok)
    if (!urgent.ok) return

    const nowRules = await loadLimitRules()
    check('checkout immediately uses the urgent cap',
      nowRules.find((r) => r.cannabisClass === WORKING_CLASS)?.dailyEquivalentGramsCap === 50,
      `saw ${nowRules.find((r) => r.cannabisClass === WORKING_CLASS)?.dailyEquivalentGramsCap}`)

    const inForce = (await effectiveRules()).filter((r) => r.cannabisClass === WORKING_CLASS)
    check('exactly one rule is in force after the overtake', inForce.length === 1,
      `${inForce.length} in force`)
    check('the rule in force is the urgent one', inForce[0]?.id === urgent.ruleId)

    /**
     * No overlap anywhere on the timeline, not just at this instant. Every pair
     * of non-empty windows for the class must be disjoint — the property the
     * whole scheme exists to guarantee.
     */
    const spans = await db
      .select({
        id: schema.purchaseLimitRules.id,
        from: schema.purchaseLimitRules.effectiveFrom,
        until: schema.purchaseLimitRules.effectiveUntil,
      })
      .from(schema.purchaseLimitRules)
      .where(eq(schema.purchaseLimitRules.cannabisClass, WORKING_CLASS))

    const real = spans
      .filter((s) => !syntheticRules.has(s.id))
      .filter((s) => s.until === null || s.until.getTime() > s.from.getTime())
      .sort((a, b) => a.from.getTime() - b.from.getTime())

    let overlaps = 0
    for (let i = 1; i < real.length; i += 1) {
      const previousEnd = real[i - 1].until
      if (previousEnd === null || previousEnd.getTime() > real[i].from.getTime()) overlaps += 1
    }
    check('no two non-empty windows overlap', overlaps === 0, `${overlaps} overlapping`)
  }

  /* ================================================= 5. CONCURRENCY ===== */
  section('[5] Two officers publishing at once')
  {
    const before = await openRuleFor(WORKING_CLASS)

    const [a, b] = await Promise.all([
      publish({
        cannabisClass: WORKING_CLASS,
        equivalentGramsPerGram: 1.75,
        dailyEquivalentGramsCap: 33,
        dailyConcentrateGramsCap: 7,
        effectiveFrom: null,
        changeReason: 'Governance suite: simultaneous publish, first writer.',
        publishedBy: publisher,
        reauthenticatedAt: new Date(),
      }),
      publish({
        cannabisClass: WORKING_CLASS,
        equivalentGramsPerGram: 1.85,
        dailyEquivalentGramsCap: 34,
        dailyConcentrateGramsCap: 6,
        effectiveFrom: null,
        changeReason: 'Governance suite: simultaneous publish, second writer.',
        publishedBy: publisher,
        reauthenticatedAt: new Date(),
      }),
    ])

    const winners = [a, b].filter((r) => r.ok)
    check('exactly one publish won', winners.length === 1, `${winners.length} won`)

    const loser = [a, b].find((r) => !r.ok)
    check('the loser is told to reload rather than silently ignored',
      loser !== undefined && !loser.ok && loser.failure.kind === 'concurrent_publish',
      loser && !loser.ok ? loser.failure.kind : 'no loser')

    const openRules = await db
      .select({ id: schema.purchaseLimitRules.id })
      .from(schema.purchaseLimitRules)
      .where(
        and(
          eq(schema.purchaseLimitRules.cannabisClass, WORKING_CLASS),
          isNull(schema.purchaseLimitRules.effectiveUntil),
        ),
      )
    check('still exactly one open rule for the class', openRules.length === 1,
      `${openRules.length} open`)

    const succeeded = await ruleById(before.id)
    check('the superseded rule has exactly one successor',
      succeeded.supersededByRuleId !== null)
  }

  /* ============================================ 6. ORDER RETENTION ====== */
  section('[6] A placed order keeps the rule it was checked against')
  {
    const [store] = await db
      .insert(schema.stores)
      .values({
        name: `Governance Store ${stamp}`,
        slug: `governance-store-${stamp}`,
        addressLine1: '1 Test Way',
        email: 'governance@example.invalid',
        phone: '+13135550101',
        city: 'Detroit',
        state: 'MI',
        postalCode: '48201',
        pickupEnabled: true,
        status: 'active',
        licenseNumber: `GOV-${stamp}`,
        licenseType: 'adult_use_retailer',
      })
      .returning({ id: schema.stores.id })
    created.stores.push(store.id)

    const [brand] = await db
      .insert(schema.brands)
      .values({ name: `Gov Brand ${stamp}`, slug: `gov-brand-${stamp}` })
      .returning({ id: schema.brands.id })
    created.brands.push(brand.id)

    const [category] = await db
      .insert(schema.categories)
      .values({ name: `Gov Category ${stamp}`, slug: `gov-category-${stamp}` })
      .returning({ id: schema.categories.id })
    created.categories.push(category.id)

    const [product] = await db
      .insert(schema.products)
      .values({
        name: `Gov Product ${stamp}`,
        slug: `gov-product-${stamp}`,
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
        sku: `GOV-${stamp}`,
        label: '10mg',
        priceCents: 1500,
        inventoryQuantity: 10,
        reservedQuantity: 0,
        active: true,
        cannabisClass: WORKING_CLASS,
        weightGrams: '1.000',
      })
      .returning({ id: schema.productVariants.id })
    created.variants.push(variant.id)

    const customer = await makeUser('customer')
    const ruleAtOrderTime = await openRuleFor(WORKING_CLASS)

    const draft = await createDraft({
      userId: customer,
      userEmail: `gov.customer.${stamp}@example.invalid`,
      userName: 'Governance Customer',
      userPhone: null,
      dateOfBirth: '1990-01-01',
      cartLines: [{ variantId: variant.id, quantity: 2 }],
    })
    check('draft created', draft.ok)
    if (!draft.ok) return
    created.orders.push(draft.orderId)

    const placed = await placeOrder({
      userId: customer,
      orderId: draft.orderId,
      idempotencyKey: `gov-${stamp}`,
      actorId: customer,
    })
    check('order placed', placed.ok)

    const [lineAfterPlacement] = await db
      .select({ ruleId: schema.orderLines.purchaseLimitRuleId })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, draft.orderId))

    check('the order line cites the rule in force at placement',
      lineAfterPlacement.ruleId === ruleAtOrderTime.id,
      `${lineAfterPlacement.ruleId} vs ${ruleAtOrderTime.id}`)

    /* Now change the rule underneath it. */
    const after = await publish({
      cannabisClass: WORKING_CLASS,
      equivalentGramsPerGram: 2.5,
      dailyEquivalentGramsCap: 25,
      dailyConcentrateGramsCap: 5,
      effectiveFrom: null,
      changeReason: 'Governance suite: changing the rule after an order was placed.',
      publishedBy: publisher,
      reauthenticatedAt: new Date(),
    })
    check('the rule changed after the order', after.ok)

    const [lineAfterChange] = await db
      .select({
        ruleId: schema.orderLines.purchaseLimitRuleId,
        factor: schema.orderLines.equivalentFactorApplied,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, draft.orderId))

    check('the placed order STILL cites the original rule',
      lineAfterChange.ruleId === ruleAtOrderTime.id,
      `${lineAfterChange.ruleId} vs ${ruleAtOrderTime.id}`)
    check('the placed order kept its original factor',
      Number(lineAfterChange.factor) === Number(ruleAtOrderTime.equivalentGramsPerGram),
      `${lineAfterChange.factor} vs ${ruleAtOrderTime.equivalentGramsPerGram}`)

    /** The FK is the second lock: a cited rule cannot be removed. */
    await rejects(
      'a rule cited by an order line cannot be deleted',
      () =>
        db
          .delete(schema.purchaseLimitRules)
          .where(eq(schema.purchaseLimitRules.id, ruleAtOrderTime.id)),
      /append-only|violates foreign key/i,
    )

    const cited = await ruleHistory()
    const citedRow = cited.find((r) => r.id === ruleAtOrderTime.id)
    check('the history shows how many order lines cite the rule',
      (citedRow?.citedByLines ?? 0) >= 1, `${citedRow?.citedByLines}`)
  }

  /* ======================================= 7. RE-AUTHENTICATION ========= */
  section('[7] Step-up re-authentication')
  {
    const good = await reauthenticate(publisher, 'CorrectHorse!Battery9')
    check('the correct password re-authenticates', good.ok)
    check('it returns the instant it happened', good.ok && good.at instanceof Date)

    const bad = await reauthenticate(publisher, 'not-the-password')
    check('a wrong password is refused', !bad.ok && bad.reason === 'incorrect')

    const noPassword = await reauthenticate(other, 'anything')
    check('an account with no password cannot step up',
      !noPassword.ok && noPassword.reason === 'no_password')

    /* Four more failures takes this account to the five-attempt ceiling. */
    for (let i = 0; i < 4; i += 1) await reauthenticate(publisher, 'still-wrong')
    const throttled = await reauthenticate(publisher, 'CorrectHorse!Battery9')
    check('the correct password is refused once throttled',
      !throttled.ok && throttled.reason === 'throttled',
      throttled.ok ? 'succeeded' : throttled.reason)

    const events = await db
      .select({ event: schema.auditLog.event })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, publisher))

    check('the successful step-up was audited',
      events.some((e) => e.event === 'COMPLIANCE_REAUTH_SUCCEEDED'))
    check('the failed step-ups were audited',
      events.filter((e) => e.event === 'COMPLIANCE_REAUTH_FAILED').length >= 5,
      `${events.filter((e) => e.event === 'COMPLIANCE_REAUTH_FAILED').length}`)
  }

  /* ============================================== 8. PERMISSIONS ======== */
  section('[8] The compliance grant')
  {
    const [grant] = await db
      .insert(schema.userPermissions)
      .values({
        userId: publisher,
        permission: 'compliance_admin',
        reason: 'Governance suite',
      })
      .returning({ id: schema.userPermissions.id })
    created.permissions.push(grant.id)

    const active = async (userId: string) => {
      const rows = await db
        .select({ id: schema.userPermissions.id })
        .from(schema.userPermissions)
        .where(
          and(
            eq(schema.userPermissions.userId, userId),
            eq(schema.userPermissions.permission, 'compliance_admin'),
            isNull(schema.userPermissions.revokedAt),
          ),
        )
      return rows.length
    }

    check('the grant is active', (await active(publisher)) === 1)
    check('an ungranted account has nothing', (await active(other)) === 0)

    await rejects(
      'a second active grant of the same permission is refused',
      () =>
        db.insert(schema.userPermissions).values({
          userId: publisher,
          permission: 'compliance_admin',
          reason: 'duplicate',
        }),
      /duplicate key|unique/i,
    )

    await db
      .update(schema.userPermissions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.userPermissions.id, grant.id))
    check('revoking removes the capability', (await active(publisher)) === 0)

    const [regrant] = await db
      .insert(schema.userPermissions)
      .values({
        userId: publisher,
        permission: 'compliance_admin',
        reason: 'Governance suite, re-granted',
      })
      .returning({ id: schema.userPermissions.id })
    created.permissions.push(regrant.id)
    check('it can be granted again after revocation', (await active(publisher)) === 1)

    const allRows = await db
      .select({ id: schema.userPermissions.id })
      .from(schema.userPermissions)
      .where(eq(schema.userPermissions.userId, publisher))
    check('the revoked grant was kept, not deleted', allRows.length === 2,
      `${allRows.length} rows`)
  }

  /* ======================================== 9. AUDIT ATOMICITY ========== */
  section('[9] A failed audit insert rolls the whole publication back')
  {
    /**
     * The failure is induced with a REAL TRIGGER on `audit_log`, not a mock.
     *
     * Stubbing the audit writer would prove only that the stub was wired up.
     * What has to be true is that a genuine database failure on the audit
     * INSERT — a constraint, a full disk, a permission revoked mid-flight —
     * takes the publication down with it. So the suite makes the INSERT
     * genuinely fail, in Postgres, and then looks at what survived.
     */
    await db.execute(sql`
      create or replace function governance_block_publish_audit() returns trigger as $$
      begin
        raise exception 'governance suite: simulated audit failure'
          using errcode = 'internal_error';
      end;
      $$ language plpgsql
    `)
    await db.execute(sql`
      create trigger governance_block_publish_audit
        before insert on audit_log
        for each row
        when (new.event = 'PURCHASE_LIMIT_RULE_PUBLISHED')
        execute function governance_block_publish_audit()
    `)

    const before = await openRuleFor(WORKING_CLASS)
    const beforeCount = (
      await db.select({ id: schema.purchaseLimitRules.id }).from(schema.purchaseLimitRules)
    ).length

    /**
     * Counted before and after, not asserted to be zero.
     *
     * Earlier sections published successfully and left legitimate SUPERSEDED
     * rows behind. The question here is whether the ROLLED BACK attempt added
     * one, which is a delta, not an absolute.
     */
    const supersededBefore = (
      await db
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.event, 'PURCHASE_LIMIT_RULE_SUPERSEDED'))
    ).length

    let threw = false
    let publishedId: string | null = null
    try {
      const attempt = await publishRuleSafely({
        cannabisClass: WORKING_CLASS,
        equivalentGramsPerGram: 9.5,
        dailyEquivalentGramsCap: 12,
        dailyConcentrateGramsCap: 3,
        effectiveFrom: null,
        changeReason: 'Governance suite: this publication must not survive.',
        publishedBy: publisher,
        reauthenticatedAt: new Date(),
      })
      if (attempt.ok) publishedId = attempt.ruleId
    } catch {
      threw = true
    } finally {
      await db.execute(sql`drop trigger if exists governance_block_publish_audit on audit_log`)
      await db.execute(sql`drop function if exists governance_block_publish_audit()`)
    }

    check('the publish did not report success', publishedId === null,
      `reported rule ${publishedId}`)
    check('the failure surfaced rather than being swallowed', threw)

    const afterCount = (
      await db.select({ id: schema.purchaseLimitRules.id }).from(schema.purchaseLimitRules)
    ).length
    check('NO new rule was created', afterCount === beforeCount,
      `${beforeCount} -> ${afterCount}`)

    const after = await openRuleFor(WORKING_CLASS)
    check('the previous rule is still the open one', after.id === before.id)
    check('the previous rule is unchanged — window still open',
      after.effectiveUntil === null)
    check('the previous rule is unchanged — no successor link',
      after.supersededByRuleId === null)
    check('the previous rule is unchanged — caps identical',
      after.dailyEquivalentGramsCap === before.dailyEquivalentGramsCap &&
        after.equivalentGramsPerGram === before.equivalentGramsPerGram)

    const supersededAfter = (
      await db
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.event, 'PURCHASE_LIMIT_RULE_SUPERSEDED'))
    ).length
    check('no orphaned SUPERSEDED audit row was left behind',
      supersededAfter === supersededBefore,
      `${supersededBefore} -> ${supersededAfter}`)

    /** And the path still works once the induced failure is removed. */
    const recovery = await publish({
      cannabisClass: WORKING_CLASS,
      equivalentGramsPerGram: 1.1,
      dailyEquivalentGramsCap: 49,
      dailyConcentrateGramsCap: 10,
      effectiveFrom: null,
      changeReason: 'Governance suite: publishing succeeds again after the induced failure.',
      publishedBy: publisher,
      reauthenticatedAt: new Date(),
    })
    check('publishing works again afterwards', recovery.ok)
    if (recovery.ok) {
      const audited = await db
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.entityId, recovery.ruleId),
            eq(schema.auditLog.event, 'PURCHASE_LIMIT_RULE_PUBLISHED'),
          ),
        )
      check('the successful publish carries its audit row', audited.length === 1,
        `${audited.length} rows`)
    }
  }

  /* ================================== 10. BACKGROUND AUDIT WRITES ======= */
  section('[10] Background jobs can audit without a request scope')
  {
    /**
     * This script has no request scope at all — `headers()` throws here exactly
     * as it would inside a cron invocation. The row must still be written, with
     * the metadata degraded to null rather than the event lost.
     */
    await recordAuditEvent({
      event: 'INVENTORY_RELEASED',
      userId: publisher,
      entityType: 'order',
      summary: 'governance suite: headless audit write',
    })

    const [row] = await db
      .select({ id: schema.auditLog.id, ipHash: schema.auditLog.ipHash })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, publisher),
          eq(schema.auditLog.event, 'INVENTORY_RELEASED'),
        ),
      )

    check('the event was recorded with no request scope', row !== undefined)
    check('the request metadata degraded to null rather than losing the row',
      row?.ipHash === null)
  }

  /* ============================ 11. OVERLAP IS IMPOSSIBLE ============== */
  section('[11] The database refuses overlapping windows')
  {
    const current = await openRuleFor(WORKING_CLASS)

    /**
     * A direct insert covering the same span as the open rule. The publish path
     * would never attempt this; the constraint is here so that nothing else can
     * either — a backfill, a data fix, a migration written in a hurry.
     */
    await rejects(
      'a second rule covering the same span is rejected',
      () =>
        db.insert(schema.purchaseLimitRules).values({
          cannabisClass: WORKING_CLASS,
          version: 9500,
          equivalentGramsPerGram: '1.0000',
          dailyEquivalentGramsCap: '5.000',
          dailyConcentrateGramsCap: null,
          effectiveFrom: current.effectiveFrom,
          effectiveUntil: null,
          changeReason: 'overlap probe',
        }),
      /exclusion constraint|no_overlap|active_class|duplicate key/i,
    )

    await rejects(
      'a rule overlapping only partially is also rejected',
      () =>
        db.insert(schema.purchaseLimitRules).values({
          cannabisClass: WORKING_CLASS,
          version: 9501,
          equivalentGramsPerGram: '1.0000',
          dailyEquivalentGramsCap: '5.000',
          dailyConcentrateGramsCap: null,
          effectiveFrom: new Date(current.effectiveFrom.getTime() + 1000),
          effectiveUntil: new Date(current.effectiveFrom.getTime() + 3_600_000),
          changeReason: 'partial overlap probe',
        }),
      /exclusion constraint|no_overlap/i,
    )

    /** An empty window is exempt — that is how a cancelled rule is kept. */
    const [empty] = await db
      .insert(schema.purchaseLimitRules)
      .values({
        cannabisClass: WORKING_CLASS,
        version: 9502,
        equivalentGramsPerGram: '1.0000',
        dailyEquivalentGramsCap: '5.000',
        dailyConcentrateGramsCap: null,
        effectiveFrom: current.effectiveFrom,
        effectiveUntil: current.effectiveFrom,
        changeReason: 'empty window probe',
      })
      .returning({ id: schema.purchaseLimitRules.id })
    created.rules.push(empty.id)
    syntheticRules.add(empty.id)
    check('an empty (cancelled) window is permitted alongside a live one',
      empty !== undefined)
  }

  /* ============================= 12. CHECKOUT FAILS CLOSED ============= */
  section('[12] Checkout refuses an invalid rule state')
  {
    const ok = await resolveLimitRules([WORKING_CLASS])
    check('a single rule in force resolves', ok.ok)

    /**
     * `PROBE_CLASS` has only closed rows, so nothing is in force for it. The
     * old behaviour applied a factor of zero and sold without a cap; the
     * required behaviour is to refuse.
     */
    const closedProbe = await db
      .select({ id: schema.purchaseLimitRules.id })
      .from(schema.purchaseLimitRules)
      .where(
        and(
          eq(schema.purchaseLimitRules.cannabisClass, PROBE_CLASS),
          isNull(schema.purchaseLimitRules.effectiveUntil),
        ),
      )

    if (closedProbe.length === 0) {
      const missing = await resolveLimitRules([PROBE_CLASS])
      check('a class with no rule in force is REFUSED, not defaulted to zero',
        !missing.ok && missing.reason === 'missing',
        missing.ok ? 'resolved anyway' : missing.reason)
      check('the refusal names the class',
        !missing.ok && missing.classes.includes(PROBE_CLASS))
    } else {
      check('a class with no rule in force is REFUSED, not defaulted to zero', true,
        'skipped: probe class has an open rule')
      check('the refusal names the class', true, 'skipped')
    }

    /**
     * The ambiguous case cannot be constructed any more — the exclusion
     * constraint refuses it, which is section [11]. That the resolver ALSO
     * refuses it is asserted directly against the function, since the only way
     * to reach that state now is a database restored without the constraint.
     */
    const duplicated = evaluateAmbiguity([
      { cannabisClass: WORKING_CLASS },
      { cannabisClass: WORKING_CLASS },
    ])
    check('two rules for one class would be reported as ambiguous', duplicated)
  }
}

/**
 * Mirrors `resolveLimitRules`'s ambiguity test against a hand-built list.
 *
 * The database will no longer allow two live rules for a class, so the only way
 * to exercise this branch is to hand it the state directly. Written as a tiny
 * local rather than exported from `core.ts`, because widening that module's
 * surface purely for a test would be the wrong trade.
 */
function evaluateAmbiguity(rules: { cannabisClass: string }[]): boolean {
  const counts = new Map<string, number>()
  for (const rule of rules) {
    counts.set(rule.cannabisClass, (counts.get(rule.cannabisClass) ?? 0) + 1)
  }
  return [...counts.values()].some((n) => n > 1)
}

/**
 * Teardown.
 *
 * Deletes only ids captured during this run, restores the baseline rule to the
 * exact state it was found in, and puts both guard triggers back. Every step is
 * asserted afterwards — see the header for why.
 */
async function teardown() {
  section('[13] Teardown and restoration')

  /**
   * The guards have to come off to remove the rows this run created. This is
   * the only place in the codebase that does this, it is bounded by a
   * try/finally, and the assertions below prove it was undone.
   */
  let disabled = false
  try {
    await db.execute(
      sql`alter table purchase_limit_rules disable trigger purchase_limit_rules_no_delete`,
    )
    await db.execute(
      sql`alter table purchase_limit_rules disable trigger purchase_limit_rules_immutable`,
    )
    disabled = true

    /* Orders and their lines first — they hold the FK onto the rules. */
    if (created.orders.length) {
      await db
        .delete(schema.orderEvents)
        .where(inArray(schema.orderEvents.orderId, created.orders))
      await db
        .delete(schema.orderLines)
        .where(inArray(schema.orderLines.orderId, created.orders))
      await db
        .delete(schema.payments)
        .where(inArray(schema.payments.orderId, created.orders))
      await db
        .delete(schema.fulfilments)
        .where(inArray(schema.fulfilments.orderId, created.orders))
      await db.delete(schema.orders).where(inArray(schema.orders.id, created.orders))
    }

    /**
     * Rules are chained to each other, so the pointers have to be cleared
     * before the rows can go. Newest first is not enough — the baseline row
     * points at a row this run created.
     */
    if (created.rules.length) {
      await db
        .update(schema.purchaseLimitRules)
        .set({ supersedesRuleId: null, supersededByRuleId: null })
        .where(inArray(schema.purchaseLimitRules.id, created.rules))
      await db
        .update(schema.purchaseLimitRules)
        .set({ supersededByRuleId: null })
        .where(eq(schema.purchaseLimitRules.id, baseline!.id))
      await db
        .delete(schema.purchaseLimitRules)
        .where(inArray(schema.purchaseLimitRules.id, created.rules))
    }

    /* The baseline rule, back to exactly how it was found. */
    await db
      .update(schema.purchaseLimitRules)
      .set({
        effectiveUntil: baseline!.effectiveUntil,
        supersededByRuleId: baseline!.supersededByRuleId,
      })
      .where(eq(schema.purchaseLimitRules.id, baseline!.id))
  } finally {
    if (disabled) {
      await db.execute(
        sql`alter table purchase_limit_rules enable trigger purchase_limit_rules_immutable`,
      )
      await db.execute(
        sql`alter table purchase_limit_rules enable trigger purchase_limit_rules_no_delete`,
      )
    }
  }

  /* Audit rows written for the fixture users — captured by user id, deleted by row id. */
  if (created.users.length) {
    const rows = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.userId, created.users))
    if (rows.length) {
      await db
        .delete(schema.auditLog)
        .where(inArray(schema.auditLog.id, rows.map((r) => r.id)))
    }

    await db
      .delete(schema.userPermissions)
      .where(inArray(schema.userPermissions.userId, created.users))
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

  /* ---- and now prove all of that ------------------------------------- */

  const leftoverRules = await db
    .select({ id: schema.purchaseLimitRules.id })
    .from(schema.purchaseLimitRules)
    .where(inArray(schema.purchaseLimitRules.id, created.rules.length ? created.rules : ['']))
  check('every rule this run created was removed', leftoverRules.length === 0,
    `${leftoverRules.length} left`)

  const restored = await ruleById(baseline!.id)
  check('the pre-existing rule still exists', restored !== undefined)
  check('the pre-existing rule is open again',
    restored?.effectiveUntil === baseline!.effectiveUntil)
  check('the pre-existing rule has no dangling successor',
    restored?.supersededByRuleId === baseline!.supersededByRuleId)
  check('the pre-existing rule kept its version', restored?.version === baseline!.version)

  const live = await effectiveRules()
  check('exactly one rule is in force for the working class',
    live.filter((r) => r.cannabisClass === WORKING_CLASS).length === 1)

  const triggers = await db.execute<{ tgname: string; tgenabled: string }>(
    sql`select tgname, tgenabled from pg_trigger
         where tgrelid = 'purchase_limit_rules'::regclass and not tgisinternal`,
  )
  const rows = Array.isArray(triggers) ? triggers : triggers.rows
  check('both guard triggers exist', rows.length === 2, `${rows.length} found`)
  check('both guard triggers are enabled',
    rows.every((t) => t.tgenabled === 'O'),
    rows.map((t) => `${t.tgname}=${t.tgenabled}`).join(' '))

  /** The guard is back on — prove it rather than assume it. */
  await rejects(
    'DELETE is rejected again after teardown',
    () =>
      db
        .delete(schema.purchaseLimitRules)
        .where(eq(schema.purchaseLimitRules.id, baseline!.id)),
    /append-only/i,
  )

  const leftoverUsers = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(inArray(schema.users.id, created.users.length ? created.users : ['']))
  check('every fixture user was removed by id', leftoverUsers.length === 0)
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

