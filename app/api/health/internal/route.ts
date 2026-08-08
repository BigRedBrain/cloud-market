import { createHash, timingSafeEqual } from 'node:crypto'

import { serverEnv } from '@/lib/env'
import { resolveAdminIdentity } from '@/lib/auth/admin-identity'

/**
 * AUTHENTICATED diagnostic health — `GET /api/health/internal`.
 *
 * Everything the public probe used to publish, now behind a credential. See the
 * header of `../route.ts` for why the split happened.
 *
 * TWO WAYS IN, because there are two legitimate callers with different shapes:
 *
 *  1. AN ADMINISTRATOR, holding a session. This is the operator opening it in a
 *     browser to see why something looks wrong. Gated on the full admin
 *     identity model — owner or backup, nothing else.
 *
 *  2. A MONITOR, presenting `Authorization: Bearer <CRON_SECRET>`. Uptime checks
 *     and alerting have no cookie and never will. Reuses the secret the
 *     scheduler already authenticates with rather than introducing a second one
 *     — a third credential to rotate is a third credential to forget.
 *
 * Anything else gets a bare 401 with no body. An unauthenticated caller learns
 * that the route exists and nothing more; in particular the response is
 * identical whether or not the deployment is healthy, so this cannot be used as
 * the oracle the public endpoint was.
 */

export const dynamic = 'force-dynamic'

type InternalHealthBody = {
  status: 'ok' | 'degraded'
  environment: string
  database: {
    configured: boolean
    reachable: boolean
    /** See `fingerprint()` — identifies the branch without naming it. */
    fingerprint: string | null
    latencyMs: number | null
  }
  /**
   * Liveness of the expired-draft sweeper.
   *
   * Reports the last run that COMPLETED, not the last that started: a job being
   * invoked and failing every minute would otherwise show a fresh timestamp and
   * read as healthy, which is the exact failure this is here to catch.
   *
   * `ageSeconds` is what a monitor should alert on. Absent entirely means the
   * schedule has never run — a fresh deployment, or a cron that was never
   * installed. Both need looking at, and neither is an outage on its own, so
   * this does not degrade the overall status.
   */
  scheduler?: {
    job: string
    lastSuccessAt: string | null
    ageSeconds: number | null
    lastExpired: number | null
    lastDurationMs: number | null
  }
  /**
   * Whether the security-critical environment is configured. BOOLEANS ONLY —
   * never the owner's id, never the pepper, never any part of either. "Is the
   * owner id set and well-formed" is the question an operator actually has
   * after a deploy, and it can be answered yes or no.
   */
  configuration: {
    ownerIdentityConfigured: boolean
    inviteCodesConfigured: boolean
    /**
     * Whether product media can be served at all.
     *
     * Media is private in storage and streamed through `/api/media/<id>` using
     * the store credential, so a deployment without this token shows a catalog
     * of broken images — a failure that looks like a CSS bug and is actually a
     * missing variable. Boolean only, like everything else here.
     */
    mediaStorageConfigured: boolean
    checkoutEnabled: boolean
    cryptoPaymentsEnabled: boolean
  }
  timestamp: string
}

/**
 * A stable, non-reversible identifier for the database this instance is talking
 * to, derived from the connection host.
 *
 * The raw Neon hostname is deliberately NOT returned even here. The only
 * question being asked is "is preview pointed somewhere different from
 * production?", which is answered by comparing two fingerprints and never by
 * reading either one — so there is no reason for the endpoint to hold the
 * hostname even for an authenticated caller.
 */
function fingerprint(connectionString: string): string | null {
  try {
    const { hostname } = new URL(connectionString)
    return createHash('sha256').update(hostname).digest('hex').slice(0, 12)
  } catch {
    return null
  }
}

