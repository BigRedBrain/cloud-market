/**
 * Pre-write gate: proves where `drizzle-kit migrate` is about to write.
 *
 *   # Production
 *   $env:DATABASE_URL_UNPOOLED = "<production DIRECT string>"
 *   $env:PRODUCTION_POOLED_URL = "<production POOLED string>"
 *   node scripts/verify-migration-target.mjs https://cloudmarket.cc --expect-migrations=8
 *
 *   # An isolated rehearsal copy
 *   $env:DATABASE_URL          = "<copy POOLED string>"
 *   $env:DATABASE_URL_UNPOOLED = "<copy DIRECT string>"
 *   node scripts/verify-migration-target.mjs https://cloudmarket.cc --rehearsal --expect-migrations=8
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
 * proves that connection is the intended target three independent ways:
 *
 *   A. Branch identity — the resolved endpoint must be the same Neon endpoint
 *      as the pooled string, with '-pooler' stripped. Catches "direct string
 *      from the wrong branch".
 *   B. Deployment anchor — see the two modes below.
 *   C. Data signature — read through the resolved connection itself: the
 *      journal, the catalog, and the absence of cart objects must look like the
 *      expected target and not like the seeded development branch.
 *
 * THE TWO MODES, AND WHY CHECK B INVERTS
 *
 * Check B is the only check whose expectation depends on what you are writing
 * to, so it is the only one that changes between modes.
 *
 *   PRODUCTION (default) — the pooled string MUST match the fingerprint the
 *   live application publishes at /api/health. Anything else means you are not
 *   pointed at the database the deployed app is using.
 *
 *   REHEARSAL (--rehearsal) — the target MUST NOT match that fingerprint, and
 *   must not match the known production or development fingerprints either. A
 *   correctly isolated copy is *defined* by not being production; a rehearsal
 *   that anchored to production would be a rehearsal against production.
 *
 * This mode exists because the alternative was telling operators that a NO-GO
 * is sometimes expected. It never is. A NO-GO always means stop — the mode
 * changes what is being asserted, not whether the answer may be ignored.
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

/**
 * Known identities, so a rehearsal can be refused for pointing at production or
 * development even when /api/health is unreachable. Fingerprints are SHA-256 of
 * the hostname (or of the endpoint id with '-pooler' stripped), first 12 hex —
 * they identify a database without disclosing one.
 */
export const KNOWN_FINGERPRINTS = {
  productionHost: '2b968b3cbe06',
  developmentHosts: ['eec6912eb35b', '3c503c1409d2'],
  developmentEndpoint: 'a5d81ac199d8',
}

export const hostFp = (u) =>
  createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)
export const endpointFp = (u) =>
  createHash('sha256')
    .update(new URL(u).hostname.split('.')[0].replace('-pooler', ''))
    .digest('hex')
    .slice(0, 12)

/**
 * The identity decision, as a pure function of fingerprints.
 *
 * Extracted so both modes can be tested without a database, a network or a
 * credential — the part worth testing is the expectation, not the plumbing.
 *
 * @param {object} input
 * @param {'production'|'rehearsal'} input.mode
 * @param {string} input.resolvedHost      hostFp of the string drizzle-kit will open
 * @param {string} input.resolvedEndpoint  endpointFp of the same
 * @param {string} input.pooledHost        hostFp of the pooled string
 * @param {string} input.pooledEndpoint    endpointFp of the same
 * @param {string|null} input.liveFingerprint    what /api/health published, or null
 * @param {string|null} input.liveEnvironment    what /api/health called itself, or null
 * @returns {string[]} problems; empty means the identity checks passed
 */
export function evaluateIdentity({
  mode,
  resolvedHost,
  resolvedEndpoint,
  pooledHost,
  pooledEndpoint,
  liveFingerprint,
  liveEnvironment,
}) {
  const problems = []

  /* ---- A. both strings must be the same Neon branch, in BOTH modes ------- */
  if (resolvedEndpoint !== pooledEndpoint) {
    problems.push(
      'The resolved write target is a DIFFERENT Neon branch than the pooled string. ' +
        'This is the exact shape of an accidental write to development.',
    )
  }

  if (mode === 'production') {
    /* ---- B. must BE the database the live application is using ----------- */
    if (liveFingerprint === null) {
      problems.push('Could not read the live application fingerprint, so nothing anchors this target.')
    } else if (liveFingerprint !== pooledHost) {
      problems.push(
        'The pooled string is not the database the deployed app is using, so it ' +
          'cannot anchor anything. Both strings may be wrong.',
      )
    }
    if (liveEnvironment !== null && liveEnvironment !== 'production') {
      problems.push(`The app reports environment "${liveEnvironment}", not "production".`)
    }
    return problems
  }

  /* ---- B (inverted). must NOT be production, and must not be development - */
  for (const [label, fp] of [
    ['resolved write target', resolvedHost],
    ['pooled string', pooledHost],
  ]) {
    if (liveFingerprint !== null && fp === liveFingerprint) {
      problems.push(
        `The ${label} IS the database the live application is using. A rehearsal ` +
          'must never be run against production.',
      )
    }
    if (fp === KNOWN_FINGERPRINTS.productionHost) {
      problems.push(`The ${label} matches the known production fingerprint.`)
    }
    if (KNOWN_FINGERPRINTS.developmentHosts.includes(fp)) {
      problems.push(
        `The ${label} matches the known development fingerprint. A rehearsal must ` +
          'be an isolated copy of production, not the development database.',
      )
    }
  }
  for (const [label, fp] of [
    ['resolved write target', resolvedEndpoint],
    ['pooled string', pooledEndpoint],
  ]) {
    if (fp === KNOWN_FINGERPRINTS.developmentEndpoint) {
      problems.push(`The ${label} is on the known development endpoint.`)
    }
  }

  return problems
}

