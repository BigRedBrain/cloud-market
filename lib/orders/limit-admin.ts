import 'server-only'

import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import type { CannabisClass } from '@/lib/db/schema'

/**
 * Publishing and reading purchase limit rules.
 *
 * THE ONE RULE THIS MODULE EXISTS TO KEEP: a published rule is never modified
 * and never deleted. Changing a cap inserts a new row and closes the previous
 * one at the instant the new one takes effect.
 *
 * That is not politeness about history. `order_lines.purchase_limit_rule_id`
 * points at the row an order was actually checked against, so mutating a rule
 * would retroactively change the stated basis of orders already placed — and
 * the one question this data exists to answer is "under what rule did you sell
 * that?". An answer that changes after the fact is not an answer.
 *
 * The database enforces it too (migration 0009): an UPDATE touching any value
 * column is rejected by trigger, and DELETE is rejected outright. This module
 * is the sanctioned path, not the only line of defence.
 */

export type PublishInput = {
  cannabisClass: CannabisClass
  equivalentGramsPerGram: number
  dailyEquivalentGramsCap: number
  dailyConcentrateGramsCap: number | null
  /**
   * When the new rule takes effect, or `null` for immediately.
   *
   * NULL IS NOT THE SAME AS `new Date()`, AND THE DIFFERENCE IS NOT COSMETIC.
   * A JavaScript "now" is this machine's clock, and it is routinely a second or
   * two ahead of the database's. A rule stamped with a start instant the
   * database has not reached yet is not in force — so "publish immediately"
   * would quietly leave the OLD cap running for as long as the skew lasts, and
   * the screen would show the new rule as scheduled for a moment that already
   * passed. Passing null makes the database stamp it, which is the same rule
   * every expiry comparison in this phase follows.
   */
  effectiveFrom: Date | null
  changeReason: string
  publishedBy: string
  reauthenticatedAt: Date
}

export type PublishFailure =
  | { kind: 'effective_in_past' }
  | { kind: 'before_current'; currentEffectiveFrom: Date }
  | { kind: 'identical' }
  | { kind: 'concurrent_publish' }

export type PublishResult =
  | {
      ok: true
      ruleId: string
      version: number
      supersededRuleId: string | null
      /** True when the row it replaced had not yet taken effect. */
      cancelledPending: boolean
    }
  | { ok: false; failure: PublishFailure }

/**
 * The window predicate: which rule governs a class right now.
 *
 * `[effective_from, effective_until)` evaluated against DATABASE time, for the
 * same reason every expiry check in Phase 4 does. A rule that takes effect at
 * midnight must do so on one clock, not on whichever application server happens
 * to answer the request.
 */
function currentlyEffective() {
  return and(
    sql`${schema.purchaseLimitRules.effectiveFrom} <= now()`,
    sql`(${schema.purchaseLimitRules.effectiveUntil} is null
         or ${schema.purchaseLimitRules.effectiveUntil} > now())`,
  )
}

/** Rules in force at this instant, with their ids. */
export async function effectiveRules() {
  return db
    .select()
    .from(schema.purchaseLimitRules)
    .where(currentlyEffective())
    .orderBy(asc(schema.purchaseLimitRules.cannabisClass))
}

/**
 * Every version of every rule, newest first.
 *
 * Deliberately unfiltered. This is the screen a compliance officer opens when
 * asked to justify a sale, so it shows superseded rules, cancelled ones that
 * never took effect, and rules scheduled for the future, all labelled.
 */
