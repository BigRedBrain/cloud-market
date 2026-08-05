import { z } from 'zod'

/**
 * Environment validation.
 *
 * This module is imported by both the Next.js server runtime and by Node-only
 * tooling (drizzle-kit). It therefore must NOT import `server-only`.
 *
 * Client-safe values must be declared in `clientSchema` and read through
 * `clientEnv`. Everything in `serverSchema` is secret and will throw if it is
 * ever reached from a browser bundle.
 */

const nodeEnvSchema = z.enum(['development', 'test', 'production'])

const serverSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),

  /** Neon Postgres pooled connection string. */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),

  /**
   * Direct (non-pooled) connection, used by drizzle-kit for migrations.
   * Falls back to DATABASE_URL when not supplied.
   */
  DATABASE_URL_UNPOOLED: z.string().optional(),

  /** Auth.js secret. Generate with `npx auth secret`. */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),

  /** Vercel Blob read/write token for product imagery. */
  BLOB_READ_WRITE_TOKEN: z.string().optional(),

  /** Server-side Google Maps key (geocoding, distance matrix). */
  GOOGLE_MAPS_SERVER_API_KEY: z.string().optional(),

  /**
   * Transactional email (Phase 3.5).
   *
   * Defaults to `console` so a fresh checkout and CI need no credential — the
   * link is printed to the terminal instead of sent. That default is safe
   * because `lib/email/index.ts` refuses anything but `resend` when NODE_ENV is
   * production, rather than silently falling back.
   *
   * These are validated as optional here, and required *at the point of use*,
   * because a missing email key must not stop the storefront from booting.
   * Browsing, the bag and sign-in do not need email; only recovery does.
   */
  /**
   * Shared secret for scheduled invocations (Phase 4 hardening).
   *
   * Optional here and required at the point of use: a missing value makes
   * `/api/cron/sweep-drafts` return 503 rather than run unauthenticated, which
   * is the correct failure. Validating it as required would instead stop the
   * storefront from booting over a job nothing customer-facing depends on.
   */
  CRON_SECRET: z.string().min(16).optional(),

  EMAIL_PROVIDER: z.enum(['resend', 'console', 'capture']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_REPLY_TO: z.string().optional(),
})

const clientSchema = z.object({
  /** Canonical public origin, e.g. https://cloudmarket.com */
  NEXT_PUBLIC_APP_URL: z.url('NEXT_PUBLIC_APP_URL must be a valid URL'),

  /** Browser-restricted Google Maps key (Places autocomplete, map display). */
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: z.string().optional(),
})

/**
 * `process.env` is not a plain object in Next.js client bundles — keys are
 * statically replaced. Referencing them explicitly keeps that inlining intact.
 */
const clientRuntime = {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
}

function format(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}

function parseClient() {
  const parsed = clientSchema.safeParse(clientRuntime)
  if (!parsed.success) {
    throw new Error(`Invalid public environment variables:\n${format(parsed.error)}`)
  }
  return parsed.data
}

function parseServer() {
  if (typeof window !== 'undefined') {
    throw new Error('Server environment variables cannot be read from the browser.')
  }
  const parsed = serverSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(`Invalid server environment variables:\n${format(parsed.error)}`)
  }
  return parsed.data
}

export const clientEnv = parseClient()

/**
 * Lazily validated so that importing this module in a client component does not
 * eagerly throw. Access is still guarded by the `typeof window` check above.
 */
let cachedServerEnv: z.infer<typeof serverSchema> | undefined

export function serverEnv(): z.infer<typeof serverSchema> {
  cachedServerEnv ??= parseServer()
  return cachedServerEnv
}

export type ServerEnv = z.infer<typeof serverSchema>
export type ClientEnv = z.infer<typeof clientSchema>
