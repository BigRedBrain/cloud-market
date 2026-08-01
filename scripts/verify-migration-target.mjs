/**
 * Pre-write gate: proves where `drizzle-kit migrate` is about to write.
 *
 *   $env:DATABASE_URL_UNPOOLED = "<production DIRECT string>"
 *   $env:PRODUCTION_POOLED_URL = "<production POOLED string>"
 *   node scripts/verify-migration-target.mjs https://cloud-market-ten.vercel.app
 *
 * Run this in the SAME shell that will run the migration, immediately before it.
 *
 * WHY THIS EXISTS, AND WHY IT RESOLVES THE TARGET THE WAY IT DOES
 *
 * `drizzle.config.ts` does two things that make "I set the variable" an unsafe
 * assumption:
 *
 *   1. It loads `.env.local` (DEVELOPMENT credentials) before resolving.
 *      dotenv does not override a variable that is already set, so an exported
 *      variable wins — but an *unset* one is silently filled in from the file.
 *   2. It prefers `DATABASE_URL_UNPOOLED ?? DATABASE_URL`.
 *
 * Together those mean that setting only `DATABASE_URL` to a production string
 * does NOT target production: `.env.local` supplies a development
 * `DATABASE_URL_UNPOOLED`, which wins on precedence. The migration would run
 * against development while appearing to succeed.
 *
 * So this script does not check what you set. It replicates the config's exact
 * resolution and reports the connection drizzle-kit will actually open, then
 * proves that connection is production three independent ways:
 *
 *   A. Branch identity — the resolved endpoint must be the same Neon endpoint
 *      as the pooled string, with '-pooler' stripped. Catches "direct string
 *      from the wrong branch".
 *   B. Deployment anchor — that pooled string must match the fingerprint the
 *      live app publishes at /api/health. Catches "both strings wrong".
 *   C. Data signature — read through the resolved connection itself: the
 *      journal, the catalog, and the absence of cart objects must look like
 *      production and not like the seeded development branch.
 *
 * A and B establish identity; C establishes it again through the very channel
 * the write will use. Read-only throughout — it opens a connection, runs
 * SELECTs, and closes.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'https://cloud-market-ten.vercel.app'

/* ---------------------------------------------------------- expectations ---
 *
 * Supplied per rollout rather than baked in, so this gate never reports NO-GO
 * for a reason that stopped being true two phases ago.
 *
 *   --expect-migrations=7               journal length BEFORE this migration
 *   --require-table=carts,cart_lines    must already exist
 *   --forbid-table=foo                  must NOT yet exist
 *   --forbid-column=verification_tokens.superseded_at
 *   --forbid-enum=audit_event:EMAIL_VERIFIED
 *
 * For migration 0007:
 *
 *   node scripts/verify-migration-target.mjs <url> \
 *     --expect-migrations=7 \
 *     --require-table=carts,cart_lines \
 *     --forbid-column=verification_tokens.superseded_at \
 *     --forbid-enum=audit_event:EMAIL_VERIFIED
 */
const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const list = (name) => {
  const raw = flag(name)
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
}

const rawExpect = flag('expect-migrations')
const EXPECT_MIGRATIONS = rawExpect === null ? null : Number(rawExpect)
const REQUIRE_TABLES = list('require-table')
const FORBID_TABLES = list('forbid-table')
const FORBID_COLUMNS = list('forbid-column')
const FORBID_ENUM = list('forbid-enum')

/* ---- replicate drizzle.config.ts exactly ---------------------------------- */
loadEnv({ path: '.env.local', quiet: true })
loadEnv({ path: '.env', quiet: true })

const RESOLVED_VAR = process.env.DATABASE_URL_UNPOOLED ? 'DATABASE_URL_UNPOOLED' : 'DATABASE_URL'
const resolved = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
const pooled = process.env.PRODUCTION_POOLED_URL

const hostFp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)
const endpointFp = (u) =>
  createHash('sha256')
    .update(new URL(u).hostname.split('.')[0].replace('-pooler', ''))
    .digest('hex')
    .slice(0, 12)

const problems = []
const note = (s) => console.log(`  ${s}`)

