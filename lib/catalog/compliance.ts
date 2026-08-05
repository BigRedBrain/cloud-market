import 'server-only'

import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { recordAuditEventWithin } from '@/lib/auth/audit'
import { db, schema } from '@/lib/db'
import type { MeasurementBasis } from '@/lib/db/schema'
import {
  fromDecimalString,
  isZero,
  multiply,
  toFixed,
  type Rational,
} from '@/lib/orders/exact'
import {
  CLASS_EQUIVALENCE,
  CLASS_MEASUREMENT,
  isSupportedClass,
  type SupportedCannabisClass,
} from '@/lib/orders/limits'

/**
 * Catalog compliance: classifying what a product physically is.
 *
 * THIS MODULE NEVER GUESSES. Nothing here reads a product name, a category, a
 * description, a THC figure or prior seed data to decide a classification. That
 * is not a limitation to be worked around later — a classification is a factual
 * claim about a physical item, made by a person who can be asked to justify it,
 * and a plausible inference from "Blackberry Gummies" is exactly the kind of
 * mistake that looks right in a spreadsheet and is wrong on a shelf.
 *
 * The matrix itself lives in `lib/orders/limits.ts`, alongside the arithmetic
 * that consumes it, so there is one definition rather than two that can drift.
 * Here it becomes validation, a readiness verdict, and an audited write.
 */

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type ComplianceInput = {
  cannabisClass: string
  measurementBasis: string | null
  /** Exact decimal string, or null. NEVER a `number`. */
  measurementValue: string | null
}

export type ComplianceRejection =
  | { kind: 'unsupported_class'; cannabisClass: string }
  | { kind: 'basis_required'; expected: MeasurementBasis }
  | { kind: 'basis_mismatch'; expected: MeasurementBasis; supplied: string }
  | { kind: 'value_required' }
  | { kind: 'value_not_allowed' }
  | { kind: 'value_not_decimal'; supplied: string }
  | { kind: 'value_not_positive'; supplied: string }
  | { kind: 'plants_not_whole'; supplied: string }
  | { kind: 'no_rule_in_force'; cannabisClass: string }

/**
 * The matrix, enforced.
 *
 * Every rejection is named. "Invalid" as a single verdict would be useless to
 * the person who has to fix it — they need to know whether the class is wrong,
 * the unit is wrong, or the number is.
 */
export function validateCompliance(input: ComplianceInput): ComplianceRejection | null {
  if (!isSupportedClass(input.cannabisClass)) {
    return { kind: 'unsupported_class', cannabisClass: input.cannabisClass }
  }

  const cls: SupportedCannabisClass = input.cannabisClass
  const spec = CLASS_MEASUREMENT[cls]

  if (input.measurementBasis === null) {
    return { kind: 'basis_required', expected: spec.basis }
  }
  if (input.measurementBasis !== spec.basis) {
    return {
      kind: 'basis_mismatch',
      expected: spec.basis,
      supplied: input.measurementBasis,
    }
  }

  /**
   * `non_cannabis` is the ONLY class that may carry no measurement, and it must
   * carry none at all. A value on an exempt item is a contradiction: either the
   * item is outside the calculation or it is not, and a number sitting there
   * suggests somebody was unsure.
   */
  if (!spec.countsAsCannabis) {
    if (input.measurementValue !== null && input.measurementValue.trim() !== '') {
      return { kind: 'value_not_allowed' }
    }
    return null
  }

  if (input.measurementValue === null || input.measurementValue.trim() === '') {
    return { kind: 'value_required' }
  }

  let value: Rational
  try {
    value = fromDecimalString(input.measurementValue)
  } catch {
    return { kind: 'value_not_decimal', supplied: input.measurementValue }
  }

  /**
   * Zero and negative are both refused, and zero is the dangerous one: a
   * cannabis item measuring nothing contributes nothing to any cap, which is
   * the `other = 0` failure wearing a different field.
   */
  if (isZero(value) || value.n < 0n) {
    return { kind: 'value_not_positive', supplied: input.measurementValue }
  }

  /** Plants are counted. Two and a half plants is not a thing. */
  if (cls === 'immature_plant' && value.d !== 1n) {
    return { kind: 'plants_not_whole', supplied: input.measurementValue }
  }

  return null
}

