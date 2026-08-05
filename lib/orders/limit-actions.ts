'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAuditEvent } from '@/lib/auth/audit'
import { requirePermission } from '@/lib/auth/dal'
import { reauthenticate, reauthMessage } from '@/lib/auth/reauth'
import { CLASS_MEASUREMENT, SUPPORTED_CANNABIS_CLASSES } from '@/lib/orders/limits'
import { previewPublish, publishRuleSafely, type PublishInput } from '@/lib/orders/limit-admin'
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
 * it changes the legal caps enforced at every checkout. The gates are
 * deliberately redundant, and each catches something the others do not.
 *
 *   1. `requirePermission` — a named grant, not a role.
 *   2. Validation — shape, then units, then dangerous values.
 *   3. Confirmation — the class typed by hand, plus an explicit acknowledgement.
 *   4. `reauthenticate` — the password again, in this request.
 *   5. `publishRuleSafely` — validates the calculation, then inserts and
 *      supersedes. Never updates, never deletes.
 *   6. Audit — inside the publishing transaction, and for every refusal here.
 *
 * The permission check runs first so an unauthorised caller cannot use this as
 * an oracle for whether a password is correct.
 */

/**
 * The conversion is entered as a RATIO, not a decimal.
 *
 * 28.349523125/36 grams per fluid ounce is not a terminating decimal. A field
 * that accepted "0.7875" would silently publish an approximation of a legal
 * conversion, and nothing downstream could tell it apart from the exact value.
 */
const positiveInteger = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${label} must be a whole number`)
    .transform((raw) => BigInt(raw))

const exactDecimal = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${label} must be a decimal number`)

const publishSchema = z
  .object({
    cannabisClass: z.enum(SUPPORTED_CANNABIS_CLASSES),

    equivalenceNumerator: positiveInteger('The conversion numerator'),
    equivalenceDenominator: positiveInteger('The conversion denominator'),

    usableEquivalentCapGrams: exactDecimal('The usable-equivalent cap'),
    concentrateCapGrams: exactDecimal('The concentrate cap'),
    immaturePlantCapUnits: z
      .string()
      .trim()
      .regex(/^\d+$/, 'The immature plant cap must be a whole number')
      .transform(Number),

    timing: z.enum(['now', 'scheduled']),
    effectiveFrom: z
      .string()
      .trim()
      .optional()
      .transform((raw) => (raw === '' || raw === undefined ? null : raw)),

    changeReason: z
      .string()
      .trim()
      .min(20, 'Give a reason of at least 20 characters — this is the audit record')
      .max(1000),

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
    { path: ['effectiveFrom'], message: 'Choose the date and time this takes effect' },
  )
  .refine((data) => data.equivalenceDenominator > 0n, {
    path: ['equivalenceDenominator'],
    message: 'The denominator must be greater than zero',
  })

/**
 * A dry run: what would change, and what would stop it.
 *
 * Called by the confirmation step so an operator sees the outgoing and incoming
 * caps side by side BEFORE entering a password. It writes nothing and needs no
 * re-authentication — it only reads the rule already in force, which the same
 * user can already see on the page.
 */
export async function previewLimitRuleAction(
  _previous: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  const user = await requirePermission('compliance_admin')

  /**
   * The password is not required for a preview and is deliberately not read.
   * A dry run that demanded the password would burn a re-authentication attempt
   * against the throttle for a request that writes nothing.
   */
  const parsed = parseInput(
    publishSchema,
    { ...formDataToObject(formData), password: 'preview-only' },
  )
  if (!parsed.ok) return parsed

  const preview = await previewPublish(toPublishInput(parsed.data, user.id, new Date()))
  return ok(JSON.stringify(preview))
}

function toPublishInput(
  data: z.output<typeof publishSchema>,
  userId: string,
  reauthenticatedAt: Date,
): PublishInput {
  return {
    cannabisClass: data.cannabisClass,
    equivalenceNumerator: data.equivalenceNumerator,
    equivalenceDenominator: data.equivalenceDenominator,
    /**
     * Derived from the class, not accepted from the form.
     *
     * The basis is a property of the classification — flower is measured in
     * grams, liquid infused product in fluid ounces — so letting the operator
     * pick it independently would create a field whose only possible value is
     * already known, and whose wrong value is a silent factor-of-two error.
     * `validateRuleValues` checks it anyway, because this function is not the
     * only caller.
     */
    expectedBasis: CLASS_MEASUREMENT[data.cannabisClass].basis,
    usableEquivalentCapGrams: data.usableEquivalentCapGrams,
    concentrateCapGrams: data.concentrateCapGrams,
    immaturePlantCapUnits: data.immaturePlantCapUnits,
    effectiveFrom: data.timing === 'now' ? null : new Date(data.effectiveFrom as string),
    changeReason: data.changeReason,
    publishedBy: userId,
    reauthenticatedAt,
  }
}

export async function publishLimitRuleAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const user = await requirePermission('compliance_admin')

  const parsed = parseInput(publishSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const input = parsed.data

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

  const published = await publishRuleSafely(toPublishInput(input, user.id, reauth.at))

  if (!published.ok) {
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
      case 'unsupported_class':
        return fail(
          'conflict',
          `"${published.failure.cannabisClass}" is not a class this calculation supports. ` +
            'Publishing a rule for it would have no defined conversion.',
        )
      case 'zero_conversion':
        return fail(
          'conflict',
          'A conversion of zero means this class counts toward no limit at all — ' +
            'an unlimited sale. Only immature plants and explicitly non-cannabis ' +
            'merchandise may contribute nothing.',
        )
      case 'incompatible_units':
        return fail(
          'conflict',
          `This class is measured in ${published.failure.expected.replace(/_/g, ' ')}, ` +
            `but the rule expects ${published.failure.supplied.replace(/_/g, ' ')}. ` +
            'A conversion applied to the wrong unit is silently wrong.',
        )
      case 'invalid_cap':
        return fail(
          'conflict',
          `The ${published.failure.cap.replace(/_/g, ' ')} cap of ` +
            `"${published.failure.value}" is not a usable limit. A cap of zero would ` +
            'prohibit the class entirely, which needs to be stated deliberately ' +
            'rather than reached by leaving a field empty.',
        )
      case 'would_orphan_class':
        return fail(
          'conflict',
          `Publishing this would leave ${published.failure.classes.join(', ')} with no ` +
            'rule in force, and those products would stop being sellable.',
        )
    }
  }

  /**
   * The PUBLISHED and SUPERSEDED audit rows are written INSIDE the publishing
   * transaction — see `publishRule`. Reaching this line means both the rule and
   * its audit row committed together, or neither did.
   */
  revalidatePath('/admin/purchase-limits')
  return ok()
}
