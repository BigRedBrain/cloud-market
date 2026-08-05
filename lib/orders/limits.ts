/**
 * Michigan adult-use purchase limits. Pure calculation; the rules arrive as
 * data; the arithmetic is exact.
 *
 * THREE INDEPENDENT CAPS, PER TRANSACTION, EVERY ONE OF WHICH MUST PASS:
 *
 *   1. usable-marijuana equivalent   ≤ 2.5 oz  (70.87380781250 g exactly)
 *   2. concentrate                   ≤ 15 g
 *   3. immature plants               ≤ 3 units
 *
 * They are NOT combined into one weighted score. 15 g of concentrate sits well
 * inside the usable ceiling and is still the legal maximum on its own terms;
 * a single number cannot express that, and the earlier design's attempt to —
 * weighting concentrate 5:1 so it would trip the total — produced a figure that
 * matched no rule in the guidance and refused lawful baskets while permitting
 * unlawful ones.
 *
 * PER TRANSACTION, NOT PER DAY. Adult-use limits apply to the transaction. The
 * previous implementation summed a rolling 24-hour window of prior purchases,
 * which is the medical-caregiver model and is stricter than the law requires in
 * a way that silently blocked legitimate customers.
 *
 * EQUIVALENCY IS BY FINISHED-PRODUCT MASS AND VOLUME, NEVER BY POTENCY:
 *
 *   16 oz  of solid infused product  = 1 oz usable  →  ×1/16 by mass
 *   36 fl oz of liquid infused product = 1 oz usable → ×(28.349523125/36) g per fl oz
 *
 * THC milligrams do not enter any calculation here. Deriving equivalency from
 * potency would produce a plausible-looking number that is not the one the
 * guidance specifies.
 *
 * EVERYTHING FAILS CLOSED. An unknown class, an unsupported class, a missing
 * measurement, a mismatched unit or a missing rule refuses the basket. There is
 * no default that lets a cannabis product through contributing zero — that was
 * the `other = 0` behaviour, and it meant a product sold without any cap
 * because someone left a field alone.
 *
 * NO I/O and NO FLOATING POINT, so the property tests can hammer it and the
 * comparisons are exact.
 */

import type { CannabisClass, MeasurementBasis } from '@/lib/db/schema'
import {
  add,
  compare,
  fromDecimalString,
  isNegative,
  isZero,
  multiply,
  rational,
  toFixed,
  toRatioString,
  ZERO,
  CONCENTRATE_CAP_GRAMS,
  GRAMS_PER_OUNCE,
  IMMATURE_PLANT_CAP,
  USABLE_CAP_GRAMS,
  type Rational,
} from './exact'

/**
 * Bumped when the SHAPE of the calculation changes, not when a number does.
 *
 * Version 1 was the weighted-factor model with a rolling 24-hour window.
 * Version 2 is this: three independent caps, per transaction, exact ratios,
 * finished-product equivalency. A line snapshotting version 1 was decided by
 * different arithmetic and must not be re-checked with this code as though it
 * were the same question.
 */
export const CALCULATION_VERSION = 2

/** The classes checkout will actually sell. Anything else fails closed. */
export const SUPPORTED_CANNABIS_CLASSES = [
  'flower',
  'concentrate',
  'infused_solid',
  'infused_liquid',
  'immature_plant',
  'non_cannabis',
] as const

export type SupportedCannabisClass = (typeof SUPPORTED_CANNABIS_CLASSES)[number]

export function isSupportedClass(value: string): value is SupportedCannabisClass {
  return (SUPPORTED_CANNABIS_CLASSES as readonly string[]).includes(value)
}

/**
 * The one legal measurement basis for each class, and the unit it is read in.
 *
 * A single source of truth for "does this variant make sense", used by
 * checkout, by the catalog readiness report and by rule publication. Three
 * copies of this table would be three chances to disagree.
 */
