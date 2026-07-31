import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn, softDeleteColumns, timestampColumns } from './_shared'
import { media, products } from './catalog'

/**
 * CMS and marketing engine.
 *
 * The point of this phase: everything a business owner changes regularly stops
 * being code. No hardcoded homepage promotions, no boolean flags standing in
 * for editorial decisions, no deploy required to run a weekend sale.
 *
 * ONE IDEA CARRIES MOST OF THE DESIGN — the publishing window.
 *
 * Every publishable record shares `status`, `publish_at`, `unpublish_at` and
 * `priority`. Whether something is live is COMPUTED AT READ TIME from those
 * columns, not stored as a flag that something has to flip:
 *
 *     live  =  status = 'published'
 *              or (status = 'scheduled' and publish_at <= now)
 *           and (unpublish_at is null or unpublish_at > now)
 *
 * That is why "the business owner can publish automatically" needs no cron, no
 * queue and no background worker. A campaign scheduled for Friday 9am simply
 * starts matching the query at 9am, and stops matching when its window closes.
 * Nothing can get stuck half-published because there is no second source of
 * truth to drift.
 */

/** Shared lifecycle for every editable record. */
export const contentStatus = pgEnum('content_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
])

export const campaignType = pgEnum('campaign_type', [
  'hero',
  'new_drop',
  'weekend_sale',
  'staff_pick',
  'limited_supply',
  'holiday',
  'brand_collab',
  'announcement',
])

/** Which homepage slot a section fills. */
export const homepageSectionType = pgEnum('homepage_section_type', [
  'hero',
  'announcement_bar',
  'featured_products',
  'collections',
  'categories',
  'promotions',
])

export const brandAssetType = pgEnum('brand_asset_type', [
  'logo',
  'seasonal_artwork',
  'homepage_graphic',
  'marketing_asset',
  'promotional_banner',
])

/**
 * The publishing window, spread into every editable table.
 *
 * `priority` breaks ties when several records are live at once — a holiday
 * campaign can outrank a standing weekend sale without either being edited.
 */
const publishableColumns = {
  status: contentStatus('status').notNull().default('draft'),
  publishAt: timestamp('publish_at', { withTimezone: true, mode: 'date' }),
  unpublishAt: timestamp('unpublish_at', { withTimezone: true, mode: 'date' }),
  priority: smallint('priority').notNull().default(0),
}

/* -------------------------------------------------------------------------- */
/* Campaigns                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A campaign is a reusable promotional record. The announcement bar is a
 * campaign of type `announcement` rather than its own table — it has exactly
 * the same shape (message, call to action, schedule, priority), and a second
 * table would mean two scheduling implementations to keep in step.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: primaryKeyColumn(),
    slug: varchar('slug', { length: 96 }).notNull(),
    type: campaignType('type').notNull(),

    title: varchar('title', { length: 200 }).notNull(),
    subtitle: varchar('subtitle', { length: 320 }),
    /** Short line for the announcement bar, where a title would be too long. */
    body: text('body'),

    ctaLabel: varchar('cta_label', { length: 80 }),
    /** Stored as an app-relative path. Validated on write, never interpolated. */
    ctaHref: varchar('cta_href', { length: 300 }),

    heroMediaId: uuid('hero_media_id').references(() => media.id, {
      onDelete: 'set null',
    }),

    ...publishableColumns,
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('campaigns_slug_unique').on(table.slug),
    index('campaigns_type_idx').on(table.type),
    /** The resolver's hot path: "live campaigns of this type, best first". */
    index('campaigns_type_status_priority_idx').on(table.type, table.status, table.priority),
    index('campaigns_window_idx').on(table.publishAt, table.unpublishAt),
  ],
)

/* -------------------------------------------------------------------------- */
/* Collections                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Collections are NOT categories.
 *
 * A category is what a product *is* — taxonomy, one per product, structural.
 * A collection is an editorial grouping — "Staff Picks", "Michigan Favorites" —
 * and a product belongs to as many as the owner likes. Keeping them separate is
 * what stops merchandising decisions corrupting the taxonomy.
 */
