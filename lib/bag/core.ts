import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { cookies } from 'next/headers'

import { db, schema } from '@/lib/db'

/**
 * Bag identity and reads.
 *
 * GUEST IDENTITY. A guest bag is addressed by an opaque 256-bit token held in a
 * cookie; the database stores only its SHA-256. Three properties follow, and
 * all three matter:
 *
 *   - Nothing sequential or enumerable is ever exposed. The cart's primary key
 *     is a UUID and never leaves the server; the client only ever holds a
 *     random token that maps to it.
 *   - A database disclosure leaks no bags, because the stored hash cannot be
 *     replayed as a cookie.
 *   - A forged or tampered token simply resolves to nothing. There is no
 *     signature to verify and no failure mode where a bad token becomes
 *     *someone else's* bag — it is a lookup miss, and the visitor gets an empty
 *     bag.
 *
 * PRICE AUTHORITY. Nothing here reads a price from the client, because the
 * client never sends one. Line rows hold a variant id and a quantity; every
 * price and subtotal on this page is computed from `product_variants` at render
 * time. There is no field a tampered request could target.
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

/**
 * `__Host-` in production: the browser refuses the cookie unless it is Secure,
 * path=/, and carries no Domain — closing off subdomain cookie injection. Falls
 * back in development because the prefix requires HTTPS.
 */
export const BAG_COOKIE = IS_PRODUCTION ? '__Host-cloudmarket_bag' : 'cloudmarket_bag'

/** Guest bags live 30 days of inactivity. Long enough to be useful, short
 *  enough that abandoned guest rows do not accumulate forever. */
const GUEST_BAG_TTL_MS = 30 * 24 * 60 * 60 * 1000

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const newToken = () => randomBytes(32).toString('base64url')

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** Reads the guest token from the cookie. Never creates one. */
async function readGuestToken(): Promise<string | null> {
  const store = await cookies()
  return store.get(BAG_COOKIE)?.value ?? null
}

async function setGuestCookie(token: string) {
  const store = await cookies()
  store.set(BAG_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    expires: new Date(Date.now() + GUEST_BAG_TTL_MS),
  })
}

