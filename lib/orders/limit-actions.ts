'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAuditEvent } from '@/lib/auth/audit'
import { requirePermission } from '@/lib/auth/dal'
import { reauthenticate, reauthMessage } from '@/lib/auth/reauth'
import { cannabisClass } from '@/lib/db/schema'
import { publishRuleSafely } from '@/lib/orders/limit-admin'
import {
  fail,
  formDataToObject,
  ok,
  parseInput,
  type ActionResult,
} from '@/lib/result'

/**
 * Publishing a purchase limit rule.
 *
 * This is the highest-consequence write a human can make in this application:
 * it changes the legal cap enforced at every checkout. The gates below are
 * therefore deliberately redundant, and each one catches something the others
 * do not.
 *
 *   1. `requirePermission` — a named grant, not a role. An administrator
 *      without it is refused.
 *   2. `reauthenticate` — the password again, in this request. Proves a person
 *      is present, not merely that a session exists.
 *   3. Validation — the numbers must be sane before anyone is asked to confirm.
 *   4. Confirmation — the class name typed by hand, so the class being changed
 *      has been read rather than left at whatever the select box defaulted to.
 *   5. `publishRule` — inserts and supersedes; never updates, never deletes.
 *   6. Audit — every outcome, including the refusals.
 *
 * ORDERING MATTERS. Validation runs BEFORE re-authentication so a typo does not
 * cost a password entry, but the permission check runs before everything: an
 * unauthorised caller must not be able to use this action as an oracle for
 * whether a password is correct.
 */

/**
 * Grams as a positive decimal, parsed from a text input.
 *
 * `z.coerce.number()` is avoided on purpose — it maps '' to 0 and 'abc' to NaN,
 * and a silently-zero daily cap is an unlimited daily cap. This rejects
 * anything that is not a finite number outright.
 */
const decimal = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `Enter ${label}`)
    .refine((raw) => Number.isFinite(Number(raw)), `${label} must be a number`)
    .transform(Number)
    .refine((n) => n >= 0, `${label} cannot be negative`)
    .refine((n) => n <= max, `${label} looks too large — check the units`)

const publishSchema = z
  .object({
    cannabisClass: z.enum(cannabisClass.enumValues),

    equivalentGramsPerGram: decimal('the equivalence factor', 1000),
    dailyEquivalentGramsCap: decimal('the daily equivalent cap', 100000),

    /** Blank means "no separate concentrate cap", which is a real choice. */
    dailyConcentrateGramsCap: z
      .string()
      .trim()
      .optional()
      .transform((raw) => (raw === '' || raw === undefined ? null : raw))
      .refine(
        (raw) => raw === null || (Number.isFinite(Number(raw)) && Number(raw) >= 0),
        'The concentrate cap must be a number, or blank for no separate cap',
      )
      .transform((raw) => (raw === null ? null : Number(raw))),

    /**
     * Immediately, or at a stated instant.
     *
     * "Immediately" deliberately carries NO date across the wire. The database
     * stamps it, so the rule is in force the moment the transaction commits
     * rather than whenever this machine's clock catches up to the value it put
     * in the form. See `PublishInput.effectiveFrom`.
     */
    timing: z.enum(['now', 'scheduled']),

    /** Read only when `timing` is 'scheduled'. `datetime-local` gives no zone. */
    effectiveFrom: z
      .string()
      .trim()
      .optional()
      .transform((raw) => (raw === '' || raw === undefined ? null : raw)),

    /**
     * Long enough to be a reason rather than a shrug. "updated" explains
     * nothing to whoever reads this during an audit two years from now.
     */
    changeReason: z
      .string()
      .trim()
      .min(20, 'Give a reason of at least 20 characters — this is the audit record')
      .max(1000),

    /** The typed confirmation. Checked against the class below. */
    confirmClass: z.string().trim(),

    acknowledgeImmutable: z.literal('on', {
      message: 'Confirm you understand this cannot be edited or deleted afterwards',
    }),

    password: z.string().min(1, 'Enter your password to confirm'),
  })
  .refine((data) => data.confirmClass === data.cannabisClass, {
    path: ['confirmClass'],
    message: 'Type the class name exactly to confirm which rule you are changing',
  })
  .refine(
    (data) =>
      data.timing === 'now' ||
      (data.effectiveFrom !== null && !Number.isNaN(Date.parse(data.effectiveFrom))),
    {
      path: ['effectiveFrom'],
      message: 'Choose the date and time this takes effect',
    },
  )
  .refine(
    (data) =>
      data.dailyConcentrateGramsCap === null ||
      data.dailyConcentrateGramsCap <= data.dailyEquivalentGramsCap,
    {
      path: ['dailyConcentrateGramsCap'],
      message: 'The concentrate cap cannot exceed the overall daily cap',
    },
  )

