/**
 * Money and tax. Pure functions, integer cents, no I/O.
 *
 * NOT `server-only`, deliberately: this is the one module in the ordering path
 * with no database and no session, which is what lets a property-based test run
 * ten thousand cases against it in a second. Everything that touches a total
 * routes through here.
 *
 * THREE RULES.
 *
 * 1. **Integer cents throughout.** No float ever holds money. `0.1 + 0.2` is
 *    famously not `0.3`, and a cent lost per line becomes a reconciliation
 *    problem nobody can reproduce.
 *
 * 2. **Tax is computed per line, then summed.** Not computed on the order total
 *    and divided back. Allocating a single rounded figure across lines is where
 *    the sum stops matching the parts, and a receipt whose lines do not add up
 *    to its total is one a customer will notice.
 *
 * 3. **Rates are basis points.** 10% is 1000 bps. A percentage as a float
 *    reintroduces exactly the problem rule 1 avoids.
 */

/** Michigan adult-use, as of writing. Stored per order so history reproduces. */
export const DEFAULT_EXCISE_TAX_BPS = 1000 // 10%
export const DEFAULT_SALES_TAX_BPS = 600 // 6%

const BPS_DIVISOR = 10_000

export type TaxRates = {
  exciseBps: number
  salesBps: number
}

export type PricedLineInput = {
  variantId: string
  quantity: number
  unitPriceCents: number
}

export type PricedLine = PricedLineInput & {
  lineSubtotalCents: number
  lineExciseTaxCents: number
  lineSalesTaxCents: number
  lineTotalCents: number
}

export type PricedOrder = {
  lines: PricedLine[]
  subtotalCents: number
  exciseTaxCents: number
  salesTaxCents: number
  totalCents: number
  rates: TaxRates
}

/**
 * Rounds half away from zero, which is what a receipt is expected to do.
 *
 * `Math.round` rounds half UP, so it treats -0.5 and 0.5 differently — fine
 * while everything is positive, wrong the moment a refund or credit appears.
 * Choosing the behaviour now costs nothing; discovering it later costs a
 * reconciliation.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * Tax on a single amount, at a basis-point rate.
 *
 * Deliberately not exported as "the" tax function — callers should price lines,
 * not amounts, so that rule 2 holds. It is exported for the property tests,
 * which need to check the primitive directly.
 */
export function taxOnCents(amountCents: number, rateBps: number): number {
  if (!Number.isInteger(amountCents)) {
    throw new TypeError(`amountCents must be an integer, received ${amountCents}`)
  }
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new TypeError(`rateBps must be a non-negative integer, received ${rateBps}`)
  }
  return roundHalfAwayFromZero((amountCents * rateBps) / BPS_DIVISOR)
}

/**
 * The one place a line's money is calculated.
 *
 * Excise applies to the pre-tax amount; sales tax in Michigan applies to the
 * amount INCLUDING excise, which is why the second call takes `subtotal +
 * excise` rather than `subtotal`. Getting that order wrong understates the bill
 * by 0.6% — small enough to pass a glance, large enough to matter across a
 * year.
 */
export function priceLine(line: PricedLineInput, rates: TaxRates): PricedLine {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new TypeError(`quantity must be a positive integer, received ${line.quantity}`)
  }
  if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
    throw new TypeError(
      `unitPriceCents must be a non-negative integer, received ${line.unitPriceCents}`,
    )
  }

  const lineSubtotalCents = line.unitPriceCents * line.quantity
  const lineExciseTaxCents = taxOnCents(lineSubtotalCents, rates.exciseBps)
  const lineSalesTaxCents = taxOnCents(
    lineSubtotalCents + lineExciseTaxCents,
    rates.salesBps,
  )

  return {
    ...line,
    lineSubtotalCents,
    lineExciseTaxCents,
    lineSalesTaxCents,
    lineTotalCents: lineSubtotalCents + lineExciseTaxCents + lineSalesTaxCents,
  }
}

/**
 * Prices a whole order.
 *
 * The order's tax is the SUM OF THE LINES' tax, never a fresh calculation on the
 * order subtotal. Those two disagree whenever rounding lands differently, and
 * when they disagree it is the receipt that is wrong.
 */
export function priceOrder(
  lines: PricedLineInput[],
  rates: TaxRates = {
    exciseBps: DEFAULT_EXCISE_TAX_BPS,
    salesBps: DEFAULT_SALES_TAX_BPS,
  },
): PricedOrder {
  const priced = lines.map((line) => priceLine(line, rates))

  const subtotalCents = priced.reduce((sum, l) => sum + l.lineSubtotalCents, 0)
  const exciseTaxCents = priced.reduce((sum, l) => sum + l.lineExciseTaxCents, 0)
  const salesTaxCents = priced.reduce((sum, l) => sum + l.lineSalesTaxCents, 0)

  return {
    lines: priced,
    subtotalCents,
    exciseTaxCents,
    salesTaxCents,
    totalCents: subtotalCents + exciseTaxCents + salesTaxCents,
    rates,
  }
}

/** Formats integer cents for display. Never used in a calculation. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