const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'https://cloudmarket.cc'

/* ---------------------------------------------------------- expectations ---
 *
 * Supplied per rollout rather than baked in, so this gate never reports NO-GO
 * for a reason that stopped being true two phases ago.
 *
 *   --rehearsal                         verify an isolated copy, not production
 *   --expect-migrations=8               journal length BEFORE this migration
 *   --require-table=carts,cart_lines    must already exist
 *   --forbid-table=foo                  must NOT yet exist
 *   --forbid-column=verification_tokens.superseded_at
 *   --forbid-enum=audit_event:EMAIL_VERIFIED
 */
const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const list = (name) => {
  const raw = flag(name)
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
}

const MODE = process.argv.includes('--rehearsal') ? 'rehearsal' : 'production'
const rawExpect = flag('expect-migrations')
const EXPECT_MIGRATIONS = rawExpect === null ? null : Number(rawExpect)
const REQUIRE_TABLES = list('require-table')
const FORBID_TABLES = list('forbid-table')
const FORBID_COLUMNS = list('forbid-column')
const FORBID_ENUM = list('forbid-enum')

const problems = []
const note = (s) => console.log(`  ${s}`)

async function main() {
  /* ---- replicate drizzle.config.ts exactly -------------------------------- */
  loadEnv({ path: '.env.local', quiet: true })
  loadEnv({ path: '.env', quiet: true })

  const RESOLVED_VAR = process.env.DATABASE_URL_UNPOOLED ? 'DATABASE_URL_UNPOOLED' : 'DATABASE_URL'
  const resolved = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

  /**
   * In production the anchor is the production POOLED string, supplied
   * explicitly. In a rehearsal there is no production credential in the room —
   * and there must not be — so the pooled half of the pair being verified is
   * the copy's own DATABASE_URL.
   */
  const pooled = MODE === 'rehearsal' ? process.env.DATABASE_URL : process.env.PRODUCTION_POOLED_URL

  console.log(`Migration target verification (read-only) — ${MODE.toUpperCase()} mode\n`)

  if (!resolved) {
    console.error('No connection string resolved. Set DATABASE_URL_UNPOOLED.')
    process.exitCode = 1
    return
  }
  if (!pooled) {
    console.error(
      MODE === 'rehearsal'
        ? 'DATABASE_URL is required in --rehearsal mode — it is the pooled half of the pair being verified.\n' +
            '  $env:DATABASE_URL = "<the copy\'s POOLED string>"'
        : 'PRODUCTION_POOLED_URL is required — it is the anchor that /api/health validates.\n' +
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
  note(`pooled endpoint id: ${endpointFp(pooled)}`)
  note(`same branch:        ${endpointFp(resolved) === endpointFp(pooled) ? 'YES' : 'NO'}`)

  console.log(
    MODE === 'rehearsal'
      ? '\n[3] B — is the target ISOLATED from production and development?'
      : '\n[3] B — does the pooled string match the deployed application?',
  )
  let health
  try {
    health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  } catch (error) {
    note(`could not reach ${BASE}/api/health — ${error.message}`)
  }
  const liveFingerprint = health?.database?.fingerprint ?? null
  const liveEnvironment = health?.environment ?? null
  if (health) {
    note(`app reports:        ${liveFingerprint} (environment: ${liveEnvironment})`)
    note(`pooled hostname:    ${hostFp(pooled)}`)
    note(
      MODE === 'rehearsal'
        ? `isolated:           ${liveFingerprint !== hostFp(pooled) ? 'YES' : 'NO'}`
        : `anchored:           ${liveFingerprint === hostFp(pooled) ? 'YES' : 'NO'}`,
    )
  }

  problems.push(
    ...evaluateIdentity({
      mode: MODE,
      resolvedHost: hostFp(resolved),
      resolvedEndpoint: endpointFp(resolved),
      pooledHost: hostFp(pooled),
      pooledEndpoint: endpointFp(pooled),
      liveFingerprint,
      liveEnvironment,
    }),
  )

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
     * wrong target regardless of which migration is being applied. It holds in
     * rehearsal mode too — a copy of production inherits production's empty
     * catalog, so a populated one means the copy is not what it claims to be.
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
    console.log('\nA NO-GO is a stop. Resolve the reason; do not proceed past it.')
    process.exitCode = 1
  } else {
    console.log(
      MODE === 'rehearsal'
        ? 'GO — the resolved target is an isolated copy: not production, not development,'
        : 'GO — the resolved target is the production database the live app is using,',
    )
    console.log(
      `     both strings on one branch, catalog empty${
        EXPECT_MIGRATIONS === null ? '' : `, journal at ${EXPECT_MIGRATIONS}`
      }.`,
    )
    console.log('     Run `npx drizzle-kit migrate` in THIS shell.')
  }
  console.log('==========================================================')
}

/** Only run when executed directly, so the pure logic above can be imported. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nABORTED: ${error.message}`)
    process.exitCode = 1
  })
}
