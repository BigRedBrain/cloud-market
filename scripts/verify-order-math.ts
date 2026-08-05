/**
 * Property-based tests for order arithmetic.
 *
 *   npx tsx scripts/verify-order-math.ts
 *
 * Example-based tests are weak here for a specific reason: the person writing
 * the test and the person writing the calculation are the same, so both tend to
 * encode the same assumption. `expect(taxOn(1000, 600)).toBe(60)` proves that
 * one case matches what I already believed.
 *
 * These assert PROPERTIES that must hold for every input — the parts sum to the
 * whole, doubling the quantity doubles the subtotal, a tax is never negative,
 * the order total equals the sum of its lines — across thousands of generated
 * cases including the awkward ones. A rounding bug that costs a cent on one line
 * in a thousand is invisible to an example and obvious to an invariant.
 *
 * No database, no network. Pure functions only.
 */
import {
  DEFAULT_EXCISE_TAX_BPS,
  DEFAULT_SALES_TAX_BPS,
  priceLine,
  priceOrder,
  roundHalfAwayFromZero,
  taxOnCents,
  type TaxRates,
} from '../lib/orders/pricing'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Deterministic PRNG, seeded.
 *
 * A failing property must be reproducible. `Math.random()` would give a test
 * that fails once in CI and never again, which is worse than no test.
 */
function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const random = makeRandom(0x5eed)
const randomInt = (min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1))

/** Runs a property over many generated cases, reporting the first counterexample. */
function forAll(
  name: string,
  cases: number,
  generate: () => unknown,
  property: (value: never) => boolean,
) {
  for (let i = 0; i < cases; i += 1) {
    const value = generate()
    let held = false
    try {
      held = property(value as never)
    } catch (error) {
      check(name, false, `threw on ${JSON.stringify(value)}: ${(error as Error).message}`)
      return
    }
    if (!held) {
      check(name, false, `counterexample after ${i + 1} cases: ${JSON.stringify(value)}`)
      return
    }
  }
  check(`${name} (${cases} cases)`, true)
}

const RATES: TaxRates = {
  exciseBps: DEFAULT_EXCISE_TAX_BPS,
  salesBps: DEFAULT_SALES_TAX_BPS,
}

console.log('Order arithmetic — property-based\n')

/* ============================================================ ROUNDING === */
console.log('[1] Rounding')

forAll(
  'rounding always returns an integer',
  2000,
  () => random() * 2000 - 1000,
  (value: number) => Number.isInteger(roundHalfAwayFromZero(value)),
)

forAll(
  'rounding never moves a value by more than half a unit',
  2000,
  () => random() * 2000 - 1000,
  (value: number) => Math.abs(roundHalfAwayFromZero(value) - value) <= 0.5 + 1e-9,
)

forAll(
  'rounding is symmetric about zero',
  2000,
  () => random() * 1000,
  (value: number) => roundHalfAwayFromZero(-value) === -roundHalfAwayFromZero(value),
)

check(
  'a half rounds away from zero in both directions',
  roundHalfAwayFromZero(2.5) === 3 && roundHalfAwayFromZero(-2.5) === -3,
  `${roundHalfAwayFromZero(2.5)} / ${roundHalfAwayFromZero(-2.5)}`,
)

/* ================================================ QUANTITY MULTIPLICATION === */
console.log('\n[2] Quantity multiplication')

forAll(
  'line subtotal is exactly unit price times quantity',
  3000,
  () => ({ unitPriceCents: randomInt(0, 500_000), quantity: randomInt(1, 500) }),
  (v: { unitPriceCents: number; quantity: number }) =>
    priceLine({ variantId: 'v', ...v }, RATES).lineSubtotalCents ===
    v.unitPriceCents * v.quantity,
)

forAll(
  'doubling the quantity doubles the subtotal',
  2000,
  () => ({ unitPriceCents: randomInt(1, 100_000), quantity: randomInt(1, 250) }),
  (v: { unitPriceCents: number; quantity: number }) => {
    const single = priceLine({ variantId: 'v', ...v }, RATES)
    const double = priceLine(
      { variantId: 'v', unitPriceCents: v.unitPriceCents, quantity: v.quantity * 2 },
      RATES,
    )
    return double.lineSubtotalCents === single.lineSubtotalCents * 2
  },
)

forAll(
  'every money field is an integer',
  3000,
  () => ({ unitPriceCents: randomInt(0, 999_999), quantity: randomInt(1, 99) }),
  (v: { unitPriceCents: number; quantity: number }) => {
    const line = priceLine({ variantId: 'v', ...v }, RATES)
    return [
      line.lineSubtotalCents,
      line.lineExciseTaxCents,
      line.lineSalesTaxCents,
      line.lineTotalCents,
    ].every(Number.isInteger)
  },
)

/* ================================================== TAX CALCULATION === */
console.log('\n[3] Tax calculation')

forAll(
  'tax is never negative for a non-negative amount',
  3000,
  () => ({ amount: randomInt(0, 1_000_000), bps: randomInt(0, 3000) }),
  (v: { amount: number; bps: number }) => taxOnCents(v.amount, v.bps) >= 0,
)

forAll(
  'tax never exceeds the amount for rates under 100%',
  3000,
  () => ({ amount: randomInt(0, 1_000_000), bps: randomInt(0, 9999) }),
  (v: { amount: number; bps: number }) => taxOnCents(v.amount, v.bps) <= v.amount,
)

forAll(
  'a zero rate produces zero tax',
  1000,
  () => randomInt(0, 1_000_000),
  (amount: number) => taxOnCents(amount, 0) === 0,
)