export const collections = pgTable(
  'collections',
  {
    id: primaryKeyColumn(),
    slug: varchar('slug', { length: 96 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),

    heroMediaId: uuid('hero_media_id').references(() => media.id, {
      onDelete: 'set null',
    }),

    ...publishableColumns,
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('collections_slug_unique').on(table.slug),
    index('collections_status_priority_idx').on(table.status, table.priority),
  ],
)

export const collectionProducts = pgTable(
  'collection_products',
  {
    id: primaryKeyColumn(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Editorial ordering within the collection — not price, not date. */
    sortOrder: smallint('sort_order').notNull().default(0),
    createdAt: timestampColumns.createdAt,
  },
  (table) => [
    uniqueIndex('collection_products_unique').on(table.collectionId, table.productId),
    index('collection_products_collection_idx').on(table.collectionId),
    index('collection_products_product_idx').on(table.productId),
  ],
)

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Badges are records, not booleans.
 *
 * `products.featured` and `products.new_arrival` were booleans, and that is
 * exactly the pattern this replaces: every new label would have meant a
 * migration and a deploy. A badge is a row, so the owner invents "Big Red
 * Select" without a developer.
 *
 * `variant` maps onto the FROZEN design system's Badge variants. It is a
 * constrained vocabulary on purpose — an editor picks from the existing visual
 * language rather than introducing a new colour.
 */
export const badges = pgTable(
  'badges',
  {
    id: primaryKeyColumn(),
    slug: varchar('slug', { length: 64 }).notNull(),
    label: varchar('label', { length: 60 }).notNull(),

    /** Optional leading emoji. Decorative, and always paired with the label. */
    icon: varchar('icon', { length: 16 }),

    /** One of the design system's Badge variants. Validated on write. */
    variant: varchar('variant', { length: 20 }).notNull().default('ember'),

    description: varchar('description', { length: 200 }),
    active: boolean('active').notNull().default(true),
    priority: smallint('priority').notNull().default(0),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('badges_slug_unique').on(table.slug),
    index('badges_active_idx').on(table.active),
  ],
)

export const productBadges = pgTable(
  'product_badges',
  {
    id: primaryKeyColumn(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    badgeId: uuid('badge_id')
      .notNull()
      .references(() => badges.id, { onDelete: 'cascade' }),
    sortOrder: smallint('sort_order').notNull().default(0),
    createdAt: timestampColumns.createdAt,
  },
  (table) => [
    uniqueIndex('product_badges_unique').on(table.productId, table.badgeId),
    index('product_badges_product_idx').on(table.productId),
  ],
)

/* -------------------------------------------------------------------------- */
/* Homepage                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Homepage sections.
 *
 * Each row is one slot on the homepage. `sortOrder` is the vertical order,
 * `status` decides whether it renders at all, and `config` carries the few
 * per-type knobs (how many products, which collection) that do not deserve
 * their own columns.
 *
 * `config` is jsonb rather than a column per section type because the shapes
 * genuinely differ and are editorial rather than relational. Anything that
 * needs a foreign key gets a real column — `collectionId` and `campaignId` do,
 * so the database can still enforce that they point at something real.
 */
export const homepageSections = pgTable(
  'homepage_sections',
  {
    id: primaryKeyColumn(),
    type: homepageSectionType('type').notNull(),

    /** Editor-facing label; not rendered. */
    name: varchar('name', { length: 120 }).notNull(),

    /** Optional overrides for the section's heading and eyebrow. */
    heading: varchar('heading', { length: 160 }),
    eyebrow: varchar('eyebrow', { length: 80 }),
    subheading: varchar('subheading', { length: 320 }),

    campaignId: uuid('campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),
    collectionId: uuid('collection_id').references(() => collections.id, {
      onDelete: 'set null',
    }),

    config: jsonb('config').$type<Record<string, unknown>>(),

    sortOrder: smallint('sort_order').notNull().default(0),

    ...publishableColumns,
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    index('homepage_sections_sort_idx').on(table.sortOrder),
    index('homepage_sections_status_idx').on(table.status),
    index('homepage_sections_type_idx').on(table.type),
  ],
)

/* -------------------------------------------------------------------------- */
/* Brand Studio                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Brand Studio — data model and admin scaffolding only, per the brief.
 *
 * A named slot pointing at a media record. `key` is the stable handle code
 * looks up ("logo_primary", "winter_hero"), so seasonal artwork can be swapped
 * by changing which media a key resolves to — on a schedule, with no deploy.
 *
 * Deliberately NOT wired into rendering yet.
 */
export const brandAssets = pgTable(
  'brand_assets',
  {
    id: primaryKeyColumn(),
    key: varchar('key', { length: 96 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    assetType: brandAssetType('asset_type').notNull(),

    mediaId: uuid('media_id').references(() => media.id, { onDelete: 'set null' }),

    notes: text('notes'),

    ...publishableColumns,
    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    /**
     * A key may have several rows — that is how seasonal swaps work: two
     * "homepage_hero" assets with different windows. Uniqueness is therefore on
     * (key, id) implicitly, not on key alone.
     */
    index('brand_assets_key_idx').on(table.key),
    index('brand_assets_type_idx').on(table.assetType),
    index('brand_assets_status_idx').on(table.status),
  ],
)

/* -------------------------------------------------------------------------- */
/* Relations                                                                   */
/* -------------------------------------------------------------------------- */

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  heroMedia: one(media, { fields: [campaigns.heroMediaId], references: [media.id] }),
  sections: many(homepageSections),
}))

export const collectionsRelations = relations(collections, ({ one, many }) => ({
  heroMedia: one(media, { fields: [collections.heroMediaId], references: [media.id] }),
  products: many(collectionProducts),
}))

export const collectionProductsRelations = relations(collectionProducts, ({ one }) => ({
  collection: one(collections, {
    fields: [collectionProducts.collectionId],
    references: [collections.id],
  }),
  product: one(products, {
    fields: [collectionProducts.productId],
    references: [products.id],
  }),
}))

export const badgesRelations = relations(badges, ({ many }) => ({
  products: many(productBadges),
}))

export const productBadgesRelations = relations(productBadges, ({ one }) => ({
  product: one(products, { fields: [productBadges.productId], references: [products.id] }),
  badge: one(badges, { fields: [productBadges.badgeId], references: [badges.id] }),
}))

export const homepageSectionsRelations = relations(homepageSections, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [homepageSections.campaignId],
    references: [campaigns.id],
  }),
  collection: one(collections, {
    fields: [homepageSections.collectionId],
    references: [collections.id],
  }),
}))

export const brandAssetsRelations = relations(brandAssets, ({ one }) => ({
  asset: one(media, { fields: [brandAssets.mediaId], references: [media.id] }),
}))

export type ContentStatus = (typeof contentStatus.enumValues)[number]
export type CampaignType = (typeof campaignType.enumValues)[number]
export type HomepageSectionType = (typeof homepageSectionType.enumValues)[number]
export type BrandAssetType = (typeof brandAssetType.enumValues)[number]
export type Campaign = typeof campaigns.$inferSelect
export type Collection = typeof collections.$inferSelect
export type Badge = typeof badges.$inferSelect
export type HomepageSection = typeof homepageSections.$inferSelect
export type BrandAsset = typeof brandAssets.$inferSelect