export async function ruleHistory() {
  const publisher = schema.users

  return db
    .select({
      id: schema.purchaseLimitRules.id,
      cannabisClass: schema.purchaseLimitRules.cannabisClass,
      version: schema.purchaseLimitRules.version,
      equivalentGramsPerGram: schema.purchaseLimitRules.equivalentGramsPerGram,
      dailyEquivalentGramsCap: schema.purchaseLimitRules.dailyEquivalentGramsCap,
      dailyConcentrateGramsCap: schema.purchaseLimitRules.dailyConcentrateGramsCap,
      effectiveFrom: schema.purchaseLimitRules.effectiveFrom,
      effectiveUntil: schema.purchaseLimitRules.effectiveUntil,
      changeReason: schema.purchaseLimitRules.changeReason,
      publishedAt: schema.purchaseLimitRules.publishedAt,
      reauthenticatedAt: schema.purchaseLimitRules.reauthenticatedAt,
      supersedesRuleId: schema.purchaseLimitRules.supersedesRuleId,
      supersededByRuleId: schema.purchaseLimitRules.supersededByRuleId,
      notes: schema.purchaseLimitRules.notes,
      publishedByEmail: publisher.email,
      /**
       * Resolved in SQL against database time so the three states cannot
       * disagree with the `effectiveRules()` query rendered beside them.
       *
       * `cancelled` is the case worth naming: a scheduled rule that was
       * replaced before its start date has from == until, an empty window, and
       * never governed anything. It is kept rather than deleted because the
       * fact that somebody scheduled it and then thought better of it is
       * itself part of the record.
       */
      state: sql<'effective' | 'scheduled' | 'cancelled' | 'superseded'>`
        case
          when ${schema.purchaseLimitRules.effectiveUntil} is not null
           and ${schema.purchaseLimitRules.effectiveUntil}
               <= ${schema.purchaseLimitRules.effectiveFrom} then 'cancelled'
          when ${schema.purchaseLimitRules.effectiveFrom} > now() then 'scheduled'
          when ${schema.purchaseLimitRules.effectiveUntil} is null
            or ${schema.purchaseLimitRules.effectiveUntil} > now() then 'effective'
          else 'superseded'
        end
      `,
      /** How many order lines cite this rule. Why it cannot be deleted. */
      citedByLines: sql<number>`(
        select count(*)::int from ${schema.orderLines}
         where ${schema.orderLines.purchaseLimitRuleId} = ${schema.purchaseLimitRules.id}
      )`,
    })
    .from(schema.purchaseLimitRules)
    .leftJoin(publisher, eq(publisher.id, schema.purchaseLimitRules.publishedBy))
    .orderBy(
      asc(schema.purchaseLimitRules.cannabisClass),
      desc(schema.purchaseLimitRules.version),
    )
}

export type RuleHistoryRow = Awaited<ReturnType<typeof ruleHistory>>[number]

const numbersMatch = (a: string | null, b: number | null) =>
  a === null ? b === null : b !== null && Number(a) === b

/**
 * Publishes a new version of a class's rule.
 *
 * THE SEQUENCE, AND WHY IT IS THREE STATEMENTS AND NOT TWO
 *
 * A partial unique index permits exactly one row per class with
 * `effective_until is null`. So the new row cannot be inserted while the old
 * one is still open:
 *
 *   1. close the old row at the new rule's start instant
 *   2. insert the new row, pointing back at the old one
 *   3. write the forward pointer on the old row
 *
 * All three inside one transaction, with the old row locked `for update` first.
 * Two officers pressing publish at the same moment therefore serialise: the
 * second finds the row it read has already been closed, and is told to reload
 * rather than silently producing a second successor.
 *
 * SCHEDULING, AND WHAT HAPPENS TO A PENDING RULE
 *
 * `effective_from` may be in the future. Publishing again before that date
 * closes the pending rule at the new start instant. If both share a date the
 * pending rule ends up with `effective_until == effective_from` — an empty
 * window, so it never governs anything — which is how a scheduled change is
 * cancelled without deleting the evidence that it was scheduled.
 */
