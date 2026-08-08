/**
 * PUBLIC liveness probe — `GET /api/health`.
 *
 * WHAT THIS USED TO RETURN, AND WHY IT NO LONGER DOES.
 *
 * Until Phase 5 this endpoint answered, to anyone on the internet, with: which
 * environment it was (`production` / `preview`), a stable fingerprint of the
 * database host, the observed database latency, and the name, schedule age, run
 * duration and row counts of the background sweeper.
 *
 * Every one of those is useful to an operator and useful to an attacker. The
 * fingerprint distinguishes production from preview for anyone probing both.
 * The latency is a timing side channel into database health and load. The
 * scheduler block names an internal job and publishes how far behind it is —
 * which is precisely when to attack something that depends on it. And on a
 * storefront that is now PRIVATE, an unauthenticated endpoint confirming a
 * production deployment exists at all is itself a disclosure.
 *
 * So this endpoint was split, per section AL:
 *
 *  - HERE: the minimum a deployment platform needs to decide whether to route
 *    traffic to this instance. A status, and a timestamp. Nothing else.
 *  - `/api/health/internal`: everything above, behind authentication.
 *
 * THE DATABASE IS STILL PROBED. Returning `ok` without checking would make this
 * a test that the process is running rather than that it works, and the whole
 * reason the endpoint exists is that a build can succeed while `DATABASE_URL`
 * is wrong. What changed is that the RESULT is reduced to one bit: reachable,
 * or not. A 503 still fails the deploy; it just no longer explains why to
 * strangers.
 */

/**
 * Route Handlers are already uncached by default in Next 16, but a health check
 * that is ever served from cache is worse than no health check at all — it
 * reports the database as reachable long after it stopped being so. Stated
 * explicitly so the guarantee survives a future `cacheComponents: true`.
 */
export const dynamic = 'force-dynamic'

type PublicHealthBody = {
  status: 'ok' | 'degraded'
  timestamp: string
}

function json(body: PublicHealthBody, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      // Defence in depth against any CDN or proxy deciding to cache a 200.
      'Cache-Control': 'no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

export async function GET(): Promise<Response> {
  const timestamp = new Date().toISOString()

  /**
   * Read `process.env` directly rather than through `serverEnv()`. A preview
   * deployment with no Neon branch attached has no `DATABASE_URL` at all, and
   * the goal is to report that as a structured 503 rather than let validation
   * throw and surface a generic 500.
   */
  if (!process.env.DATABASE_URL) {
    return json({ status: 'degraded', timestamp }, 503)
  }

  try {
    /**
     * Imported lazily: `lib/db` would otherwise be evaluated at module scope,
     * so a misconfigured deployment would throw before this handler could turn
     * the failure into a 503.
     */
    const { sql } = await import('drizzle-orm')
    const { db } = await import('@/lib/db')

    await db.execute(sql`select 1`)

    return json({ status: 'ok', timestamp }, 200)
  } catch (error) {
    /**
     * Logged server-side and never returned: driver errors embed the connection
     * string, which would publish the database password to an unauthenticated
     * endpoint. This was already true of the previous implementation and is the
     * one part of it that needed no change.
     */
    console.error('[health] database probe failed:', error)

    return json({ status: 'degraded', timestamp }, 503)
  }
}
