import { z } from 'zod'

/**
 * The single return contract for every Server Action in the application.
 *
 * Server Actions are a public network boundary: anything they return is
 * serialized to the client. Throwing raw errors across that boundary leaks
 * stack traces and database messages in development and yields an opaque
 * digest in production. Returning a typed, discriminated result instead lets
 * forms render precise feedback while keeping internals server-side.
 */

export type ActionErrorCode =
  /** Input failed Zod validation. `fieldErrors` is populated. */
  | 'validation_error'
  /** No authenticated session. */
  | 'unauthenticated'
  /** Authenticated, but not permitted to perform this action. */
  | 'forbidden'
  /** Target record does not exist, or is not visible to this tenant. */
  | 'not_found'
  /** Violates a business rule (e.g. outside delivery radius, age gate). */
  | 'conflict'
  /** Too many attempts. */
  | 'rate_limited'
  /** Unexpected server fault. Details are logged, never returned. */
  | 'internal_error'

export type ActionSuccess<T> = { ok: true; data: T }

export type ActionFailure = {
  ok: false
  code: ActionErrorCode
  /** Safe to render directly to the user. */
  message: string
  /** Per-field messages keyed by form field name, for validation failures. */
  fieldErrors?: Record<string, string[]>
}

export type ActionResult<T = void> = ActionSuccess<T> | ActionFailure

export function ok(): ActionResult<void>
export function ok<T>(data: T): ActionResult<T>
export function ok<T>(data?: T): ActionResult<T | void> {
  return { ok: true, data: data as T }
}

export function fail(
  code: ActionErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ActionFailure {
  return fieldErrors ? { ok: false, code, message, fieldErrors } : { ok: false, code, message }
}

/** Narrowing helpers for call sites that hold an unresolved `ActionResult`. */
export function isOk<T>(result: ActionResult<T>): result is ActionSuccess<T> {
  return result.ok
}

export function isFail<T>(result: ActionResult<T>): result is ActionFailure {
  return !result.ok
}

/**
 * Converts a Zod failure into an `ActionFailure`, preserving per-field messages
 * so a form can highlight the offending inputs.
 */
export function fromZodError(error: z.ZodError): ActionFailure {
  const fieldErrors: Record<string, string[]> = {}
  const formErrors: string[] = []

  for (const issue of error.issues) {
    if (issue.path.length === 0) {
      // Schema-level issue (e.g. a `.refine()` on the object itself).
      formErrors.push(issue.message)
      continue
    }

    // Dotted path keeps nested fields addressable, e.g. `address.postalCode`.
    const key = issue.path.map(String).join('.')
    ;(fieldErrors[key] ??= []).push(issue.message)
  }

  const message =
    formErrors.at(0) ?? 'Please correct the highlighted fields and try again.'

  return Object.keys(fieldErrors).length > 0
    ? fail('validation_error', message, fieldErrors)
    : fail('validation_error', message)
}

/**
 * Validates untrusted input against a schema, returning the standard failure
 * shape instead of throwing.
 *
 * Every Server Action must funnel its arguments through this — client-supplied
 * data is never trusted, including data that a Client Component "already
 * validated".
 */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): ActionResult<z.output<S>> {
  const parsed = schema.safeParse(input)
  return parsed.success ? ok(parsed.data) : fromZodError(parsed.error)
}

/** Converts `FormData` to a plain object before schema parsing. */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const entries: Record<string, unknown> = {}

  for (const [key, value] of formData.entries()) {
    const existing = entries[key]
    if (existing === undefined) {
      entries[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      entries[key] = [existing, value]
    }
  }

  return entries
}
