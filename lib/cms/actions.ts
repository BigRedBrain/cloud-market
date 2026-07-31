'use server'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { recordAuditEvent } from '@/lib/auth/audit'
import { requireAdmin } from '@/lib/auth/dal'
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
 * CMS and marketing actions.
 *
 * Every action begins with `requireAdmin()`. Server Actions are a public
 * network boundary, so the admin UI being unreachable protects nothing.
 *
 * EVERY PUBLISH WRITES AN AUDIT EVENT. Publishing is the moment content becomes
 * customer-facing, so it is the moment worth being able to reconstruct: who
 * changed the hero, when the weekend sale went live, which media replaced what.
 * Audit writes never throw — losing a log line must not block a business owner
 * from launching a promotion.
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

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : value))

/**
 * Call-to-action targets are constrained to same-origin paths.
 *
 * An editable field that becomes an `href` is an open-redirect and phishing
 * primitive if it accepts absolute URLs — a link on our domain that lands on
 * someone else's page. Same rule as `safeRedirectPath` in auth.
 */
const internalHref = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === '' || value === undefined ? null : value))
  .refine(
    (value) =>
      value === null ||
      (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')),
    'Use a path on this site, starting with /',
  )

/** Empty string → null, so "no schedule" is distinguishable from epoch zero. */
const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === '' || value === undefined ? null : new Date(value)))
  .refine((value) => value === null || !Number.isNaN(value.getTime()), 'Enter a valid date')

const publishable = {
  status: z.enum(schema.contentStatus.enumValues),
  publishAt: optionalDate,
  unpublishAt: optionalDate,
  priority: z.coerce.number().int().min(-100).max(100).default(0),
}

/** A window that closes before it opens would never be live — catch it here. */
function windowIsValid(publishAt: Date | null, unpublishAt: Date | null): boolean {
  if (!publishAt || !unpublishAt) return true
  return unpublishAt.getTime() > publishAt.getTime()
}

const campaignSchema = z.object({
  id: z.uuid().optional(),
  slug,
  type: z.enum(schema.campaignType.enumValues),
  title: z.string().trim().min(1, 'Enter a title').max(200),
  subtitle: optionalText(320),
  body: optionalText(2000),
  ctaLabel: optionalText(80),
  ctaHref: internalHref,
  heroMediaId: z.uuid().optional().or(z.literal('')).transform((v) => (v ? v : null)),
  ...publishable,
})

const collectionSchema = z.object({
  id: z.uuid().optional(),
  slug,
  name: z.string().trim().min(1, 'Enter a name').max(120),
  description: optionalText(2000),
  ...publishable,
})

const badgeSchema = z.object({
  id: z.uuid().optional(),
  slug,
  label: z.string().trim().min(1, 'Enter a label').max(60),
  icon: optionalText(16),
  /** Constrained to the frozen design system's Badge variants. */
  variant: z.enum(['volt', 'ember', 'flare', 'cream', 'smoke', 'outline']),
  description: optionalText(200),
  active: z.coerce.boolean().optional().default(true),
  priority: z.coerce.number().int().min(-100).max(100).default(0),
})

const sectionSchema = z.object({
  id: z.uuid().optional(),
  type: z.enum(schema.homepageSectionType.enumValues),
  name: z.string().trim().min(1, 'Enter a name').max(120),
  heading: optionalText(160),
  eyebrow: optionalText(80),
  subheading: optionalText(320),
  campaignId: z.uuid().optional().or(z.literal('')).transform((v) => (v ? v : null)),
  collectionId: z.uuid().optional().or(z.literal('')).transform((v) => (v ? v : null)),
  sortOrder: z.coerce.number().int().min(0).max(100).default(0),
  ...publishable,
})

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  )
}

/** True when this save makes the record customer-facing. */
function becomesLive(status: schema.ContentStatus): boolean {
  return status === 'published' || status === 'scheduled'
}

