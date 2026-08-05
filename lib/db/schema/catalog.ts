import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn, softDeleteColumns, timestampColumns } from './_shared'

/**
 * Catalog schema — brands, categories, products, variants, media.
 *
 * Two structural rules drive the whole design:
 *
 *  1. **A product is a thing; a variant is the thing you buy.** Price, SKU,
 *     weight and inventory live on the variant, never on the product. A strain
 *     sold in five weights is one product and five variants, so a price change
 *     at 3.5g cannot silently move the 28g price.
 *
 *  2. **Images are records, not columns.** Products reference `media` through a
 *     join table, so one photograph can appear on several products, carry its
 *     own alt text and dimensions, and be reordered without touching the
 *     product row.
 *
 * FUTURE COMPATIBILITY. These are not implemented, but nothing here blocks
 * them:
 *
 *  - *Discounts* — money is integer cents on the variant, and `compareAtPrice`
 *    already models a strike-through. A `discounts` table can target a product,
 *    variant or category without altering these tables.
 *  - *Bundles* — a bundle becomes a product whose variants map to component
 *    variants through a `bundle_items` join. Nothing here assumes a variant has
 *    exactly one physical item.
 *  - *Loyalty* — lives on the customer, not the catalog.
 *  - *Multiple store locations* — `inventory_quantity` on the variant is the
 *    single-location quantity the brief specifies. Multi-location becomes
 *    `inventory_levels(variant_id, store_id, quantity)`, backfilled from this
 *    column. That is an additive migration, not a redesign, and `stores`
 *    already exists to point at.
 *  - *Wholesale pricing* — `price_tiers(variant_id, customer_group, price)`
 *    layered over the variant's list price.
 */

/** draft is invisible to customers; archived is retired but retained. */
export const productStatus = pgEnum('product_status', ['draft', 'active', 'archived'])

/**
 * Nullable on the product, because accessories and apparel legitimately have no
 * strain. `cbd` covers hemp-derived and high-CBD cultivars that customers
 * filter for separately from the classic three.
 */
export const strainType = pgEnum('strain_type', ['indica', 'sativa', 'hybrid', 'cbd'])

/**
 * How a variant counts against the state daily purchase limit.
 *
 * Defined here rather than in the orders module because it describes a catalog
 * property — and because orders already imports this file, so declaring it
 * there would make the two modules import each other, which under ESM leaves
 * whichever loads second holding an undefined reference.
 *
 * The conversion FACTOR is configuration (`purchase_limit_rules`); this is only
 * the classification.
 */
export const cannabisClass = pgEnum('cannabis_class', [
  'flower',
  'concentrate',
  'edible',
  'other',
])

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

export const media = pgTable(
  'media',
  {
    id: primaryKeyColumn(),

    /** Vercel Blob URL once Phase 3 uploads land; seed data uses placeholders. */
    url: text('url').notNull(),

    /**
     * Required, not optional. An empty string is a deliberate, valid value
     * meaning "decorative" — but it has to be chosen, not forgotten. Making the
     * column nullable is how alt text quietly stops existing.
     */
    altText: varchar('alt_text', { length: 255 }).notNull().default(''),

    /** Stored so layout can be reserved before the image loads (no CLS). */
    width: integer('width'),
    height: integer('height'),
    mimeType: varchar('mime_type', { length: 100 }),

    /** Editor-facing name in the media library. */
    title: varchar('title', { length: 160 }),

    /**
     * Focal point as fractions of width/height, origin top-left, default centre.
     *
     * Art direction, not decoration: the same photograph is cropped to a wide
     * hero and a 4:3 card, and without a focal point the subject drifts out of
     * frame at one of them. Stored on the asset so every crop everywhere agrees.
     */
    focalX: numeric('focal_x', { precision: 4, scale: 3 }).notNull().default('0.500'),
    focalY: numeric('focal_y', { precision: 4, scale: 3 }).notNull().default('0.500'),

    /**
     * Archive rather than delete. An asset may still be referenced by a past
     * campaign or a historic product; hiding it from the picker is enough.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),

    /**
     * Replacement lineage. "Replace" inserts a NEW row and points the old one
     * here, instead of mutating the URL in place. That keeps the audit trail
     * honest — what a campaign showed last month is still resolvable — and
     * means a bad replacement can be undone.
     */
    replacedByMediaId: uuid('replaced_by_media_id').references(
      (): AnyPgColumn => media.id,
      { onDelete: 'set null' },
    ),

    ...timestampColumns,
  },
  (table) => [
    index('media_created_at_idx').on(table.createdAt),
    index('media_archived_at_idx').on(table.archivedAt),
  ],
)