export const CLASS_MEASUREMENT: Record<
  SupportedCannabisClass,
  { basis: MeasurementBasis; unit: string; countsAsCannabis: boolean }
> = {
  flower: { basis: 'net_weight_grams', unit: 'g', countsAsCannabis: true },
  concentrate: { basis: 'net_weight_grams', unit: 'g', countsAsCannabis: true },
  infused_solid: { basis: 'finished_net_weight_grams', unit: 'g', countsAsCannabis: true },
  infused_liquid: {
    basis: 'finished_volume_fluid_ounces',
    unit: 'fl_oz',
    countsAsCannabis: true,
  },
  immature_plant: { basis: 'unit_count', unit: 'unit', countsAsCannabis: true },
  /**
   * The ONLY class permitted to contribute nothing, and it says so in its name.
   * `non_cannabis` is a statement that an item is outside the calculation —
   * a lighter, a t-shirt — not a fallback for "we did not classify this".
   */
  non_cannabis: { basis: 'exempt', unit: 'exempt', countsAsCannabis: false },
}

/**
 * The conversions the CRA guidance specifies, as exact ratios.
 *
 * Applied to the measurement value to produce usable-marijuana-equivalent
 * grams. These are the DEFAULTS used to seed `purchase_limit_rules`; the rules
 * table is authoritative at runtime, and checkout contains no gram figure.
 */
export const CLASS_EQUIVALENCE: Record<SupportedCannabisClass, Rational> = {
  /** 1:1 by actual gram weight. */
  flower: rational(1n, 1n),
  /** 1:1 by actual gram weight — and separately capped at 15 g. */
  concentrate: rational(1n, 1n),
  /** 16 oz finished mass = 1 oz usable; a mass:mass ratio, unit-independent. */
  infused_solid: rational(1n, 16n),
  /** 36 fl oz = 1 oz usable, so grams-usable per fluid ounce = 28.349523125/36. */
  infused_liquid: multiply(rational(1n, 36n), GRAMS_PER_OUNCE),
  /** Counted against the plant cap, contributes no usable weight. */
  immature_plant: ZERO,
  /** Explicitly exempt. */
  non_cannabis: ZERO,
}

export type LimitRule = {
  ruleId?: string | null
  cannabisClass: CannabisClass
  /** The exact conversion. */
  equivalence: Rational
  /** The basis this conversion expects the variant to carry. */
  expectedBasis: MeasurementBasis
  usableEquivalentCapGrams: Rational
  concentrateCapGrams: Rational
  immaturePlantCapUnits: number
}

export type LimitLineInput = {
  variantId: string
  quantity: number
  cannabisClass: string
  /** As stored: an exact decimal string, or null when never recorded. */
  measurementValue: string | null
  measurementBasis: string | null
}

export type LimitLineResult = {
  variantId: string
  quantity: number
  cannabisClass: SupportedCannabisClass
  measurementBasis: MeasurementBasis
  measurementUnit: string
  /** Per line, i.e. per-unit value × quantity. Exact decimal string. */
  measurementValue: string
  usableEquivalentGrams: Rational
  concentrateGrams: Rational
  immaturePlantCount: number
  equivalence: Rational
  ruleIdApplied: string | null
}

export type LimitRejection =
  | { kind: 'unsupported_class'; variantId: string; cannabisClass: string }
  | { kind: 'missing_measurement'; variantId: string; cannabisClass: string }
  | {
      kind: 'basis_mismatch'
      variantId: string
      cannabisClass: string
      expected: MeasurementBasis
      found: string
    }
  | { kind: 'no_rule'; variantId: string; cannabisClass: string }
  | { kind: 'invalid_measurement'; variantId: string; detail: string }
  | { kind: 'zero_equivalent_cannabis'; variantId: string; cannabisClass: string }

export type CapBreach =
  | { cap: 'usable'; total: string; limit: string }
  | { cap: 'concentrate'; total: string; limit: string }
  | { cap: 'immature_plants'; total: number; limit: number }

