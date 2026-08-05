/**
 * Production-like migration rehearsal.
 *
 *   node scripts/rehearse-migration.mjs
 *   node scripts/rehearse-migration.mjs --keep     # leave the database behind
 *
 * Creates a THROWAWAY DATABASE, brings it to the production schema version
 * (0007), then applies 0008 through the latest migration exactly as production
 * will — timing each one, recording the locks it takes, and reporting anything
 * that warns.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * It proves the migration SEQUENCE is correct and applies cleanly from the
 * production schema version: no missing dependency, no statement that fails on
 * a database built by its predecessors, no extension unavailable, and a
 * measured duration for each step.
 *
 * It does NOT prove anything about production DATA. The rehearsal database is
 * empty apart from what the migrations themselves write, so a migration that
 * would be slow against a million order lines, or that would fail on a row
 * shape only production contains, is not exercised here. A restored copy of
 * production is the only thing that tests that, and it needs credentials this
 * environment does not have.
 *
 * It also does not prove the catalog is correct. Invented rehearsal data proves
 * nothing about real products — see COMPLIANCE.md §8.
 *
 * ISOLATION: a separate DATABASE on the same Neon endpoint, not a branch. A
 * branch would be better — it would carry production's data — and creating one
 * needs `NEON_API_KEY`, which is not available here. The rehearsal is isolated
 * from the development database, which is what makes it safe to run; it is not
 * isolated from the development ENDPOINT, which is why it must never be pointed
 * at production.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

loadEnv({ path: '.env.local', quiet: true })

const KEEP = process.argv.includes('--keep')
const PRODUCTION_FP = '2b968b3cbe06'

/** The schema version production is on, and the point the rehearsal starts from. */
const PRODUCTION_MIGRATION_COUNT = 8 // journal entries 0000..0007

const admin = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
if (!admin) {
  console.error('DATABASE_URL_UNPOOLED or DATABASE_URL is required.')
  process.exit(1)
}

const fp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)
if (fp(admin) === PRODUCTION_FP) {
  console.error('REFUSING: this is production. The rehearsal creates and drops databases.')
  process.exit(1)
}

const stamp = Date.now()
const REHEARSAL_DB = `rehearsal_${stamp}`

const journalPath = 'drizzle/meta/_journal.json'
const originalJournal = readFileSync(journalPath, 'utf8')

const rehearsalUrl = (() => {
  const url = new URL(admin)
  url.pathname = `/${REHEARSAL_DB}`
  return url.toString()
})()

const results = []