function revalidateStorefront() {
  revalidatePath('/')
  revalidatePath('/shop')
}

/* -------------------------------------------------------------------------- */
/* Campaigns (including the announcement bar)                                  */
/* -------------------------------------------------------------------------- */

export async function saveCampaignAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const parsed = parseInput(campaignSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { id, ...values } = parsed.data

  if (!windowIsValid(values.publishAt, values.unpublishAt)) {
    return fail('validation_error', 'The end date must be after the start date.', {
      unpublishAt: ['Must be after the start date'],
    })
  }

  let campaignId = id
  try {
    if (id) {
      await db.update(schema.campaigns).set(withUpdatedAt(values)).where(eq(schema.campaigns.id, id))
    } else {
      const [created] = await db
        .insert(schema.campaigns)
        .values(values)
        .returning({ id: schema.campaigns.id })
      campaignId = created.id
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('conflict', 'That slug is already in use.', { slug: ['Already in use'] })
    }
    throw error
  }

  const isAnnouncement = values.type === 'announcement'
  await recordAuditEvent({
    event: id
      ? becomesLive(values.status)
        ? isAnnouncement
          ? 'ANNOUNCEMENT_PUBLISHED'
          : 'CAMPAIGN_PUBLISHED'
        : 'CAMPAIGN_UPDATED'
      : 'CAMPAIGN_CREATED',
    userId: admin.id,
    entityType: 'campaign',
    entityId: campaignId,
    summary: `${values.type} "${values.title}" → ${values.status}`,
  })

  revalidateStorefront()
  revalidatePath('/admin/campaigns')
  return ok()
}

export async function archiveCampaignAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const id = String(formDataToObject(formData).id ?? '')
  if (!id) return fail('validation_error', 'Missing campaign.')

  const [row] = await db
    .update(schema.campaigns)
    .set(withUpdatedAt({ status: 'archived' as const }))
    .where(eq(schema.campaigns.id, id))
    .returning({ title: schema.campaigns.title })

  await recordAuditEvent({
    event: 'CAMPAIGN_ARCHIVED',
    userId: admin.id,
    entityType: 'campaign',
    entityId: id,
    summary: `Archived "${row?.title ?? id}"`,
  })

  revalidateStorefront()
  revalidatePath('/admin/campaigns')
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Collections                                                                 */
/* -------------------------------------------------------------------------- */

export async function saveCollectionAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const parsed = parseInput(collectionSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { id, ...values } = parsed.data

  if (!windowIsValid(values.publishAt, values.unpublishAt)) {
    return fail('validation_error', 'The end date must be after the start date.')
  }

  let collectionId = id
  try {
    if (id) {
      await db
        .update(schema.collections)
        .set(withUpdatedAt(values))
        .where(eq(schema.collections.id, id))
    } else {
      const [created] = await db
        .insert(schema.collections)
        .values(values)
        .returning({ id: schema.collections.id })
      collectionId = created.id
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('conflict', 'That slug is already in use.', { slug: ['Already in use'] })
    }
    throw error
  }

  await recordAuditEvent({
    event: id
      ? becomesLive(values.status)
        ? 'COLLECTION_PUBLISHED'
        : 'COLLECTION_UPDATED'
      : 'COLLECTION_CREATED',
    userId: admin.id,
    entityType: 'collection',
    entityId: collectionId,
    summary: `"${values.name}" → ${values.status}`,
  })

  revalidateStorefront()
  revalidatePath('/admin/collections')
  return ok()
}

