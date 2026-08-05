import { createHash } from 'node:crypto'

/**
 * Liveness/readiness probe — `GET /api/health`.
 *
 * Exists so that deployment health can be verified from outside the process:
 * a build succeeding proves the bundle compiles, not that the running instance
 * can reach Postgres. Those fail independently — a wrong `DATABASE_URL` in the
 * Vercel project builds perfectly and is broken at runtime.
 *
 * Reports on the pooled endpoint (`DATABASE_URL`) specifically, because that is
 * the path application traffic actually takes. The direct endpoint is only used
 * by drizzle-kit at migration time and is deliberately not probed here.
 *
 * Also reports which database it reached, which is how preview-branch isolation
 * is verified — see DATABASE.md.
 */

/**
 * Route Handlers are already uncached by default in Next 16, but a health check
 * that is ever served from cache is worse than no health check at all — it
 * reports the database as reachable long after it stopped being so. Stated
 * explicitly so the guarantee survives a future `cacheComponents: true`.
 */
export const dynamic = 'force-dynamic'

type HealthBody = {
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
  timestamp: string
}

/**
 * A stable, non-reversible identifier for the database this instance is talking
 * to, derived from the connection host.
 *
 * The raw Neon hostname is deliberately NOT returned: this endpoint is
 * unauthenticated, and publishing the exact endpoint hostname hands an attacker
 * a target for free. A truncated digest is enough for the only question being
 * asked — "is preview pointed somewhere different from production?" — which is
 * answered by comparing two fingerprints, never by reading either one.
 */
function fingerprint(connectionString: string): string | null {
  try {
    const { hostname } = new URL(connectionString)
    return createHash('sha256').update(hostname).digest('hex').slice(0, 12)
  } catch {
    return null
  }
}

function json(body: HealthBody, status: number): Response {
  return Response.json(body, {
    status,
    // Defence in depth against any CDN or proxy deciding to cache a 200.
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}

export async function GET(): Promise<Response> {
  const startedAt = Date.now()
  const environment = process.env.VERCEL_ENV ?? 'local'

  /**
   * Read `process.env` directly rather than through `serverEnv()`. A preview
   * deployment with no Neon branch attached has no `DATABASE_URL` at all, and
   * the goal is to report that as structured JSON rather than let validation
   * throw and surface a generic 500.
   */
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    return json(
      {
        status: 'degraded',
        environment,
        database: {
          configured: false,
          reachable: false,
          fingerprint: null,
          latencyMs: null,
        },
        timestamp: new Date().toISOString(),
      },
      503,
    )
  }

  const fp = fingerprint(connectionString)

  try {
    /**
     * Imported lazily: `lib/db` builds its connection pool at module scope, so
     * a static import would throw during module evaluation on a misconfigured
     * deployment — before this handler could turn it into a 503.
     */
    const { sql } = await import('drizzle-orm')
    const { db } = await import('@/lib/db')

    await db.execute(sql`select 1`)

    /**
     * Best-effort, and deliberately after the liveness probe.
     *
     * If the scheduler table cannot be read the process is still alive and the
     * database is still reachable, which is what this endpoint primarily
     * answers. Letting a missing `scheduler_runs` table — a deployment ahead of
     * its migration — turn a healthy instance into a 503 would take the site
     * down over a reporting field.
     */
    let scheduler: HealthBody['scheduler']
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
      console.error('[health] scheduler probe failed:', error)
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
        timestamp: new Date().toISOString(),
      },
      200,
    )
  } catch (error) {
    /**
     * Logged server-side but never returned to the caller: driver errors embed
     * the connection string, which would publish the database password to an
     * unauthenticated endpoint.
     */
    console.error('[health] database probe failed:', error)

    return json(
      {
        status: 'degraded',
        environment,
        database: {
          configured: true,
          reachable: false,
          fingerprint: fp,
          latencyMs: null,
        },
        timestamp: new Date().toISOString(),
      },
      503,
    )
  }
}