export async function clearGuestCookie() {
  const store = await cookies()
  store.delete(BAG_COOKIE)
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Finds the viewer's active bag WITHOUT creating one.
 *
 * Used by every read path. Browsing must never write — a bag row created by a
 * page view is a row nobody asked for, and on a crawled storefront that is a
 * lot of rows.
 */
export async function findActiveBag(
  userId: string | null,
): Promise<schema.Cart | null> {
  if (userId) {
    const [row] = await db
      .select()
      .from(schema.carts)
      .where(and(eq(schema.carts.userId, userId), eq(schema.carts.status, 'active')))
      .limit(1)
    return row ?? null
  }

  const token = await readGuestToken()
  if (!token) return null

  const [row] = await db
    .select()
    .from(schema.carts)
    .where(
      and(
        eq(schema.carts.guestTokenHash, hashToken(token)),
        eq(schema.carts.status, 'active'),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Finds or creates the viewer's active bag. Only ever called from a mutation.
 *
 * CONCURRENCY. Two simultaneous "add to bag" clicks from the same signed-in
 * customer would both find no bag and both try to create one. The partial
 * unique index `carts_one_active_per_user` makes that a database-level race the
 * database resolves: one insert wins, the loser's `ON CONFLICT DO NOTHING`
 * returns no row, and it re-reads the winner. No application locking, and no
 * window in which a customer can end up with two active bags.
 */
export async function findOrCreateBag(userId: string | null): Promise<schema.Cart> {
  const existing = await findActiveBag(userId)
  if (existing) return existing

  if (userId) {
    const [created] = await db
      .insert(schema.carts)
      .values({ userId, status: 'active' })
      .onConflictDoNothing()
      .returning()

    if (created) return created

    // Lost the race — the winner's row is now committed.
    const [winner] = await db
      .select()
      .from(schema.carts)
      .where(and(eq(schema.carts.userId, userId), eq(schema.carts.status, 'active')))
      .limit(1)
    return winner
  }

  const token = newToken()
  const [created] = await db
    .insert(schema.carts)
    .values({ guestTokenHash: hashToken(token), status: 'active' })
    .returning()

  await setGuestCookie(token)
  return created
}

/** Marks activity. Drives guest expiry and future abandoned-bag recovery. */
export async function touchBag(cartId: string) {
  await db
    .update(schema.carts)
    .set({ lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.carts.id, cartId))
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export type BagLine = {
  lineId: string
  variantId: string
  quantity: number
  /** Live, from the catalog. Never stored on the line. */
  unitPriceCents: number
  lineTotalCents: number
  compareAtPriceCents: number | null
  label: string
  sku: string
  productName: string
  productSlug: string
  categoryName: string
  imageUrl: string | null
  /** Stock at read time. Advisory only — nothing is reserved. */
  availableQuantity: number
  /** The line cannot be purchased as it stands. */
  isUnavailable: boolean
  unavailableReason: 'out_of_stock' | 'insufficient_stock' | 'discontinued' | null
}

export type BagView = {
  cartId: string | null
  lines: BagLine[]
  itemCount: number
  subtotalCents: number
  hasIssues: boolean
}

const EMPTY_BAG: BagView = {
  cartId: null,
  lines: [],
  itemCount: 0,
  subtotalCents: 0,
  hasIssues: false,
}

/**
 * The bag, priced live.
 *
 * ONE query joins lines to variants, products, categories and the primary
 * image. Subtotal is summed in application code from those live prices, so a
 * price change in the catalog is reflected the next time the bag is rendered —
 * with no reconciliation step, because nothing was ever snapshotted.
 *
 * A line whose product has been unpublished or whose variant retired is not
 * silently dropped: it is returned marked `discontinued`, so the customer is
 * told rather than quietly having their bag edited underneath them.
 */
export async function getBag(userId: string | null): Promise<BagView> {
  const cart = await findActiveBag(userId)
  if (!cart) return EMPTY_BAG

  const rows = await db
    .select({
      lineId: schema.cartLines.id,
      quantity: schema.cartLines.quantity,
      variantId: schema.productVariants.id,
      unitPriceCents: schema.productVariants.priceCents,
      compareAtPriceCents: schema.productVariants.compareAtPriceCents,
      label: schema.productVariants.label,
      sku: schema.productVariants.sku,
      inventoryQuantity: schema.productVariants.inventoryQuantity,
      variantActive: schema.productVariants.active,
      variantDeletedAt: schema.productVariants.deletedAt,
      productName: schema.products.name,
      productSlug: schema.products.slug,
      productStatus: schema.products.status,
      productDeletedAt: schema.products.deletedAt,
      categoryName: schema.categories.name,
    })
    .from(schema.cartLines)
    .innerJoin(
      schema.productVariants,
      eq(schema.cartLines.variantId, schema.productVariants.id),
    )
    .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
    .innerJoin(schema.categories, eq(schema.products.categoryId, schema.categories.id))
    .where(eq(schema.cartLines.cartId, cart.id))
    .orderBy(asc(schema.cartLines.createdAt))

  /**
   * `inArray`, not a hand-written `any(...)`. Interpolating a JS array into raw
   * SQL sends it as a string and Postgres rejects it with "malformed array
   * literal" — which threw the whole bag page. Drizzle's helper emits a proper
   * parameterised list.
   */
  const productSlugs = [...new Set(rows.map((row) => row.productSlug))]
  const images = productSlugs.length
    ? await db
        .select({
          slug: schema.products.slug,
          url: schema.media.url,
          isPrimary: schema.productMedia.isPrimary,
        })
        .from(schema.productMedia)
        .innerJoin(schema.media, eq(schema.productMedia.mediaId, schema.media.id))
        .innerJoin(schema.products, eq(schema.productMedia.productId, schema.products.id))
        .where(inArray(schema.products.slug, productSlugs))
        .orderBy(desc(schema.productMedia.isPrimary))
    : []

  const imageBySlug = new Map<string, string>()
  for (const image of images) {
    if (!imageBySlug.has(image.slug)) imageBySlug.set(image.slug, image.url)
  }

  const lines: BagLine[] = rows.map((row) => {
    const purchasable =
      row.variantActive &&
      row.variantDeletedAt === null &&
      row.productStatus === 'active' &&
      row.productDeletedAt === null

    let reason: BagLine['unavailableReason'] = null
    if (!purchasable) reason = 'discontinued'
    else if (row.inventoryQuantity === 0) reason = 'out_of_stock'
    else if (row.inventoryQuantity < row.quantity) reason = 'insufficient_stock'

    return {
      lineId: row.lineId,
      variantId: row.variantId,
      quantity: row.quantity,
      unitPriceCents: row.unitPriceCents,
      lineTotalCents: row.unitPriceCents * row.quantity,
      compareAtPriceCents: row.compareAtPriceCents,
      label: row.label,
      sku: row.sku,
      productName: row.productName,
      productSlug: row.productSlug,
      categoryName: row.categoryName,
      imageUrl: imageBySlug.get(row.productSlug) ?? null,
      availableQuantity: purchasable ? row.inventoryQuantity : 0,
      isUnavailable: reason !== null,
      unavailableReason: reason,
    }
  })

  return {
    cartId: cart.id,
    lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    /**
     * Unavailable lines are excluded from the subtotal. Charging for something
     * that cannot ship would be the wrong default, and showing a total the
     * customer cannot actually pay is worse than showing a smaller one.
     */
    subtotalCents: lines
      .filter((line) => !line.isUnavailable)
      .reduce((sum, line) => sum + line.lineTotalCents, 0),
    hasIssues: lines.some((line) => line.isUnavailable),
  }
}

/** Cheap count for the header badge — no joins, no pricing. */
export async function getBagCount(userId: string | null): Promise<number> {
  const cart = await findActiveBag(userId)
  if (!cart) return 0

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.cartLines.quantity}), 0)::int` })
    .from(schema.cartLines)
    .where(eq(schema.cartLines.cartId, cart.id))

  return row?.total ?? 0
}

/**
 * Resolves a variant for a write, returning null when it must not be added.
 *
 * The single place that decides purchasability. Every mutation goes through it,
 * so "is this variant real, live, and in stock" is answered identically for add,
 * update and merge.
 */
export async function resolvePurchasableVariant(variantId: string) {
  const [row] = await db
    .select({
      id: schema.productVariants.id,
      priceCents: schema.productVariants.priceCents,
      inventoryQuantity: schema.productVariants.inventoryQuantity,
      label: schema.productVariants.label,
      productName: schema.products.name,
      cannabisClass: schema.productVariants.cannabisClass,
      measurementBasis: schema.productVariants.measurementBasis,
      measurementValue: schema.productVariants.measurementValue,
    })
    .from(schema.productVariants)
    .where(
      and(
        eq(schema.productVariants.id, variantId),
        eq(schema.productVariants.active, true),
        isNull(schema.productVariants.deletedAt),
        eq(schema.products.status, 'active'),
        isNull(schema.products.deletedAt),
      ),
    )
    .innerJoin(schema.products, eq(schema.productVariants.productId, schema.products.id))
    .limit(1)

  return row ?? null
}