/* -------------------------------------------------------------------------- */
/* Brands                                                                      */
/* -------------------------------------------------------------------------- */

export const brands = pgTable(
  'brands',
  {
    id: primaryKeyColumn(),
    slug: varchar('slug', { length: 96 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),

    /** References media rather than storing a URL, same rule as products. */
    logoMediaId: uuid('logo_media_id').references(() => media.id, {
      onDelete: 'set null',
    }),

    active: boolean('active').notNull().default(true),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('brands_slug_unique').on(table.slug),
    index('brands_active_idx').on(table.active),
  ],
)

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export const categories = pgTable(
  'categories',
  {
    id: primaryKeyColumn(),
    slug: varchar('slug', { length: 96 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),

    /**
     * Self-reference for future sub-categories ("Flower > Pre-ground").
     * Unused today — one nullable column now is cheaper than a migration that
     * has to rewrite every category URL later.
     */
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'set null',
    }),

    sortOrder: smallint('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('categories_slug_unique').on(table.slug),
    index('categories_sort_order_idx').on(table.sortOrder),
    index('categories_active_idx').on(table.active),
  ],
)

/* -------------------------------------------------------------------------- */
/* Products                                                                    */
/* -------------------------------------------------------------------------- */

export const products = pgTable(
  'products',
  {
    id: primaryKeyColumn(),
    slug: varchar('slug', { length: 128 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),

    /** One line for cards and search results. */
    shortDescription: varchar('short_description', { length: 320 }),
    description: text('description'),

    /**
     * `restrict` on both: deleting a brand or category that still has products
     * should fail loudly rather than orphan the catalog or silently null out a
     * customer-visible field.
     */
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),

    status: productStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    newArrival: boolean('new_arrival').notNull().default(false),

    /* ---- Cannabis attributes ------------------------------------------- *
     * Captured now even where the UI does not yet surface them. These are the
     * fields customers filter and compare on, and backfilling potency and
     * lineage across a live catalogue is far more painful than carrying a few
     * nullable columns from the start.
     *
     * All nullable: accessories and apparel have none of them.
     */

    strainType: strainType('strain_type'),

    /**
     * numeric, not float. Potency is printed on a label, quoted to a regulator
     * and compared against lab results — binary floating point is the wrong
     * tool for a value that has to round-trip exactly.
     */
    thcPercent: numeric('thc_percent', { precision: 5, scale: 2 }),
    cbdPercent: numeric('cbd_percent', { precision: 5, scale: 2 }),

    /** Cultivar lineage, e.g. "Zkittlez × Gelato". */
    genetics: varchar('genetics', { length: 160 }),

    /**
     * Effects and flavours are free-form tag lists, stored as Postgres arrays
     * with GIN indexes rather than join tables.
     *
     * Join tables would be more normalised, and would be the right answer if
     * these needed their own descriptions or translations. They do not: they
     * are labels used for filtering. Two arrays and two indexes deliver the
     * same query ("everything tagged energizing") without four extra tables to
     * maintain. If faceted search later needs canonical names, promoting these
     * to join tables is a contained migration.
     */
    effects: text('effects').array(),
    flavors: text('flavors').array(),

    /**
     * Terpene profile as { name: percentage }. jsonb rather than an array
     * because each entry carries a value, and rather than a table because
     * nothing queries an individual terpene yet.
     */
    terpenes: jsonb('terpenes').$type<Record<string, number>>(),

    /** Certificate of analysis. Regulators and customers both ask for it. */
    labTestReference: varchar('lab_test_reference', { length: 120 }),
    labTestUrl: text('lab_test_url'),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('products_slug_unique').on(table.slug),
    index('products_status_idx').on(table.status),
    index('products_category_id_idx').on(table.categoryId),
    index('products_brand_id_idx').on(table.brandId),
    /** Composite: the storefront's hottest query is "active in this category". */
    index('products_status_category_idx').on(table.status, table.categoryId),
    index('products_featured_idx').on(table.featured),
    index('products_strain_type_idx').on(table.strainType),
    index('products_effects_gin').using('gin', table.effects),
    index('products_flavors_gin').using('gin', table.flavors),
  ],
)

/* -------------------------------------------------------------------------- */
/* Variants                                                                    */
/* -------------------------------------------------------------------------- */

export const productVariants = pgTable(
  'product_variants',
  {
    id: primaryKeyColumn(),

    /** cascade: a variant has no meaning without its product. */
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    /** Operational identity — what stock is counted against. */
    sku: varchar('sku', { length: 64 }).notNull(),

    /** Display label: "3.5g", "10 pk", "Large". */
    label: varchar('label', { length: 64 }).notNull(),

    /** Nullable — apparel and accessories are not sold by weight. */
    weightGrams: numeric('weight_grams', { precision: 10, scale: 3 }),

    /**
     * Integer cents, never floats. `compare_at_price_cents` is the struck-through
     * "was" price; null means not on offer. A discounts engine can layer over
     * these without changing the columns.
     */
    priceCents: integer('price_cents').notNull(),
    compareAtPriceCents: integer('compare_at_price_cents'),

    /**
     * Single-location stock, per the brief. Multi-location becomes
     * `inventory_levels(variant_id, store_id, quantity)` backfilled from here —
     * additive, not a redesign.
     */
    inventoryQuantity: integer('inventory_quantity').notNull().default(0),

    /**
     * Units held by open checkout drafts but not yet sold.
     *
     * AVAILABLE STOCK IS `inventory_quantity - reserved_quantity`. Splitting the
     * two keeps a reservation reversible without ever having to remember what
     * the number used to be: releasing a hold decrements this, committing a sale
     * decrements both. A single counter would leave an expired draft
     * indistinguishable from a completed sale.
     */
    reservedQuantity: integer('reserved_quantity').notNull().default(0),

    /**
     * How this variant counts against the state daily purchase limit.
     *
     * Lives on the variant because weight and form are variant properties — the
     * same strain sold as flower and as a cartridge counts differently. The
     * conversion factor itself is configuration (`purchase_limit_rules`); this
     * column is only the classification.
     */
    cannabisClass: cannabisClass('cannabis_class').notNull().default('other'),

    /** Per-unit cannabinoid content, for edibles and beverages. */
    thcMg: numeric('thc_mg', { precision: 8, scale: 2 }),
    cbdMg: numeric('cbd_mg', { precision: 8, scale: 2 }),

    active: boolean('active').notNull().default(true),
    sortOrder: smallint('sort_order').notNull().default(0),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('product_variants_sku_unique').on(table.sku),
    index('product_variants_product_id_idx').on(table.productId),
    index('product_variants_active_idx').on(table.active),
  ],
)

/* -------------------------------------------------------------------------- */
/* Product ↔ media                                                             */
/* -------------------------------------------------------------------------- */

export const productMedia = pgTable(
  'product_media',
  {
    id: primaryKeyColumn(),

    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    /**
     * cascade here too: if the underlying asset is deleted the association is
     * meaningless. The asset itself is shared, so deleting a *product* never
     * deletes media.
     */
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),

    sortOrder: smallint('sort_order').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),

    createdAt: timestampColumns.createdAt,
  },
  (table) => [
    /** The same asset may not be attached to one product twice. */
    uniqueIndex('product_media_product_media_unique').on(table.productId, table.mediaId),
    index('product_media_product_id_idx').on(table.productId),
    /**
     * Partial unique index: at most ONE primary image per product, enforced by
     * the database rather than by hoping the application remembers. Postgres
     * treats the predicate as part of the key, so non-primary rows are exempt.
     */
    uniqueIndex('product_media_one_primary_per_product')
      .on(table.productId)
      .where(sql`${table.isPrimary}`),
  ],
)

