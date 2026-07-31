/**
 * Reports what the current .env.local actually points at, without printing
 * hostnames or credentials. Used to prove a destructive-ish operation is
 * aimed at development rather than production before running it.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const PRODUCTION_POOLED_FP = '2b968b3cbe06'

const fp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
  const raw = process.env[key]
  if (!raw) {
    console.log(`${key}: NOT SET`)
    continue
  }
  const url = new URL(raw)
  const pooled = url.hostname.includes('-pooler')
  console.log(`\n${key}`)
  console.log(`  fingerprint  ${fp(raw)}`)
  console.log(`  endpoint     ${pooled ? 'POOLED' : 'DIRECT'}`)
  console.log(`  database     ${url.pathname.slice(1).split('?')[0]}`)
  console.log(`  is production? ${fp(raw) === PRODUCTION_POOLED_FP ? '*** YES ***' : 'no'}`)

  const pool = new Pool({ connectionString: raw })
  try {
    const { rows } = await pool.query(
      `select current_database() as db, current_user as usr, version() as v`,
    )
    console.log(`  connected    as ${rows[0].usr} to ${rows[0].db}`)
    console.log(`  server       ${rows[0].v.split(' ').slice(0, 2).join(' ')}`)

    const tables = await pool.query(`
      select table_name from information_schema.tables
       where table_schema='public' and table_type='BASE TABLE' order by table_name
    `)
    console.log(`  tables       ${tables.rows.map((r) => r.table_name).join(', ') || '(none)'}`)

    const journal = await pool
      .query(`select count(*)::int as n from drizzle.__drizzle_migrations`)
      .catch(() => null)
    console.log(
      `  migrations   ${journal ? journal.rows[0].n + ' applied' : 'journal table absent'}`,
    )
  } catch (error) {
    console.log(`  CONNECT FAILED: ${error.message}`)
  } finally {
    await pool.end().catch(() => {})
  }
}
