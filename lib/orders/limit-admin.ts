import 'server-only'

import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm'

import { recordAuditEventWithin } from '@/lib/auth/audit'
import { db, schema } from '@/lib/db'
import type { CannabisClass, MeasurementBasis } from '@/lib/db/schema'
import {
  compare as compareExact,
  fromDecimalString,
  rational,
  toRatioString,
  ZERO,
} from '@/lib/orders/exact'
import {
  CALCULATION_VERSION,
  CLASS_MEASUREMENT,
  isSupportedClass,
  SUPPORTED_CANNABIS_CLASSES,
} from '@/lib/orders/limits'

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
  /** The exact conversion, as integers. Never a decimal. */
  equivalenceNumerator: bigint
  equivalenceDenominator: bigint
  /** Which measurement the conversion expects. Checked for compatibility. */
  expectedBasis: MeasurementBasis
  /** Exact decimal strings — parsed into rationals, never through `Number`. */
  usableEquivalentCapGrams: string
  concentrateCapGrams: string
  immaturePlantCapUnits: number
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
  /* --- refusals that protect the calculation itself --------------------- */
  /** The class is not one this calculation supports (`edible`, `other`). */
  | { kind: 'unsupported_class'; cannabisClass: string }
  /** A conversion of zero on a class that actually contains cannabis. */
  | { kind: 'zero_conversion'; cannabisClass: string }
  /** The basis does not match what the class is measured in. */
  | { kind: 'incompatible_units'; expected: MeasurementBasis; supplied: MeasurementBasis }
  /** A cap of zero or below, which would prohibit rather than limit. */
  | { kind: 'invalid_cap'; cap: 'usable' | 'concentrate' | 'immature_plants'; value: string }
  /** Publishing this would leave a supported class with no rule in force. */
  | { kind: 'would_orphan_class'; classes: string[] }

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
      equivalenceNumerator: schema.purchaseLimitRules.equivalenceNumerator,
      equivalenceDenominator: schema.purchaseLimitRules.equivalenceDenominator,
      expectedBasis: schema.purchaseLimitRules.expectedBasis,
      usableEquivalentCapGrams: schema.purchaseLimitRules.usableEquivalentCapGrams,
      concentrateCapGrams: schema.purchaseLimitRules.concentrateCapGrams,
      immaturePlantCapUnits: schema.purchaseLimitRules.immaturePlantCapUnits,
      calculationVersion: schema.purchaseLimitRules.calculationVersion,
      /** Legacy decimals, shown labelled so they cannot be mistaken for current. */
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

/**
 * Which supported classes currently have no rule in force.
 *
 * Surfaced on the admin screen and checked at publication. A class with no rule
 * cannot be sold — `resolveLimitRules` refuses it — so this is the difference
 * between "the shop sells six categories" and "the shop sells four and silently
 * refuses two at the last step of checkout".
 */
export async function classesWithoutRules(): Promise<string[]> {
  const live = await effectiveRules()
  const covered = new Set(live.map((rule) => rule.cannabisClass as string))
  return SUPPORTED_CANNABIS_CLASSES.filter((cls) => !covered.has(cls))
}

/**
 * What the operator is shown before they confirm.
 *
 * Built server-side from the rule actually in force, not from what the form
 * remembers, so the "outgoing" column cannot be stale. Every figure that could
 * be dangerous is here: the three caps, the conversion, the measurement basis,
 * and the exact instant it takes effect with its zone.
 */
export type PublishPreview = {
  cannabisClass: string
  measurementBasis: MeasurementBasis
  measurementUnit: string
  outgoing: {
    version: number
    equivalence: string
    basis: string
    usableCapGrams: string
    concentrateCapGrams: string
    plantCap: string
    effectiveFrom: string
  } | null
  incoming: {
    equivalence: string
    basis: string
    usableCapGrams: string
    concentrateCapGrams: string
    plantCap: string
  }
  /** Refusal that would occur, computed before the password is asked for. */
  blockedBy: PublishFailure | null
}