export type LimitEvaluation = {
  lines: LimitLineResult[]
  totalUsableEquivalentGrams: Rational
  totalConcentrateGrams: Rational
  totalImmaturePlants: number
  allowed: boolean
  /** Populated only when `allowed` is false. Safe to show a customer. */
  reason: string | null
  /** Structured detail for auditing and for the catalog readiness report. */
  rejections: LimitRejection[]
  breaches: CapBreach[]
  caps: { usableGrams: Rational; concentrateGrams: Rational; immaturePlants: number }
  calculationVersion: number
}

/** Grams carry five decimals in the schema; this rounds only for storage. */
export const formatGrams = (value: Rational): string => toFixed(value, 5)

/**
 * Evaluates one line, or explains precisely why it cannot be evaluated.
 *
 * Returns a rejection rather than throwing, and never returns a "safe default".
 * Every path that cannot produce a defensible number produces a refusal.
 */
export function evaluateLine(
  line: LimitLineInput,
  rules: Map<string, LimitRule>,
): LimitLineResult | LimitRejection {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    return {
      kind: 'invalid_measurement',
      variantId: line.variantId,
      detail: `quantity must be a positive integer, received ${line.quantity}`,
    }
  }

  if (!isSupportedClass(line.cannabisClass)) {
    return {
      kind: 'unsupported_class',
      variantId: line.variantId,
      cannabisClass: line.cannabisClass,
    }
  }

  const cls = line.cannabisClass
  const spec = CLASS_MEASUREMENT[cls]

  /**
   * Exempt merchandise short-circuits — but only because it was explicitly
   * classified as exempt, which is a different act from failing to classify it.
   * It still requires the matching basis, so a cannabis product cannot be
   * waved through by setting the basis to `exempt` and leaving the class alone.
   */
  if (!spec.countsAsCannabis) {
    if (line.measurementBasis !== null && line.measurementBasis !== 'exempt') {
      return {
        kind: 'basis_mismatch',
        variantId: line.variantId,
        cannabisClass: cls,
        expected: 'exempt',
        found: line.measurementBasis,
      }
    }
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      cannabisClass: cls,
      measurementBasis: 'exempt',
      measurementUnit: spec.unit,
      measurementValue: '0',
      usableEquivalentGrams: ZERO,
      concentrateGrams: ZERO,
      immaturePlantCount: 0,
      equivalence: ZERO,
      ruleIdApplied: rules.get(cls)?.ruleId ?? null,
    }
  }

  if (line.measurementValue === null || line.measurementBasis === null) {
    return {
      kind: 'missing_measurement',
      variantId: line.variantId,
      cannabisClass: cls,
    }
  }

  if (line.measurementBasis !== spec.basis) {
    return {
      kind: 'basis_mismatch',
      variantId: line.variantId,
      cannabisClass: cls,
      expected: spec.basis,
      found: line.measurementBasis,
    }
  }

  let perUnit: Rational
  try {
    perUnit = fromDecimalString(line.measurementValue)
  } catch (error) {
    return {
      kind: 'invalid_measurement',
      variantId: line.variantId,
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  if (isNegative(perUnit)) {
    return {
      kind: 'invalid_measurement',
      variantId: line.variantId,
      detail: 'measurement value is negative',
    }
  }

  /**
   * A cannabis item measuring zero is refused, not sold as weightless.
   *
   * This is the same failure as `other = 0` wearing different clothes: a
   * variant whose measurement was never filled in defaults to nothing and
   * therefore counts against nothing. If it is genuinely outside the
   * calculation it must be classified `non_cannabis`, deliberately.
   */
  if (isZero(perUnit)) {
    return {
      kind: 'zero_equivalent_cannabis',
      variantId: line.variantId,
      cannabisClass: cls,
    }
  }

  const rule = rules.get(cls)
  if (!rule) {
    return { kind: 'no_rule', variantId: line.variantId, cannabisClass: cls }
  }

  if (rule.expectedBasis !== spec.basis) {
    return {
      kind: 'basis_mismatch',
      variantId: line.variantId,
      cannabisClass: cls,
      expected: spec.basis,
      found: rule.expectedBasis,
    }
  }

  const total = multiply(perUnit, rational(BigInt(line.quantity)))

  /** Plants are counted, not weighed. */
  if (cls === 'immature_plant') {
    const units = Number(toFixed(total, 0))
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      cannabisClass: cls,
      measurementBasis: spec.basis,
      measurementUnit: spec.unit,
      measurementValue: toFixed(total, 4),
      usableEquivalentGrams: ZERO,
      concentrateGrams: ZERO,
      immaturePlantCount: units,
      equivalence: rule.equivalence,
      ruleIdApplied: rule.ruleId ?? null,
    }
  }

  /**
   * A cannabis class whose published conversion is zero would contribute
   * nothing regardless of its weight. Refused here as well as at publication,
   * because a database restored without the publication checks would otherwise
   * sell without a cap and nothing would notice.
   */
  if (isZero(rule.equivalence)) {
    return { kind: 'zero_equivalent_cannabis', variantId: line.variantId, cannabisClass: cls }
  }

  return {
    variantId: line.variantId,
    quantity: line.quantity,
    cannabisClass: cls,
    measurementBasis: spec.basis,
    measurementUnit: spec.unit,
    measurementValue: toFixed(total, 4),
    usableEquivalentGrams: multiply(total, rule.equivalence),
    /** Concentrate counts toward BOTH the usable total and its own ceiling. */
    concentrateGrams: cls === 'concentrate' ? total : ZERO,
    immaturePlantCount: 0,
    equivalence: rule.equivalence,
    ruleIdApplied: rule.ruleId ?? null,
  }
}

