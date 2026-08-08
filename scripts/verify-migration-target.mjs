/**
 * Pre-write gate: proves where `drizzle-kit migrate` is about to write.
 *
 *   # Production
 *   $env:DATABASE_URL          = "<production POOLED string>"
 *   $env:DATABASE_URL_UNPOOLED = "<production DIRECT string>"
 *   $env:PRODUCTION_POOLED_URL = "<production POOLED string>"
 *   node scripts/verify-migration-target.mjs https://cloudmarket.cc --expect-migrations=8
 *
 *   # An isolated rehearsal copy
 *   $env:DATABASE_URL          = "<copy POOLED string>"
 *   $env:DATABASE_URL_UNPOOLED = "<copy DIRECT string>"
 *   node scripts/verify-migration-target.mjs https://cloudmarket.cc --rehearsal --expect-migrations=8
 *
 * BOTH halves of the pair are REQUIRED in both modes, and the gate refuses if
 * either is missing, if they are swapped, or if they are on different branches.
 * Setting only `DATABASE_URL_UNPOOLED` used to be tolerated with a warning; a
 * warning that an operator may proceed past is not a control, and the pair is
 * what makes "these two strings are the same database" checkable at all.
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
import { pathToFileURL } from 'node:url'
import { Pool, neonConfig } from '@neondatabase/serverless'

import { loadEnvFile } from './lib/env-file.mjs'
import {
  endpointFingerprint,
  evaluateDatabaseTarget,
  hostFingerprint,
  redactSecrets,
} from './lib/database-target.mjs'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

/**
 * Re-exported so `scripts/verify-migration-target-modes.mjs` keeps importing the
 * decision from the gate that uses it, while the decision itself lives in a
 * module that needs neither a database nor a network to test.
 */
export {
  evaluateIdentity,
  evaluateConnectionShape,
  KNOWN_FINGERPRINTS,
} from './lib/database-target.mjs'

/** Historic names, kept because other scripts import them. */
export const hostFp = hostFingerprint
export const endpointFp = endpointFingerprint

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
  /**
   * Replicate drizzle.config.ts exactly — BUT WITH A BOM-SAFE LOADER.
   *
   * `loadEnvFile` strips a UTF-8 byte order mark before parsing. Node's own
   * `--env-file` does not, which is how a `.env.local` saved by a Windows editor
   * can leave `DATABASE_URL` undefined while `process.env` still contains
   * something that PRINTS as `DATABASE_URL`. Under
   * `DATABASE_URL_UNPOOLED ?? DATABASE_URL` that does not raise an error, it
   * silently changes which database is written to. `evaluateDatabaseTarget`
   * refuses outright if any such key is present, whatever set it.
   */
  loadEnvFile('.env.local')
  loadEnvFile('.env')

  console.log(`Migration target verification (read-only) — ${MODE.toUpperCase()} mode\n`)

  /**
   * The live fingerprint is gathered BEFORE the decision, because the decision
   * is a pure function and takes it as an input. Everything printed below is a
   * fingerprint or a variable NAME; no connection string, hostname, user or
   * password is ever written to this terminal.
   */
  let health
  try {
    health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  } catch (error) {
    console.log(`  could not reach ${BASE}/api/health — ${error.message}`)
  }
  const liveFingerprint = health?.database?.fingerprint ?? null
  const liveEnvironment = health?.environment ?? null

  const decision = evaluateDatabaseTarget({
    mode: MODE,
    env: process.env,
    liveFingerprint,
    liveEnvironment,
  })
  problems.push(...decision.problems)

  const { resolvedHost, resolvedEndpoint, pooledHost, pooledEndpoint } = decision.fingerprints

  console.log('[1] What drizzle-kit will actually use')
  note(`resolved from:      ${decision.resolvedFrom ?? '(nothing — no connection string)'}`)
  note(`endpoint id:        ${resolvedEndpoint ?? '—'}`)
  note(`full hostname:      ${resolvedHost ?? '—'}`)

  console.log('\n[2] A — is the write target the same branch as the pooled string?')
  note(`pooled endpoint id: ${pooledEndpoint ?? '—'}`)
  note(
    `same branch:        ${
      resolvedEndpoint && pooledEndpoint ? (resolvedEndpoint === pooledEndpoint ? 'YES' : 'NO') : '—'
    }`,
  )

  console.log(
    MODE === 'rehearsal'
      ? '\n[3] B — is the target ISOLATED from production and development?'
      : '\n[3] B — does the pooled string match the deployed application?',
  )
  if (health) {
    note(`app reports:        ${liveFingerprint} (environment: ${liveEnvironment})`)
    note(`pooled hostname:    ${pooledHost ?? '—'}`)
    note(
      MODE === 'rehearsal'
        ? `isolated:           ${liveFingerprint !== pooledHost ? 'YES' : 'NO'}`
        : `anchored:           ${liveFingerprint === pooledHost ? 'YES' : 'NO'}`,
    )
  }

  /**
   * STOP BEFORE CONNECTING when the environment itself is unsound.
   *
   * The data-signature checks below open the resolved connection, and opening a
   * connection nobody has proved the identity of is the thing this gate exists
   * to prevent. A missing, swapped or cross-branch pair is a NO-GO on its own —
   * there is no value in reading a journal from a database we have just decided
   * we cannot identify.
   */
  if (problems.length > 0) {
    report()
    return
  }

  const resolved = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

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
    /**
     * REDACTED, because a connection failure is the one error here that quotes
     * its input back: `getaddrinfo ENOTFOUND ep-….neon.tech` names the host, and
     * an authentication failure names the user. This gate is run in a shell
     * holding a production credential, and its output is pasted into runbooks.
     */
    problems.push(`Could not read the target: ${redactSecrets(error.message)}`)
  } finally {
    await pool.end().catch(() => {})
  }

  report()
}

/** The verdict. Extracted so the environment checks can stop before connecting. */
function report() {
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
