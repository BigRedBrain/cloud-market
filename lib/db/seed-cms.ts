/**
 * CMS seed — `npm run db:seed:cms`.
 *
 * Gives a business owner something real to edit on day one: badges,
 * collections, a hero campaign, an announcement and a homepage layout.
 *
 * EVERYTHING PUBLISHABLE IS SEEDED AS `draft`. That is deliberate — the brief
 * requires no visual change to the storefront, and seeding published content
 * would silently rewrite the homepage. The owner publishes when ready; until
 * then the storefront renders exactly as it did before this phase.
 *
 * Idempotent: every insert upserts on its natural key.
 */
import { Pool, neonConfig } from '@neondatabase/serverless'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/neon-serverless'

import * as schema from './schema'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set.')

const BADGES = [
  { slug: 'new', label: 'New', icon: '🔥', variant: 'ember', priority: 90, description: 'Just landed.' },
  { slug: 'staff-pick', label: 'Staff Pick', icon: '⭐', variant: 'volt', priority: 80, description: 'Chosen by the counter team.' },
  { slug: 'limited', label: 'Limited', icon: '💨', variant: 'flare', priority: 70, description: 'Small batch, going fast.' },
  { slug: 'lab-tested', label: 'Lab Tested', icon: '🧪', variant: 'outline', priority: 20, description: 'COA on the product page.' },
  { slug: 'big-red-select', label: 'Big Red Select', icon: '👑', variant: 'cream', priority: 95, description: 'House selection.' },
  { slug: 'best-seller', label: 'Best Seller', icon: '🏆', variant: 'ember', priority: 85, description: 'Top of the menu.' },
]

const COLLECTIONS = [
  { slug: 'new-drops', name: 'New Drops', description: 'Fresh on the menu this week.', priority: 90 },
  { slug: 'staff-picks', name: 'Staff Picks', description: 'What the counter team is taking home.', priority: 80 },
  { slug: 'high-thc', name: 'High THC', description: 'Everything testing above 24%.', priority: 70 },
  { slug: 'michigan-favorites', name: 'Michigan Favorites', description: 'Grown and cured in state.', priority: 60 },
]

const CAMPAIGNS = [
  {
    slug: 'default-hero',
    type: 'hero' as const,
    title: 'Cannabis,',
    subtitle: 'to your door',
    body: 'Licensed Michigan flower, cured properly and tested twice. Order by 8pm and it lands the same day — or pick it up in twenty minutes.',
    ctaLabel: 'Shop now',
    ctaHref: '/shop',
    priority: 10,
  },
  {
    slug: 'delivery-notice',
    type: 'announcement' as const,
    title: 'Delivery notice',
    body: 'Same-day delivery closes at 8pm. Order early on holidays.',
    ctaLabel: 'Check your address',
    ctaHref: '/shop',
    priority: 10,
  },
  {
    slug: 'weekend-sale',
    type: 'weekend_sale' as const,
    title: 'Weekend Sale',
    subtitle: '20% off selected pre-rolls',
    ctaLabel: 'See the deals',
    ctaHref: '/shop/pre-rolls',
    priority: 50,
  },
]

const SECTIONS = [
  { type: 'announcement_bar' as const, name: 'Announcement bar', sortOrder: 0 },
  { type: 'hero' as const, name: 'Hero', sortOrder: 10 },
  { type: 'featured_products' as const, name: 'Featured drops', eyebrow: 'This week', heading: 'Featured drops', sortOrder: 20 },
  { type: 'categories' as const, name: 'Shop by category', heading: 'Shop by category', sortOrder: 30 },
  { type: 'collections' as const, name: 'Collections', heading: 'Collections', sortOrder: 40 },
]

