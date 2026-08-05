import 'server-only'

import { and, desc, eq, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import { SWEEP_BATCH_SIZE, sweepExpiredDrafts } from '@/lib/orders/core'

/**
 * The expired-draft sweeper, as a scheduled job.
 *
 * WHY THIS EXISTS AT ALL
 *
 * A draft holds stock for fifteen minutes. Until now nothing released it except
 * the customer coming back, and that is the wrong party to depend on: the
 * customer who abandoned checkout is by definition the one who is not coming
 * back. Stock stayed held until someone happened to run the sweep by hand,
 * which on a quiet evening could be never — and "we could not sell it because
 * somebody almost bought it" is an outage with a friendly name.
 *
 * THE MUTUAL EXCLUSION IS A ROW, NOT AN ADVISORY LOCK
 *
 * The obvious implementation is `pg_try_advisory_lock`, and it was the first
 * one here. It is wrong over a connection pool, and the sweeper suite caught
 * it: advisory locks are SESSION-scoped, the pool hands each statement whatever
 * connection is free, so the `pg_advisory_unlock` at the end frequently runs on
 * a different session than the one holding the lock. The unlock silently does
 * nothing, the lock outlives the request, and every subsequent invocation
 * skips — a sweeper that has quietly stopped sweeping while reporting success.
 *
 * Instead the guard is a partial unique index: at most one `scheduler_runs` row
 * per job may have `outcome = 'running'`. A second invocation's INSERT
 * conflicts and it stands down. That works regardless of which connection any
 * statement lands on, because the state lives in a table rather than in a
 * session.
 *
 * A run that dies without finishing would leave `running` forever, so stale
 * rows are marked `abandoned` after `STALE_RUN_MINUTES` before the insert is
 * attempted. That is the self-healing path, and it is deliberately much longer
 * than a sweep should ever take.
 *
 * NONE OF THIS IS THE CORRECTNESS ARGUMENT. Every step in `sweepExpiredDrafts`
 * is a conditional UPDATE that exactly one caller can win, so two sweepers
 * running simultaneously are already safe; they would just duplicate work.
 * `verify-sweeper.ts` proves that by racing them with the guard bypassed.
 */

export const SWEEP_JOB = 'sweep-expired-drafts'

/**
 * How long a `running` row may persist before it is assumed dead.
 *
 * Generously longer than any real sweep: a bounded batch takes seconds, and
 * reclaiming a run that is merely slow would put two sweepers on the same
 * batch. They would still be correct — just wasteful — but the point of the
 * guard is to avoid exactly that.
 */
const STALE_RUN_MINUTES = 10

export type SweepRunResult = {
  outcome: 'completed' | 'skipped' | 'failed'
  scanned: number
  expired: number
  unitsReleased: number
  failed: number
  more: boolean
  durationMs: number
  error: string | null
  runId: string | null
}

/**
 * Runs one sweep and records it.
 *
 * The run row is written even when the sweep is skipped or fails, because the
 * health signal is "when did this last SUCCEED" and that question needs the
 * failures visible beside it to be worth asking.
 */
export async function runDraftSweep(
  batchSize: number = SWEEP_BATCH_SIZE,
): Promise<SweepRunResult> {
  const startedAt = Date.now()

  /** Reclaim anything a dead invocation left marked `running`. */
  await db
    .update(schema.schedulerRuns)
    .set({ outcome: 'abandoned', finishedAt: new Date() })
    .where(
      and(
        eq(schema.schedulerRuns.job, SWEEP_JOB),
        eq(schema.schedulerRuns.outcome, 'running'),
        sql`${schema.schedulerRuns.startedAt} < now() - interval '${sql.raw(String(STALE_RUN_MINUTES))} minutes'`,
      ),
    )

  /**
   * The claim. `onConflictDoNothing` against the partial unique index means the
   * loser of a race gets no row back and stands down.
   */
  const claimed = await db
    .insert(schema.schedulerRuns)
    .values({ job: SWEEP_JOB, outcome: 'running' })
    .onConflictDoNothing()
    .returning({ id: schema.schedulerRuns.id })

  if (!claimed[0]) {
    /**
     * Recorded as its own row rather than silently returning. A schedule that
     * skips every tick because a run is wedged is worth being able to see, and
     * it is invisible if skipping writes nothing.
     */
    const [skipped] = await db
      .insert(schema.schedulerRuns)
      .values({
        job: SWEEP_JOB,
        outcome: 'skipped',
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
      })
      .returning({ id: schema.schedulerRuns.id })

    const result: SweepRunResult = {
      outcome: 'skipped',
      scanned: 0,
      expired: 0,
      unitsReleased: 0,
      failed: 0,
      more: false,
      durationMs: Date.now() - startedAt,
      error: null,
      runId: skipped?.id ?? null,
    }
    console.log(JSON.stringify({ event: 'scheduler.run', job: SWEEP_JOB, ...result }))
    return result
  }

  const run = claimed[0]

  const finish = async (result: Omit<SweepRunResult, 'runId'>) => {
    await db
      .update(schema.schedulerRuns)
      .set({
        finishedAt: new Date(),
        outcome: result.outcome,
        scanned: result.scanned,
        expired: result.expired,
        unitsReleased: result.unitsReleased,
        failed: result.failed,
        durationMs: result.durationMs,
        error: result.error,
      })
      .where(eq(schema.schedulerRuns.id, run.id))

    /**
     * One structured line per run. JSON so a log drain can index it, and flat
     * so it survives whatever mangling the platform applies to multi-line
     * output.
     */
    console.log(
      JSON.stringify({
        event: 'scheduler.run',
        job: SWEEP_JOB,
        runId: run.id,
        ...result,
      }),
    )

    return { ...result, runId: run.id }
  }

  try {
    const swept = await sweepExpiredDrafts(batchSize)

    return await finish({
      /**
       * Individual draft failures do not make the RUN a failure. The batch did
       * its job: it released what it could and left the rest, idempotently, for
       * the next tick. `failed` carries the count so a monitor can alert on a
       * draft that keeps failing without treating every blip as an outage.
       */
      outcome: 'completed',
      scanned: swept.scanned,
      expired: swept.expired,
      unitsReleased: swept.unitsReleased,
      failed: swept.failed,
      more: swept.more,
      durationMs: Date.now() - startedAt,
      error: swept.firstError,
    })
  } catch (error) {
    return await finish({
      outcome: 'failed',
      scanned: 0,
      expired: 0,
      unitsReleased: 0,
      failed: 0,
      more: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    })
  }
  /**
   * No `finally` releasing anything. The claim is the run row, and both exit
   * paths above go through `finish`, which moves it out of `running`. If the
   * process dies between the two, `STALE_RUN_MINUTES` reclaims it — which is
   * the case an advisory lock handled implicitly and a row has to handle on
   * purpose.
   */
}

/**
 * The health signal: the newest run that actually completed.
 *
 * Deliberately not "the newest run". A sweeper that is being invoked and
 * failing every time would show a fresh timestamp and look healthy, which is
 * the failure mode this is meant to catch.
 */
export async function lastSuccessfulSweep(): Promise<{
  at: Date
  expired: number
  durationMs: number | null
} | null> {
  const [row] = await db
    .select({
      at: schema.schedulerRuns.startedAt,
      expired: schema.schedulerRuns.expired,
      durationMs: schema.schedulerRuns.durationMs,
    })
    .from(schema.schedulerRuns)
    .where(
      and(
        eq(schema.schedulerRuns.job, SWEEP_JOB),
        eq(schema.schedulerRuns.outcome, 'completed'),
      ),
    )
    .orderBy(desc(schema.schedulerRuns.startedAt))
    .limit(1)

  return row ?? null
}
