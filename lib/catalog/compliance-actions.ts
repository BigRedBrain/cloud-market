'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAuditEvent } from '@/lib/auth/audit'
import { requireAdminPermission } from '@/lib/auth/admin-identity'
import {
  classifyVariants,
  describeRejection,
  validateCompliance,
  type ClassifyInput,
} from '@/lib/catalog/compliance'
import { db, schema } from '@/lib/db'
import { CLASS_MEASUREMENT, SUPPORTED_CANNABIS_CLASSES } from '@/lib/orders/limits'
import {
  fail,
  formDataToObject,
  ok,
  parseInput,
  type ActionResult,
} from '@/lib/result'
import { eq, inArray } from 'drizzle-orm'

/**
 * Catalog compliance actions.
 *
 * EVERY ONE STARTS WITH `requireAdminPermission('catalog_compliance_admin')`. Not the
 * page — the page hiding a control protects nothing, because a Server Action is
 * a public POST endpoint reachable by anyone who can read an action id out of
 * any page that embeds it. The grant is also NOT implied by `admin`: an
 * administrator without it is refused exactly like a customer.
 *
 * Nothing here infers a classification. There is no "suggest", no mapping from
 * category, no reading of product names or THC figures. Every value comes from
 * a person who typed it and gave a reason.
 */

const reason = z
  .string()
  .trim()
  .min(15, 'Give a reason of at least 15 characters — this is the audit record')
  .max(1000)

/**
 * The measurement value arrives as a STRING and stays one.
 *
 * Parsing it to a `number` here would round-trip a legal measurement through
 * binary floating point before it ever reached the exact arithmetic — 0.1 fl oz
 * would stop being 0.1. The only validation applied is shape; the meaning is
 * checked by `validateCompliance`, which parses it exactly.
 */
const measurementValue = z
  .string()
  .trim()
  .optional()
  .transform((raw) => (raw === '' || raw === undefined ? null : raw))

const classifySchema = z.object({
  variantId: z.uuid(),
  cannabisClass: z.enum(SUPPORTED_CANNABIS_CLASSES),
  measurementValue,
  reason,
})