async function main() {
  const pool = new Pool({ connectionString })
  const db = drizzle(pool, { schema })

  try {
    /* ---- Badges --------------------------------------------------------- */
    const badgeIds = new Map<string, string>()
    for (const badge of BADGES) {
      const [row] = await db
        .insert(schema.badges)
        .values(badge)
        .onConflictDoUpdate({
          target: schema.badges.slug,
          set: { ...badge, updatedAt: new Date() },
        })
        .returning({ id: schema.badges.id })
      badgeIds.set(badge.slug, row.id)
    }

    /* ---- Collections ---------------------------------------------------- */
    const collectionIds = new Map<string, string>()
    for (const collection of COLLECTIONS) {
      const [row] = await db
        .insert(schema.collections)
        .values({ ...collection, status: 'draft' })
        .onConflictDoUpdate({
          target: schema.collections.slug,
          set: { name: collection.name, description: collection.description, updatedAt: new Date() },
        })
        .returning({ id: schema.collections.id })
      collectionIds.set(collection.slug, row.id)
    }

    /* ---- Campaigns ------------------------------------------------------ */
    for (const campaign of CAMPAIGNS) {
      await db
        .insert(schema.campaigns)
        .values({ ...campaign, status: 'draft' })
        .onConflictDoUpdate({
          target: schema.campaigns.slug,
          set: {
            title: campaign.title,
            subtitle: 'subtitle' in campaign ? campaign.subtitle : null,
            body: 'body' in campaign ? campaign.body : null,
            ctaLabel: campaign.ctaLabel,
            ctaHref: campaign.ctaHref,
            updatedAt: new Date(),
          },
        })
    }

    /* ---- Homepage sections ---------------------------------------------- */
    for (const section of SECTIONS) {
      const existing = await db
        .select({ id: schema.homepageSections.id })
        .from(schema.homepageSections)
        .where(eq(schema.homepageSections.name, section.name))
        .limit(1)

      if (existing.length === 0) {
        await db.insert(schema.homepageSections).values({ ...section, status: 'draft' })
      }
    }

    /* ---- Membership: put real products into collections ------------------ */
    const products = await db
      .select({ id: schema.products.id, slug: schema.products.slug, thc: schema.products.thcPercent })
      .from(schema.products)
      .where(eq(schema.products.status, 'active'))

    const link = async (collectionSlug: string, productId: string, sortOrder: number) => {
      const collectionId = collectionIds.get(collectionSlug)
      if (!collectionId) return
      await db
        .insert(schema.collectionProducts)
        .values({ collectionId, productId, sortOrder })
        .onConflictDoNothing()
    }

    let index = 0
    for (const product of products) {
      if (Number(product.thc ?? 0) >= 24) await link('high-thc', product.id, index)
      if (index < 4) await link('new-drops', product.id, index)
      if (index % 3 === 0) await link('staff-picks', product.id, index)
      await link('michigan-favorites', product.id, index)
      index += 1
    }

    /* ---- Badge assignments ---------------------------------------------- */
    const assign = async (productSlug: string, badgeSlug: string) => {
      const product = products.find((row) => row.slug === productSlug)
      const badgeId = badgeIds.get(badgeSlug)
      if (!product || !badgeId) return
      await db
        .insert(schema.productBadges)
        .values({ productId: product.id, badgeId })
        .onConflictDoNothing()
    }

    await assign('midnight-runtz', 'big-red-select')
    await assign('midnight-runtz', 'lab-tested')
    await assign('motor-city-haze', 'new')
    await assign('gas-station-sushi-preroll', 'limited')
    await assign('cold-cure-rosin-papaya', 'staff-pick')
    await assign('northside-blackberry-gummies', 'best-seller')

    const memberships = await db.select({ id: schema.collectionProducts.id }).from(schema.collectionProducts)
    const badgeLinks = await db.select({ id: schema.productBadges.id }).from(schema.productBadges)

    console.log(
      `CMS seeded: ${BADGES.length} badges, ${COLLECTIONS.length} collections, ` +
        `${CAMPAIGNS.length} campaigns, ${SECTIONS.length} homepage sections, ` +
        `${memberships.length} collection memberships, ${badgeLinks.length} badge assignments.`,
    )
    console.log(
      '  Everything publishable is DRAFT — the storefront is unchanged until an owner publishes.',
    )
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('CMS seed failed:', error)
  process.exitCode = 1
})
