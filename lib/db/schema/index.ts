/**
 * Schema barrel.
 *
 * `lib/db` passes this module to Drizzle as the full schema, which is what
 * enables the relational query API (`db.query.*`). Every new table module must
 * be re-exported here.
 */
export * from './_shared'
export * from './admin'
export * from './audit'
export * from './auth'
export * from './cart'
export * from './catalog'
export * from './cms'
export * from './invites'
export * from './jobs'
export * from './orders'
export * from './payments'
export * from './permissions'
export * from './stores'
