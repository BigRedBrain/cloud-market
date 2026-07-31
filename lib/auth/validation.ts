import type { Route } from 'next'
import { z } from 'zod'

/**
 * Input schemas for every authentication action.
 *
 * Shared with nothing on the client. Client-side validation is a convenience
 * for the user; these run on the server and are the only ones that count.
 */

/** Michigan adult-use retail. Not negotiable, and not a UI concern. */
export const MINIMUM_AGE_YEARS = 21

/**
 * Length over composition, per current NIST guidance. Forcing a symbol and a
 * digit produces `Password1!` and a sticky note; twelve characters of anything
 * is meaningfully harder to guess and easier to remember. Upper bound exists
 * only to keep scrypt's input bounded.
 */
export const PASSWORD_MIN_LENGTH = 12
const PASSWORD_MAX_LENGTH = 200

/**
 * Normalise BEFORE validating, not after.
 *
 * `z.email()` runs against the raw input, so a trailing space from a paste or a
 * mobile keyboard's autocapitalised first letter would fail validation outright
 * rather than being cleaned up. Trimming and lower-casing first means the value
 * that reaches the unique index and every lookup is already canonical.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(255, 'Email address is too long'))

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, 'Password is too long')

/** Whole years elapsed, calendar-correct — not a division by 365.25. */
export function ageInYears(birthDate: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear()
  const monthDelta = now.getUTCMonth() - birthDate.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1
  }
  return age
}

const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker to enter your date of birth')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: 'That date does not exist',
  })
  .refine((value) => ageInYears(new Date(`${value}T00:00:00Z`)) >= MINIMUM_AGE_YEARS, {
    message: `You must be ${MINIMUM_AGE_YEARS} or older to create an account`,
  })

export const signUpSchema = z.object({
  email,
  password,
  dateOfBirth,
  name: z.string().trim().min(1, 'Enter your name').max(120, 'Name is too long'),
})

/**
 * Sign-in deliberately does NOT reuse the `password` schema. Applying a
 * minimum-length rule to an existing password tells an attacker the policy and,
 * worse, rejects legitimate older passwords with a validation error that reads
 * differently from a wrong-password error.
 */
export const signInSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
  /** Relative path only — see `safeRedirectPath`. */
  next: z.string().optional(),
})

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: password,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'Choose a password you have not used here before',
    path: ['newPassword'],
  })

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120, 'Name is too long'),
  phone: z
    .string()
    .trim()
    .max(32, 'Phone number is too long')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
})

export const revokeSessionSchema = z.object({
  sessionId: z.uuid('Unknown session'),
})

/**
 * Constrains a post-sign-in redirect to a path on this origin.
 *
 * An unchecked `?next=` is an open redirect, which is a phishing primitive:
 * a link to *our* domain that lands on an attacker's login page. Anything with
 * a scheme, a host, or a protocol-relative `//` prefix is discarded.
 */
export function safeRedirectPath(
  candidate: string | undefined,
  fallback: Route = '/account',
): Route {
  /**
   * `typedRoutes` cannot verify a path computed at runtime, so the assertion
   * lives here — the single function that establishes the invariant it asserts.
   * Casting at each call site instead would scatter unchecked assertions
   * through the codebase and lose the connection to this validation.
   */
  if (!candidate) return fallback
  if (!candidate.startsWith('/')) return fallback
  if (candidate.startsWith('//')) return fallback
  if (candidate.includes('\\')) return fallback
  return candidate as Route
}

/**
 * Query flag meaning "the bag changed during sign-in, tell the customer".
 *
 * A flag rather than a payload. The reason a line vanished lives in the merge
 * outcome and the `CART_MERGED` audit row; putting item detail in the URL would
 * make it forwardable, bookmarkable and stale, and none of those are true of a
 * one-time notice.
 */
export const BAG_UPDATED_FLAG = 'bag=updated'

/**
 * Appends a query flag to an already-validated path.
 *
 * Lives beside `safeRedirectPath` so both `Route` assertions sit in the file
 * that establishes the invariant. The input is already same-origin; adding a
 * fixed, literal query string cannot make it otherwise.
 */
export function withQueryFlag(path: Route, flag: string): Route {
  return `${path}${path.includes('?') ? '&' : '?'}${flag}` as Route
}