export async function publishLimitRuleAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  /* 1 — permission, before anything else can be learned from this action. */
  const user = await requirePermission('compliance_admin')

  /* 3 — validation before the password prompt is spent on a typo. */
  const parsed = parseInput(publishSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const input = parsed.data

  /* 2 — re-authentication. Audited inside, whatever the outcome. */
  const reauth = await reauthenticate(user.id, input.password)
  if (!reauth.ok) {
    await recordAuditEvent({
      event: 'PURCHASE_LIMIT_RULE_REJECTED',
      userId: user.id,
      entityType: 'purchase_limit_rule',
      summary: `${input.cannabisClass}: re-authentication failed`,
    })
    return fail(
      reauth.reason === 'throttled' ? 'rate_limited' : 'forbidden',
      reauthMessage(reauth.reason),
    )
  }

  /* 5 — insert-and-supersede. */
  const published = await publishRuleSafely({
    cannabisClass: input.cannabisClass,
    equivalentGramsPerGram: input.equivalentGramsPerGram,
    dailyEquivalentGramsCap: input.dailyEquivalentGramsCap,
    dailyConcentrateGramsCap: input.dailyConcentrateGramsCap,
    /** Null hands the timestamp to the database. See PublishInput. */
    effectiveFrom:
      input.timing === 'now' ? null : new Date(input.effectiveFrom as string),
    changeReason: input.changeReason,
    publishedBy: user.id,
    reauthenticatedAt: reauth.at,
  })

  if (!published.ok) {
    /**
     * A refusal is audited too. Someone re-authenticated and attempted a change
     * to a legal cap; that it did not land does not make it uninteresting.
     */
    await recordAuditEvent({
      event: 'PURCHASE_LIMIT_RULE_REJECTED',
      userId: user.id,
      entityType: 'purchase_limit_rule',
      summary: `${input.cannabisClass}: ${published.failure.kind}`,
    })

    switch (published.failure.kind) {
      case 'effective_in_past':
        return fail(
          'conflict',
          'A rule cannot take effect in the past. Choose now or a future date.',
        )
      case 'before_current':
        return fail(
          'conflict',
          'This would start before the rule it replaces, which would leave two ' +
            'rules claiming the same moment. Choose a later date.',
        )
      case 'identical':
        return fail(
          'conflict',
          'Those values match the rule already in force. Nothing was published.',
        )
      case 'concurrent_publish':
        return fail(
          'conflict',
          'Someone else published a change to this class while you were working. ' +
            'Reload to see it, then decide whether yours is still needed.',
        )
    }
  }

  /**
   * 6 — the record of what happened is already written.
   *
   * `PURCHASE_LIMIT_RULE_PUBLISHED` and `_SUPERSEDED` are inserted INSIDE the
   * publishing transaction, not here. Writing them from the action would put
   * them outside it, and a crash between COMMIT and this line would leave a
   * changed legal cap with no record of who changed it. Reaching this point
   * means both the rule and its audit row committed together, or neither did.
   *
   * The refusal paths above are audited from here on purpose: those are
   * non-transactional by nature — there is no publication to be atomic with —
   * and a lost refusal record must not turn into a 500 for the operator.
   */
  revalidatePath('/admin/purchase-limits')
  return ok()
}
