/**
 * Schema barrel.
 *
 * `lib/db` passes this module to Drizzle as the full schema, which is what
 * enables the relational query API (`db.query.*`). Every new table module must
 * be re-exported here.
 */
export * from './_shared'
export * from './audit'
export * from './auth'
export * from './stores'