export async function classifyVariantAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const { user } = await requireAdminPermission('catalog_compliance_admin')

  const parsed = parseInput(classifySchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  /**
   * The basis is DERIVED from the class, never accepted from the form.
   *
   * Each supported class has exactly one legal measurement basis, so a separate
   * field would have only one correct value and one silent, unit-mismatched
   * wrong one. `validateCompliance` checks it regardless, because this is not
   * the only caller.
   */
  const input: ClassifyInput = {
    variantId: parsed.data.variantId,
    cannabisClass: parsed.data.cannabisClass,
    measurementBasis: CLASS_MEASUREMENT[parsed.data.cannabisClass].basis,
    measurementValue: parsed.data.measurementValue,
    reason: parsed.data.reason,
    actorId: user.id,
  }

  const rejection = validateCompliance(input)
  if (rejection) {
    await recordAuditEvent({
      event: 'CATALOG_COMPLIANCE_REJECTED',
      userId: user.id,
      entityType: 'product_variant',
      entityId: input.variantId,
      summary: `${input.cannabisClass}: ${rejection.kind}`,
    })
    return fail('validation_error', describeRejection(rejection))
  }

  const result = await classifyVariants([input])
  if (!result.ok) return failureMessage(result.failure)

  revalidatePath('/admin/catalog/compliance')
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Bulk                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Bulk is EXPLICIT SELECTION ONLY.
 *
 * There is no "classify all", no filter-and-apply, and no pattern matching.
 * The variant ids come from checkboxes the operator ticked, one class applies
 * to all of them, and the preview shows every SKU with its before and after
 * before anything is written. A bulk tool that could act on a filter would
 * eventually act on the wrong filter.
 */
const bulkSchema = z.object({
  variantIds: z
    .union([z.uuid(), z.array(z.uuid())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .refine((ids) => ids.length > 0, 'Select at least one variant')
    .refine((ids) => ids.length <= 200, 'Select no more than 200 variants at once'),
  cannabisClass: z.enum(SUPPORTED_CANNABIS_CLASSES),
  measurementValue,
  reason,
})

export type BulkPreviewRow = {
  variantId: string
  sku: string
  productName: string
  before: { cannabisClass: string | null; basis: string | null; value: string | null }
  after: { cannabisClass: string; basis: string; value: string | null }
  /** Populated when this row alone would make the batch invalid. */
  problem: string | null
}

/**
 * A dry run. Writes nothing, and shows every affected SKU.
 *
 * Returned as JSON through the standard action result rather than as a separate
 * route, so it inherits the same permission check as the write it previews.
 */
export async function previewBulkClassifyAction(
  _previous: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  const { user } = await requireAdminPermission('catalog_compliance_admin')
  void user

  const parsed = parseInput(bulkSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const basis = CLASS_MEASUREMENT[parsed.data.cannabisClass].basis
  const value = parsed.data.measurementValue

  const variants = await db
    .select({
      variantId: schema.productVariants.id,
      sku: schema.productVariants.sku,
      cannabisClass: schema.productVariants.cannabisClass,
      measurementBasis: schema.productVariants.measurementBasis,
      measurementValue: schema.productVariants.measurementValue,
      productName: schema.products.name,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
    .where(inArray(schema.productVariants.id, parsed.data.variantIds))

  const rows: BulkPreviewRow[] = variants.map((variant) => {
    const rejection = validateCompliance({
      cannabisClass: parsed.data.cannabisClass,
      measurementBasis: basis,
      measurementValue: value,
    })
    return {
      variantId: variant.variantId,
      sku: variant.sku,
      productName: variant.productName,
      before: {
        cannabisClass: variant.cannabisClass,
        basis: variant.measurementBasis,
        value: variant.measurementValue,
      },
      after: { cannabisClass: parsed.data.cannabisClass, basis, value },
      problem: rejection ? describeRejection(rejection) : null,
    }
  })

  /**
   * A selected id that no longer resolves is reported rather than dropped. A
   * preview quietly listing 38 of the 40 rows the operator ticked is a preview
   * that has already lied about what it will do.
   */
  const missing = parsed.data.variantIds.filter(
    (id) => !variants.some((v) => v.variantId === id),
  )

  return ok(JSON.stringify({ rows, missing }))
}

export async function bulkClassifyAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const { user } = await requireAdminPermission('catalog_compliance_admin')

  const parsed = parseInput(bulkSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const basis = CLASS_MEASUREMENT[parsed.data.cannabisClass].basis

  /**
   * Validated ONCE for the batch, because one class, basis and value apply to
   * every row — which is the precondition for a bulk edit being safe at all. If
   * different variants needed different values this would not be a bulk
   * operation, and the form does not offer one.
   */
  const rejection = validateCompliance({
    cannabisClass: parsed.data.cannabisClass,
    measurementBasis: basis,
    measurementValue: parsed.data.measurementValue,
  })
  if (rejection) {
    await recordAuditEvent({
      event: 'CATALOG_COMPLIANCE_REJECTED',
      userId: user.id,
      entityType: 'product_variant',
      summary: `bulk ${parsed.data.cannabisClass}: ${rejection.kind}`,
    })
    return fail('validation_error', describeRejection(rejection))
  }

  const inputs: ClassifyInput[] = parsed.data.variantIds.map((variantId) => ({
    variantId,
    cannabisClass: parsed.data.cannabisClass,
    measurementBasis: basis,
    measurementValue: parsed.data.measurementValue,
    reason: parsed.data.reason,
    actorId: user.id,
  }))

  /** One transaction. An unknown id in the batch rejects all of it. */
  const result = await classifyVariants(inputs)
  if (!result.ok) return failureMessage(result.failure)

  revalidatePath('/admin/catalog/compliance')
  return ok()
}

function failureMessage(
  failure: Extract<Awaited<ReturnType<typeof classifyVariants>>, { ok: false }>['failure'],
): ActionResult<void> {
  switch (failure.kind) {
    case 'not_found':
      return fail(
        'not_found',
        'One of the selected variants no longer exists. Nothing was changed — reload and try again.',
      )
    case 'invalid':
      return fail('validation_error', describeRejection(failure.rejection))
    case 'unchanged':
      return fail('conflict', 'Those values match what is already recorded.')
  }
}