export async function previewPublish(input: PublishInput): Promise<PublishPreview> {
  const [current] = await db
    .select()
    .from(schema.purchaseLimitRules)
    .where(
      and(
        eq(schema.purchaseLimitRules.cannabisClass, input.cannabisClass),
        isNull(schema.purchaseLimitRules.effectiveUntil),
      ),
    )
    .limit(1)

  const spec = isSupportedClass(input.cannabisClass)
    ? CLASS_MEASUREMENT[input.cannabisClass]
    : { basis: 'exempt' as MeasurementBasis, unit: '?' }

  return {
    cannabisClass: input.cannabisClass,
    measurementBasis: spec.basis,
    measurementUnit: spec.unit,
    outgoing: current
      ? {
          version: current.version,
          equivalence:
            current.equivalenceNumerator && current.equivalenceDenominator
              ? toRatioString(
                  rational(
                    BigInt(current.equivalenceNumerator),
                    BigInt(current.equivalenceDenominator),
                  ),
                )
              : (current.equivalentGramsPerGram ?? 'not recorded'),
          basis: current.expectedBasis ?? 'not recorded',
          usableCapGrams:
            current.usableEquivalentCapGrams ?? current.dailyEquivalentGramsCap ?? 'not recorded',
          concentrateCapGrams:
            current.concentrateCapGrams ?? current.dailyConcentrateGramsCap ?? 'not recorded',
          plantCap:
            current.immaturePlantCapUnits === null
              ? 'not recorded'
              : String(current.immaturePlantCapUnits),
          effectiveFrom: current.effectiveFrom.toISOString(),
        }
      : null,
    incoming: {
      equivalence: toRatioString(
        rational(input.equivalenceNumerator, input.equivalenceDenominator),
      ),
      basis: input.expectedBasis,
      usableCapGrams: input.usableEquivalentCapGrams,
      concentrateCapGrams: input.concentrateCapGrams,
      plantCap: String(input.immaturePlantCapUnits),
    },
    blockedBy: validateRuleValues(input),
  }
}

const exactMatch = (stored: string | null, supplied: string) => {
  if (stored === null) return false
  try {
    return compareExact(fromDecimalString(stored), fromDecimalString(supplied)) === 0
  } catch {
    return false
  }
}

/**
 * Everything that must be true before a rule may be published.
 *
 * Pure, and exported, so the admin screen can show the operator exactly what
 * would be refused BEFORE they enter a password — and so the tests can assert
 * each refusal without a database.
 *
 * These are refusals about the CALCULATION, distinct from the refusals about
 * the timeline (`before_current`, `identical`, `concurrent_publish`) which need
 * the current row and therefore live inside the transaction.
 */
