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
  cloudMarketDb: DrizzleDatabase | undefined
}

function createPool(): Pool {
  return new Pool({ connectionString: serverEnv().DATABASE_URL })
}

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>

/**
 * The pool is built on FIRST USE, not at module evaluation.
 *
 * This matters at build time, not only at runtime. Next imports the full module
 * graph of every route while collecting page data, so a pool constructed at
 * module scope makes `DATABASE_URL` a *build* requirement for any page that
 * transitively imports this file. Preview deployments deliberately carry no
 * database credentials (see DATABASE.md — an unscoped Preview value would be
 * the fallback for every branch and silently defeat per-branch isolation), so
 * eager construction broke every preview build with
 * "Invalid server environment variables: DATABASE_URL".
 *
 * Deferring it means a deployment without credentials builds fine and fails
 * only if it actually tries to reach the database — which is the correct
 * failure mode, and the one `/api/health` reports as a structured 503.
 */
function getDb(): DrizzleDatabase {
  if (globalForDb.cloudMarketDb) return globalForDb.cloudMarketDb

  const pool = globalForDb.cloudMarketPool ?? createPool()
  const instance = drizzle(pool, {
    schema,
    logger: serverEnv().NODE_ENV === 'development',
  })

  /**
   * Next.js dev-mode hot reloading re-evaluates modules, which would otherwise
   * open a new pool on every edit until the database refuses connections.
   */
  if (serverEnv().NODE_ENV !== 'production') {
    globalForDb.cloudMarketPool = pool
    globalForDb.cloudMarketDb = instance
  }

  return instance
}

/**
 * Proxy so call sites keep the familiar `db.select(...)` shape while
 * construction stays lazy. Methods are bound to the real instance because
 * Drizzle's query builders rely on `this`.
 */
export const db = new Proxy({} as DrizzleDatabase, {
  get(_target, property) {
    const instance = getDb() as unknown as Record<string | symbol, unknown>
    const value = instance[property]
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

export type Database = DrizzleDatabase

/**
 * Transaction helper.
 *
 * Prefer this over `db.transaction` at call sites so that the transaction type
 * is named once and future concerns (retry on serialization failure, statement
 * timeouts) have a single place to live.
 */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export { schema }