const isRejection = (value: LimitLineResult | LimitRejection): value is LimitRejection =>
  'kind' in value

/**
 * Evaluates a whole basket against all three caps.
 *
 * A rejection anywhere refuses the basket outright — the totals are not
 * reported as though the unevaluable line simply were not there, because that
 * is precisely how an unmeasured product ends up sold.
 *
 * Caps come from the rules. Where several classes are present they should
 * agree; the STRICTEST is taken, because a permissive merge of two stated legal
 * limits is not a position anyone could defend.
 */
export function evaluateOrderLimits(
  lines: LimitLineInput[],
  rules: LimitRule[],
): LimitEvaluation {
  const byClass = new Map(rules.map((rule) => [rule.cannabisClass as string, rule]))
  const evaluated = lines.map((line) => evaluateLine(line, byClass))

  const rejections = evaluated.filter(isRejection)
  const ok = evaluated.filter((value): value is LimitLineResult => !isRejection(value))

  const strictest = (
    pick: (rule: LimitRule) => Rational,
    fallback: Rational,
  ): Rational =>
    rules.length === 0
      ? fallback
      : rules.reduce<Rational>(
          (best, rule) => (compare(pick(rule), best) < 0 ? pick(rule) : best),
          pick(rules[0]),
        )

  const caps = {
    usableGrams: strictest((r) => r.usableEquivalentCapGrams, USABLE_CAP_GRAMS),
    concentrateGrams: strictest((r) => r.concentrateCapGrams, CONCENTRATE_CAP_GRAMS),
    immaturePlants:
      rules.length === 0
        ? Number(toFixed(IMMATURE_PLANT_CAP, 0))
        : Math.min(...rules.map((r) => r.immaturePlantCapUnits)),
  }

  const totalUsableEquivalentGrams = ok.reduce<Rational>(
    (sum, line) => add(sum, line.usableEquivalentGrams),
    ZERO,
  )
  const totalConcentrateGrams = ok.reduce<Rational>(
    (sum, line) => add(sum, line.concentrateGrams),
    ZERO,
  )
  const totalImmaturePlants = ok.reduce((sum, line) => sum + line.immaturePlantCount, 0)

  /** Every cap is checked, so the message can name all of them at once. */
  const breaches: CapBreach[] = []
  if (compare(totalUsableEquivalentGrams, caps.usableGrams) > 0) {
    breaches.push({
      cap: 'usable',
      total: formatGrams(totalUsableEquivalentGrams),
      limit: formatGrams(caps.usableGrams),
    })
  }
  if (compare(totalConcentrateGrams, caps.concentrateGrams) > 0) {
    breaches.push({
      cap: 'concentrate',
      total: formatGrams(totalConcentrateGrams),
      limit: formatGrams(caps.concentrateGrams),
    })
  }
  if (totalImmaturePlants > caps.immaturePlants) {
    breaches.push({
      cap: 'immature_plants',
      total: totalImmaturePlants,
      limit: caps.immaturePlants,
    })
  }

  const reason =
    rejections.length > 0
      ? describeRejection(rejections[0])
      : breaches.length > 0
        ? breaches.map(describeBreach).join(' ')
        : null

  return {
    lines: ok,
    totalUsableEquivalentGrams,
    totalConcentrateGrams,
    totalImmaturePlants,
    allowed: rejections.length === 0 && breaches.length === 0,
    reason,
    rejections,
    breaches,
    caps,
    calculationVersion: CALCULATION_VERSION,
  }
}