forAll(
  'tax is monotonic in the amount',
  2000,
  () => ({ a: randomInt(0, 500_000), b: randomInt(0, 500_000) }),
  (v: { a: number; b: number }) => {
    const [lo, hi] = v.a <= v.b ? [v.a, v.b] : [v.b, v.a]
    return taxOnCents(lo, RATES.salesBps) <= taxOnCents(hi, RATES.salesBps)
  },
)

forAll(
  'sales tax applies on top of excise, not alongside it',
  2000,
  () => ({ unitPriceCents: randomInt(1, 200_000), quantity: randomInt(1, 20) }),
  (v: { unitPriceCents: number; quantity: number }) => {
    const line = priceLine({ variantId: 'v', ...v }, RATES)
    const expected = taxOnCents(
      line.lineSubtotalCents + line.lineExciseTaxCents,
      RATES.salesBps,
    )
    return line.lineSalesTaxCents === expected
  },
)

forAll(
  'line total is exactly subtotal plus both taxes',
  3000,
  () => ({ unitPriceCents: randomInt(0, 300_000), quantity: randomInt(1, 100) }),
  (v: { unitPriceCents: number; quantity: number }) => {
    const line = priceLine({ variantId: 'v', ...v }, RATES)
    return (
      line.lineTotalCents ===
      line.lineSubtotalCents + line.lineExciseTaxCents + line.lineSalesTaxCents
    )
  },
)

check(
  'a non-integer amount is rejected rather than silently rounded',
  (() => {
    try {
      taxOnCents(10.5, 600)
      return false
    } catch {
      return true
    }
  })(),
)

/* ========================================= TAX ALLOCATION ACROSS LINES === */
console.log('\n[4] Tax allocation across lines')

const generateBasket = () =>
  Array.from({ length: randomInt(1, 12) }, (_, i) => ({
    variantId: `v${i}`,
    quantity: randomInt(1, 40),
    unitPriceCents: randomInt(1, 250_000),
  }))

forAll(
  'order excise equals the sum of line excise',
  2000,
  generateBasket,
  (lines: { variantId: string; quantity: number; unitPriceCents: number }[]) => {
    const order = priceOrder(lines, RATES)
    return (
      order.exciseTaxCents === order.lines.reduce((s, l) => s + l.lineExciseTaxCents, 0)
    )
  },
)

forAll(
  'order sales tax equals the sum of line sales tax',
  2000,
  generateBasket,
  (lines: { variantId: string; quantity: number; unitPriceCents: number }[]) => {
    const order = priceOrder(lines, RATES)
    return order.salesTaxCents === order.lines.reduce((s, l) => s + l.lineSalesTaxCents, 0)
  },
)

forAll(
  'order total equals the sum of line totals',
  2000,
  generateBasket,
  (lines: { variantId: string; quantity: number; unitPriceCents: number }[]) => {
    const order = priceOrder(lines, RATES)
    return order.totalCents === order.lines.reduce((s, l) => s + l.lineTotalCents, 0)
  },
)

forAll(
  'order total equals subtotal plus both order taxes',
  2000,
  generateBasket,
  (lines: { variantId: string; quantity: number; unitPriceCents: number }[]) => {
    const order = priceOrder(lines, RATES)
    return (
      order.totalCents ===
      order.subtotalCents + order.exciseTaxCents + order.salesTaxCents
    )
  },
)

/**
 * The property that justifies pricing per line rather than on the total.
 *
 * These two figures are allowed to differ — that is exactly why the receipt is
 * built from lines. What must never happen is the order claiming one and the
 * lines summing to the other, which is the assertion above. This one records
 * how often they diverge, so the choice is visible rather than assumed.
 */
let divergences = 0
for (let i = 0; i < 2000; i += 1) {
  const lines = generateBasket()
  const order = priceOrder(lines, RATES)
  const naive = taxOnCents(order.subtotalCents, RATES.exciseBps)
  if (naive !== order.exciseTaxCents) divergences += 1
}
check(
  `per-line and whole-order tax genuinely differ (${divergences}/2000 baskets)`,
  divergences > 0,
  'if these never diverged, the choice would not matter',
)

/* ================================================= SPLITTING AND ORDER === */
console.log('\n[5] Basket composition')

forAll(
  'line order does not change the totals',
  1500,
  generateBasket,
  (lines: { variantId: string; quantity: number; unitPriceCents: number }[]) => {
    const forward = priceOrder(lines, RATES)
    const backward = priceOrder([...lines].reverse(), RATES)
    return (
      forward.totalCents === backward.totalCents &&
      forward.exciseTaxCents === backward.exciseTaxCents &&
      forward.salesTaxCents === backward.salesTaxCents
    )
  },
)

forAll(
  'an empty basket costs nothing',
  1,
  () => [],
  () => {
    const order = priceOrder([], RATES)
    return order.totalCents === 0 && order.subtotalCents === 0
  },
)

/* ====================================================== PURCHASE LIMITS === */
/**
 * The limit properties MOVED to `scripts/verify-compliance.ts`.
 *
 * They no longer belong here. This suite is about money: rounding, tax
 * allocation, and the arithmetic of a receipt, all of it in integer cents. The
 * limit calculation is now exact rational arithmetic over three independent
 * caps with unit conversions, which is a different subject with different
 * failure modes — and mixing them meant a change to the tax code and a change
 * to a legal cap shared one pass/fail number.
 */

/* ========================================================================= */

console.log('\n==========================================================')
console.log(`RESULT: ${passed} passed, ${failed} failed`)
if (failed) console.log(`Failed: ${failures.join(', ')}`)
console.log('==========================================================')
process.exitCode = failed ? 1 : 0
