/**
 * Daily purchase limits. Pure calculation; the rules arrive as data.
 *
 * Phase 3 refused to invent a per-line quantity cap, on the grounds that a
 * limit is a legal rule with licensing weight rather than a validation
 * constant. This is the other half of that decision: the arithmetic lives here,
 * the NUMBERS live in `purchase_limit_rules`, and checkout code never contains
 * a gram figure.
 *
 * That separation is what lets a rule change be a row update rather than a
 * deploy — and, more importantly, lets a historical order be re-checked against
 * the rule that applied when it was placed.
 *
 * NO I/O, so the property tests can hammer it.
 */

import type { CannabisClass } from '@/lib/db/schema'

export type LimitRule = {
  /**
   * The `purchase_limit_rules` row this came from, when it came from one.
   *
   * Optional because `FALLBACK_LIMIT_RULES` has no row behind it, and because
   * the property tests construct rules directly. Where it is present it is
   * copied onto the order line, so an order records not just the arithmetic but
   * the published rule that authorised it.
   */
  ruleId?: string | null
  cannabisClass: CannabisClass
  /** Cannabis-equivalent grams per gram of this class. Flower is 1. */
  equivalentGramsPerGram: number
  dailyEquivalentGramsCap: number
  /** Applies to concentrate mass only. Null means no separate cap. */
  dailyConcentrateGramsCap: number | null
}

export type LimitLineInput = {
  variantId: string
  quantity: number
  cannabisClass: CannabisClass
  /** Per unit, not per line. Null for items with no cannabis weight. */
  unitWeightGrams: number | null
}

export type LimitLineResult = LimitLineInput & {
  equivalentGrams: number
  concentrateGrams: number
  equivalentFactorApplied: number
  /** The rule row that supplied the factor. Null when none applied. */
  ruleIdApplied: string | null
}

export type LimitEvaluation = {
  lines: LimitLineResult[]
  totalEquivalentGrams: number
  totalConcentrateGrams: number
  /** What the customer has already taken today, passed in by the caller. */
  priorEquivalentGrams: number
  priorConcentrateGrams: number
  allowed: boolean
  /** Populated only when `allowed` is false. Safe to show a customer. */
  reason: string | null
  caps: { equivalent: number; concentrate: number | null }
}

/**
 * Grams carry three decimals in the schema, so the arithmetic rounds there too.
 *
 * Floating point on weights has the same hazard as on money, but the tolerance
 * is different: nobody disputes a milligram, whereas a limit check that drifts
 * upward could authorise a sale the state does not permit. Rounding at three
 * places keeps the calculation identical to what gets stored, so a re-check
 * reproduces exactly.
 */
export function roundGrams(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * A line's contribution to the daily limits.
 *
 * An item with no weight — a lighter, a t-shirt — contributes nothing. It is
 * not an error, and it must not silently count as zero-weight cannabis.
 */
export function evaluateLine(
  line: LimitLineInput,
  rules: Map<CannabisClass, LimitRule>,
): LimitLineResult {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new TypeError(`quantity must be a positive integer, received ${line.quantity}`)
  }

  const rule = rules.get(line.cannabisClass)
  const factor = rule?.equivalentGramsPerGram ?? 0
  const grams = line.unitWeightGrams ?? 0
  const totalGrams = roundGrams(grams * line.quantity)

  return {
    ...line,
    equivalentGrams: roundGrams(totalGrams * factor),
    concentrateGrams: line.cannabisClass === 'concentrate' ? totalGrams : 0,
    equivalentFactorApplied: factor,
    ruleIdApplied: rule?.ruleId ?? null,
  }
}

/**
 * Evaluates a whole basket against the caps.
 *
 * `prior*` is what the customer has already bought today. It is a parameter
 * rather than something this module fetches, so the calculation stays pure and
 * the caller decides what "today" means — which is a store-timezone question,
 * not an arithmetic one.
 *
 * The caps come from the rules themselves. Where several classes are present
 * they should agree; the strictest is taken, because a permissive merge of two
 * legal limits is not a defensible position.
 */
export function evaluateOrderLimits(
  lines: LimitLineInput[],
  rules: LimitRule[],
  prior: { equivalentGrams: number; concentrateGrams: number } = {
    equivalentGrams: 0,
    concentrateGrams: 0,
  },
): LimitEvaluation {
  const byClass = new Map(rules.map((rule) => [rule.cannabisClass, rule]))
  const evaluated = lines.map((line) => evaluateLine(line, byClass))

  const totalEquivalentGrams = roundGrams(
    evaluated.reduce((sum, l) => sum + l.equivalentGrams, 0),
  )
  const totalConcentrateGrams = roundGrams(
    evaluated.reduce((sum, l) => sum + l.concentrateGrams, 0),
  )

  const equivalentCap = rules.length
    ? Math.min(...rules.map((r) => r.dailyEquivalentGramsCap))
    : Infinity
  const concentrateCaps = rules
    .map((r) => r.dailyConcentrateGramsCap)
    .filter((c): c is number => c !== null)
  const concentrateCap = concentrateCaps.length ? Math.min(...concentrateCaps) : null

  const projectedEquivalent = roundGrams(prior.equivalentGrams + totalEquivalentGrams)
  const projectedConcentrate = roundGrams(prior.concentrateGrams + totalConcentrateGrams)

  let reason: string | null = null
  if (projectedEquivalent > equivalentCap) {
    reason =
      `This order would put you over the daily limit of ${equivalentCap}g ` +
      `cannabis-equivalent. You've purchased ${prior.equivalentGrams}g today and ` +
      `this order is ${totalEquivalentGrams}g.`
  } else if (concentrateCap !== null && projectedConcentrate > concentrateCap) {
    reason =
      `This order would put you over the daily concentrate limit of ` +
      `${concentrateCap}g. You've purchased ${prior.concentrateGrams}g today and ` +
      `this order is ${totalConcentrateGrams}g.`
  }

  return {
    lines: evaluated,
    totalEquivalentGrams,
    totalConcentrateGrams,
    priorEquivalentGrams: prior.equivalentGrams,
    priorConcentrateGrams: prior.concentrateGrams,
    allowed: reason === null,
    reason,
    caps: { equivalent: equivalentCap, concentrate: concentrateCap },
  }
}

/**
 * Fallback rules, used only when the table is empty.
 *
 * THESE NUMBERS NEED LEGAL CONFIRMATION and exist so a fresh database is not
 * silently unlimited. Michigan adult-use is commonly stated as 2.5 oz
 * (70.87 g) of usable marijuana per day, of which no more than 15 g may be
 * concentrate. Edible equivalence varies by interpretation — which is precisely
 * why the real values belong in a table an operator can correct.
 */
export const FALLBACK_LIMIT_RULES: LimitRule[] = [
  {
    cannabisClass: 'flower',
    equivalentGramsPerGram: 1,
    dailyEquivalentGramsCap: 70.87,
    dailyConcentrateGramsCap: 15,
  },
  {
    cannabisClass: 'concentrate',
    equivalentGramsPerGram: 5,
    dailyEquivalentGramsCap: 70.87,
    dailyConcentrateGramsCap: 15,
  },
  {
    cannabisClass: 'edible',
    equivalentGramsPerGram: 1,
    dailyEquivalentGramsCap: 70.87,
    dailyConcentrateGramsCap: 15,
  },
  {
    cannabisClass: 'other',
    equivalentGramsPerGram: 0,
    dailyEquivalentGramsCap: 70.87,
    dailyConcentrateGramsCap: 15,
  },
]