export function validateRuleValues(input: PublishInput): PublishFailure | null {
  if (!isSupportedClass(input.cannabisClass)) {
    return { kind: 'unsupported_class', cannabisClass: input.cannabisClass }
  }

  const spec = CLASS_MEASUREMENT[input.cannabisClass]

  /**
   * The unit check. A conversion written for grams applied to a fluid-ounce
   * measurement is wrong by more than a factor of two, and every other field in
   * the row would look perfectly reasonable.
   */
  if (input.expectedBasis !== spec.basis) {
    return {
      kind: 'incompatible_units',
      expected: spec.basis,
      supplied: input.expectedBasis,
    }
  }

  /**
   * A conversion of zero means the class contributes nothing to any cap — an
   * unlimited sale. Permitted ONLY for the two classes where contributing
   * nothing is the correct, deliberate answer: plants are counted against
   * their own cap, and `non_cannabis` is an explicit exemption.
   */
  if (input.equivalenceNumerator === 0n && spec.countsAsCannabis && input.cannabisClass !== 'immature_plant') {
    return { kind: 'zero_conversion', cannabisClass: input.cannabisClass }
  }
  if (input.equivalenceDenominator <= 0n) {
    return { kind: 'invalid_cap', cap: 'usable', value: 'denominator must be positive' }
  }

  /**
   * Caps of zero or below. Zero would mean "this class is prohibited", which
   * is a legitimate thing to want and NOT something to arrive at by leaving a
   * field blank — so it is refused here and a prohibition would need its own
   * explicit representation.
   */
  const caps: [PublishFailure & { kind: 'invalid_cap' }, boolean][] = []
  try {
    const usable = fromDecimalString(input.usableEquivalentCapGrams)
    caps.push([
      { kind: 'invalid_cap', cap: 'usable', value: input.usableEquivalentCapGrams },
      compareExact(usable, ZERO) <= 0,
    ])
    const concentrate = fromDecimalString(input.concentrateCapGrams)
    caps.push([
      { kind: 'invalid_cap', cap: 'concentrate', value: input.concentrateCapGrams },
      compareExact(concentrate, ZERO) <= 0,
    ])
  } catch {
    return {
      kind: 'invalid_cap',
      cap: 'usable',
      value: 'caps must be exact decimals',
    }
  }
  caps.push([
    {
      kind: 'invalid_cap',
      cap: 'immature_plants',
      value: String(input.immaturePlantCapUnits),
    },
    !Number.isInteger(input.immaturePlantCapUnits) || input.immaturePlantCapUnits <= 0,
  ])

  for (const [failure, breached] of caps) if (breached) return failure

  return null
}

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
  /**
   * Value validation first, outside the transaction.
   *
   * None of these refusals need to see the database, and running them before
   * anything is locked means an operator with a bad number never contends with
   * a colleague publishing a good one.
   */
  const invalid = validateRuleValues(input)
  if (invalid) return { ok: false, failure: invalid }

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
        current.equivalenceNumerator === input.equivalenceNumerator.toString() &&
        current.equivalenceDenominator === input.equivalenceDenominator.toString() &&
        current.expectedBasis === input.expectedBasis &&
        exactMatch(current.usableEquivalentCapGrams, input.usableEquivalentCapGrams) &&
        exactMatch(current.concentrateCapGrams, input.concentrateCapGrams) &&
        current.immaturePlantCapUnits === input.immaturePlantCapUnits
      ) {
        result = { ok: false, failure: { kind: 'identical' } }
        return
      }
    }

    /**
     * Would this publication REMOVE coverage from a class that has it?
     *
     * Deliberately a regression check, not "does the result cover everything".
     * The absolute version cannot be right: on an empty table no class is
     * covered, so publishing the first rule would be refused and coverage could
     * never be established. What must never happen is a class that IS sellable
     * today becoming unsellable because of an unrelated publication.
     *
     * In the current design this cannot fire — a publication always inserts a
     * successor for the same class. It is here because the consequence is
     * severe and silent: a class with no rule in force is refused at the last
     * step of checkout, and the first person to discover it is a customer.
     *
     * The absolute question — "is every supported class covered?" — is answered
     * where it is actionable: `classesWithoutRules()` on the admin screen, the
     * catalog readiness gate, and `resolveLimitRules` failing closed.
     */
    const coveredBefore = new Set<string>(
      (
        await tx
          .select({ cls: schema.purchaseLimitRules.cannabisClass })
          .from(schema.purchaseLimitRules)
          .where(currentlyEffective())
      ).map((row) => row.cls as string),
    )
    const coveredAfter = new Set(coveredBefore)
    coveredAfter.add(input.cannabisClass)

    const lost = [...coveredBefore].filter((cls) => !coveredAfter.has(cls))
    if (lost.length > 0) {
      result = { ok: false, failure: { kind: 'would_orphan_class', classes: lost } }
      return
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
        equivalenceNumerator: input.equivalenceNumerator.toString(),
        equivalenceDenominator: input.equivalenceDenominator.toString(),
        expectedBasis: input.expectedBasis,
        usableEquivalentCapGrams: input.usableEquivalentCapGrams,
        concentrateCapGrams: input.concentrateCapGrams,
        immaturePlantCapUnits: input.immaturePlantCapUnits,
        calculationVersion: CALCULATION_VERSION,
        /** Legacy decimal columns stay null; they cannot hold these ratios. */
        equivalentGramsPerGram: null,
        dailyEquivalentGramsCap: null,
        dailyConcentrateGramsCap: null,
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

    /**
     * 4 — the audit, INSIDE this transaction and allowed to throw.
     *
     * This is the whole point of doing it here rather than in the caller. A
     * publish that succeeds and an audit that fails would leave a legal cap
     * changed with no record of who changed it — which is precisely the
     * artefact the audit exists to make impossible. `recordAuditEventWithin`
     * does not swallow errors, so a failure here takes the new rule, the closed
     * predecessor and the successor link down with it.
     */
    await recordAuditEventWithin(tx, {
      event: 'PURCHASE_LIMIT_RULE_PUBLISHED',
      userId: input.publishedBy,
      entityType: 'purchase_limit_rule',
      entityId: inserted.id,
      summary:
        `${input.cannabisClass} v${inserted.version}: ` +
        `${toRatioString(rational(input.equivalenceNumerator, input.equivalenceDenominator))} ` +
        `per ${CLASS_MEASUREMENT[input.cannabisClass as 'flower']?.unit ?? '?'}, ` +
        `usable cap ${input.usableEquivalentCapGrams}g, ` +
        `concentrate cap ${input.concentrateCapGrams}g, ` +
        `plants ${input.immaturePlantCapUnits}`,
    })

    if (current) {
      await recordAuditEventWithin(tx, {
        event: 'PURCHASE_LIMIT_RULE_SUPERSEDED',
        userId: input.publishedBy,
        entityType: 'purchase_limit_rule',
        entityId: current.id,
        summary: cancelledPending
          ? `superseded by v${inserted.version} before it took effect`
          : `superseded by v${inserted.version}`,
      })
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

    /**
     * `conflicting key value violates exclusion constraint` is the overlap
     * guard in migration 0011 firing. It means another transaction committed a
     * window that intersects this one between our read and our write — the same
     * lost race the unique indexes catch, arriving by a different route.
     */
    if (
      /duplicate key|unique constraint|exclusion constraint|purchase_limit_rules_(class_version|active_class|no_overlap)/i.test(
        joined,
      )
    ) {
      return { ok: false, failure: { kind: 'concurrent_publish' } }
    }
    throw error
  }
}