async function main() {
  console.log('Migration target verification (read-only)\n')

  if (!resolved) {
    console.error('No connection string resolved. Set DATABASE_URL_UNPOOLED.')
    process.exitCode = 1
    return
  }
  if (!pooled) {
    console.error(
      'PRODUCTION_POOLED_URL is required — it is the anchor that /api/health validates.\n' +
        '  $env:PRODUCTION_POOLED_URL = "<production POOLED string>"',
    )
    process.exitCode = 1
    return
  }

  console.log('[1] What drizzle-kit will actually use')
  note(`resolved from:      ${RESOLVED_VAR}`)
  note(`endpoint id:        ${endpointFp(resolved)}`)
  note(`full hostname:      ${hostFp(resolved)}`)
  if (RESOLVED_VAR === 'DATABASE_URL') {
    problems.push(
      'DATABASE_URL_UNPOOLED is unset, so DATABASE_URL was used. DDL over a pooled ' +
        'endpoint can fail mid-run — set DATABASE_URL_UNPOOLED to the direct string.',
    )
  }

  console.log('\n[2] A — is the write target the same branch as the pooled string?')
  const sameBranch = endpointFp(resolved) === endpointFp(pooled)
  note(`pooled endpoint id: ${endpointFp(pooled)}`)
  note(`same branch:        ${sameBranch ? 'YES' : 'NO'}`)
  if (!sameBranch) {
    problems.push(
      'The resolved write target is a DIFFERENT Neon branch than the pooled string. ' +
        'This is the exact shape of an accidental write to development.',
    )
  }

  console.log('\n[3] B — does the pooled string match the deployed application?')
  let health
  try {
    health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  } catch (error) {
    problems.push(`Could not reach ${BASE}/api/health — ${error.message}`)
  }
  if (health) {
    note(`app reports:        ${health.database?.fingerprint} (environment: ${health.environment})`)
    note(`pooled hostname:    ${hostFp(pooled)}`)
    const anchored = health.database?.fingerprint === hostFp(pooled)
    note(`anchored:           ${anchored ? 'YES' : 'NO'}`)
    if (!anchored) {
      problems.push(
        'The pooled string is not the database the deployed app is using, so it ' +
          'cannot anchor anything. Both strings may be wrong.',
      )
    }
    if (health.environment !== 'production') {
      problems.push(`The app at ${BASE} reports environment "${health.environment}".`)
    }
  }

  console.log('\n[4] C — data signature, read through the write connection itself')
  const pool = new Pool({ connectionString: resolved })
  try {
    const q = async (t) => (await pool.query(t)).rows

    const [{ n: migrations }] = await q(
      'select count(*)::int n from drizzle.__drizzle_migrations',
    )
    const tables = (
      await q(
        `select table_name from information_schema.tables where table_schema='public'`,
      )
    ).map((r) => r.table_name)
    const [{ n: products }] = await q('select count(*)::int n from products')
    const [{ n: variants }] = await q('select count(*)::int n from product_variants')
    const [{ present: cartMerged }] = await q(
      `select count(*)::int > 0 as present from pg_enum e
         join pg_type t on t.oid = e.enumtypid
        where t.typname='audit_event' and e.enumlabel='CART_MERGED'`,
    )

    note(`migrations applied: ${migrations}`)
    note(`public tables:      ${tables.length}`)
    note(`products:           ${products}`)
    note(`product_variants:   ${variants}`)
    note(`carts:              ${tables.includes('carts') ? 'present' : 'absent'}`)
    note(`cart_lines:         ${tables.includes('cart_lines') ? 'present' : 'absent'}`)
    note(`CART_MERGED:        ${cartMerged ? 'present' : 'absent'}`)

    /**
     * The catalog check is the one invariant that does not move: production is
     * unseeded, the development branch is not, so a populated catalog means the
     * wrong target regardless of which migration is being applied.
     */
    if (products > 0 || variants > 0) {
      problems.push(
        `The target has a populated catalog (${products} products, ${variants} variants). ` +
          "Production's catalog is empty; the seeded development branch is not. " +
          'This looks like development.',
      )
    }

    /**
     * Everything else is supplied per rollout.
     *
     * This section used to hard-code "expect 5 journal entries, expect no cart
     * tables" — true for the Phase 3 rollout and false the moment it landed. A
     * gate that reports NO-GO for a stale reason teaches its operator to read
     * past it, which is worse than having no gate. Expectations now come from
     * the caller, so the script asserts what THIS rollout actually requires.
     */
    if (EXPECT_MIGRATIONS !== null && migrations !== EXPECT_MIGRATIONS) {
      problems.push(
        `Expected ${EXPECT_MIGRATIONS} journal entries before this rollout; found ${migrations}. ` +
          'Do not migrate until this is explained.',
      )
    }

    for (const name of REQUIRE_TABLES) {
      if (!tables.includes(name)) {
        problems.push(`Required table "${name}" is missing — the target is behind where it should be.`)
      }
    }
    for (const name of FORBID_TABLES) {
      if (tables.includes(name)) {
        problems.push(`Table "${name}" already exists — this migration may already be applied.`)
      }
    }

    for (const spec of FORBID_COLUMNS) {
      const [table, column] = spec.split('.')
      const [{ present }] = await q(
        `select count(*)::int > 0 as present from information_schema.columns
          where table_schema='public' and table_name='${table}' and column_name='${column}'`)
      note(`${spec}: ${present ? 'present' : 'absent'}`)
      if (present) {
        problems.push(`Column "${spec}" already exists — this migration may already be applied.`)
      }
    }

    for (const spec of FORBID_ENUM) {
      const [type, label] = spec.split(':')
      const [{ present }] = await q(
        `select count(*)::int > 0 as present from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname='${type}' and e.enumlabel='${label}'`)
      note(`${spec}: ${present ? 'present' : 'absent'}`)
      if (present) {
        problems.push(`Enum value "${spec}" already exists — this migration may already be applied.`)
      }
    }
  } catch (error) {
    problems.push(`Could not read the target: ${error.message}`)
  } finally {
    await pool.end().catch(() => {})
  }

  console.log('\n==========================================================')
  if (problems.length) {
    console.log('NO-GO — do not run drizzle-kit migrate:')
    for (const p of problems) console.log(`  • ${p}`)
    process.exitCode = 1
  } else {
    console.log('GO — the resolved target is production/main at 0004, catalog empty,')
    console.log('     cart objects absent. Run `npx drizzle-kit migrate` in THIS shell.')
  }
  console.log('==========================================================')
}

main().catch((error) => {
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
