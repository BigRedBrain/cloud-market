import 'server-only'

import { asc, desc, eq, isNull, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'

/**
 * Admin CMS reads.
 *
 * Separate from `queries.ts` for the same reason the catalog's are: the public
 * layer hard-codes the liveness window, admin must see drafts, scheduled and
 * archived records. A shared module with a flag is how unpublished content
 * eventually reaches a customer.
 *
 * Plain async functions, not Server Actions — a `'use server'` export is a
 * public endpoint. Callers are Server Components that already passed
 * `requireAdmin()`.
 */

/** Derived so the admin list can show what the storefront will actually do. */
const liveNow = sql<boolean>`(
  (status = 'published' or (status = 'scheduled' and publish_at is not null and publish_at <= now()))
  and (publish_at is null or publish_at <= now())
  and (unpublish_at is null or unpublish_at > now())
  and deleted_at is null
)`

export async function adminListCampaigns() {
  return db
    .select({
      id: schema.campaigns.id,
      slug: schema.campaigns.slug,
      type: schema.campaigns.type,
      title: schema.campaigns.title,
      subtitle: schema.campaigns.subtitle,
      body: schema.campaigns.body,
      ctaLabel: schema.campaigns.ctaLabel,
      ctaHref: schema.campaigns.ctaHref,
      heroMediaId: schema.campaigns.heroMediaId,
      status: schema.campaigns.status,
      publishAt: schema.campaigns.publishAt,
      unpublishAt: schema.campaigns.unpublishAt,
      priority: schema.campaigns.priority,
      liveNow,
    })
    .from(schema.campaigns)
    .where(isNull(schema.campaigns.deletedAt))
    .orderBy(desc(schema.campaigns.priority), desc(schema.campaigns.updatedAt))
}

export async function adminListCollections() {
  return db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      description: schema.collections.description,
      status: schema.collections.status,
      publishAt: schema.collections.publishAt,
      unpublishAt: schema.collections.unpublishAt,
      priority: schema.collections.priority,
      liveNow,
      productCount: sql<number>`(
        select count(*)::int from ${schema.collectionProducts} cp
         where cp.collection_id = ${schema.collections.id}
      )`,
    })
    .from(schema.collections)
    .where(isNull(schema.collections.deletedAt))
    .orderBy(desc(schema.collections.priority), asc(schema.collections.name))
}

export async function adminListBadges() {
  return db
    .select({
      id: schema.badges.id,
      slug: schema.badges.slug,
      label: schema.badges.label,
      icon: schema.badges.icon,
      variant: schema.badges.variant,
      description: schema.badges.description,
      active: schema.badges.active,
      priority: schema.badges.priority,
      productCount: sql<number>`(
        select count(*)::int from ${schema.productBadges} pb
         where pb.badge_id = ${schema.badges.id}
      )`,
    })
    .from(schema.badges)
    .where(isNull(schema.badges.deletedAt))
    .orderBy(desc(schema.badges.priority), asc(schema.badges.label))
}

export async function adminListHomepageSections() {
  return db
    .select({
      id: schema.homepageSections.id,
      type: schema.homepageSections.type,
      name: schema.homepageSections.name,
      heading: schema.homepageSections.heading,
      eyebrow: schema.homepageSections.eyebrow,
      subheading: schema.homepageSections.subheading,
      campaignId: schema.homepageSections.campaignId,
      collectionId: schema.homepageSections.collectionId,
      sortOrder: schema.homepageSections.sortOrder,
      status: schema.homepageSections.status,
      publishAt: schema.homepageSections.publishAt,
      unpublishAt: schema.homepageSections.unpublishAt,
      priority: schema.homepageSections.priority,
      liveNow,
    })
    .from(schema.homepageSections)
    .where(isNull(schema.homepageSections.deletedAt))
    .orderBy(asc(schema.homepageSections.sortOrder))
}

export async function adminListMedia() {
  return db
    .select({
      id: schema.media.id,
      url: schema.media.url,
      title: schema.media.title,
      altText: schema.media.altText,
      focalX: schema.media.focalX,
      focalY: schema.media.focalY,
      width: schema.media.width,
      height: schema.media.height,
      archivedAt: schema.media.archivedAt,
      replacedByMediaId: schema.media.replacedByMediaId,
      usageCount: sql<number>`(
        (select count(*) from ${schema.productMedia} pm where pm.media_id = ${schema.media.id})
      + (select count(*) from ${schema.campaigns} c where c.hero_media_id = ${schema.media.id})
      + (select count(*) from ${schema.collections} col where col.hero_media_id = ${schema.media.id})
      )::int`,
    })
    .from(schema.media)
    .orderBy(desc(schema.media.createdAt))
    .limit(200)
}

export async function adminListBrandAssets() {
  return db
    .select({
      id: schema.brandAssets.id,
      key: schema.brandAssets.key,
      name: schema.brandAssets.name,
      assetType: schema.brandAssets.assetType,
      mediaId: schema.brandAssets.mediaId,
      status: schema.brandAssets.status,
      priority: schema.brandAssets.priority,
      liveNow,
    })
    .from(schema.brandAssets)
    .where(isNull(schema.brandAssets.deletedAt))
    .orderBy(asc(schema.brandAssets.key))
}

/** Recent CMS activity, for the admin overview. */
export async function adminListRecentCmsAudit(limit = 25) {
  return db
    .select({
      id: schema.auditLog.id,
      occurredAt: schema.auditLog.occurredAt,
      event: schema.auditLog.event,
      entityType: schema.auditLog.entityType,
      summary: schema.auditLog.summary,
      userEmail: schema.users.email,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.auditLog.userId, schema.users.id))
    .where(sql`${schema.auditLog.entityType} is not null`)
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(limit)
}

/** Every product, for collection and badge assignment pickers. */
export async function adminListProductsForPicker() {
  return db
    .select({
      id: schema.products.id,
      name: schema.products.name,
      status: schema.products.status,
    })
    .from(schema.products)
    .where(isNull(schema.products.deletedAt))
    .orderBy(asc(schema.products.name))
}

export async function adminGetCollectionProductIds(collectionId: string) {
  const rows = await db
    .select({ productId: schema.collectionProducts.productId })
    .from(schema.collectionProducts)
    .where(eq(schema.collectionProducts.collectionId, collectionId))
  return new Set(rows.map((row) => row.productId))
}

export async function adminGetProductBadgeIds(productId: string) {
  const rows = await db
    .select({ badgeId: schema.productBadges.badgeId })
    .from(schema.productBadges)
    .where(eq(schema.productBadges.productId, productId))
  return new Set(rows.map((row) => row.badgeId))
}
