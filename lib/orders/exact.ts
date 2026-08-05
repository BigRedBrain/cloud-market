/**
 * Exact rational arithmetic for legal limit calculations.
 *
 * NO BINARY FLOATING POINT TOUCHES A PURCHASE LIMIT. Not as a stylistic
 * preference — because the numbers involved cannot be represented in binary and
 * the errors land in the wrong direction.
 *
 * An ounce is exactly 28.349523125 grams. `Number` stores that as
 * 28.349523124999999... , and 2.5 ounces as 70.87380781249999. A basket that
 * weighs exactly 2.5 ounces would therefore compare as *under* the cap by a
 * hundred-billionth of a gram — which is harmless — but the liquid conversion
 * (28.349523125 / 36) is a non-terminating fraction, and summing thirty of
 * those accumulates error in whichever direction the rounding happens to fall.
 * Once it falls the other way, the storefront sells over a legal cap and the
 * arithmetic says it did not.
 *
 * A rational built on `bigint` has no rounding at all: every conversion here is
 * a ratio of integers, so the whole calculation stays exact from the catalog
 * value to the final comparison. Rounding happens exactly once, when a figure is
 * written down for a human, and never before a comparison.
 *
 * Deliberately no dependency. This is ~120 lines of arithmetic used in one
 * place; pulling in decimal.js would mean auditing a supply-chain dependency
 * for a compliance path, which is a worse trade than owning the code.
 */

export type Rational = {
  /** Sign lives on the numerator. */
  readonly n: bigint
  /** Always positive, never zero. */
  readonly d: bigint
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

/**
 * Reduced on construction, always.
 *
 * Without this the denominators compound as a basket is summed — thirty lines
 * of 28349523125/36000000000 produce an integer with hundreds of digits, and
 * while bigint would still be correct it would be needlessly slow and the
 * stored values would be unreadable.
 */
export function rational(n: bigint, d: bigint = 1n): Rational {
  if (d === 0n) throw new RangeError('denominator may not be zero')
  const sign = d < 0n ? -1n : 1n
  const nn = n * sign
  const dd = d * sign
  const g = gcd(nn, dd) || 1n
  return { n: nn / g, d: dd / g }
}

export const ZERO: Rational = { n: 0n, d: 1n }
export const ONE: Rational = { n: 1n, d: 1n }

export const add = (a: Rational, b: Rational): Rational =>
  rational(a.n * b.d + b.n * a.d, a.d * b.d)

export const multiply = (a: Rational, b: Rational): Rational =>
  rational(a.n * b.n, a.d * b.d)

/** -1, 0 or 1. Exact — this is what a cap check ultimately calls. */
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.n * b.d
  const right = b.n * a.d
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export const lessThanOrEqual = (a: Rational, b: Rational): boolean => compare(a, b) <= 0
export const isZero = (a: Rational): boolean => a.n === 0n
export const isNegative = (a: Rational): boolean => a.n < 0n

/**
 * Parses a decimal string exactly. `"3.5"` becomes 7/2, not 3.5000000000000004.
 *
 * Rejects anything that is not a plain decimal — no exponents, no whitespace, no
 * `Infinity`, no `NaN`. A malformed measurement must fail loudly at the parse
 * rather than silently become zero, because zero here means "contributes
 * nothing to any cap".
 */
export function fromDecimalString(value: string): Rational {
  const text = value.trim()
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new TypeError(`not an exact decimal: ${JSON.stringify(value)}`)
  }

  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text
  const [whole, fraction = ''] = digits.split('.')

  const scaled = BigInt(whole + fraction)
  const denominator = 10n ** BigInt(fraction.length)

  return rational(negative ? -scaled : scaled, denominator)
}

/** Accepts what a numeric column or a form field hands over. */
export function fromValue(value: string | number | bigint): Rational {
  if (typeof value === 'bigint') return rational(value)
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      /**
       * Refused on purpose. A non-integer `number` has already lost precision
       * before this function is reached — accepting it would launder a float
       * into the exact path and defeat the entire point of this module.
       */
      throw new TypeError(
        `refusing a non-integer number (${value}); pass the exact decimal as a string`,
      )
    }
    return rational(BigInt(value))
  }
  return fromDecimalString(value)
}

/**
 * Renders with a fixed number of decimal places, rounding half away from zero.
 *
 * FOR DISPLAY AND FOR STORAGE ONLY. Never call this before a comparison — the
 * whole design is that comparisons happen on the unrounded value. The snapshot
 * columns store the rounded figure because a receipt needs a number a person
 * can read; the decision that produced it was made on the exact one.
 */
export function toFixed(value: Rational, places: number): string {
  const scale = 10n ** BigInt(places)
  const negative = value.n < 0n
  const n = negative ? -value.n : value.n

  const scaled = (n * scale) / value.d
  const remainder = (n * scale) % value.d
  const rounded = remainder * 2n >= value.d ? scaled + 1n : scaled

  const text = rounded.toString().padStart(places + 1, '0')
  const whole = text.slice(0, text.length - places)
  const fraction = places > 0 ? `.${text.slice(text.length - places)}` : ''

  return `${negative && rounded !== 0n ? '-' : ''}${whole}${fraction}`
}

/** Human-readable ratio, for audit summaries: "1/16", "3". */
export function toRatioString(value: Rational): string {
  return value.d === 1n ? value.n.toString() : `${value.n}/${value.d}`
}

/* -------------------------------------------------------------------------- */
/* Michigan constants — exact                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The international avoirdupois ounce, exactly 28.349523125 g by definition.
 * Written as an explicit ratio so nobody is tempted to "simplify" it to 28.35.
 */
export const GRAMS_PER_OUNCE = rational(28_349_523_125n, 1_000_000_000n)

/** 2.5 oz of usable marijuana = 70.87380781250 g, exactly. */
export const USABLE_CAP_GRAMS = multiply(rational(5n, 2n), GRAMS_PER_OUNCE)

/** The separate concentrate ceiling. */
export const CONCENTRATE_CAP_GRAMS = rational(15n)

/** Immature plants per transaction. */
export const IMMATURE_PLANT_CAP = rational(3n)
