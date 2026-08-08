'use server'

import { and, eq, isNull, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { Route } from 'next'
import { z } from 'zod'

import { requireAdminIdentity } from '@/lib/auth/admin-identity'
import { db, schema } from '@/lib/db'
import { withUpdatedAt } from '@/lib/db/schema'
import {
  fail,
  formDataToObject,
  ok,
  parseInput,
  type ActionResult,
} from '@/lib/result'

/**
 * Catalogue administration.
 *
 * Every action starts with `requireAdminIdentity()`. Server Actions are a public
 * network boundary — the admin UI being unreachable to a customer protects
 * nothing, because the endpoint is callable directly. Hiding a form is not an
 * authorization check.
 *
 * Deletes are SOFT for brands, categories and products. Cannabis retail is
 * record-retention regulated, and a hard delete would break historic orders the
 * moment Phase 3 exists. Variants are soft-deleted for the same reason.
 */

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(1, 'Enter a slug')
      .max(96)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens'),
  )

const optionalText = z
  .string()
  .trim()
  .max(4000)
  .optional()
  .transform((value) => (value === '' ? null : (value ?? null)))

/** "12.5" → "12.50"; blank → null. Kept as a string so numeric stays exact. */
const optionalDecimal = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === '' || value === undefined ? null : value))
  .refine((value) => value === null || !Number.isNaN(Number(value)), 'Enter a number')

/** "relaxed, sleepy" → ["relaxed", "sleepy"]. */
const csvList = z
  .string()
  .trim()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      : null,
  )

const brandSchema = z.object({
  id: z.uuid().optional(),
  slug,
  name: z.string().trim().min(1, 'Enter a name').max(120),
  description: optionalText,
  active: z.coerce.boolean().optional().default(true),
})

const categorySchema = z.object({
  id: z.uuid().optional(),
  slug,
  name: z.string().trim().min(1, 'Enter a name').max(120),
  description: optionalText,
  sortOrder: z.coerce.number().int().min(0).max(32000).default(0),
  active: z.coerce.boolean().optional().default(true),
})

const productSchema = z.object({
  id: z.uuid().optional(),
  slug,
  name: z.string().trim().min(1, 'Enter a name').max(160),
  shortDescription: z.string().trim().max(320).optional().transform((v) => (v === '' ? null : (v ?? null))),
  description: optionalText,
  brandId: z.uuid('Choose a brand'),
  categoryId: z.uuid('Choose a category'),
  status: z.enum(schema.productStatus.enumValues),
  featured: z.coerce.boolean().optional().default(false),
  newArrival: z.coerce.boolean().optional().default(false),
  strainType: z
    .string()
    .optional()
    .transform((value) =>
      value && schema.strainType.enumValues.includes(value as schema.StrainType)
        ? (value as schema.StrainType)
        : null,
    ),
  thcPercent: optionalDecimal,
  cbdPercent: optionalDecimal,
  genetics: z.string().trim().max(160).optional().transform((v) => (v === '' ? null : (v ?? null))),
  effects: csvList,
  flavors: csvList,
  labTestReference: z.string().trim().max(120).optional().transform((v) => (v === '' ? null : (v ?? null))),
})

const variantSchema = z.object({
  id: z.uuid().optional(),
  productId: z.uuid(),
  sku: z.string().trim().min(1, 'Enter a SKU').max(64),
  label: z.string().trim().min(1, 'Enter a label').max(64),
  weightGrams: optionalDecimal,
  /** Dollars in the form, cents in the database — never floats in storage. */
  price: z.coerce.number().min(0, 'Price cannot be negative').max(100000),
  compareAtPrice: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : Number(value)))
    .refine((value) => value === null || (!Number.isNaN(value) && value >= 0), 'Enter a number'),
  inventoryQuantity: z.coerce.number().int().min(0).max(1_000_000),
  active: z.coerce.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(0).max(32000).default(0),
})

const toCents = (dollars: number) => Math.round(dollars * 100)

/** Postgres unique-violation, surfaced as a field error rather than a 500. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  )
}

/* -------------------------------------------------------------------------- */
/* Brands                                                                      */
/* -------------------------------------------------------------------------- */

export async function saveBrandAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(brandSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { id, ...values } = parsed.data

  try {
    if (id) {
      await db.update(schema.brands).set(withUpdatedAt(values)).where(eq(schema.brands.id, id))
    } else {
      await db.insert(schema.brands).values(values)
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('conflict', 'That slug is already in use.', { slug: ['Already in use'] })
    }
    throw error
  }

  revalidatePath('/admin/brands')
  revalidatePath('/shop')
  return ok()
}

