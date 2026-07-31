import 'server-only'

import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import { db, schema } from '@/lib/db'
import type { Product as CardProduct } from '@/components/product-card'

/**
 * CMS read layer.
 *
 * ONE definition of "live", used by every surface. A second, slightly different
 * copy of this predicate is exactly how a campaign ends up visible on the
 * homepage and invisible on a collection page.
 */

type Publishable = {
  status: PgColumn
  publishAt: PgColumn
  unpublishAt: PgColumn
  deletedAt: PgColumn
}

/**
 * Is this record live *right now*?
 *
 * Computed at read time from the publishing window rather than stored as a
 * flag. That is what makes scheduled publishing work with no cron and no
 * worker: a campaign scheduled for Friday 9am simply starts matching this
 * predicate at 9am, and stops matching when its window closes. There is no
 * second source of truth to drift, and nothing can get stuck half-published.
 *
 * `now()` is evaluated by Postgres, not Node — so scheduling is correct even if
 * an application server's clock is skewed.
 */
export function livePredicate(table: Publishable) {
  return and(
    or(
      eq(table.status, 'published'),
      and(eq(table.status, 'scheduled'), lte(table.publishAt, sql`now()`)),
    ),
    or(isNull(table.publishAt), lte(table.publishAt, sql`now()`)),
    or(isNull(table.unpublishAt), gt(table.unpublishAt, sql`now()`)),
    isNull(table.deletedAt),
  )
}

/* -------------------------------------------------------------------------- */
/* Campaigns                                                                   */
/* -------------------------------------------------------------------------- */

export type LiveCampaign = {
  id: string
  slug: string
  type: schema.CampaignType
  title: string
  subtitle: string | null
  body: string | null
  ctaLabel: string | null
  ctaHref: string | null
  heroUrl: string | null
  heroAlt: string | null
}

/**
 * The single best live campaign of a type.
 *
 * Highest `priority` wins; the most recently scheduled breaks a tie. Returning
 * one rather than a list is deliberate — a hero slot holds one thing, and
 * forcing the decision here keeps "which promo is showing?" answerable.
 */
export async function getLiveCampaign(
  type: schema.CampaignType,
): Promise<LiveCampaign | null> {
  const [row] = await db
    .select({
      id: schema.campaigns.id,
      slug: schema.campaigns.slug,
      type: schema.campaigns.type,
      title: schema.campaigns.title,
      subtitle: schema.campaigns.subtitle,
      body: schema.campaigns.body,
      ctaLabel: schema.campaigns.ctaLabel,
      ctaHref: schema.campaigns.ctaHref,
      heroUrl: schema.media.url,
      heroAlt: schema.media.altText,
    })
    .from(schema.campaigns)
    .leftJoin(schema.media, eq(schema.campaigns.heroMediaId, schema.media.id))
    .where(and(eq(schema.campaigns.type, type), livePredicate(schema.campaigns)))
    .orderBy(desc(schema.campaigns.priority), desc(schema.campaigns.publishAt))
    .limit(1)

  return row ?? null
}

/** The announcement bar is a campaign of type `announcement`. */
export async function getLiveAnnouncement(): Promise<LiveCampaign | null> {
  return getLiveCampaign('announcement')
}

/* -------------------------------------------------------------------------- */
/* Collections                                                                 */
/* -------------------------------------------------------------------------- */

export async function listLiveCollections() {
  return db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      description: schema.collections.description,
      productCount: sql<number>`(
        select count(*)::int from ${schema.collectionProducts} cp
          join ${schema.products} p on p.id = cp.product_id
         where cp.collection_id = ${schema.collections.id}
           and p.status = 'active' and p.deleted_at is null
      )`,
    })
    .from(schema.collections)
    .where(livePredicate(schema.collections))
    .orderBy(desc(schema.collections.priority), asc(schema.collections.name))
}

export async function getLiveCollectionBySlug(slug: string) {
  const [row] = await db
    .select()
    .from(schema.collections)
    .where(and(eq(schema.collections.slug, slug), livePredicate(schema.collections)))
    .limit(1)
  return row ?? null
}

/**
 * Product ids in a collection, in editorial order.
 *
 * Returns ids rather than joining straight to product rows so the caller can
 * reuse the catalog's own card-shaping logic. Merchandising decides the order;
 * the catalog still decides what a product looks like.
 */
