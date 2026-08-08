import 'server-only'

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import { mediaHref } from './constants'

/**
 * Product media reads.
 *
 * Ordering is stated once, here, and every caller inherits it: primary first,
 * then `sort_order`, then `created_at` as the tie-break. Without that last term
 * two assets sharing a sort order swap places between requests, which reads as
 * a bug on a page that is supposed to be stable.
 *
 * EVERY `url` THESE FUNCTIONS RETURN IS `/api/media/<id>`, NOT THE STORAGE URL.
 *
 * That substitution is made here, in the query layer, and not in each component,
 * because the property being protected is "the storage address never reaches a
 * browser" — and a property enforced at twenty call sites is a property that
 * survives until somebody adds the twenty-first. A DTO built from these
 * functions cannot leak an address it was never given. The storage URL is read
 * back from the database only by `lib/media/serve.ts` and by the delete path,
 * both of which are server-only.
 */

/** Primary first, then explicit order, then oldest first. */
const GALLERY_ORDER = [
  desc(schema.productMedia.isPrimary),
  asc(schema.productMedia.sortOrder),
  asc(schema.productMedia.createdAt),
] as const

export type GalleryItem = {
  /** The `product_media` row id — what reorder and detach act on. */
  id: string
  mediaId: string
  /** `/api/media/<mediaId>` — the authenticated route, never the storage URL. */
  url: string
  kind: schema.MediaKind
  mimeType: string | null
  /** Placement override resolved against the asset's own alt text. */
  altText: string
  caption: string | null
  width: number | null
  height: number | null
  durationSeconds: string | null
  isPrimary: boolean
  sortOrder: number
}

export type AdminGalleryItem = GalleryItem & {
  title: string | null
  bytes: number | null
  storageKey: string | null
  /** Placement alt as stored — null means "inherits", which the UI shows. */
  altTextOverride: string | null
  assetAltText: string
  /** How many OTHER records point at this asset. Drives delete safety. */
  otherUsageCount: number
}

/**
 * Columns shared by both projections.
 *
 * `media.url` is deliberately ABSENT. The projections below build their `url`
 * from `mediaId`; selecting the storage column here would put it one spread
 * operator away from every DTO that leaves the server.
 */
const baseColumns = {
  id: schema.productMedia.id,
  mediaId: schema.media.id,
  kind: schema.media.kind,
  mimeType: schema.media.mimeType,
  caption: schema.productMedia.caption,
  width: schema.media.width,
  height: schema.media.height,
  durationSeconds: schema.media.durationSeconds,
  isPrimary: schema.productMedia.isPrimary,
  sortOrder: schema.productMedia.sortOrder,
} as const

/**
 * Counts references to an asset from everywhere EXCEPT the placement in hand.
 *
 * `brand_assets`, `campaigns` and `collections` all point at `media` too, so
 * "is anything else using this?" is a four-way question. Getting it wrong in the
 * permissive direction deletes an image out from under a live campaign, which is
 * why permanent deletion refuses on any non-zero count.
 */
function otherUsageCount() {
  return sql<number>`(
      (select count(*) from ${schema.productMedia} pm
        where pm.media_id = ${schema.media.id}
          and pm.id <> ${schema.productMedia.id})
    + (select count(*) from ${schema.campaigns} c where c.hero_media_id = ${schema.media.id})
    + (select count(*) from ${schema.collections} col where col.hero_media_id = ${schema.media.id})
    + (select count(*) from ${schema.brandAssets} ba where ba.media_id = ${schema.media.id})
    + (select count(*) from ${schema.brands} b where b.logo_media_id = ${schema.media.id})
  )::int`
}

/** Public gallery for one product. */
export async function productGallery(productId: string): Promise<GalleryItem[]> {
  const rows = await db
    .select({
      ...baseColumns,
      altTextOverride: schema.productMedia.altTextOverride,
      assetAltText: schema.media.altText,
    })
    .from(schema.productMedia)
    .innerJoin(schema.media, eq(schema.productMedia.mediaId, schema.media.id))
    .where(eq(schema.productMedia.productId, productId))
    .orderBy(...GALLERY_ORDER)

  return rows.map(({ altTextOverride, assetAltText, ...row }) => ({
    ...row,
    url: mediaHref(row.mediaId),
    altText: altTextOverride ?? assetAltText,
  }))
}

