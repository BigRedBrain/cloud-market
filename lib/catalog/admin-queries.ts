import 'server-only'

import { asc, desc, eq, isNull, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import { mediaHref } from '@/lib/media/constants'

/**
 * Admin catalogue reads.
 *
 * Separate from `queries.ts` on purpose. The public layer hard-codes
 * `status = 'active'`; admin must see drafts and archives. Keeping the two in
 * one module invites a boolean flag, and a boolean flag is how unreleased
 * product eventually reaches a customer.
 *
 * These are plain async functions, NOT Server Actions — a `'use server'` module
 * turns every export into a callable endpoint, and a list query that accepts an
 * id from the caller is exactly the wrong thing to expose. Callers are Server
 * Components that have already passed `requireAdminIdentity()`.
 */

export async function adminListBrands() {
  return db
    .select({
      id: schema.brands.id,
      slug: schema.brands.slug,
      name: schema.brands.name,
      description: schema.brands.description,
      active: schema.brands.active,
      productCount: sql<number>`(
        select count(*)::int from ${schema.products} p where p.brand_id = ${schema.brands.id}
      )`,
    })
    .from(schema.brands)
    .where(isNull(schema.brands.deletedAt))
    .orderBy(asc(schema.brands.name))
}

export async function adminListCategories() {
  return db
    .select({
      id: schema.categories.id,
      slug: schema.categories.slug,
      name: schema.categories.name,
      description: schema.categories.description,
      sortOrder: schema.categories.sortOrder,
      active: schema.categories.active,
      productCount: sql<number>`(
        select count(*)::int from ${schema.products} p
         where p.category_id = ${schema.categories.id}
      )`,
    })
    .from(schema.categories)
    .where(isNull(schema.categories.deletedAt))
    .orderBy(asc(schema.categories.sortOrder), asc(schema.categories.name))
}

export async function adminListProducts() {
  const rows = await db
    .select({
      id: schema.products.id,
      slug: schema.products.slug,
      name: schema.products.name,
      status: schema.products.status,
      featured: schema.products.featured,
      newArrival: schema.products.newArrival,
      brandName: schema.brands.name,
      categoryName: schema.categories.name,
      updatedAt: schema.products.updatedAt,
      /**
       * Thumbnail for the list, as a correlated subquery rather than a join.
       *
       * A join to `product_media` would multiply product rows by their media
       * rows and silently break the row count this page displays. The subquery
       * mirrors the storefront's own ordering — primary first, then sort order —
       * and excludes video, because a card has no player.
       */
      /**
       * The media ID, not its storage URL — the row is turned into
       * `/api/media/<id>` below. Selecting `m.url` here would put a
       * world-readable address into an admin DTO for no gain; the thumbnail is
       * rendered through the authenticated route like every other asset.
       */
      thumbnailMediaId: sql<string | null>`(
        select m.id from ${schema.productMedia} pm
          join ${schema.media} m on m.id = pm.media_id
         where pm.product_id = ${schema.products.id}
           and m.kind = 'image' and m.archived_at is null
         order by pm.is_primary desc, pm.sort_order asc, pm.created_at asc
         limit 1
      )`,
      thumbnailMimeType: sql<string | null>`(
        select m.mime_type from ${schema.productMedia} pm
          join ${schema.media} m on m.id = pm.media_id
         where pm.product_id = ${schema.products.id}
           and m.kind = 'image' and m.archived_at is null
         order by pm.is_primary desc, pm.sort_order asc, pm.created_at asc
         limit 1
      )`,
      mediaCount: sql<number>`(
        select count(*)::int from ${schema.productMedia} pm
         where pm.product_id = ${schema.products.id}
      )`,
      variantCount: sql<number>`(
        select count(*)::int from ${schema.productVariants} v
         where v.product_id = ${schema.products.id} and v.deleted_at is null
      )`,
      totalStock: sql<number>`(
        select coalesce(sum(v.inventory_quantity), 0)::int from ${schema.productVariants} v
         where v.product_id = ${schema.products.id} and v.deleted_at is null
      )`,
    })
    .from(schema.products)
    .innerJoin(schema.brands, eq(schema.products.brandId, schema.brands.id))
    .innerJoin(schema.categories, eq(schema.products.categoryId, schema.categories.id))
    .where(isNull(schema.products.deletedAt))
    .orderBy(desc(schema.products.updatedAt))

  return rows.map(({ thumbnailMediaId, ...row }) => ({
    ...row,
    thumbnailUrl: thumbnailMediaId === null ? null : mediaHref(thumbnailMediaId),
  }))
}

export async function adminGetProduct(id: string) {
  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, id))
    .limit(1)

  if (!product) return null

  const variants = await db
    .select()
    .from(schema.productVariants)
    .where(
      eq(schema.productVariants.productId, id),
    )
    .orderBy(asc(schema.productVariants.sortOrder))

  return { product, variants: variants.filter((variant) => !variant.deletedAt) }
}