export async function deleteBrandAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const id = String(formDataToObject(formData).id ?? '')
  if (!id) return fail('validation_error', 'Missing brand.')

  /**
   * Refuse rather than orphan. The foreign key is `restrict`, so the database
   * would reject this anyway — checking first turns a 500 into a sentence the
   * admin can act on.
   */
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.products)
    .where(and(eq(schema.products.brandId, id), isNull(schema.products.deletedAt)))

  if (count > 0) {
    return fail(
      'conflict',
      `This brand still has ${count} product${count === 1 ? '' : 's'}. Move or archive them first.`,
    )
  }

  await db
    .update(schema.brands)
    .set(withUpdatedAt({ deletedAt: new Date(), active: false }))
    .where(eq(schema.brands.id, id))

  revalidatePath('/admin/brands')
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export async function saveCategoryAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(categorySchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { id, ...values } = parsed.data

  try {
    if (id) {
      await db
        .update(schema.categories)
        .set(withUpdatedAt(values))
        .where(eq(schema.categories.id, id))
    } else {
      await db.insert(schema.categories).values(values)
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('conflict', 'That slug is already in use.', { slug: ['Already in use'] })
    }
    throw error
  }

  revalidatePath('/admin/categories')
  revalidatePath('/shop')
  return ok()
}

export async function deleteCategoryAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const id = String(formDataToObject(formData).id ?? '')
  if (!id) return fail('validation_error', 'Missing category.')

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.products)
    .where(and(eq(schema.products.categoryId, id), isNull(schema.products.deletedAt)))

  if (count > 0) {
    return fail(
      'conflict',
      `This category still has ${count} product${count === 1 ? '' : 's'}. Move or archive them first.`,
    )
  }

  await db
    .update(schema.categories)
    .set(withUpdatedAt({ deletedAt: new Date(), active: false }))
    .where(eq(schema.categories.id, id))

  revalidatePath('/admin/categories')
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Products                                                                    */
/* -------------------------------------------------------------------------- */

export async function saveProductAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(productSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { id, ...values } = parsed.data

  let createdId: string | undefined

  try {
    if (id) {
      await db.update(schema.products).set(withUpdatedAt(values)).where(eq(schema.products.id, id))
    } else {
      const [created] = await db
        .insert(schema.products)
        .values(values)
        .returning({ id: schema.products.id })
      createdId = created.id
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('conflict', 'That slug is already in use.', { slug: ['Already in use'] })
    }
    throw error
  }

  revalidatePath('/admin/products')
  revalidatePath('/shop')
  if (id) revalidatePath(`/admin/products/${id}`)

  /**
   * A new product goes straight to its editor, which opens on the media
   * section.
   *
   * Creating one from the list page previously left the operator exactly where
   * they started, with a success message and no obvious next step — so a product
   * would routinely get its prices before it got a photograph, and reach the
   * storefront as a placeholder tile. The redirect makes "now add a picture" the
   * default path rather than something to remember.
   *
   * OUTSIDE the try/catch above: `redirect()` signals by throwing, and catching
   * it here would swallow the navigation and report a spurious failure.
   */
  if (createdId) {
    redirect(`/admin/products/${createdId}` as Route)
  }

  return ok()
}

export async function deleteProductAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const id = String(formDataToObject(formData).id ?? '')
  if (!id) return fail('validation_error', 'Missing product.')

  // Soft delete, and archive so it cannot be published by accident later.
  await db
    .update(schema.products)
    .set(withUpdatedAt({ deletedAt: new Date(), status: 'archived' }))
    .where(eq(schema.products.id, id))

  revalidatePath('/admin/products')
  revalidatePath('/shop')
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Variants                                                                    */
/* -------------------------------------------------------------------------- */

export async function saveVariantAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(variantSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed

  const { id, price, compareAtPrice, ...values } = parsed.data

  const payload = {
    ...values,
    priceCents: toCents(price),
    compareAtPriceCents: compareAtPrice === null ? null : toCents(compareAtPrice),
  }

  try {
    if (id) {
      await db
        .update(schema.productVariants)
        .set(withUpdatedAt(payload))
        .where(eq(schema.productVariants.id, id))
    } else {
      await db.insert(schema.productVariants).values(payload)
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('conflict', 'That SKU is already in use.', { sku: ['Already in use'] })
    }
    throw error
  }

  revalidatePath(`/admin/products/${values.productId}`)
  revalidatePath('/shop')
  return ok()
}

export async function deleteVariantAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const input = formDataToObject(formData)
  const id = String(input.id ?? '')
  const productId = String(input.productId ?? '')
  if (!id) return fail('validation_error', 'Missing variant.')

  /**
   * Soft delete and deactivate. The SKU stays claimed by the unique index,
   * which is deliberate — reusing a retired SKU would make historic stock
   * movements ambiguous.
   */
  await db
    .update(schema.productVariants)
    .set(withUpdatedAt({ deletedAt: new Date(), active: false }))
    .where(eq(schema.productVariants.id, id))

  if (productId) revalidatePath(`/admin/products/${productId}`)
  revalidatePath('/shop')
  return ok()
}
