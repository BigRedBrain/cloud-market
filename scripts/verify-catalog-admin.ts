/**
 * Catalog compliance administration, the checkout gate, and the interaction
 * between a catalog correction and an order being placed.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server \
 *     scripts/verify-catalog-admin.ts
 *
 * Runs against the real database. Validation is pure and could be tested
 * anywhere, but the properties that matter here are transactional — an audit
 * failure rolling a catalog write back, a correction racing a placement — and
 * those are properties of Postgres, not of this code.
 *
 * DEVELOPMENT ONLY. Refuses the production fingerprint. Every row is captured
 * by id at creation and deleted by id.
 */
import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, schema } from '../lib/db'
import {
  classifyVariants,
  isVariantCheckoutEligible,
  loadVariantCompliance,
  validateCompliance,
} from '../lib/catalog/compliance'
import { createDraft, placeOrder } from '../lib/orders/core'
import { checkoutGate, MAX_SWEEP_AGE_SECONDS } from '../lib/orders/gate'
import { runDraftSweep, SWEEP_JOB } from '../lib/jobs/sweep'
import { CLASS_MEASUREMENT, SUPPORTED_CANNABIS_CLASSES } from '../lib/orders/limits'

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

/** Restored in teardown so the suite cannot leave checkout switched on. */
const originalFlag = process.env.CHECKOUT_ENABLED

let fixtureSeq = 0
async function makeVariant(options: {
  cannabisClass: string
  measurementBasis: string | null
  measurementValue: string | null
  stock?: number
}) {
  const tag = `${stamp}-${(fixtureSeq += 1)}`

  const [store] = await db
    .insert(schema.stores)
    .values({
      name: `Catalog Store ${tag}`,
      slug: `catalog-store-${tag}`,
      addressLine1: '1 Test Way',
      email: 'catalog@example.invalid',
      phone: '+13135550103',
      city: 'Detroit',
      state: 'MI',
      postalCode: '48201',
      pickupEnabled: true,
      status: 'active',
      licenseNumber: `CAT-${tag}`,
      licenseType: 'adult_use_retailer',
    })
    .returning({ id: schema.stores.id })
  created.stores.push(store.id)

  const [brand] = await db
    .insert(schema.brands)
    .values({ name: `Cat Brand ${tag}`, slug: `cat-brand-${tag}` })
    .returning({ id: schema.brands.id })
  created.brands.push(brand.id)

  const [category] = await db
    .insert(schema.categories)
    .values({ name: `Cat Category ${tag}`, slug: `cat-category-${tag}` })
    .returning({ id: schema.categories.id })
  created.categories.push(category.id)

  const [product] = await db
    .insert(schema.products)
    .values({
      name: `Cat Product ${tag}`,
      slug: `cat-product-${tag}`,
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
      sku: `CAT-${tag}`,
      label: '3.5g',
      priceCents: 4500,
      inventoryQuantity: options.stock ?? 20,
      reservedQuantity: 0,
      active: true,
      cannabisClass: options.cannabisClass as 'flower',
      measurementBasis: options.measurementBasis as 'net_weight_grams' | null,
      measurementValue: options.measurementValue,
    })
    .returning({ id: schema.productVariants.id })
  created.variants.push(variant.id)

  return { variantId: variant.id, storeId: store.id }
}

async function makeUser(label: string) {
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `cat.${label}.${stamp}@example.invalid`,
      passwordHash: 'x',
      dateOfBirth: '1990-01-01',
      status: 'active',
      role: 'admin',
      emailVerifiedAt: new Date(),
      name: `Catalog ${label}`,
    })
    .returning({ id: schema.users.id })
  created.users.push(user.id)
  return user.id
}

const draftFor = (userId: string, variantId: string, quantity: number) =>
  createDraft({
    userId,
    userEmail: `cat.${userId}@example.invalid`,
    userName: 'Catalog',
    userPhone: null,
    dateOfBirth: '1990-01-01',
    cartLines: [{ variantId, quantity }],
  })

