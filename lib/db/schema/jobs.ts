import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn } from './_shared'

/**
 * Scheduled job runs.
 *
 * WHY A TABLE AND NOT JUST LOGS
 *
 * Structured logs answer "what happened during that run". They do not answer
 * "when did this last succeed", which is the question that matters at 3am when
 * inventory looks wrong. Platform log retention is finite and log search is not
 * a health check — a monitor that has to grep a log stream to decide whether a
 * job is alive will eventually be grepping an empty one.
 *
 * So each run writes a row, and `/api/health` reads the newest successful one.
 * The absence of a recent row IS the alarm: a sweeper that stops being invoked
 * writes nothing at all, and a health check built on logs would see silence and
 * call it calm.
 *
 * Rows are small and bounded by the schedule. At one run a minute this is
 * ~525k rows a year, which is nothing, and pruning is a later decision rather
 * than an operational risk.
 */
export const schedulerRuns = pgTable(
  'scheduler_runs',
  {
    id: primaryKeyColumn(),

    /** Stable identifier for the job, e.g. `sweep-expired-drafts`. */
    job: varchar('job', { length: 60 }).notNull(),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),

    /**
     * `skipped` is a first-class outcome, not a failure.
     *
     * Overlapping invocations are expected at a one-minute cadence: a run that
     * finds the advisory lock held exits immediately and records why. Counting
     * that as an error would train whoever reads this to ignore errors.
     */
    outcome: varchar('outcome', { length: 20 }).notNull(),

    scanned: integer('scanned').notNull().default(0),
    expired: integer('expired').notNull().default(0),
    unitsReleased: integer('units_released').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    durationMs: integer('duration_ms'),

    /** First error message, truncated. Never a stack trace. */
    error: text('error'),
  },
  (table) => [
    /** The health query: newest successful run for a job. */
    index('scheduler_runs_job_started_idx').on(table.job, table.startedAt),

    /**
     * At most one run per job may be `running` — this row IS the mutual
     * exclusion between overlapping invocations.
     *
     * A partial unique index rather than an advisory lock, because advisory
     * locks are session-scoped and a connection pool hands each statement a
     * different session: the unlock lands somewhere else, the lock leaks, and
     * the schedule silently stops. State in a table has no such problem.
     */
    uniqueIndex('scheduler_runs_one_running')
      .on(table.job)
      .where(sql`${table.outcome} = 'running'`),
  ],
)

export type SchedulerRun = typeof schedulerRuns.$inferSelect