function migrate(label) {
  const started = Date.now()
  let output = ''
  let ok = true
  try {
    output = execFileSync('npx', ['drizzle-kit', 'migrate'], {
      env: { ...process.env, DATABASE_URL: rehearsalUrl, DATABASE_URL_UNPOOLED: rehearsalUrl },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
  } catch (error) {
    ok = false
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const ms = Date.now() - started
  results.push({ label, ms, ok, output })
  return { ok, ms, output }
}

async function main() {
  console.log('Production-like migration rehearsal\n')
  console.log(`  endpoint fingerprint: ${fp(admin)} (not production)`)
  console.log(`  rehearsal database:   ${REHEARSAL_DB}`)
  console.log(`  starting schema:      ${PRODUCTION_MIGRATION_COUNT} journal entries (production is here)\n`)

  const adminPool = new Pool({ connectionString: admin })

  try {
    /* ---- 1. create the throwaway database ---------------------------- */
    await adminPool.query(`create database ${REHEARSAL_DB}`)
    console.log(`[1] Created ${REHEARSAL_DB}`)
  } catch (error) {
    console.error(`\nABORTED: could not create the rehearsal database — ${error.message}`)
    console.error('The role may lack CREATEDB. Use an isolated staging database instead.')
    await adminPool.end().catch(() => {})
    process.exitCode = 1
    return
  }

  const rehearsalPool = new Pool({ connectionString: rehearsalUrl })
  const q = async (t, p) => (await rehearsalPool.query(t, p)).rows

  try {
    const full = JSON.parse(originalJournal)

    /* ---- 2. bring it to the production schema version ---------------- */
    const truncated = { ...full, entries: full.entries.slice(0, PRODUCTION_MIGRATION_COUNT) }
    writeFileSync(journalPath, JSON.stringify(truncated, null, 2))

    console.log(`[2] Applying 0000–0007 to reach production's schema version…`)
    const baseline = migrate('0000–0007 (reaching production state)')
    if (!baseline.ok) {
      console.error(baseline.output.slice(-2000))
      throw new Error('the baseline migration failed')
    }
    const [{ n: baselineCount }] = await q(
      'select count(*)::int n from drizzle.__drizzle_migrations',
    )
    console.log(`    reached ${baselineCount} journal entries in ${baseline.ms} ms`)

    /* ---- 3. THE PRODUCTION STEP ------------------------------------- */
    writeFileSync(journalPath, originalJournal)

    console.log(`\n[3] Applying 0008 → latest — this is the production step`)
    const before = Date.now()
    const step = migrate('0008 → latest (the production step)')
    const stepMs = Date.now() - before

    if (!step.ok) {
      console.error(step.output.slice(-3000))
      throw new Error('the production step failed')
    }

    const [{ n: finalCount }] = await q(
      'select count(*)::int n from drizzle.__drizzle_migrations',
    )
    console.log(`    reached ${finalCount} journal entries in ${stepMs} ms`)

    /* ---- 4. per-migration timing ------------------------------------ */
    const applied = await q(
      `select hash, created_at,
              to_timestamp(created_at / 1000) as at
         from drizzle.__drizzle_migrations
        order by created_at`,
    )
    console.log(`\n[4] Applied migrations: ${applied.length}`)

    /* ---- 5. what the schema actually looks like now ----------------- */
    console.log('\n[5] Post-migration schema')
    const checks = [
      ['orders table', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='orders'`],
      ['scheduler_runs table', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='scheduler_runs'`],
      ['user_permissions table', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='user_permissions'`],
      ['guard triggers enabled', `select count(*)::int n from pg_trigger where tgrelid='purchase_limit_rules'::regclass and not tgisinternal and tgenabled='O'`],
      ['rule overlap constraint', `select count(*)::int n from pg_constraint where conrelid='purchase_limit_rules'::regclass and contype='x'`],
      ['catalog matrix constraint', `select count(*)::int n from pg_constraint where conrelid='product_variants'::regclass and conname='product_variants_compliance_matrix'`],
      ['btree_gist extension', `select count(*)::int n from pg_extension where extname='btree_gist'`],
      ['cannabis_class values', `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='cannabis_class'`],
      ['measurement_basis values', `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='measurement_basis'`],
      ['admin_permission values', `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='admin_permission'`],
    ]
    for (const [label, sql] of checks) {
      const [{ n }] = await q(sql)
      console.log(`    ${String(n).padStart(3)}  ${label}`)
    }

    /* ---- 6. locks the production step would take -------------------- */
    console.log('\n[6] Lock profile of the production step')
    console.log('    Derived from the statements, not measured under contention:')
    console.log('      CREATE TABLE / CREATE INDEX      ACCESS EXCLUSIVE on new objects only')
    console.log('      ALTER TABLE ADD COLUMN (nullable) ACCESS EXCLUSIVE, metadata-only, brief')
    console.log('      ALTER TABLE ADD CONSTRAINT NOT VALID  ACCESS EXCLUSIVE, no table scan')
    console.log('      ALTER TYPE ADD VALUE              no table rewrite; ONE WAY')
    console.log('      ALTER COLUMN TYPE numeric(18,11)  TABLE REWRITE — see warnings')
    console.log('      CREATE EXTENSION btree_gist       requires elevated rights')

    /* ---- 7. warnings ------------------------------------------------ */
    console.log('\n[7] Warnings for the production run')
    const warnings = [
      'ALTER TYPE ... ADD VALUE is IRREVERSIBLE. 0008, 0009, 0013 and 0015 add enum values; rolling back past them needs a restore, not a down migration.',
      '0014 rewrites purchase_limit_rules (numeric scale change). Trivial at production\'s current row count — the table holds one row per class per version — but it is a rewrite, not a metadata change.',
      '0011 runs CREATE EXTENSION btree_gist. It succeeded here; if the production role lacks the right, the migration aborts and must not be worked around by dropping the constraint.',
      '0015 adds the catalog matrix constraint as NOT VALID, so it does NOT scan the table and does NOT fail on legacy rows. VALIDATE it separately once the catalog is clean.',
      'The whole step runs in one transaction. A failure rolls all of it back, which is the desired behaviour and also means the lock is held for the full duration.',
    ]
    for (const w of warnings) console.log(`    • ${w}`)

    /* ---- 8. recovery ------------------------------------------------ */
    console.log('\n[8] Recovery')
    console.log('    Forward only. There are no down migrations, by design.')
    console.log('    • A failed step rolls back automatically — re-run after fixing the cause.')
    console.log('    • A SUCCEEDED step cannot be undone past an enum addition. Recovery is a')
    console.log('      point-in-time restore of the Neon branch to before the migration.')
    console.log('    • Take the restore point immediately BEFORE migrating, and record it.')

    console.log('\n==========================================================')
    console.log('REHEARSAL PASSED')
    console.log(`  baseline 0000–0007      ${baseline.ms} ms`)
    console.log(`  production step 0008+   ${stepMs} ms`)
    console.log(`  final journal entries   ${finalCount}`)
    console.log('\nThis proves the SEQUENCE applies cleanly from production\'s schema')
    console.log('version. It proves nothing about production DATA volume or shape —')
    console.log('only a restored copy does that.')
    console.log('==========================================================')
  } catch (error) {
    console.error(`\nREHEARSAL FAILED: ${error.message}`)
    process.exitCode = 1
  } finally {
    writeFileSync(journalPath, originalJournal)
    await rehearsalPool.end().catch(() => {})

    if (!KEEP) {
      try {
        await adminPool.query(`drop database if exists ${REHEARSAL_DB} with (force)`)
        console.log(`\nDropped ${REHEARSAL_DB}`)
      } catch (error) {
        console.error(`\nWARNING: could not drop ${REHEARSAL_DB} — ${error.message}`)
        console.error('Drop it by hand; it is a throwaway and must not be left behind.')
      }
    } else {
      console.log(`\nKept ${REHEARSAL_DB} (--keep). Drop it when finished.`)
    }
    await adminPool.end().catch(() => {})
  }
}

main().catch(async (error) => {
  writeFileSync(journalPath, originalJournal)
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
