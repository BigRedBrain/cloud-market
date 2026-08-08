import 'server-only'

import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import type { Product as CardProduct } from '@/components/product-card'
import {
  primaryMediaByProduct,
  productGallery,
  type CardMedia,
  type GalleryItem,
} from '@/lib/media/queries'

/**
 * Catalog read layer.
 *
 * Every public query is filtered to `status = 'active'` and `deleted_at is
 * null` in ONE place. Draft and archived products are invisible to customers
 * because the query cannot express them, not because each page remembers to
 * ask — a page that forgets a `where` clause is how unreleased product leaks.
 *
 * PERFORMANCE. Listing is three round trips regardless of result size:
 *
 *   1. products + brand + category  (joined, filtered, sorted, paginated)
 *   2. variants for those products  (single `where product_id in (...)`)
 *   3. primary media for those products
 *
 * Assembly happens in memory. The obvious alternative — fetching variants per
 * product — is an N+1 that turns a 24-product page into 49 queries. The obvious
 * *other* alternative, one big join, multiplies product rows by variant rows and
 * makes pagination wrong.
 */

const PAGE_SIZE = 24

/** Public visibility, expressed once. */
function visibleProduct() {
  return and(eq(schema.products.status, 'active'), isNull(schema.products.deletedAt))
}

export type CatalogSort = 'featured' | 'newest' | 'price-asc' | 'price-desc' | 'name'

export type CatalogFilters = {
  q?: string
  category?: string
  brand?: string
  strain?: schema.StrainType
  inStockOnly?: boolean
  sort?: CatalogSort
  page?: number
}

export type CatalogListing = {
  products: CardProduct[]
  total: number
  page: number
  pageCount: number
}

type VariantSummary = {
  entryLabel: string
  entryPriceCents: number
  totalStock: number
  variantCount: number
}

/**
 * Aggregates a product's variants into what a card needs.
 *
 * "Entry" is the cheapest active variant — the price a customer sees on the
 * card and the one they expect to find when they open the product.
 */
function summariseVariants(variants: schema.ProductVariant[]): VariantSummary | null {
  const active = variants.filter((variant) => variant.active && !variant.deletedAt)
  if (active.length === 0) return null

  const cheapest = active.reduce((low, variant) =>
    variant.priceCents < low.priceCents ? variant : low,
  )

  return {
    entryLabel: cheapest.label,
    entryPriceCents: cheapest.priceCents,
    totalStock: active.reduce((sum, variant) => sum + variant.inventoryQuantity, 0),
    variantCount: active.length,
  }
}

/**
 * Maps catalogue rows onto the EXISTING ProductCard contract.
 *
 * The design system is frozen, so the card is not changed to suit the data —
 * the data is shaped to suit the card. `category` becomes the eyebrow
 * ("Indica · Flower"), `size` the entry variant's label.
 */
function toCardProduct(
  product: schema.CatalogProduct,
  categoryName: string,
  summary: VariantSummary | null,
  image: CardMedia | undefined,
): CardProduct {
  const strain = product.strainType
    ? product.strainType.charAt(0).toUpperCase() + product.strainType.slice(1)
    : null

  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    category: strain ? `${strain} · ${categoryName}` : categoryName,
    size: summary?.entryLabel ?? '—',
    thcPercent: product.thcPercent ? Number(product.thcPercent) : 0,
    priceCents: summary?.entryPriceCents ?? 0,
    /**
     * The whole asset, not just its URL.
     *
     * The card has to know the MIME type to decide whether the image optimizer
     * is bypassed — a GIF that goes through it comes back as a still. Passing a
     * bare URL, as this did before, made an animated thumbnail impossible.
     */
    image,
    inStock: (summary?.totalStock ?? 0) > 0,
    // Only surface a count when it is low enough to matter on a card.
    stockCount:
      summary && summary.totalStock > 0 && summary.totalStock <= 3
        ? summary.totalStock
        : undefined,
  }
}

function orderBy(sort: CatalogSort) {
  switch (sort) {
    case 'newest':
      return [desc(schema.products.createdAt)]
    case 'name':
      return [asc(schema.products.name)]
    /**
     * Price sorting orders by the product's cheapest active variant, computed
     * as a correlated subquery so it stays correct under pagination.
     */
    case 'price-asc':
      return [asc(cheapestVariantPrice())]
    case 'price-desc':
      return [desc(cheapestVariantPrice())]
    case 'featured':
    default:
      return [desc(schema.products.featured), desc(schema.products.createdAt)]
  }
}

function cheapestVariantPrice() {
  return sql<number>`(
    select min(v.price_cents) from ${schema.productVariants} v
     where v.product_id = ${schema.products.id} and v.active and v.deleted_at is null
  )`
}

/** Free-text search across product name, brand name and category name. */
function searchClause(term: string) {
  const pattern = `%${term.replace(/[%_]/g, (match) => `\\${match}`)}%`
  return or(
    ilike(schema.products.name, pattern),
    ilike(schema.products.shortDescription, pattern),
    ilike(schema.brands.name, pattern),
    ilike(schema.categories.name, pattern),
  )
}