export async function getCollectionProductIds(collectionId: string): Promise<string[]> {
  const rows = await db
    .select({ productId: schema.collectionProducts.productId })
    .from(schema.collectionProducts)
    .innerJoin(schema.products, eq(schema.collectionProducts.productId, schema.products.id))
    .where(
      and(
        eq(schema.collectionProducts.collectionId, collectionId),
        eq(schema.products.status, 'active'),
        isNull(schema.products.deletedAt),
      ),
    )
    .orderBy(asc(schema.collectionProducts.sortOrder))

  return rows.map((row) => row.productId)
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

export type ProductBadge = {
  slug: string
  label: string
  icon: string | null
  variant: string
}

/**
 * Badges for a page of products, in ONE query.
 *
 * Keyed by product id so the caller can attach without an N+1. The design
 * system allows one badge per card, so callers take the first — but the data
 * layer returns all of them, because the product page shows more.
 */
export async function getBadgesForProducts(
  productIds: string[],
): Promise<Map<string, ProductBadge[]>> {
  const byProduct = new Map<string, ProductBadge[]>()
  if (productIds.length === 0) return byProduct

  const rows = await db
    .select({
      productId: schema.productBadges.productId,
      slug: schema.badges.slug,
      label: schema.badges.label,
      icon: schema.badges.icon,
      variant: schema.badges.variant,
      sortOrder: schema.productBadges.sortOrder,
      priority: schema.badges.priority,
    })
    .from(schema.productBadges)
    .innerJoin(schema.badges, eq(schema.productBadges.badgeId, schema.badges.id))
    .where(
      and(
        inArray(schema.productBadges.productId, productIds),
        eq(schema.badges.active, true),
        isNull(schema.badges.deletedAt),
      ),
    )
    .orderBy(desc(schema.badges.priority), asc(schema.productBadges.sortOrder))

  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? []
    list.push({ slug: row.slug, label: row.label, icon: row.icon, variant: row.variant })
    byProduct.set(row.productId, list)
  }

  return byProduct
}

/** Maps a badge onto the design system's Badge props. Never invents a colour. */
const ALLOWED_BADGE_VARIANTS = ['volt', 'ember', 'flare', 'cream', 'smoke', 'outline'] as const
export type BadgeVariant = (typeof ALLOWED_BADGE_VARIANTS)[number]

export function toCardBadge(badge: ProductBadge | undefined) {
  if (!badge) return undefined
  const variant = ALLOWED_BADGE_VARIANTS.includes(badge.variant as BadgeVariant)
    ? (badge.variant as BadgeVariant)
    : 'ember'
  return {
    label: badge.icon ? `${badge.icon} ${badge.label}` : badge.label,
    variant: variant as 'ember' | 'flare' | 'volt' | 'cream',
  }
}

/** Attaches the top badge to each card, in one extra query for the whole page. */
export async function withBadges(
  products: CardProduct[],
): Promise<Array<{ product: CardProduct; badge: ReturnType<typeof toCardBadge> }>> {
  const badges = await getBadgesForProducts(products.map((product) => product.id))
  return products.map((product) => ({
    product,
    badge: toCardBadge(badges.get(product.id)?.[0]),
  }))
}

/* -------------------------------------------------------------------------- */
/* Homepage                                                                    */
/* -------------------------------------------------------------------------- */

export type LiveHomepageSection = {
  id: string
  type: schema.HomepageSectionType
  heading: string | null
  eyebrow: string | null
  subheading: string | null
  collectionId: string | null
  campaignId: string | null
  config: Record<string, unknown> | null
}

/**
 * The homepage, as configured.
 *
 * Returns only live sections in editorial order. An empty result is a valid
 * state, not an error — the homepage then falls back to its built-in defaults
 * so an unconfigured install still renders. See `app/page.tsx`.
 */
export async function getLiveHomepageSections(): Promise<LiveHomepageSection[]> {
  return db
    .select({
      id: schema.homepageSections.id,
      type: schema.homepageSections.type,
      heading: schema.homepageSections.heading,
      eyebrow: schema.homepageSections.eyebrow,
      subheading: schema.homepageSections.subheading,
      collectionId: schema.homepageSections.collectionId,
      campaignId: schema.homepageSections.campaignId,
      config: schema.homepageSections.config,
    })
    .from(schema.homepageSections)
    .where(livePredicate(schema.homepageSections))
    .orderBy(asc(schema.homepageSections.sortOrder))
}

/* -------------------------------------------------------------------------- */
/* Brand Studio                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolves a brand asset key to its currently-live media.
 *
 * Scaffolding: nothing renders through this yet. It exists so seasonal artwork
 * can later be swapped by scheduling a second row against the same key, with no
 * deploy.
 */
export async function resolveBrandAsset(key: string) {
  const [row] = await db
    .select({
      key: schema.brandAssets.key,
      name: schema.brandAssets.name,
      url: schema.media.url,
      altText: schema.media.altText,
      focalX: schema.media.focalX,
      focalY: schema.media.focalY,
    })
    .from(schema.brandAssets)
    .leftJoin(schema.media, eq(schema.brandAssets.mediaId, schema.media.id))
    .where(and(eq(schema.brandAssets.key, key), livePredicate(schema.brandAssets)))
    .orderBy(desc(schema.brandAssets.priority))
    .limit(1)

  return row ?? null
}