/** Add or remove a product. One action, because the UI is a set of toggles. */
export async function toggleCollectionProductAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const input = formDataToObject(formData)
  const collectionId = String(input.collectionId ?? '')
  const productId = String(input.productId ?? '')
  const shouldAdd = String(input.add ?? '') === '1'

  if (!collectionId || !productId) return fail('validation_error', 'Missing ids.')

  if (shouldAdd) {
    await db
      .insert(schema.collectionProducts)
      .values({ collectionId, productId })
      .onConflictDoNothing()
  } else {
    await db
      .delete(schema.collectionProducts)
      .where(
        and(
          eq(schema.collectionProducts.collectionId, collectionId),
          eq(schema.collectionProducts.productId, productId),
        ),
      )
  }

  await recordAuditEvent({
    event: 'COLLECTION_UPDATED',
    userId: admin.id,
    entityType: 'collection',
    entityId: collectionId,
    summary: `${shouldAdd ? 'Added' : 'Removed'} product ${productId}`,
  })

  revalidateStorefront()
  revalidatePath('/admin/collections')
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

export async function saveBadgeAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const parsed = parseInput(badgeSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { id, ...values } = parsed.data

  let badgeId = id
  try {
    if (id) {
      await db.update(schema.badges).set(withUpdatedAt(values)).where(eq(schema.badges.id, id))
    } else {
      const [created] = await db
        .insert(schema.badges)
        .values(values)
        .returning({ id: schema.badges.id })
      badgeId = created.id
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail('conflict', 'That slug is already in use.', { slug: ['Already in use'] })
    }
    throw error
  }

  await recordAuditEvent({
    event: id ? 'BADGE_UPDATED' : 'BADGE_CREATED',
    userId: admin.id,
    entityType: 'badge',
    entityId: badgeId,
    summary: `"${values.label}"`,
  })

  revalidateStorefront()
  revalidatePath('/admin/badges')
  return ok()
}

export async function toggleProductBadgeAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const input = formDataToObject(formData)
  const productId = String(input.productId ?? '')
  const badgeId = String(input.badgeId ?? '')
  const shouldAdd = String(input.add ?? '') === '1'

  if (!productId || !badgeId) return fail('validation_error', 'Missing ids.')

  if (shouldAdd) {
    await db.insert(schema.productBadges).values({ productId, badgeId }).onConflictDoNothing()
  } else {
    await db
      .delete(schema.productBadges)
      .where(
        and(
          eq(schema.productBadges.productId, productId),
          eq(schema.productBadges.badgeId, badgeId),
        ),
      )
  }

  await recordAuditEvent({
    event: 'PRODUCT_BADGED',
    userId: admin.id,
    entityType: 'product',
    entityId: productId,
    summary: `${shouldAdd ? 'Added' : 'Removed'} badge ${badgeId}`,
  })

  revalidateStorefront()
  revalidatePath('/admin/badges')
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Homepage                                                                    */
/* -------------------------------------------------------------------------- */