export async function publishRule(input: PublishInput): Promise<PublishResult> {
  let result: PublishResult = { ok: false, failure: { kind: 'concurrent_publish' } }

  await db.transaction(async (tx) => {
    /**
     * One reading of the clock, taken from the database, used for every
     * comparison below and written into the row when the change is immediate.
     * `now()` is transaction time, so the closing boundary of the outgoing rule
     * and the opening boundary of the incoming one are the same value by
     * construction rather than by luck.
     */
    const clock = await tx.execute<{ at: string | Date }>(sql`select now() as at`)
    /**
     * `execute` returns driver rows, which hand back a timestamp string rather
     * than the Date the query builder would have parsed for us. Coerced here
     * rather than trusted.
     */
    const dbNow = new Date((Array.isArray(clock) ? clock : clock.rows)[0].at)

    const effectiveAt = input.effectiveFrom ?? dbNow

    /** A minute of tolerance for the round trip from the operator's form. */
    if (input.effectiveFrom && effectiveAt.getTime() < dbNow.getTime() - 60_000) {
      result = { ok: false, failure: { kind: 'effective_in_past' } }
      return
    }

    /**
     * Lock the open row for this class. Everything below reads from `current`,
     * and the lock is what makes those reads still true at COMMIT.
     */
    const [current] = await tx
      .select()
      .from(schema.purchaseLimitRules)
      .where(
        and(
          eq(schema.purchaseLimitRules.cannabisClass, input.cannabisClass),
          isNull(schema.purchaseLimitRules.effectiveUntil),
        ),
      )
      .for('update')
      .limit(1)

    /**
     * The highest version this class has ever had, open or closed.
     *
     * Versions are numbered from the whole history rather than from `current`,
     * and the distinction matters under contention. In READ COMMITTED the
     * loser of a race blocks on the winner's lock, then re-evaluates its
     * predicate against the committed row — which no longer has a null
     * `effective_until`, so it drops out of the result and `current` comes back
     * undefined. Deriving the version from `current` would then restart the
     * numbering at 1 and collide with the existing history. That collision was
     * caught by the unique index on (cannabis_class, version), but as a raw
     * constraint error rather than something a caller could act on.
     */
    const [tally] = await tx
      .select({ maxVersion: sql<number | null>`max(${schema.purchaseLimitRules.version})` })
      .from(schema.purchaseLimitRules)
      .where(eq(schema.purchaseLimitRules.cannabisClass, input.cannabisClass))

    /** No open rule but history exists: someone else just published. */
    if (!current && tally?.maxVersion) {
      result = { ok: false, failure: { kind: 'concurrent_publish' } }
      return
    }

    /**
     * Is the open rule a change that has not landed yet?
     *
     * This is the case that makes an urgent correction possible. When a change
     * is scheduled, the rule GOVERNING TODAY is not the open one — it is the
     * open one's predecessor, closed at the future start instant. Publishing
     * immediately therefore has to reach past the pending rule and re-close the
     * one actually in force.
     */
    const pending = current !== undefined && current.effectiveFrom.getTime() > dbNow.getTime()
    const startsBeforePending =
      current !== undefined && effectiveAt.getTime() < current.effectiveFrom.getTime()

    if (current) {
      /**
       * A rule may not start before one that is ALREADY IN FORCE. Allowing it
       * would produce two rules claiming the same past instant, and "which
       * applied?" would stop having one answer.
       *
       * A rule that has not taken effect yet is different: nothing has been
       * checked against it, so starting before it rewrites nothing.
       */
      if (startsBeforePending && !pending) {
        result = {
          ok: false,
          failure: { kind: 'before_current', currentEffectiveFrom: current.effectiveFrom },
        }
        return
      }

      /**
       * Republishing identical numbers is refused rather than recorded. The
       * history is meant to be a list of CHANGES; padding it with no-ops makes
       * the real changes harder to find, which is the only thing the history is
       * for.
       */
      if (
        numbersMatch(current.equivalentGramsPerGram, input.equivalentGramsPerGram) &&
        numbersMatch(current.dailyEquivalentGramsCap, input.dailyEquivalentGramsCap) &&
        numbersMatch(current.dailyConcentrateGramsCap, input.dailyConcentrateGramsCap)
      ) {
        result = { ok: false, failure: { kind: 'identical' } }
        return
      }
    }

    const cancelledPending = pending

    /* 1 — close the outgoing rule, if there is one. */
    if (current) {
      /**
       * A pending rule is closed at its own start instant, giving it an empty
       * window: it exists, it is on the record, and it never governed anything.
       * Anything else is closed at the moment its successor begins.
       */
      const closeAt = pending && startsBeforePending ? current.effectiveFrom : effectiveAt

      const closed = await tx
        .update(schema.purchaseLimitRules)
        .set({ effectiveUntil: closeAt, updatedAt: new Date() })
        .where(
          and(
            eq(schema.purchaseLimitRules.id, current.id),
            /** Still open — the conditional write, not a re-read. */
            isNull(schema.purchaseLimitRules.effectiveUntil),
          ),
        )
        .returning({ id: schema.purchaseLimitRules.id })

      if (closed.length === 0) {
        result = { ok: false, failure: { kind: 'concurrent_publish' } }
        return
      }

      /**
       * 1b — and when we are starting before a pending rule, bring forward the
       * close of the rule ACTUALLY in force, so the new one does not overlap it.
       *
       * Without this there would be two rules covering the span between now and
       * the cancelled rule's start date. The boundary being moved is by
       * definition still in the future — it is the pending rule's start — so
       * the database's guard permits it and no sale is retroactively affected.
       *
       * FOUND BY QUERY, NOT BY FOLLOWING `supersedes_rule_id`. One link back
       * from a pending rule is not necessarily the rule in force: schedule a
       * change, then replace it before it lands, and the predecessor is itself
       * a cancelled rule with an empty window. Closing THAT one at the present
       * instant would put its end before its start, which the check constraint
       * rejects — as it should. Asking which rule actually governs right now is
       * both simpler and correct at any chain depth.
       */
      if (pending && startsBeforePending) {
        const [inForce] = await tx
          .select({
            id: schema.purchaseLimitRules.id,
            effectiveUntil: schema.purchaseLimitRules.effectiveUntil,
          })
          .from(schema.purchaseLimitRules)
          .where(
            and(
              eq(schema.purchaseLimitRules.cannabisClass, input.cannabisClass),
              ne(schema.purchaseLimitRules.id, current.id),
              sql`${schema.purchaseLimitRules.effectiveFrom} <= ${dbNow}`,
              sql`(${schema.purchaseLimitRules.effectiveUntil} is null
                   or ${schema.purchaseLimitRules.effectiveUntil} > ${dbNow})`,
            ),
          )
          .for('update')
          .limit(1)

        if (inForce?.effectiveUntil && inForce.effectiveUntil.getTime() > dbNow.getTime()) {
          await tx
            .update(schema.purchaseLimitRules)
            .set({ effectiveUntil: effectiveAt, updatedAt: new Date() })
            .where(eq(schema.purchaseLimitRules.id, inForce.id))
        }
      }
    }

    /* 2 — the new rule. */
    const [inserted] = await tx
      .insert(schema.purchaseLimitRules)
      .values({
        cannabisClass: input.cannabisClass,
        version: (tally?.maxVersion ?? 0) + 1,
        equivalentGramsPerGram: String(input.equivalentGramsPerGram),
        dailyEquivalentGramsCap: String(input.dailyEquivalentGramsCap),
        dailyConcentrateGramsCap:
          input.dailyConcentrateGramsCap === null
            ? null
            : String(input.dailyConcentrateGramsCap),
        effectiveFrom: effectiveAt,
        changeReason: input.changeReason,
        publishedBy: input.publishedBy,
        reauthenticatedAt: input.reauthenticatedAt,
        supersedesRuleId: current?.id ?? null,
      })
      .returning({
        id: schema.purchaseLimitRules.id,
        version: schema.purchaseLimitRules.version,
      })

    /* 3 — the forward pointer, closing the chain. */
    if (current) {
      await tx
        .update(schema.purchaseLimitRules)
        .set({ supersededByRuleId: inserted.id, updatedAt: new Date() })
        .where(eq(schema.purchaseLimitRules.id, current.id))
    }

    result = {
      ok: true,
      ruleId: inserted.id,
      version: inserted.version,
      supersededRuleId: current?.id ?? null,
      cancelledPending,
    }
  })

  return result
}

/**
 * Wraps `publishRule` so that a lost race is reported rather than thrown.
 *
 * The checks inside the transaction catch contention in the ordinary case; the
 * unique indexes catch what those checks miss. This turns the second kind into
 * the same `concurrent_publish` outcome as the first, so a caller has one
 * behaviour to handle. Anything that is NOT a uniqueness violation is
 * re-thrown untouched — swallowing a real fault here would be far worse than a
 * stack trace.
 */
export async function publishRuleSafely(input: PublishInput): Promise<PublishResult> {
  try {
    return await publishRule(input)
  } catch (error) {
    const text: string[] = []
    let current: unknown = error
    for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
      text.push(current.message)
      current = (current as { cause?: unknown }).cause
    }
    const joined = text.join(' | ')

    if (/duplicate key|unique constraint|purchase_limit_rules_(class_version|active_class)/i.test(joined)) {
      return { ok: false, failure: { kind: 'concurrent_publish' } }
    }
    throw error
  }
}
