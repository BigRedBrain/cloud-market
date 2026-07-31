/**
 * Database seed — run with `npm run db:seed`.
 *
 * Creates the launch dispensary. Idempotent: re-running updates the existing
 * row rather than inserting a duplicate, so it is safe against a live database.
 *
 * This script deliberately opens its own connection instead of importing
 * `lib/db`. That module is marked `server-only`, which throws outside the React
 * Server Component runtime, and it caches a pool for Next.js dev hot-reloading
 * that a short-lived CLI process should not participate in.
 */
import { Pool, neonConfig } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'

import { stores } from './schema'

if (typeof WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = WebSocket
}

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Run via `npm run db:seed`, which loads .env.local.',
  )
}

/**
 * The launch store. Replace these placeholders with the real licence and
 * address details before seeding production.
 */
const launchStore = {
  slug: 'cloud-market',
  name: 'Cloud Market',
  description: 'Michigan-licensed cannabis retail, pickup and delivery.',
  licenseType: 'adult_use_retailer' as const,
  licenseNumber: 'AU-R-000000',
  email: 'hello@cloudmarket.example',
  phone: '+1-555-000-0000',
  addressLine1: '1 Example Street',
  city: 'Detroit',
  state: 'MI',
  postalCode: '48226',
  timezone: 'America/Detroit',
  deliveryEnabled: true,
  pickupEnabled: true,
  deliveryFeeCents: 500,
  minimumOrderCents: 2500,
}

async function main() {
  const pool = new Pool({ connectionString })
  const db = drizzle(pool)

  try {
    const [store] = await db
      .insert(stores)
      .values(launchStore)
      .onConflictDoUpdate({
        target: stores.slug,
        set: { ...launchStore, updatedAt: new Date() },
      })
      .returning({ id: stores.id, slug: stores.slug, name: stores.name })

    console.log(`Seeded store "${store.name}" (${store.slug}) — ${store.id}`)
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error)
  process.exitCode = 1
})