/**
 * Customer-facing text.
 *
 * A rejection is a problem with our catalog, not with their basket, so it says
 * so plainly rather than implying they did something wrong — and it never
 * quotes an internal class name at someone buying a pre-roll.
 */
export function describeRejection(rejection: LimitRejection): string {
  switch (rejection.kind) {
    case 'unsupported_class':
    case 'missing_measurement':
    case 'basis_mismatch':
    case 'zero_equivalent_cannabis':
    case 'invalid_measurement':
      return 'One of the items in your bag is not available for checkout right now.'
    case 'no_rule':
      return 'Checkout is temporarily unavailable for one of the items in your bag.'
  }
}

export function describeBreach(breach: CapBreach): string {
  switch (breach.cap) {
    case 'usable':
      return `This order is ${breach.total}g of usable-marijuana equivalent, over the ${breach.limit}g legal maximum for one transaction.`
    case 'concentrate':
      return `This order contains ${breach.total}g of concentrate, over the ${breach.limit}g legal maximum for one transaction.`
    case 'immature_plants':
      return `This order contains ${breach.total} immature plants, over the maximum of ${breach.limit} per transaction.`
  }
}

/**
 * The defaults used to SEED the rules table, derived from the CRA guidance.
 *
 * NOT a runtime fallback. The previous version of this constant was used
 * whenever the table was empty, which meant an unconfigured database sold
 * cannabis against compiled-in numbers nobody had approved. Checkout now
 * refuses when a class has no published rule; these exist so the seed script
 * and the tests have one source for the intended values.
 */
export const CRA_DEFAULT_RULES: LimitRule[] = SUPPORTED_CANNABIS_CLASSES.map((cls) => ({
  cannabisClass: cls,
  equivalence: CLASS_EQUIVALENCE[cls],
  expectedBasis: CLASS_MEASUREMENT[cls].basis,
  usableEquivalentCapGrams: USABLE_CAP_GRAMS,
  concentrateCapGrams: CONCENTRATE_CAP_GRAMS,
  immaturePlantCapUnits: 3,
}))

/** For audit summaries and the admin confirmation screen. */
export const describeEquivalence = (rule: LimitRule): string =>
  `${toRatioString(rule.equivalence)} per ${CLASS_MEASUREMENT[rule.cannabisClass as SupportedCannabisClass]?.unit ?? '?'}`