/**
 * Constant-time bearer comparison.
 *
 * `===` on a secret leaks its prefix through response timing, one byte at a
 * time. Both sides are digested first so the comparison is over fixed-length
 * buffers — `timingSafeEqual` throws on a length mismatch, which would itself
 * be a signal about the secret's length.
 */
function bearerMatches(presented: string | null, expected: string | undefined): boolean {
  if (!presented || !expected) return false

  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

async function isAuthorised(request: Request): Promise<boolean> {
  const header = request.headers.get('authorization')
  const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : null

  if (bearerMatches(presented, serverEnv().CRON_SECRET)) return true

  /**
   * Session path. `resolveAdminIdentity` is the non-throwing probe — a route
   * handler must return a 401, not raise Next's `forbidden()` navigation
   * interrupt, which has no meaning outside a rendered page.
   */
  return (await resolveAdminIdentity()).ok
}

function json(body: InternalHealthBody, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

export async function GET(request: Request): Promise<Response> {
  if (!(await isAuthorised(request))) {
    return new Response(null, {
      status: 401,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
  }

  const startedAt = Date.now()
  const environment = process.env.VERCEL_ENV ?? 'local'
  const connectionString = process.env.DATABASE_URL

  /**
   * Read through `process.env` rather than `serverEnv()` for the same reason
   * the public probe does: a deployment missing a variable must be REPORTED,
   * not turned into a validation throw that this handler never gets to answer.
   */
  const configuration: InternalHealthBody['configuration'] = {
    /** Presence AND shape — a malformed UUID fails admin access closed. */
    ownerIdentityConfigured: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      process.env.CLOUDMARKET_OWNER_USER_ID?.trim() ?? '',
    ),
    inviteCodesConfigured: Boolean(process.env.INVITE_CODE_PEPPER),
    mediaStorageConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    checkoutEnabled: process.env.CHECKOUT_ENABLED === 'true',
    cryptoPaymentsEnabled: process.env.CRYPTO_PAYMENTS_ENABLED === 'true',
  }

  if (!connectionString) {
    return json(
      {
        status: 'degraded',
        environment,
        database: { configured: false, reachable: false, fingerprint: null, latencyMs: null },
        configuration,
        timestamp: new Date().toISOString(),
      },
      503,
    )
  }

  const fp = fingerprint(connectionString)

  try {
    const { sql } = await import('drizzle-orm')
    const { db } = await import('@/lib/db')

    await db.execute(sql`select 1`)

    /**
     * Best-effort, and deliberately after the liveness probe. Letting a missing
     * `scheduler_runs` table — a deployment ahead of its migration — turn a
     * healthy instance into a 503 would take the site down over a reporting
     * field.
     */
    let scheduler: InternalHealthBody['scheduler']
    try {
      const { SWEEP_JOB, lastSuccessfulSweep } = await import('@/lib/jobs/sweep')
      const last = await lastSuccessfulSweep()
      scheduler = {
        job: SWEEP_JOB,
        lastSuccessAt: last?.at.toISOString() ?? null,
        ageSeconds: last ? Math.round((Date.now() - last.at.getTime()) / 1000) : null,
        lastExpired: last?.expired ?? null,
        lastDurationMs: last?.durationMs ?? null,
      }
    } catch (error) {
      console.error('[health/internal] scheduler probe failed:', error)
    }

    return json(
      {
        status: 'ok',
        environment,
        database: {
          configured: true,
          reachable: true,
          fingerprint: fp,
          latencyMs: Date.now() - startedAt,
        },
        ...(scheduler ? { scheduler } : {}),
        configuration,
        timestamp: new Date().toISOString(),
      },
      200,
    )
  } catch (error) {
    /** Never returned: driver errors embed the connection string. */
    console.error('[health/internal] database probe failed:', error)

    return json(
      {
        status: 'degraded',
        environment,
        database: { configured: true, reachable: false, fingerprint: fp, latencyMs: null },
        configuration,
        timestamp: new Date().toISOString(),
      },
      503,
    )
  }
}