export function describeRejection(rejection: ComplianceRejection): string {
  switch (rejection.kind) {
    case 'unsupported_class':
      return `"${rejection.cannabisClass}" is not a supported classification. Choose one of the six in the matrix; "other" and "edible" are legacy values that cannot be sold.`
    case 'basis_required':
      return `This class must be measured as ${rejection.expected.replace(/_/g, ' ')}.`
    case 'basis_mismatch':
      return `This class is measured as ${rejection.expected.replace(/_/g, ' ')}, not ${rejection.supplied.replace(/_/g, ' ')}. A conversion applied to the wrong unit is silently wrong.`
    case 'value_required':
      return 'A measurement value is required. Without it the item counts toward no limit.'
    case 'value_not_allowed':
      return 'Non-cannabis merchandise is exempt and must carry no measurement value.'
    case 'value_not_decimal':
      return `"${rejection.supplied}" is not an exact decimal.`
    case 'value_not_positive':
      return `"${rejection.supplied}" must be greater than zero. A cannabis item measuring zero would sell with no cap.`
    case 'plants_not_whole':
      return `"${rejection.supplied}" must be a whole number of plants.`
    case 'no_rule_in_force':
      return `No purchase-limit rule is currently in force for ${rejection.cannabisClass}, so it cannot be sold yet.`
  }
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

export type VariantCompliance = {
  variantId: string
  sku: string
  label: string
  productName: string
  active: boolean
  productActive: boolean
  cannabisClass: string | null
  measurementBasis: string | null
  measurementValue: string | null
  measurementUnit: string | null
  /** Per sellable unit, rendered exactly. Null when not calculable. */
  usableEquivalentGrams: string | null
  concentrateGrams: string | null
  immaturePlantCount: number | null
  ready: boolean
  rejection: ComplianceRejection | null
  reason: string | null
}

/**
 * Everything the admin screen and the readiness gate need, per variant.
 *
 * The per-unit figures are computed here rather than in the page so the number
 * an administrator sees while classifying is produced by the same code that
 * will price the limit at checkout. A screen that calculated its own preview
 * would eventually disagree with the thing it is previewing.
 */
export async function loadVariantCompliance(options?: {
  includeInactive?: boolean
}): Promise<VariantCompliance[]> {
  const ruled = new Set(
    (
      await db
        .select({ cls: schema.purchaseLimitRules.cannabisClass })
        .from(schema.purchaseLimitRules)
        .where(
          and(
            sql`${schema.purchaseLimitRules.effectiveFrom} <= now()`,
            sql`(${schema.purchaseLimitRules.effectiveUntil} is null
                 or ${schema.purchaseLimitRules.effectiveUntil} > now())`,
            sql`${schema.purchaseLimitRules.equivalenceNumerator} is not null`,
            sql`${schema.purchaseLimitRules.expectedBasis} is not null`,
          ),
        )
    ).map((row) => row.cls as string),
  )

  const rows = await db
    .select({
      variantId: schema.productVariants.id,
      sku: schema.productVariants.sku,
      label: schema.productVariants.label,
      active: schema.productVariants.active,
      deletedAt: schema.productVariants.deletedAt,
      cannabisClass: schema.productVariants.cannabisClass,
      measurementBasis: schema.productVariants.measurementBasis,
      measurementValue: schema.productVariants.measurementValue,
      productName: schema.products.name,
      productStatus: schema.products.status,
      productDeletedAt: schema.products.deletedAt,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
    .where(
      options?.includeInactive
        ? isNull(schema.productVariants.deletedAt)
        : and(
            eq(schema.productVariants.active, true),
            isNull(schema.productVariants.deletedAt),
            eq(schema.products.status, 'active'),
            isNull(schema.products.deletedAt),
          ),
    )
    .orderBy(asc(schema.products.name), asc(schema.productVariants.sku))

  return rows.map((row) => {
    const rejection =
      validateCompliance({
        cannabisClass: row.cannabisClass ?? '',
        measurementBasis: row.measurementBasis,
        measurementValue: row.measurementValue,
      }) ??
      /**
       * The rule check is last and separate: a correctly classified variant in
       * a class nobody has published a rule for is a DIFFERENT problem, fixed
       * by a compliance officer rather than by whoever maintains the catalog.
       */
      (row.cannabisClass && !ruled.has(row.cannabisClass)
        ? ({ kind: 'no_rule_in_force', cannabisClass: row.cannabisClass } as const)
        : null)

    const supported = row.cannabisClass && isSupportedClass(row.cannabisClass)
    const spec = supported
      ? CLASS_MEASUREMENT[row.cannabisClass as SupportedCannabisClass]
      : null

    let usable: string | null = null
    let concentrate: string | null = null
    let plants: number | null = null

    if (supported && !rejection) {
      const cls = row.cannabisClass as SupportedCannabisClass
      if (!spec!.countsAsCannabis) {
        usable = '0.00000'
        concentrate = '0.00000'
        plants = 0
      } else {
        const value = fromDecimalString(row.measurementValue!)
        usable = toFixed(multiply(value, CLASS_EQUIVALENCE[cls]), 5)
        concentrate = cls === 'concentrate' ? toFixed(value, 5) : '0.00000'
        plants = cls === 'immature_plant' ? Number(toFixed(value, 0)) : 0
      }
    }

    return {
      variantId: row.variantId,
      sku: row.sku,
      label: row.label,
      productName: row.productName,
      active: row.active && row.deletedAt === null,
      productActive: row.productStatus === 'active' && row.productDeletedAt === null,
      cannabisClass: row.cannabisClass,
      measurementBasis: row.measurementBasis,
      measurementValue: row.measurementValue,
      measurementUnit: spec?.unit ?? null,
      usableEquivalentGrams: usable,
      concentrateGrams: concentrate,
      immaturePlantCount: plants,
      ready: rejection === null,
      rejection,
      reason: rejection ? describeRejection(rejection) : null,
    }
  })
}

/**
 * Is this one variant sellable right now?
 *
 * Used by the bag, so a non-compliant item cannot even be added — the customer
 * finds out at the point they choose it rather than at the last step of
 * checkout. Deliberately a single-row query rather than a filter over
 * `loadVariantCompliance`, which loads the whole catalog.
 */
export async function isVariantCheckoutEligible(variantId: string): Promise<boolean> {
  const [row] = await db
    .select({
      cannabisClass: schema.productVariants.cannabisClass,
      measurementBasis: schema.productVariants.measurementBasis,
      measurementValue: schema.productVariants.measurementValue,
    })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.id, variantId))
    .limit(1)

  if (!row) return false
  if (validateCompliance({
    cannabisClass: row.cannabisClass ?? '',
    measurementBasis: row.measurementBasis,
    measurementValue: row.measurementValue,
  })) {
    return false
  }

  const [rule] = await db
    .select({ id: schema.purchaseLimitRules.id })
    .from(schema.purchaseLimitRules)
    .where(
      and(
        eq(schema.purchaseLimitRules.cannabisClass, row.cannabisClass!),
        sql`${schema.purchaseLimitRules.effectiveFrom} <= now()`,
        sql`(${schema.purchaseLimitRules.effectiveUntil} is null
             or ${schema.purchaseLimitRules.effectiveUntil} > now())`,
        sql`${schema.purchaseLimitRules.equivalenceNumerator} is not null`,
      ),
    )
    .limit(1)

  return rule !== undefined
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export type ClassifyInput = {
  variantId: string
  cannabisClass: string
  measurementBasis: string | null
  measurementValue: string | null
  reason: string
  actorId: string
}

export type ClassifyFailure =
  | { kind: 'not_found'; variantId: string }
  | { kind: 'invalid'; variantId: string; rejection: ComplianceRejection }
  | { kind: 'unchanged'; variantId: string }

export type ClassifyResult =
  | { ok: true; changed: number }
  | { ok: false; failure: ClassifyFailure }

/**
 * Applies one or more classifications, atomically, with a mandatory audit row.
 *
 * ONE FUNCTION FOR SINGLE AND BULK, because a bulk operation that took a
 * different code path would be a second implementation of the rules, and the
 * one used less often is the one that rots.
 *
 * TRANSACTIONALLY MANDATORY AUDIT. `recordAuditEventWithin` throws rather than
 * swallowing, so a failed audit insert rolls the catalog change back with it.
 * A classification with no record of who made it or why is not a lesser version
 * of the same change — it is the artefact the audit exists to prevent.
 *
 * ALL-OR-NOTHING. One invalid row rejects the whole batch. Applying the valid
 * half of a bulk edit and reporting the rest would leave the operator to work
 * out which of forty SKUs actually changed, from a screen that has already
 * moved on.
 *
 * The variant's PREVIOUS values are captured inside the transaction and written
 * into the audit summary, so the log answers "what did it used to be" without
 * needing a separate history table.
 */
export async function classifyVariants(
  inputs: ClassifyInput[],
): Promise<ClassifyResult> {
  if (inputs.length === 0) return { ok: true, changed: 0 }

  /** Validated before the transaction opens; none of it needs a lock. */
  for (const input of inputs) {
    const rejection = validateCompliance(input)
    if (rejection) {
      return { ok: false, failure: { kind: 'invalid', variantId: input.variantId, rejection } }
    }
  }

  let result: ClassifyResult = { ok: true, changed: 0 }

  await db.transaction(async (tx) => {
    let changed = 0

    for (const input of inputs) {
      const [before] = await tx
        .select({
          id: schema.productVariants.id,
          sku: schema.productVariants.sku,
          cannabisClass: schema.productVariants.cannabisClass,
          measurementBasis: schema.productVariants.measurementBasis,
          measurementValue: schema.productVariants.measurementValue,
        })
        .from(schema.productVariants)
        .where(eq(schema.productVariants.id, input.variantId))
        .for('update')
        .limit(1)

      if (!before) {
        result = { ok: false, failure: { kind: 'not_found', variantId: input.variantId } }
        throw new ComplianceRollback()
      }

      const nextValue =
        input.measurementValue === null || input.measurementValue.trim() === ''
          ? null
          : input.measurementValue.trim()

      await tx
        .update(schema.productVariants)
        .set({
          cannabisClass: input.cannabisClass as 'flower',
          measurementBasis: input.measurementBasis as MeasurementBasis,
          measurementValue: nextValue,
          updatedAt: new Date(),
        })
        .where(eq(schema.productVariants.id, input.variantId))

      /**
       * Written for EVERY variant in the batch, including ones whose values did
       * not move. A bulk edit that touched forty SKUs and audited thirty-one
       * would leave nine that an auditor cannot account for.
       */
      await recordAuditEventWithin(tx, {
        event: 'CATALOG_COMPLIANCE_CHANGED',
        userId: input.actorId,
        entityType: 'product_variant',
        entityId: input.variantId,
        summary:
          `${before.sku}: ` +
          `${before.cannabisClass ?? 'null'}/${before.measurementBasis ?? 'null'}/${before.measurementValue ?? 'null'}` +
          ` → ${input.cannabisClass}/${input.measurementBasis ?? 'null'}/${nextValue ?? 'null'}` +
          ` — ${input.reason}`,
      })

      changed += 1
    }

    result = { ok: true, changed }
  }).catch((error) => {
    /**
     * `ComplianceRollback` is how a business outcome exits the transaction
     * without becoming an exception the caller has to interpret. Anything else
     * is a real fault and is re-thrown — including an audit failure, which is
     * exactly the case that must not be swallowed.
     */
    if (!(error instanceof ComplianceRollback)) throw error
  })

  return result
}

/** Rolls back without turning a business outcome into an error. */
class ComplianceRollback extends Error {
  constructor() {
    super('compliance rollback')
    this.name = 'ComplianceRollback'
  }
}

/** The six supported classes with their required basis, for the admin form. */
export const CLASSIFICATION_MATRIX = (
  Object.keys(CLASS_MEASUREMENT) as SupportedCannabisClass[]
).map((cls) => ({
  cannabisClass: cls,
  basis: CLASS_MEASUREMENT[cls].basis,
  unit: CLASS_MEASUREMENT[cls].unit,
  countsAsCannabis: CLASS_MEASUREMENT[cls].countsAsCannabis,
  equivalence: `${CLASS_EQUIVALENCE[cls].n}/${CLASS_EQUIVALENCE[cls].d}`,
  requiresValue: CLASS_MEASUREMENT[cls].countsAsCannabis,
  wholeNumbersOnly: cls === 'immature_plant',
}))
