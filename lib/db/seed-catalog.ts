/**
 * Catalog seed — run with `npm run db:seed:catalog`.
 *
 * Populates enough realistic data to exercise every path the storefront and
 * admin have to handle: multiple brands and categories, products with one
 * variant and with five, featured items, new arrivals, a fully out-of-stock
 * product, a low-stock variant, a draft that must never appear publicly, an
 * archived product, and non-cannabis items (apparel, accessories) that
 * legitimately have no strain type or potency.
 *
 * Idempotent. Every insert upserts on its natural key, so re-running updates in
 * place rather than duplicating — safe to point at a live database.
 *
 * Opens its own connection rather than importing `lib/db`, which is
 * `server-only` and caches a pool for Next's dev hot-reloading that a
 * short-lived CLI process should not join.
 */
import { Pool, neonConfig } from '@neondatabase/serverless'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/neon-serverless'

import * as schema from './schema'

if (typeof WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = WebSocket
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Run via `npm run db:seed:catalog`.')
}

/**
 * Placeholder imagery. Real assets arrive with Vercel Blob uploads; these are
 * deterministic SVG data URIs so the seed has zero network dependencies and
 * every product still exercises the media join, alt text, ordering and the
 * one-primary-per-product constraint.
 */
function placeholderImage(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="hsl(${hue} 45% 18%)"/><circle cx="320" cy="200" r="120" fill="hsl(${hue} 60% 30%)"/><text x="320" y="400" font-family="sans-serif" font-size="34" fill="hsl(${hue} 30% 85%)" text-anchor="middle">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

type SeedVariant = {
  sku: string
  label: string
  weightGrams?: string
  priceCents: number
  compareAtPriceCents?: number
  inventoryQuantity: number
  thcMg?: string
  active?: boolean
}

type SeedProduct = {
  slug: string
  name: string
  brand: string
  category: string
  shortDescription: string
  description: string
  status: schema.ProductStatus
  featured?: boolean
  newArrival?: boolean
  strainType?: schema.StrainType
  thcPercent?: string
  cbdPercent?: string
  genetics?: string
  effects?: string[]
  flavors?: string[]
  terpenes?: Record<string, number>
  labTestReference?: string
  hue: number
  variants: SeedVariant[]
}

const BRANDS = [
  { slug: 'cloud-house', name: 'Cloud House', description: 'Our own small-batch flower, grown in Michigan.' },
  { slug: 'motor-city-farms', name: 'Motor City Farms', description: 'Detroit-based cultivator. Living soil, hang-dried.' },
  { slug: 'great-lakes-extracts', name: 'Great Lakes Extracts', description: 'Solventless hash and rosin.' },
  { slug: 'northside-edibles', name: 'Northside Edibles', description: 'Small-batch gummies and chocolate.' },
  { slug: 'lakeshore-vapor', name: 'Lakeshore Vapor', description: 'Cartridges and all-in-one devices.' },
]

const CATEGORIES = [
  { slug: 'flower', name: 'Flower', sortOrder: 10, description: 'Whole bud, hang-dried and hand-trimmed.' },
  { slug: 'pre-rolls', name: 'Pre-rolls', sortOrder: 20, description: 'Ready to go, singles and packs.' },
  { slug: 'concentrates', name: 'Concentrates', sortOrder: 30, description: 'Rosin, hash and live resin.' },
  { slug: 'edibles', name: 'Edibles', sortOrder: 40, description: 'Gummies, chocolate and drinks.' },
  { slug: 'vapes', name: 'Vapes', sortOrder: 50, description: 'Cartridges and all-in-ones.' },
  { slug: 'accessories', name: 'Accessories', sortOrder: 60, description: 'Grinders, papers and storage.' },
  { slug: 'apparel', name: 'Apparel', sortOrder: 70, description: 'Cloud Market merch.' },
]

const FLOWER_WEIGHTS: Array<{ label: string; grams: string; multiplier: number }> = [
  { label: '1g', grams: '1.000', multiplier: 1 },
  { label: '3.5g', grams: '3.500', multiplier: 3.2 },
  { label: '7g', grams: '7.000', multiplier: 6 },
  { label: '14g', grams: '14.000', multiplier: 11 },
  { label: '28g', grams: '28.000', multiplier: 20 },
]

/** Builds the five standard flower weights from a per-gram base price. */
function flowerVariants(
  skuPrefix: string,
  baseCents: number,
  stock: number[],
): SeedVariant[] {
  return FLOWER_WEIGHTS.map((weight, index) => ({
    sku: `${skuPrefix}-${weight.label.replace('.', '')}`,
    label: weight.label,
    weightGrams: weight.grams,
    priceCents: Math.round((baseCents * weight.multiplier) / 100) * 100,
    inventoryQuantity: stock[index] ?? 0,
  }))
}

const PRODUCTS: SeedProduct[] = [
  {
    slug: 'midnight-runtz',
    name: 'Midnight Runtz',
    brand: 'cloud-house',
    category: 'flower',
    shortDescription: 'Heavy indica-leaning hybrid with a candied nose.',
    description:
      'Dense, purple-tipped buds with a sweet berry front and a gassy finish. Cured for fourteen days and hand-trimmed. Best kept for the end of the evening — it settles in quickly and stays put.',
    status: 'active',
    featured: true,
    strainType: 'indica',
    thcPercent: '27.40',
    cbdPercent: '0.10',
    genetics: 'Zkittlez × Gelato',
    effects: ['relaxed', 'sleepy', 'euphoric'],
    flavors: ['berry', 'candy', 'gas'],
    terpenes: { myrcene: 0.62, caryophyllene: 0.41, limonene: 0.28 },
    labTestReference: 'COA-2026-0417',
    hue: 280,
    variants: flowerVariants('CH-MRZ', 1400, [24, 18, 9, 4, 2]),
  },
  {
    slug: 'motor-city-haze',
    name: 'Motor City Haze',
    brand: 'motor-city-farms',
    category: 'flower',
    shortDescription: 'Bright sativa. Daytime, conversation, getting things done.',
    description:
      'A classic haze phenotype grown in living soil. Citrus and pine up front, peppery on the exhale. Clear-headed and social rather than racy.',
    status: 'active',
    featured: true,
    newArrival: true,
    strainType: 'sativa',
    thcPercent: '22.10',
    cbdPercent: '0.20',
    genetics: 'Super Silver Haze × Lemon Skunk',
    effects: ['energetic', 'focused', 'uplifted'],
    flavors: ['citrus', 'pine', 'pepper'],
    terpenes: { terpinolene: 0.55, limonene: 0.44, pinene: 0.31 },
    labTestReference: 'COA-2026-0422',
    hue: 90,
    variants: flowerVariants('MCF-MCH', 1200, [30, 22, 11, 3, 0]),
  },
  {
    slug: 'eastside-og',
    name: 'Eastside OG',
    brand: 'motor-city-farms',
    category: 'flower',
    shortDescription: 'Old-school OG. Earthy, piney, dependable.',
    description:
      'A cut that has been in Michigan gardens for years. Earth and pine with a diesel edge. Balanced hybrid effects — relaxed without being sedating.',
    status: 'active',
    strainType: 'hybrid',
    thcPercent: '24.90',
    genetics: 'OG Kush × Chemdawg',
    effects: ['relaxed', 'happy', 'creative'],
    flavors: ['earth', 'pine', 'diesel'],
    terpenes: { myrcene: 0.48, limonene: 0.36, humulene: 0.22 },
    labTestReference: 'COA-2026-0405',
    hue: 140,
    // Deliberately fully out of stock: exercises the sold-out card state.
    variants: flowerVariants('MCF-EOG', 1300, [0, 0, 0, 0, 0]),
  },
  {
    slug: 'lakeshore-cbd-no-19',
    name: 'Lakeshore CBD No. 19',
    brand: 'cloud-house',
    category: 'flower',
    shortDescription: 'High-CBD, low-THC. Clear head, calm body.',
    description:
      'For customers who want the terpenes without the altitude. Tests under one percent THC and around fourteen percent CBD.',
    status: 'active',
    strainType: 'cbd',
    thcPercent: '0.80',
    cbdPercent: '14.20',
    genetics: 'Cherry Wine × Otto II',
    effects: ['calm', 'clear', 'relaxed'],
    flavors: ['herbal', 'cherry', 'tea'],
    terpenes: { myrcene: 0.30, pinene: 0.26, bisabolol: 0.18 },
    hue: 200,
    variants: flowerVariants('CH-CBD19', 900, [12, 8, 4, 2, 1]),
  },
  {
    slug: 'gas-station-sushi-preroll',
    name: 'Gas Station Sushi Pre-rolls',
    brand: 'motor-city-farms',
    category: 'pre-rolls',
    shortDescription: 'Half-gram rolls, five to a tin.',
    description:
      'Whole flower, no trim, no shake. Rolled in unbleached paper with a glass tip. The tin is worth keeping.',
    status: 'active',
    newArrival: true,
    strainType: 'hybrid',
    thcPercent: '25.60',
    genetics: 'Gas Station Sushi',
    effects: ['euphoric', 'giggly', 'relaxed'],
    flavors: ['funk', 'citrus', 'cream'],
    hue: 20,
    variants: [
      { sku: 'MCF-GSS-1PK', label: '1 pk', weightGrams: '0.500', priceCents: 1200, inventoryQuantity: 40 },
      { sku: 'MCF-GSS-5PK', label: '5 pk', weightGrams: '2.500', priceCents: 5000, compareAtPriceCents: 6000, inventoryQuantity: 3 },
    ],
  },
  {
    slug: 'cold-cure-rosin-papaya',
    name: 'Cold Cure Rosin — Papaya',
    brand: 'great-lakes-extracts',
    category: 'concentrates',
    shortDescription: 'Solventless first-press rosin. Batter consistency.',
    description:
      'Ice-water hash pressed at low temperature and cold-cured for six days. Nothing but flower, water, heat and pressure.',
    status: 'active',
    featured: true,
    strainType: 'hybrid',
    thcPercent: '76.30',
    genetics: 'Papaya',
    effects: ['euphoric', 'relaxed'],
    flavors: ['tropical', 'papaya', 'cream'],
    terpenes: { myrcene: 1.82, caryophyllene: 1.10, linalool: 0.64 },
    labTestReference: 'COA-2026-0430',
    hue: 35,
    variants: [
      { sku: 'GLE-CCR-PAP-1G', label: '1g', weightGrams: '1.000', priceCents: 6000, inventoryQuantity: 14 },
      { sku: 'GLE-CCR-PAP-2G', label: '2g', weightGrams: '2.000', priceCents: 11000, compareAtPriceCents: 12000, inventoryQuantity: 6 },
    ],
  },
  {
    slug: 'northside-blackberry-gummies',
    name: 'Blackberry Gummies',
    brand: 'northside-edibles',
    category: 'edibles',
    shortDescription: '10mg per piece, ten to a pack.',
    description:
      'Real fruit purée, pectin base, no gelatin. Start with half a piece and give it ninety minutes before deciding anything.',
    status: 'active',
    thcPercent: '0.00',
    effects: ['relaxed', 'happy'],
    flavors: ['blackberry'],
    hue: 300,
    variants: [
      { sku: 'NSE-BBG-10', label: '10 pk · 100mg', priceCents: 1800, inventoryQuantity: 55, thcMg: '10.00' },
      { sku: 'NSE-BBG-20', label: '20 pk · 200mg', priceCents: 3200, compareAtPriceCents: 3600, inventoryQuantity: 2, thcMg: '10.00' },
    ],
  },
  {
    slug: 'lakeshore-live-resin-cart',
    name: 'Live Resin Cartridge — Tangie',
    brand: 'lakeshore-vapor',
    category: 'vapes',
    shortDescription: '510-thread, live resin, no cutting agents.',
    description:
      'Cold-extracted live resin in a ceramic-core cartridge. Bright tangerine on the inhale.',
    status: 'active',
    strainType: 'sativa',
    thcPercent: '81.50',
    genetics: 'Tangie',
    effects: ['uplifted', 'focused'],
    flavors: ['tangerine', 'citrus'],
    hue: 45,
    variants: [
      { sku: 'LSV-LRC-TAN-05', label: '0.5g', weightGrams: '0.500', priceCents: 3500, inventoryQuantity: 20 },
      { sku: 'LSV-LRC-TAN-10', label: '1g', weightGrams: '1.000', priceCents: 6000, inventoryQuantity: 11 },
    ],
  },
  {
    slug: 'four-piece-grinder',
    name: 'Four-Piece Grinder',
    brand: 'cloud-house',
    category: 'accessories',
    shortDescription: 'Anodised aluminium, kief catch, 63mm.',
    description:
      'Machined aluminium with a magnetic lid and a fine mesh screen. No strain, no potency — it is a grinder.',
    status: 'active',
    hue: 220,
    variants: [
      { sku: 'CH-GRINDER-63', label: '63mm', priceCents: 3400, inventoryQuantity: 18 },
    ],
  },
  {
    slug: 'cloud-market-hoodie',
    name: 'Cloud Market Hoodie',
    brand: 'cloud-house',
    category: 'apparel',
    shortDescription: 'Heavyweight cotton, ink-printed cloud mark.',
    description: 'Garment-dyed heavyweight fleece with the cloud mark screen-printed across the chest.',
    status: 'active',
    hue: 260,
    variants: [
      { sku: 'CH-HOODIE-S', label: 'Small', priceCents: 6500, inventoryQuantity: 6, sortOrder: 1 } as SeedVariant,
      { sku: 'CH-HOODIE-M', label: 'Medium', priceCents: 6500, inventoryQuantity: 9 },
      { sku: 'CH-HOODIE-L', label: 'Large', priceCents: 6500, inventoryQuantity: 0 },
      { sku: 'CH-HOODIE-XL', label: 'X-Large', priceCents: 6500, inventoryQuantity: 4 },
    ],
  },
  {
    slug: 'winter-reserve-2026',
    name: 'Winter Reserve 2026',
    brand: 'cloud-house',
    category: 'flower',
    shortDescription: 'Not released yet. Draft — must never appear publicly.',
    description: 'Single-source winter harvest. Held back for a February drop.',
    // Draft: the storefront must never surface this. Admin must still see it.
    status: 'draft',
    strainType: 'indica',
    thcPercent: '29.80',
    hue: 210,
    variants: flowerVariants('CH-WR26', 1600, [10, 10, 5, 2, 1]),
  },
  {
    slug: 'summer-haze-2025',
    name: 'Summer Haze 2025',
    brand: 'motor-city-farms',
    category: 'flower',
    shortDescription: 'Retired. Kept for order history.',
    description: 'Last summer’s outdoor run. Archived rather than deleted so past orders still resolve.',
    status: 'archived',
    strainType: 'sativa',
    thcPercent: '19.40',
    hue: 60,
    variants: flowerVariants('MCF-SH25', 1000, [0, 0, 0, 0, 0]),
  },
]

async function main() {
  const pool = new Pool({ connectionString })
  const db = drizzle(pool, { schema })

  try {
    /* ---- Brands --------------------------------------------------------- */
    const brandIds = new Map<string, string>()
    for (const brand of BRANDS) {
      const [row] = await db
        .insert(schema.brands)
        .values({ slug: brand.slug, name: brand.name, description: brand.description })
        .onConflictDoUpdate({
          target: schema.brands.slug,
          set: { name: brand.name, description: brand.description, updatedAt: new Date() },
        })
        .returning({ id: schema.brands.id })
      brandIds.set(brand.slug, row.id)
    }

    /* ---- Categories ----------------------------------------------------- */
    const categoryIds = new Map<string, string>()
    for (const category of CATEGORIES) {
      const [row] = await db
        .insert(schema.categories)
        .values(category)
        .onConflictDoUpdate({
          target: schema.categories.slug,
          set: {
            name: category.name,
            description: category.description,
            sortOrder: category.sortOrder,
            updatedAt: new Date(),
          },
        })
        .returning({ id: schema.categories.id })
      categoryIds.set(category.slug, row.id)
    }

    /* ---- Products, media and variants ----------------------------------- */
    let variantCount = 0
    let mediaCount = 0

    for (const product of PRODUCTS) {
      const brandId = brandIds.get(product.brand)
      const categoryId = categoryIds.get(product.category)
      if (!brandId || !categoryId) {
        throw new Error(`Unknown brand/category for ${product.slug}`)
      }

      const [productRow] = await db
        .insert(schema.products)
        .values({
          slug: product.slug,
          name: product.name,
          shortDescription: product.shortDescription,
          description: product.description,
          brandId,
          categoryId,
          status: product.status,
          featured: product.featured ?? false,
          newArrival: product.newArrival ?? false,
          strainType: product.strainType,
          thcPercent: product.thcPercent,
          cbdPercent: product.cbdPercent,
          genetics: product.genetics,
          effects: product.effects,
          flavors: product.flavors,
          terpenes: product.terpenes,
          labTestReference: product.labTestReference,
        })
        .onConflictDoUpdate({
          target: schema.products.slug,
          set: {
            name: product.name,
            shortDescription: product.shortDescription,
            description: product.description,
            brandId,
            categoryId,
            status: product.status,
            featured: product.featured ?? false,
            newArrival: product.newArrival ?? false,
            strainType: product.strainType,
            thcPercent: product.thcPercent,
            cbdPercent: product.cbdPercent,
            genetics: product.genetics,
            effects: product.effects,
            flavors: product.flavors,
            terpenes: product.terpenes,
            labTestReference: product.labTestReference,
            updatedAt: new Date(),
          },
        })
        .returning({ id: schema.products.id })

      const productId = productRow.id

      /* Media: two assets each, so ordering and the primary flag are exercised. */
      await db.delete(schema.productMedia).where(eq(schema.productMedia.productId, productId))

      for (const [index, suffix] of [['0', ''], ['1', ' — detail']] as const) {
        const [asset] = await db
          .insert(schema.media)
          .values({
            url: placeholderImage(product.name, product.hue + Number(index) * 12),
            altText:
              index === '0'
                ? `${product.name} by ${product.brand.replace(/-/g, ' ')}`
                : `${product.name}${suffix}, close-up`,
            width: 640,
            height: 480,
            mimeType: 'image/svg+xml',
          })
          .returning({ id: schema.media.id })
        mediaCount += 1

        await db.insert(schema.productMedia).values({
          productId,
          mediaId: asset.id,
          sortOrder: Number(index),
          isPrimary: index === '0',
        })
      }

      /* Variants */
      for (const [index, variant] of product.variants.entries()) {
        await db
          .insert(schema.productVariants)
          .values({
            productId,
            sku: variant.sku,
            label: variant.label,
            weightGrams: variant.weightGrams,
            priceCents: variant.priceCents,
            compareAtPriceCents: variant.compareAtPriceCents,
            inventoryQuantity: variant.inventoryQuantity,
            thcMg: variant.thcMg,
            active: variant.active ?? true,
            sortOrder: index,
          })
          .onConflictDoUpdate({
            target: schema.productVariants.sku,
            set: {
              productId,
              label: variant.label,
              weightGrams: variant.weightGrams,
              priceCents: variant.priceCents,
              compareAtPriceCents: variant.compareAtPriceCents,
              inventoryQuantity: variant.inventoryQuantity,
              thcMg: variant.thcMg,
              active: variant.active ?? true,
              sortOrder: index,
              updatedAt: new Date(),
            },
          })
        variantCount += 1
      }
    }

    console.log(
      `Catalog seeded: ${BRANDS.length} brands, ${CATEGORIES.length} categories, ` +
        `${PRODUCTS.length} products, ${variantCount} variants, ${mediaCount} media assets.`,
    )
    console.log(
      '  includes: featured, new arrivals, an out-of-stock product, low-stock variants,\n' +
        '            a draft (must not appear publicly) and an archived product.',
    )
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('Catalog seed failed:', error)
  process.exitCode = 1
})
