/**
 * Money handling.
 *
 * Every monetary value in Cloud Market is an integer count of cents. Floating
 * point is never used for money: `0.1 + 0.2 !== 0.3`, and a cannabis retailer
 * has to reconcile excise and sales tax to the cent for state reporting.
 *
 * The `Cents` brand makes it a type error to pass a raw dollar amount where
 * cents are expected — the most likely and most expensive mistake in this
 * domain (a 100x pricing error).
 */

declare const centsBrand: unique symbol
export type Cents = number & { readonly [centsBrand]: true }

/** Asserts that a number is a valid, whole, non-negative cent amount. */
export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Monetary values must be whole cents, received ${value}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Monetary value ${value} exceeds safe integer range`)
  }
  return value as Cents
}

/** Converts a dollar amount (e.g. from an admin form) into cents. */
export function dollarsToCents(dollars: number): Cents {
  return cents(Math.round(dollars * 100))
}

export function centsToDollars(value: Cents): number {
  return value / 100
}

export function addCents(...values: Cents[]): Cents {
  return cents(values.reduce<number>((total, value) => total + value, 0))
}

export function multiplyCents(value: Cents, quantity: number): Cents {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError(`Quantity must be a non-negative integer, received ${quantity}`)
  }
  return cents(value * quantity)
}

/**
 * Applies a rate (e.g. 0.06 sales tax) to an amount.
 *
 * Rounds half away from zero, matching the rounding convention used for
 * Michigan tax remittance, rather than JavaScript's round-half-up which is
 * asymmetric for negative values.
 */
export function applyRate(value: Cents, rate: number): Cents {
  const raw = value * rate
  return cents(Math.sign(raw) * Math.round(Math.abs(raw)))
}

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

/** Formats cents for display, e.g. `4200` -> `"$42.00"`. */
export function formatCents(value: Cents | number): string {
  return usdFormatter.format(value / 100)
}
