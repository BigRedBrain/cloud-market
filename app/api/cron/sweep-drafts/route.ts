import { timingSafeEqual } from 'node:crypto'

import { runDraftSweep } from '@/lib/jobs/sweep'

/**
 * Scheduled sweep endpoint — `GET /api/cron/sweep-drafts`.
 *
 * Invoked by Vercel Cron (see `vercel.json`). Vercel sends
 * `Authorization: Bearer $CRON_SECRET` on every scheduled invocation, and this
 * route refuses anything else.
 *
 * WHY IT IS AUTHENTICATED AT ALL
 *
 * The sweep only releases stock that has genuinely expired, so an attacker
 * calling it repeatedly cannot corrupt anything — every decision is made by
 * Postgres against `now()`. What they CAN do is make it run constantly, which
 * is a database load amplifier reachable by anyone who guesses the path. The
 * secret turns that from free into impossible.
 *
 * FAILS CLOSED WHEN UNCONFIGURED. A missing `CRON_SECRET` returns 503 rather
 * than running unauthenticated. A scheduled job that silently becomes public
 * the moment an environment variable is dropped is exactly the kind of quiet
 * regression nobody notices until it is being abused.
 */
export const dynamic = 'force-dynamic'

/** Constant-time, and length-safe: `timingSafeEqual` throws on a mismatch. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET

  if (!expected) {
    console.error('[cron] CRON_SECRET is not set; refusing to run the sweep')
    return Response.json(
      { ok: false, error: 'scheduler is not configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!token || !secretMatches(token, expected)) {
    return Response.json(
      { ok: false, error: 'unauthorised' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const result = await runDraftSweep()

  /**
   * 200 even when individual drafts failed, because the RUN succeeded and the
   * platform retries on non-2xx. Retrying a batch that already released fifty
   * holds correctly would be pointless work; the drafts that failed are picked
   * up by the next tick regardless, since every step is idempotent.
   *
   * A run that could not execute at all does return 500, because that one is
   * worth retrying immediately.
   */
  const status = result.outcome === 'failed' ? 500 : 200

  return Response.json(
    { ok: result.outcome !== 'failed', ...result },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}