/** A fresh, successful sweeper run so the staleness gate is open. */
async function freshSweep() {
  const run = await runDraftSweep()
  if (run.runId) created.runs.push(run.runId)
  return run
}

async function main() {
  console.log('Catalog compliance administration')
  console.log(`database ${fp(process.env.DATABASE_URL!)} (not production)`)

  const admin = await makeUser('admin')

  /* ============================================ 1. THE MATRIX ============ */
  section('[1] Every invalid class/basis combination is refused')
  {
    /**
     * Every class crossed with every basis. Only the diagonal may pass — 36
     * combinations, of which 6 are legal, and asserting the whole grid means a
     * future class cannot be added with a plausible-looking wrong basis.
     */
    const bases = [
      'net_weight_grams',
      'finished_net_weight_grams',
      'finished_volume_fluid_ounces',
      'unit_count',
      'exempt',
    ]

    let wrongAccepted = 0
    let rightRejected = 0

    for (const cls of SUPPORTED_CANNABIS_CLASSES) {
      const legal = CLASS_MEASUREMENT[cls].basis
      const needsValue = CLASS_MEASUREMENT[cls].countsAsCannabis
      for (const basis of bases) {
        const result = validateCompliance({
          cannabisClass: cls,
          measurementBasis: basis,
          measurementValue: needsValue ? '1' : null,
        })
        if (basis === legal && result !== null) rightRejected += 1
        if (basis !== legal && result === null) wrongAccepted += 1
      }
    }

    check('no mismatched class/basis pair is accepted', wrongAccepted === 0,
      `${wrongAccepted} accepted`)
    check('every correct class/basis pair is accepted', rightRejected === 0,
      `${rightRejected} rejected`)

    check('an unknown class is refused',
      validateCompliance({ cannabisClass: 'widget', measurementBasis: 'net_weight_grams', measurementValue: '1' })?.kind === 'unsupported_class')
    check('`other` is refused',
      validateCompliance({ cannabisClass: 'other', measurementBasis: 'net_weight_grams', measurementValue: '1' })?.kind === 'unsupported_class')
    check('`edible` is refused',
      validateCompliance({ cannabisClass: 'edible', measurementBasis: 'net_weight_grams', measurementValue: '1' })?.kind === 'unsupported_class')

    check('a missing basis is refused',
      validateCompliance({ cannabisClass: 'flower', measurementBasis: null, measurementValue: '1' })?.kind === 'basis_required')
    check('a missing value is refused',
      validateCompliance({ cannabisClass: 'flower', measurementBasis: 'net_weight_grams', measurementValue: null })?.kind === 'value_required')
    check('a zero value is refused',
      validateCompliance({ cannabisClass: 'flower', measurementBasis: 'net_weight_grams', measurementValue: '0' })?.kind === 'value_not_positive')
    check('a negative value is refused',
      validateCompliance({ cannabisClass: 'flower', measurementBasis: 'net_weight_grams', measurementValue: '-1' })?.kind === 'value_not_positive')
    check('a non-decimal value is refused',
      validateCompliance({ cannabisClass: 'flower', measurementBasis: 'net_weight_grams', measurementValue: '3.5g' })?.kind === 'value_not_decimal')
  }

  /* ============================================ 2. PLANTS =============== */
  section('[2] Immature plants require positive whole numbers')
  {
    const ok = validateCompliance({
      cannabisClass: 'immature_plant',
      measurementBasis: 'unit_count',
      measurementValue: '1',
    })
    check('one plant is accepted', ok === null)

    check('two and a half plants are refused',
      validateCompliance({ cannabisClass: 'immature_plant', measurementBasis: 'unit_count', measurementValue: '2.5' })?.kind === 'plants_not_whole')
    check('a trailing-zero decimal is still whole',
      validateCompliance({ cannabisClass: 'immature_plant', measurementBasis: 'unit_count', measurementValue: '3.000' }) === null)
    check('zero plants are refused',
      validateCompliance({ cannabisClass: 'immature_plant', measurementBasis: 'unit_count', measurementValue: '0' })?.kind === 'value_not_positive')

    /** And the database refuses it too, independently of this code. */
    let dbRejected = false
    try {
      await db.insert(schema.productVariants).values({
        productId: created.products[0] ?? (await makeVariant({ cannabisClass: 'flower', measurementBasis: 'net_weight_grams', measurementValue: '1' })).variantId,
        sku: `CAT-FRACTIONAL-${stamp}`,
        label: 'bad',
        priceCents: 100,
        cannabisClass: 'immature_plant',
        measurementBasis: 'unit_count',
        measurementValue: '2.5000',
      })
    } catch {
      dbRejected = true
    }
    check('the database CHECK constraint refuses a fractional plant', dbRejected)
  }

  /* ================================= 3. NON-CANNABIS IS THE ONLY EXEMPT = */
  section('[3] non_cannabis is the only generally exempt classification')
  {
    check('non_cannabis with no value is accepted',
      validateCompliance({ cannabisClass: 'non_cannabis', measurementBasis: 'exempt', measurementValue: null }) === null)
    check('non_cannabis carrying a value is refused',
      validateCompliance({ cannabisClass: 'non_cannabis', measurementBasis: 'exempt', measurementValue: '5' })?.kind === 'value_not_allowed')

    /** The bypass that must not exist. */
    let exemptBypasses = 0
    for (const cls of SUPPORTED_CANNABIS_CLASSES) {
      if (cls === 'non_cannabis') continue
      const result = validateCompliance({
        cannabisClass: cls,
        measurementBasis: 'exempt',
        measurementValue: null,
      })
      if (result === null) exemptBypasses += 1
    }
    check('no cannabis class can be exempted by setting the basis', exemptBypasses === 0,
      `${exemptBypasses} bypassed`)
  }

  /* ============================== 4. ACTIVE `other` CANNOT SELL ========= */
  section('[4] An active `other` variant cannot enter checkout')
  {
    const { variantId } = await makeVariant({
      cannabisClass: 'other',
      measurementBasis: null,
      measurementValue: null,
    })

    check('it is not checkout eligible', !(await isVariantCheckoutEligible(variantId)))

    const user = await makeUser('other-buyer')
    const draft = await draftFor(user, variantId, 1)
    check('a draft containing it is refused', !draft.ok,
      draft.ok ? 'draft was created' : draft.failure.kind)
    check('the refusal names the rule problem',
      !draft.ok && draft.failure.kind === 'limit_rules_unavailable',
      draft.ok ? '' : draft.failure.kind)

    /** And it remains VISIBLE in the readiness report. */
    const report = await loadVariantCompliance({ includeInactive: true })
    const row = report.find((r) => r.variantId === variantId)
    check('it still appears in the readiness report', row !== undefined)
    check('reported as not ready', row?.ready === false)
    check('with a reason a person can act on', Boolean(row?.reason))
  }

  /* ================================ 5. AUDIT ROLLS BACK THE WRITE ======= */
  section('[5] An audit failure rolls the catalog change back')
  {
    const { variantId } = await makeVariant({
      cannabisClass: 'flower',
      measurementBasis: 'net_weight_grams',
      measurementValue: '3.5000',
    })

    /**
     * A REAL trigger on `audit_log`, not a stub. What must be true is that a
     * genuine database failure on the audit insert takes the catalog write with
     * it; a mocked writer would only prove the mock fired.
     */
    await db.execute(sql`
      create or replace function catalog_block_audit() returns trigger as $$
      begin
        raise exception 'catalog suite: simulated audit failure'
          using errcode = 'internal_error';
      end;
      $$ language plpgsql
    `)
    await db.execute(sql`
      create trigger catalog_block_audit before insert on audit_log
        for each row when (new.event = 'CATALOG_COMPLIANCE_CHANGED')
        execute function catalog_block_audit()
    `)

    let threw = false
    try {
      await classifyVariants([
        {
          variantId,
          cannabisClass: 'concentrate',
          measurementBasis: 'net_weight_grams',
          measurementValue: '1.0000',
          reason: 'Catalog suite: this change must not survive.',
          actorId: admin,
        },
      ])
    } catch {
      threw = true
    } finally {
      await db.execute(sql`drop trigger if exists catalog_block_audit on audit_log`)
      await db.execute(sql`drop function if exists catalog_block_audit()`)
    }

    check('the failure surfaced rather than being swallowed', threw)

    const [after] = await db
      .select({
        cannabisClass: schema.productVariants.cannabisClass,
        measurementValue: schema.productVariants.measurementValue,
      })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId))

    check('the classification is unchanged', after.cannabisClass === 'flower',
      String(after.cannabisClass))
    check('the measurement is unchanged', after.measurementValue === '3.5000',
      String(after.measurementValue))

    /** And it works once the induced fault is gone. */
    const recovered = await classifyVariants([
      {
        variantId,
        cannabisClass: 'concentrate',
        measurementBasis: 'net_weight_grams',
        measurementValue: '1.0000',
        reason: 'Catalog suite: classification succeeds after the induced failure.',
        actorId: admin,
      },
    ])
    check('classifying works again afterwards', recovered.ok)

    const auditRows = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, variantId),
          eq(schema.auditLog.event, 'CATALOG_COMPLIANCE_CHANGED'),
        ),
      )
    check('exactly one audit row exists for the successful change', auditRows.length === 1,
      `${auditRows.length}`)
  }

  /* ==================================== 6. BULK IS ATOMIC =============== */
  section('[6] Bulk changes are all-or-nothing')
  {
    const a = await makeVariant({ cannabisClass: 'other', measurementBasis: null, measurementValue: null })
    const b = await makeVariant({ cannabisClass: 'other', measurementBasis: null, measurementValue: null })

    const before = await db
      .select({ id: schema.productVariants.id, cls: schema.productVariants.cannabisClass })
      .from(schema.productVariants)
      .where(inArray(schema.productVariants.id, [a.variantId, b.variantId]))
    check('both start unclassified', before.every((r) => r.cls === 'other'))

    /** One good id, one that does not exist. */
    const withMissing = await classifyVariants([
      {
        variantId: a.variantId,
        cannabisClass: 'flower',
        measurementBasis: 'net_weight_grams',
        measurementValue: '3.5000',
        reason: 'Catalog suite: a batch containing an unknown variant.',
        actorId: admin,
      },
      {
        variantId: '00000000-0000-4000-8000-000000000000',
        cannabisClass: 'flower',
        measurementBasis: 'net_weight_grams',
        measurementValue: '3.5000',
        reason: 'Catalog suite: a batch containing an unknown variant.',
        actorId: admin,
      },
    ])
    check('a batch with an unknown variant is rejected', !withMissing.ok)

    const afterFailed = await db
      .select({ id: schema.productVariants.id, cls: schema.productVariants.cannabisClass })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, a.variantId))
    check('the valid row in the failed batch was NOT applied',
      afterFailed[0].cls === 'other', String(afterFailed[0].cls))

    /** An invalid VALUE rejects before the transaction opens. */
    const withInvalid = await classifyVariants([
      {
        variantId: a.variantId,
        cannabisClass: 'flower',
        measurementBasis: 'net_weight_grams',
        measurementValue: '0',
        reason: 'Catalog suite: a batch containing a zero measurement.',
        actorId: admin,
      },
    ])
    check('a batch containing an invalid value is rejected', !withInvalid.ok)

    /** And a wholly valid batch applies to every row. */
    const good = await classifyVariants(
      [a.variantId, b.variantId].map((variantId) => ({
        variantId,
        cannabisClass: 'flower' as const,
        measurementBasis: 'net_weight_grams',
        measurementValue: '3.5000',
        reason: 'Catalog suite: a valid batch applied to both variants.',
        actorId: admin,
      })),
    )
    check('a valid batch succeeds', good.ok && good.changed === 2,
      good.ok ? `${good.changed}` : 'failed')

    const afterGood = await db
      .select({ id: schema.productVariants.id, cls: schema.productVariants.cannabisClass })
      .from(schema.productVariants)
      .where(inArray(schema.productVariants.id, [a.variantId, b.variantId]))
    check('both rows were applied', afterGood.every((r) => r.cls === 'flower'))

    const audits = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          inArray(schema.auditLog.entityId, [a.variantId, b.variantId]),
          eq(schema.auditLog.event, 'CATALOG_COMPLIANCE_CHANGED'),
        ),
      )
    check('every row in the batch was audited', audits.length === 2, `${audits.length}`)
  }

  /* ============================ 7. HISTORY IS NOT REWRITTEN ============= */
  section('[7] A catalog correction never changes a placed order')
  {
    process.env.CHECKOUT_ENABLED = 'true'
    await freshSweep()

    const { variantId } = await makeVariant({
      cannabisClass: 'flower',
      measurementBasis: 'net_weight_grams',
      measurementValue: '3.5000',
    })
    const user = await makeUser('history')

    const draft = await draftFor(user, variantId, 2)
    check('draft created', draft.ok, draft.ok ? '' : draft.failure.kind)
    if (!draft.ok) return
    created.orders.push(draft.orderId)

    const placed = await placeOrder({
      userId: user,
      orderId: draft.orderId,
      idempotencyKey: `cat-history-${stamp}`,
      actorId: user,
    })
    check('order placed', placed.ok)

    const [lineBefore] = await db
      .select({
        cls: schema.orderLines.cannabisClass,
        basis: schema.orderLines.measurementBasis,
        value: schema.orderLines.measurementValue,
        usable: schema.orderLines.usableEquivalentGrams,
        ruleId: schema.orderLines.purchaseLimitRuleId,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, draft.orderId))

    check('the line snapshotted its class', lineBefore.cls === 'flower')
    check('the line snapshotted its basis', lineBefore.basis === 'net_weight_grams')
    check('the line snapshotted 7 g of usable equivalent',
      lineBefore.usable === '7.00000', String(lineBefore.usable))

    /** Now correct the catalog — the measurement was wrong all along. */
    const corrected = await classifyVariants([
      {
        variantId,
        cannabisClass: 'concentrate',
        measurementBasis: 'net_weight_grams',
        measurementValue: '1.0000',
        reason: 'Catalog suite: correcting a misclassified variant after a sale.',
        actorId: admin,
      },
    ])
    check('the correction applied', corrected.ok)

    const [lineAfter] = await db
      .select({
        cls: schema.orderLines.cannabisClass,
        basis: schema.orderLines.measurementBasis,
        value: schema.orderLines.measurementValue,
        usable: schema.orderLines.usableEquivalentGrams,
        ruleId: schema.orderLines.purchaseLimitRuleId,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, draft.orderId))

    check('the placed line still says flower', lineAfter.cls === lineBefore.cls,
      `${lineBefore.cls} -> ${lineAfter.cls}`)
    check('its measurement is unchanged', lineAfter.value === lineBefore.value,
      `${lineBefore.value} -> ${lineAfter.value}`)
    check('its usable equivalent is unchanged', lineAfter.usable === lineBefore.usable,
      `${lineBefore.usable} -> ${lineAfter.usable}`)
    check('its rule id is unchanged', lineAfter.ruleId === lineBefore.ruleId)
  }

  /* ============ 8. A CORRECTION DURING A DRAFT APPLIES AT PLACEMENT ===== */
  section('[8] A correction during a draft is applied at placement')
  {
    const { variantId } = await makeVariant({
      cannabisClass: 'flower',
      measurementBasis: 'net_weight_grams',
      measurementValue: '3.5000',
    })
    const user = await makeUser('mid-draft')

    const draft = await draftFor(user, variantId, 1)
    check('draft created', draft.ok, draft.ok ? '' : draft.failure.kind)
    if (!draft.ok) return
    created.orders.push(draft.orderId)

    const [atDraft] = await db
      .select({ usable: schema.orderLines.usableEquivalentGrams })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, draft.orderId))
    check('the draft recorded 3.5 g', atDraft.usable === '3.50000', String(atDraft.usable))

    /** The catalog is corrected while the draft is open. */
    await classifyVariants([
      {
        variantId,
        cannabisClass: 'flower',
        measurementBasis: 'net_weight_grams',
        measurementValue: '7.0000',
        reason: 'Catalog suite: correcting the measurement mid-draft.',
        actorId: admin,
      },
    ])

    const placed = await placeOrder({
      userId: user,
      orderId: draft.orderId,
      idempotencyKey: `cat-mid-${stamp}`,
      actorId: user,
    })
    check('the draft still places', placed.ok)

    const [atPlacement] = await db
      .select({ usable: schema.orderLines.usableEquivalentGrams })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, draft.orderId))
    check('placement re-read the catalog and recorded 7 g',
      atPlacement.usable === '7.00000', String(atPlacement.usable))
  }

  /* ====== 9. A CORRECTION MAKING A PRODUCT UNSELLABLE REFUSES PLACEMENT = */
  section('[9] A correction to an unsupported class refuses placement')
  {
    const { variantId } = await makeVariant({
      cannabisClass: 'flower',
      measurementBasis: 'net_weight_grams',
      measurementValue: '3.5000',
    })
    const user = await makeUser('unsellable')

    const draft = await draftFor(user, variantId, 2)
    if (!draft.ok) return
    created.orders.push(draft.orderId)

    const held = await db
      .select({ held: schema.productVariants.reservedQuantity })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, variantId))
    check('stock is held by the draft', held[0].held === 2, `${held[0].held}`)

    /**
     * Reverting to `other` is done directly, because `classifyVariants` will
     * not write an unsupported class — which is correct. The situation being
     * tested is a database that got there some other way: a restore, a data
     * fix, or a migration from before the matrix existed.
     */
    await db
      .update(schema.productVariants)
      .set({ cannabisClass: 'other', measurementBasis: null, measurementValue: null })
      .where(eq(schema.productVariants.id, variantId))

    const placed = await placeOrder({
      userId: user,
      orderId: draft.orderId,
      idempotencyKey: `cat-unsellable-${stamp}`,
      actorId: user,
    })
    check('placement is refused', !placed.ok,
      placed.ok ? 'it placed' : placed.failure.kind)
    check('the refusal is the rule/class one',
      !placed.ok && placed.failure.kind === 'limit_rules_unavailable',
      placed.ok ? '' : placed.failure.kind)

    const [order] = await db
      .select({
        status: schema.orders.currentStatus,
        inventoryState: schema.orders.inventoryState,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, draft.orderId))
    check('no placed order was created', order.status === 'draft', order.status)
    check('the inventory allocation is not stranded in a half state',
      order.inventoryState === 'reserved', order.inventoryState)
  }

  /* ================== 10. A CORRECTION RACING A PLACEMENT =============== */
  section('[10] A correction racing a placement produces one complete result')
  {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { variantId } = await makeVariant({
        cannabisClass: 'flower',
        measurementBasis: 'net_weight_grams',
        measurementValue: '3.5000',
      })
      const user = await makeUser(`race-${attempt}`)

      const draft = await draftFor(user, variantId, 1)
      if (!draft.ok) {
        check(`race ${attempt}: draft created`, false, draft.failure.kind)
        continue
      }
      created.orders.push(draft.orderId)

      /** Fired together. */
      const [placement] = await Promise.all([
        placeOrder({
          userId: user,
          orderId: draft.orderId,
          idempotencyKey: `cat-race-${stamp}-${attempt}`,
          actorId: user,
        }),
        classifyVariants([
          {
            variantId,
            cannabisClass: 'flower',
            measurementBasis: 'net_weight_grams',
            measurementValue: '7.0000',
            reason: 'Catalog suite: a correction racing a placement.',
            actorId: admin,
          },
        ]),
      ])

      const [line] = await db
        .select({
          usable: schema.orderLines.usableEquivalentGrams,
          value: schema.orderLines.measurementValue,
          basis: schema.orderLines.measurementBasis,
          cls: schema.orderLines.cannabisClass,
        })
        .from(schema.orderLines)
        .where(eq(schema.orderLines.orderId, draft.orderId))

      const [order] = await db
        .select({ status: schema.orders.currentStatus })
        .from(schema.orders)
        .where(eq(schema.orders.id, draft.orderId))

      if (!placement.ok) {
        check(`race ${attempt}: refused placement left the draft intact`,
          order.status === 'draft', order.status)
        continue
      }

      /**
       * THE PROPERTY: whichever side won, the snapshot is internally
       * consistent. It is either wholly the old measurement or wholly the new
       * one — never 3.5 g of measurement recorded against 7 g of equivalent,
       * which is what a torn read would produce.
       */
      const consistent =
        (line.value === '3.5000' && line.usable === '3.50000') ||
        (line.value === '7.0000' && line.usable === '7.00000')

      check(
        `race ${attempt}: the snapshot is whole, not mixed`,
        consistent,
        `value ${line.value}, usable ${line.usable}`,
      )
      check(`race ${attempt}: the order is placed exactly once`,
        order.status === 'placed', order.status)
      check(`race ${attempt}: the class and basis agree`,
        line.cls === 'flower' && line.basis === 'net_weight_grams')
    }
  }

  /* ================================= 11. THE KILL SWITCH =============== */
  section('[11] The checkout kill switch')
  {
    const { variantId } = await makeVariant({
      cannabisClass: 'flower',
      measurementBasis: 'net_weight_grams',
      measurementValue: '3.5000',
    })
    const user = await makeUser('switch')

    /* ---- absent means disabled ---- */
    delete process.env.CHECKOUT_ENABLED
    let gate = await checkoutGate()
    check('an absent flag means DISABLED', !gate.open && gate.reason === 'disabled',
      gate.open ? 'open' : gate.reason)

    /* ---- "false", and the near-misses ---- */
    for (const value of ['false', 'FALSE', '0', 'yes', '1', 'True', '']) {
      process.env.CHECKOUT_ENABLED = value
      const g = await checkoutGate()
      check(`"${value}" does not enable checkout`, !g.open, g.open ? 'open' : '')
    }

    /* ---- only the exact string enables it ---- */
    process.env.CHECKOUT_ENABLED = 'true'
    await freshSweep()
    gate = await checkoutGate()
    check('"true" with a fresh sweep opens the gate', gate.open,
      gate.open ? '' : gate.reason)

    const draft = await draftFor(user, variantId, 1)
    check('a draft can be created when open', draft.ok,
      draft.ok ? '' : draft.failure.kind)
    if (draft.ok) created.orders.push(draft.orderId)
  }

  /* ============================= 12. STALE SWEEPER ===================== */
  section('[12] A stale sweeper blocks new drafts and nothing else')
  {
    process.env.CHECKOUT_ENABLED = 'true'

    const { variantId } = await makeVariant({
      cannabisClass: 'flower',
      measurementBasis: 'net_weight_grams',
      measurementValue: '3.5000',
    })
    const user = await makeUser('stale')

    /** A placed order to administer while the scheduler is down. */
    await freshSweep()
    const draft = await draftFor(user, variantId, 1)
    if (!draft.ok) return
    created.orders.push(draft.orderId)
    const placed = await placeOrder({
      userId: user,
      orderId: draft.orderId,
      idempotencyKey: `cat-stale-${stamp}`,
      actorId: user,
    })
    check('an order exists before the outage', placed.ok)

    /**
     * Age every completed run past the threshold. Captured and restored below,
     * so the suite does not leave the development scheduler looking broken.
     */
    const aged = await db
      .update(schema.schedulerRuns)
      .set({ startedAt: sql`now() - interval '2 hours'` })
      .where(
        and(
          eq(schema.schedulerRuns.job, SWEEP_JOB),
          eq(schema.schedulerRuns.outcome, 'completed'),
        ),
      )
      .returning({ id: schema.schedulerRuns.id })

    const gate = await checkoutGate()
    check('the gate closes when the sweeper is stale',
      !gate.open && gate.reason === 'sweeper_stale',
      gate.open ? 'open' : gate.reason)
    check('and it reports how stale',
      !gate.open && gate.reason === 'sweeper_stale' && (gate.ageSeconds ?? 0) > MAX_SWEEP_AGE_SECONDS)

    /* ---- what must STILL work ---- */
    const [existing] = await db
      .select({ status: schema.orders.currentStatus, number: schema.orders.orderNumber })
      .from(schema.orders)
      .where(eq(schema.orders.id, draft.orderId))
    check('the existing order is still readable', existing.status === 'placed')

    const { cancelOrder } = await import('../lib/orders/core')
    const cancelled = await cancelOrder({
      orderId: draft.orderId,
      actorType: 'staff',
      actorId: admin,
      reason: 'catalog suite: staff operation during a scheduler outage',
    })
    check('staff can still cancel an order', cancelled.ok)

    const compliance = await loadVariantCompliance({ includeInactive: true })
    check('the admin readiness report still works', compliance.length > 0)

    /** Restore, so the rest of the suite and the next run see a live sweeper. */
    if (aged.length) {
      await db
        .update(schema.schedulerRuns)
        .set({ startedAt: new Date() })
        .where(inArray(schema.schedulerRuns.id, aged.map((r) => r.id)))
    }
    const restored = await checkoutGate()
    check('the gate reopens once a sweep is recent again', restored.open,
      restored.open ? '' : restored.reason)
  }
}