/** Everything the product editor needs, including deletion safety counts. */
export async function adminProductGallery(productId: string): Promise<AdminGalleryItem[]> {
  const rows = await db
    .select({
      ...baseColumns,
      title: schema.media.title,
      bytes: schema.media.bytes,
      storageKey: schema.media.storageKey,
      altTextOverride: schema.productMedia.altTextOverride,
      assetAltText: schema.media.altText,
      otherUsageCount: otherUsageCount(),
    })
    .from(schema.productMedia)
    .innerJoin(schema.media, eq(schema.productMedia.mediaId, schema.media.id))
    .where(eq(schema.productMedia.productId, productId))
    .orderBy(...GALLERY_ORDER)

  return rows.map((row) => ({
    ...row,
    url: mediaHref(row.mediaId),
    altText: row.altTextOverride ?? row.assetAltText,
  }))
}

/**
 * Primary media for a page of products, for cards.
 *
 * Returns the ASSET, not just its URL, because the card has to know whether it
 * is holding a GIF — that decides whether the image optimizer is bypassed. The
 * previous implementation selected `url` alone, which is exactly why a GIF
 * thumbnail could not have worked before this change.
 *
 * Video is excluded in SQL rather than filtered afterwards: a product whose only
 * asset is a video must fall through to the placeholder, and doing that in the
 * query means a card can never receive an unplayable `<img src="…mp4">`.
 */
export type CardMedia = {
  url: string
  mimeType: string | null
  altText: string
  width: number | null
  height: number | null
}

export async function primaryMediaByProduct(
  productIds: readonly string[],
): Promise<Map<string, CardMedia>> {
  const byProduct = new Map<string, CardMedia>()
  if (productIds.length === 0) return byProduct

  const rows = await db
    .select({
      productId: schema.productMedia.productId,
      mediaId: schema.media.id,
      mimeType: schema.media.mimeType,
      width: schema.media.width,
      height: schema.media.height,
      altTextOverride: schema.productMedia.altTextOverride,
      assetAltText: schema.media.altText,
    })
    .from(schema.productMedia)
    .innerJoin(schema.media, eq(schema.productMedia.mediaId, schema.media.id))
    .where(
      and(
        inArray(schema.productMedia.productId, [...productIds]),
        eq(schema.media.kind, 'image'),
        isNull(schema.media.archivedAt),
      ),
    )
    .orderBy(...GALLERY_ORDER)

  for (const row of rows) {
    // Ordered primary-first, so the first row for a product wins.
    if (byProduct.has(row.productId)) continue
    byProduct.set(row.productId, {
      url: mediaHref(row.mediaId),
      mimeType: row.mimeType,
      altText: row.altTextOverride ?? row.assetAltText,
      width: row.width,
      height: row.height,
    })
  }

  return byProduct
}

/**
 * The media library picker: assets not already on this product.
 *
 * Excludes archived assets and anything already attached, so "choose from
 * library" cannot produce a duplicate that the unique index would reject a
 * moment later with an opaque error.
 */
export async function libraryAssetsForPicker(productId: string, limit = 120) {
  const rows = await db
    .select({
      id: schema.media.id,
      kind: schema.media.kind,
      mimeType: schema.media.mimeType,
      title: schema.media.title,
      altText: schema.media.altText,
      width: schema.media.width,
      height: schema.media.height,
      bytes: schema.media.bytes,
      durationSeconds: schema.media.durationSeconds,
    })
    .from(schema.media)
    .where(
      and(
        isNull(schema.media.archivedAt),
        sql`not exists (
          select 1 from ${schema.productMedia} pm
           where pm.media_id = ${schema.media.id}
             and pm.product_id = ${productId}
        )`,
      ),
    )
    .orderBy(desc(schema.media.createdAt))
    .limit(limit)

  return rows.map((row) => ({ ...row, url: mediaHref(row.id) }))
}
