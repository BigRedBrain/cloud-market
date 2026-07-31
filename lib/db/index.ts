import 'server-only'

import { Pool, neonConfig } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'

import { serverEnv } from '@/lib/env'
import * as schema from './schema'

/**
 * Database client.
 *
 * Uses the WebSocket-backed `neon-serverless` driver rather than `neon-http`.
 * The HTTP driver cannot open transactions, and order placement (Phase 5) has
 * to decrement inventory and write the order atomically, so transaction support
 * is a hard requirement rather than a preference.
 *
 * `server-only` makes any accidental import from a Client Component a build
 * error instead of a leaked connection string.
 */

// Node 22+ exposes a global WebSocket; older runtimes need an explicit polyfill.
if (typeof WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = WebSocket
}

/**
 * Next.js dev-mode hot reloading re-evaluates modules, which would otherwise
 * open a new pool on every edit until the database refuses connections.
 */
const globalForDb = globalThis as unknown as {
  cloudMarketPool: Pool | undefined
}

function createPool(): Pool {
  return new Pool({ connectionString: serverEnv().DATABASE_URL })
}

const pool = globalForDb.cloudMarketPool ?? createPool()

if (serverEnv().NODE_ENV !== 'production') {
  globalForDb.cloudMarketPool = pool
}

export const db = drizzle(pool, {
  schema,
  logger: serverEnv().NODE_ENV === 'development',
})

export type Database = typeof db

/**
 * Transaction helper.
 *
 * Prefer this over `db.transaction` at call sites so that the transaction type
 * is named once and future concerns (retry on serialization failure, statement
 * timeouts) have a single place to live.
 */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export { schema }