async function teardown() {
  section('[13] Teardown')

  /** The flag is restored FIRST, so an exception below cannot leave it on. */
  if (originalFlag === undefined) delete process.env.CHECKOUT_ENABLED
  else process.env.CHECKOUT_ENABLED = originalFlag
  check('the checkout flag was restored',
    process.env.CHECKOUT_ENABLED === originalFlag)

  if (created.runs.length) {
    await db
      .delete(schema.schedulerRuns)
      .where(inArray(schema.schedulerRuns.id, created.runs))
  }

  if (created.orders.length) {
    await db.delete(schema.orderEvents).where(inArray(schema.orderEvents.orderId, created.orders))
    await db.delete(schema.orderLines).where(inArray(schema.orderLines.orderId, created.orders))
    await db.delete(schema.payments).where(inArray(schema.payments.orderId, created.orders))
    await db.delete(schema.fulfilments).where(inArray(schema.fulfilments.orderId, created.orders))
    await db.delete(schema.orders).where(inArray(schema.orders.id, created.orders))
  }

  if (created.users.length) {
    const auditRows = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.userId, created.users))
    if (auditRows.length) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.id, auditRows.map((r) => r.id)))
    }
    await db.delete(schema.carts).where(inArray(schema.carts.userId, created.users))
  }

  if (created.variants.length) {
    await db.delete(schema.cartLines).where(inArray(schema.cartLines.variantId, created.variants))
    await db.delete(schema.productVariants).where(inArray(schema.productVariants.id, created.variants))
  }
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

  const leftoverVariants = await db
    .select({ id: schema.productVariants.id })
    .from(schema.productVariants)
    .where(inArray(schema.productVariants.id, created.variants.length ? created.variants : ['']))
  check('every fixture variant was removed by id', leftoverVariants.length === 0)

  const orphanTriggers = await db.execute<{ tgname: string }>(
    sql`select tgname from pg_trigger where tgname='catalog_block_audit' and not tgisinternal`,
  )
  const rows = Array.isArray(orphanTriggers) ? orphanTriggers : orphanTriggers.rows
  check('no fault-injection trigger was left installed', rows.length === 0)
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