/* -------------------------------------------------------------------------- */
/* Relations                                                                   */
/* -------------------------------------------------------------------------- */

export const brandsRelations = relations(brands, ({ many, one }) => ({
  products: many(products),
  logo: one(media, { fields: [brands.logoMediaId], references: [media.id] }),
}))

export const categoriesRelations = relations(categories, ({ many, one }) => ({
  products: many(products),
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'category_parent',
  }),
  children: many(categories, { relationName: 'category_parent' }),
}))

export const productsRelations = relations(products, ({ many, one }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
  variants: many(productVariants),
  media: many(productMedia),
}))

export const productVariantsRelations = relations(productVariants, ({ one }) => ({
  product: one(products, {
    fields: [productVariants.productId],
    references: [products.id],
  }),
}))

export const productMediaRelations = relations(productMedia, ({ one }) => ({
  product: one(products, { fields: [productMedia.productId], references: [products.id] }),
  asset: one(media, { fields: [productMedia.mediaId], references: [media.id] }),
}))

export type Brand = typeof brands.$inferSelect
export type Category = typeof categories.$inferSelect
export type CatalogProduct = typeof products.$inferSelect
export type ProductVariant = typeof productVariants.$inferSelect
export type MediaAsset = typeof media.$inferSelect
export type ProductStatus = (typeof productStatus.enumValues)[number]
export type StrainType = (typeof strainType.enumValues)[number]