export async function listProducts(filters: CatalogFilters = {}): Promise<CatalogListing> {
  const page = Math.max(1, filters.page ?? 1)
  const sort = filters.sort ?? 'featured'

  const conditions = [visibleProduct()]

  if (filters.q?.trim()) conditions.push(searchClause(filters.q.trim()))
  if (filters.category) conditions.push(eq(schema.categories.slug, filters.category))
  if (filters.brand) conditions.push(eq(schema.brands.slug, filters.brand))
  if (filters.strain) conditions.push(eq(schema.products.strainType, filters.strain))
  if (filters.inStockOnly) {
    conditions.push(sql`(
      select coalesce(sum(v.inventory_quantity), 0) from ${schema.productVariants} v
       where v.product_id = ${schema.products.id} and v.active and v.deleted_at is null
    ) > 0`)
  }

  const where = and(...conditions)

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.products)
    .innerJoin(schema.brands, eq(schema.products.brandId, schema.brands.id))
    .innerJoin(schema.categories, eq(schema.products.categoryId, schema.categories.id))
    .where(where)

  const rows = await db
    .select({
      product: schema.products,
      categoryName: schema.categories.name,
    })
    .from(schema.products)
    .innerJoin(schema.brands, eq(schema.products.brandId, schema.brands.id))
    .innerJoin(schema.categories, eq(schema.products.categoryId, schema.categories.id))
    .where(where)
    .orderBy(...orderBy(sort))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)

  const productIds = rows.map((row) => row.product.id)
  const { variantsByProduct, mediaByProduct } = await loadVariantsAndMedia(productIds)

  return {
    products: rows.map((row) =>
      toCardProduct(
        row.product,
        row.categoryName,
        summariseVariants(variantsByProduct.get(row.product.id) ?? []),
        mediaByProduct.get(row.product.id),
      ),
    ),
    total: count,
    page,
    pageCount: Math.max(1, Math.ceil(count / PAGE_SIZE)),
  }
}

/** Bulk-loads variants and primary images for a page of products. */
async function loadVariantsAndMedia(productIds: string[]) {
  const variantsByProduct = new Map<string, schema.ProductVariant[]>()

  if (productIds.length === 0) {
    return { variantsByProduct, mediaByProduct: new Map<string, CardMedia>() }
  }

  const variants = await db
    .select()
    .from(schema.productVariants)
    .where(
      and(
        inArray(schema.productVariants.productId, productIds),
        isNull(schema.productVariants.deletedAt),
      ),
    )
    .orderBy(asc(schema.productVariants.sortOrder))

  for (const variant of variants) {
    const list = variantsByProduct.get(variant.productId) ?? []
    list.push(variant)
    variantsByProduct.set(variant.productId, list)
  }

  /**
   * Thumbnail selection lives in `lib/media/queries.ts` so that the storefront
   * and the admin cannot drift on which asset a product leads with. It also
   * excludes video in SQL — a card has no player, so a product whose only asset
   * is a video must fall through to the placeholder rather than emit an `<img>`
   * pointing at an MP4.
   */
  const mediaByProduct = await primaryMediaByProduct(productIds)

  return { variantsByProduct, mediaByProduct }
}

export type ProductDetail = {
  product: schema.CatalogProduct
  brand: { slug: string; name: string; description: string | null }
  category: { slug: string; name: string }
  variants: schema.ProductVariant[]
  /**
   * The full gallery — images, GIFs and video, primary first.
   *
   * Renamed from `images` because it is no longer only images, and a name that
   * lies about its contents is how a video ends up in an `<img>` tag.
   */
  media: GalleryItem[]
}

export async function getProductBySlug(slug: string): Promise<ProductDetail | null> {
  const [row] = await db
    .select({
      product: schema.products,
      brandSlug: schema.brands.slug,
      brandName: schema.brands.name,
      brandDescription: schema.brands.description,
      categorySlug: schema.categories.slug,
      categoryName: schema.categories.name,
    })
    .from(schema.products)
    .innerJoin(schema.brands, eq(schema.products.brandId, schema.brands.id))
    .innerJoin(schema.categories, eq(schema.products.categoryId, schema.categories.id))
    .where(and(eq(schema.products.slug, slug), visibleProduct()))
    .limit(1)

  if (!row) return null

  const variants = await db
    .select()
    .from(schema.productVariants)
    .where(
      and(
        eq(schema.productVariants.productId, row.product.id),
        eq(schema.productVariants.active, true),
        isNull(schema.productVariants.deletedAt),
      ),
    )
    .orderBy(asc(schema.productVariants.sortOrder))

  const media = await productGallery(row.product.id)

  return {
    product: row.product,
    brand: { slug: row.brandSlug, name: row.brandName, description: row.brandDescription },
    category: { slug: row.categorySlug, name: row.categoryName },
    variants,
    media,
  }
}

/** Active categories with a live product count, for nav and filter chips. */
export async function listCategoriesWithCounts() {
  return db
    .select({
      slug: schema.categories.slug,
      name: schema.categories.name,
      description: schema.categories.description,
      sortOrder: schema.categories.sortOrder,
      productCount: sql<number>`(
        select count(*)::int from ${schema.products} p
         where p.category_id = ${schema.categories.id}
           and p.status = 'active' and p.deleted_at is null
      )`,
    })
    .from(schema.categories)
    .where(and(eq(schema.categories.active, true), isNull(schema.categories.deletedAt)))
    .orderBy(asc(schema.categories.sortOrder), asc(schema.categories.name))
}

export async function getCategoryBySlug(slug: string) {
  const [row] = await db
    .select()
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.slug, slug),
        eq(schema.categories.active, true),
        isNull(schema.categories.deletedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function listActiveBrands() {
  return db
    .select({ slug: schema.brands.slug, name: schema.brands.name })
    .from(schema.brands)
    .where(and(eq(schema.brands.active, true), isNull(schema.brands.deletedAt)))
    .orderBy(asc(schema.brands.name))
}

/** Homepage strip. Featured, in stock, newest first. */
export async function listFeaturedProducts(limit = 3): Promise<CardProduct[]> {
  const listing = await listProducts({ sort: 'featured', inStockOnly: false })
  return listing.products.slice(0, limit)
}
