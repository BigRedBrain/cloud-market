import { relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn, softDeleteColumns, timestampColumns } from './_shared'

/**
 * Tenancy root.
 *
 * Cloud Market launches as a single dispensary, but every tenant-owned table in
 * later phases (products, inventory, orders, deliveries) carries a
 * `store_id` foreign key to this table. That keeps the single-store launch and
 * a future multi-store rollout on the same data model, so adding a second store
 * is a data operation rather than a migration of every query in the codebase.
 */

export const storeStatus = pgEnum('store_status', [
  'active',
  'suspended',
  'closed',
])

/**
 * Michigan CRA licence classes relevant to retail sale and delivery.
 * @see https://www.michigan.gov/cra
 */
export const licenseType = pgEnum('license_type', [
  'adult_use_retailer',
  'medical_provisioning_center',
  'both',
])

export const stores = pgTable(
  'stores',
  {
    id: primaryKeyColumn(),

    /** URL-safe identifier, e.g. `/stores/ann-arbor`. */
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),

    status: storeStatus('status').notNull().default('active'),

    // --- Regulatory identity -------------------------------------------------
    licenseType: licenseType('license_type').notNull(),
    /** State-issued licence number. Printed on compliance documents. */
    licenseNumber: varchar('license_number', { length: 64 }).notNull(),

    // --- Contact -------------------------------------------------------------
    email: varchar('email', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 32 }).notNull(),

    // --- Physical address ----------------------------------------------------
    addressLine1: varchar('address_line1', { length: 255 }).notNull(),
    addressLine2: varchar('address_line2', { length: 255 }),
    city: varchar('city', { length: 120 }).notNull(),
    /** Two-letter state code. Constrained to MI at the application layer today. */
    state: varchar('state', { length: 2 }).notNull().default('MI'),
    postalCode: varchar('postal_code', { length: 10 }).notNull(),

    /**
     * Geocoded storefront coordinates, used as the origin for delivery radius
     * and route calculations in Phase 7.
     *
     * `numeric` avoids the float drift that would otherwise accumulate in
     * distance math. Precision 9/scale 6 is ~11cm at the equator.
     */
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),

    /** IANA timezone, drives business-hours and order-cutoff logic. */
    timezone: varchar('timezone', { length: 64 }).notNull().default('America/Detroit'),

    // --- Commerce settings ---------------------------------------------------
    /** Whether this store fulfils delivery orders at all. */
    deliveryEnabled: boolean('delivery_enabled').notNull().default(true),
    /** Whether customers may place in-store pickup orders. */
    pickupEnabled: boolean('pickup_enabled').notNull().default(true),
    /** Maximum delivery distance in metres. Null means "no distance limit". */
    deliveryRadiusMeters: integer('delivery_radius_meters'),
    /**
     * Monetary amounts are stored as integer cents, never floats, so that
     * totals and tax are exact. Formatting happens at the presentation edge.
     */
    deliveryFeeCents: integer('delivery_fee_cents').notNull().default(0),
    minimumOrderCents: integer('minimum_order_cents').notNull().default(0),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('stores_slug_unique').on(table.slug),
    uniqueIndex('stores_license_number_unique').on(table.licenseNumber),
    index('stores_status_idx').on(table.status),
  ],
)

export const storesRelations = relations(stores, () => ({
  // Populated as tenant-owned tables land in later phases.
}))

export type Store = typeof stores.$inferSelect
export type NewStore = typeof stores.$inferInsert
