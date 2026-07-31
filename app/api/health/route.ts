import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'

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
  database: { reachable: boolean; latencyMs: number | null }
  timestamp: string
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

  try {
    await db.execute(sql`select 1`)

    return json(
      {
        status: 'ok',
        database: { reachable: true, latencyMs: Date.now() - startedAt },
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
        database: { reachable: false, latencyMs: null },
        timestamp: new Date().toISOString(),
      },
      503,
    )
  }
}