export async function saveHomepageSectionAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const parsed = parseInput(sectionSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { id, ...values } = parsed.data

  if (!windowIsValid(values.publishAt, values.unpublishAt)) {
    return fail('validation_error', 'The end date must be after the start date.')
  }

  let sectionId = id
  if (id) {
    await db
      .update(schema.homepageSections)
      .set(withUpdatedAt(values))
      .where(eq(schema.homepageSections.id, id))
  } else {
    const [created] = await db
      .insert(schema.homepageSections)
      .values(values)
      .returning({ id: schema.homepageSections.id })
    sectionId = created.id
  }

  await recordAuditEvent({
    event:
      values.type === 'hero'
        ? 'HERO_UPDATED'
        : becomesLive(values.status)
          ? 'HOMEPAGE_SECTION_PUBLISHED'
          : 'HOMEPAGE_SECTION_UPDATED',
    userId: admin.id,
    entityType: 'homepage_section',
    entityId: sectionId,
    summary: `${values.type} "${values.name}" → ${values.status}`,
  })

  revalidatePath('/')
  revalidatePath('/admin/homepage')
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Media library                                                               */
/* -------------------------------------------------------------------------- */

const mediaSchema = z.object({
  id: z.uuid().optional(),
  url: z.string().trim().min(1, 'Enter a URL').max(4000),
  altText: z.string().trim().max(255).default(''),
  title: optionalText(160),
  focalX: z.coerce.number().min(0).max(1).default(0.5),
  focalY: z.coerce.number().min(0).max(1).default(0.5),
})

export async function saveMediaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const parsed = parseInput(mediaSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { id, focalX, focalY, ...values } = parsed.data

  const payload = {
    ...values,
    focalX: focalX.toFixed(3),
    focalY: focalY.toFixed(3),
  }

  let mediaId = id
  if (id) {
    await db.update(schema.media).set(withUpdatedAt(payload)).where(eq(schema.media.id, id))
  } else {
    const [created] = await db
      .insert(schema.media)
      .values(payload)
      .returning({ id: schema.media.id })
    mediaId = created.id
  }

  await recordAuditEvent({
    event: id ? 'MEDIA_REPLACED' : 'MEDIA_UPLOADED',
    userId: admin.id,
    entityType: 'media',
    entityId: mediaId,
    summary: values.title ?? values.altText ?? 'media',
  })

  revalidatePath('/admin/media')
  return ok()
}

/**
 * Replace an asset.
 *
 * Inserts a NEW row and points the old one at it rather than mutating the URL
 * in place. History stays resolvable — what a campaign showed last month is
 * still answerable — and a bad replacement can be undone.
 */
export async function replaceMediaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const input = formDataToObject(formData)
  const originalId = String(input.id ?? '')
  const url = String(input.url ?? '').trim()
  if (!originalId || !url) return fail('validation_error', 'Missing asset or URL.')

  const [original] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.id, originalId))
    .limit(1)
  if (!original) return fail('not_found', 'That asset no longer exists.')

  const [replacement] = await db
    .insert(schema.media)
    .values({
      url,
      altText: original.altText,
      title: original.title,
      focalX: original.focalX,
      focalY: original.focalY,
      width: original.width,
      height: original.height,
      mimeType: original.mimeType,
    })
    .returning({ id: schema.media.id })

  await db
    .update(schema.media)
    .set(withUpdatedAt({ replacedByMediaId: replacement.id, archivedAt: new Date() }))
    .where(eq(schema.media.id, originalId))

  await recordAuditEvent({
    event: 'MEDIA_REPLACED',
    userId: admin.id,
    entityType: 'media',
    entityId: originalId,
    summary: `Replaced by ${replacement.id}`,
  })

  revalidatePath('/admin/media')
  revalidateStorefront()
  return ok()
}

export async function archiveMediaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const admin = await requireAdmin()

  const id = String(formDataToObject(formData).id ?? '')
  if (!id) return fail('validation_error', 'Missing asset.')

  /**
   * Refuse to archive an asset still in use. The reference is `set null`, so
   * archiving would silently blank a live hero rather than fail — better to say
   * so than to let the homepage lose its image quietly.
   */
  const [{ uses }] = await db
    .select({
      uses: sql<number>`(
        (select count(*) from ${schema.productMedia} pm where pm.media_id = ${id})
      + (select count(*) from ${schema.campaigns} c where c.hero_media_id = ${id} and c.deleted_at is null)
      + (select count(*) from ${schema.collections} col where col.hero_media_id = ${id} and col.deleted_at is null)
      )::int`,
    })
    .from(schema.media)
    .where(eq(schema.media.id, id))
    .limit(1)

  if (uses > 0) {
    return fail(
      'conflict',
      `This asset is used in ${uses} place${uses === 1 ? '' : 's'}. Replace it there first.`,
    )
  }

  await db
    .update(schema.media)
    .set(withUpdatedAt({ archivedAt: new Date() }))
    .where(eq(schema.media.id, id))

  await recordAuditEvent({
    event: 'MEDIA_ARCHIVED',
    userId: admin.id,
    entityType: 'media',
    entityId: id,
  })

  revalidatePath('/admin/media')
  return ok()
}
