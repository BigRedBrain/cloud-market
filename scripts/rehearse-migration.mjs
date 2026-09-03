/**
 * Production-like migration rehearsal.
 *
 *   node scripts/rehearse-migration.mjs
 *   node scripts/rehearse-migration.mjs --step=0019
 *   node scripts/rehearse-migration.mjs --keep     # leave the database behind
 *
 * Creates a THROWAWAY DATABASE, brings it to the schema version production is
 * on, then applies the ONE migration under review exactly as production will —
 * timing it, recording the locks it takes, and reporting anything that warns.
 *
 * THE BASELINE IS DERIVED, NOT HARD-CODED. It used to be the literal `8`, with
 * a comment reading "journal entries 0000..0007". Production moved on; the
 * constant did not, and a stale baseline silently turns a one-migration
 * rehearsal into an eleven-migration one that proves nothing about the step
 * actually under review. The baseline is now every journal entry BEFORE the
 * step, and the script refuses to run unless the step is the last entry — so
 * adding 0020 without saying which one you mean is an error rather than a
 * silently wrong rehearsal.
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
 * ISOLATION: a separate DATABASE on the same Neon endpoint, not a branch. The
 * rehearsal is isolated from the development database, which is what makes it
 * safe to run; it is NOT isolated from the development ENDPOINT, which is why
 * it must never be pointed at production.
 *
 * That endpoint sharing is also why this script cannot simply delegate to
 * `evaluateIdentity(mode: 'rehearsal')`: that guard refuses the development
 * endpoint outright, which is precisely where this rehearsal is designed to
 * run. It uses the shared FINGERPRINTS instead, plus an independent live check.
 *
 * FOR A REHEARSAL AGAINST PRODUCTION-SHAPED DATA, use
 * `scripts/rehearse-migration-branch.mjs`, which clones the current default
 * branch and carries its rows. That is the only thing that tests a migration
 * against real data, and it is a different question from the one this script
 * answers.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

import { isProductionHostFingerprint } from './environment-fingerprints.mjs'
import { hostFp } from './verify-migration-target.mjs'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

loadEnv({ path: '.env.local', quiet: true })

const KEEP = process.argv.includes('--keep')
const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'https://cloudmarket.cc'
const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const pooled = process.env.DATABASE_URL
const admin = process.env.DATABASE_URL_UNPOOLED

if (!pooled || !admin) {
  console.error(
    'REFUSING: both DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (direct) are required.',
  )
  process.exit(1)
}

const endpointHost = (url) => new URL(url).hostname.replace('-pooler', '')

if (endpointHost(pooled) !== endpointHost(admin)) {
  console.error(
    'REFUSING: DATABASE_URL and DATABASE_URL_UNPOOLED do not identify the same Neon endpoint.',
  )
  process.exit(1)
}

const fp = (url) => hostFp(url)

for (const [label, url] of [
  ['DATABASE_URL', pooled],
  ['DATABASE_URL_UNPOOLED', admin],
]) {
  if (isProductionHostFingerprint(fp(url))) {
    console.error(
      `REFUSING: ${label} matches a current or retired production fingerprint. ` +
        'The rehearsal creates and drops databases.',
    )
    process.exit(1)
  }
}

const journalPath = 'drizzle/meta/_journal.json'
const journalBackupPath = `${journalPath}.rehearsal-backup`

/*
 * A LEFTOVER BACKUP IS EVIDENCE, NOT CLUTTER.
 *
 * This file is written immediately before the journal is truncated and removed
 * immediately after it is restored, so its presence means a previous rehearsal
 * did not finish — killed, crashed, or interrupted between those two points.
 * In that window `_journal.json` on disk may be a TRUNCATED copy, and the
 * backup next to it may be the only surviving record of the real one.
 *
 * Overwriting it would destroy exactly the thing needed to recover, so this
 * refuses to start and hands the decision to a person. Compare the two files
 * and restore by hand; delete the backup only once the journal is known good.
 */
if (existsSync(journalBackupPath)) {
  console.error(`REFUSING: ${journalBackupPath} already exists.`)
  console.error('')
  console.error('That file is only present while a rehearsal is mid-flight, so a previous run')
  console.error('was interrupted. The journal on disk may still be truncated, and this backup')
  console.error('may be the only intact copy of it.')
  console.error('')
  console.error('  1. diff it against drizzle/meta/_journal.json')
  console.error('  2. restore the journal by hand if they differ')
  console.error('  3. delete the backup once the journal is known good')
  console.error('')
  console.error('It will not be overwritten automatically.')
  process.exit(1)
}

const originalJournal = readFileSync(journalPath, 'utf8')
const journalAtStart = JSON.parse(originalJournal)

/* ------------------------------------------------ what is under review ---
 *
 * The step defaults to the LAST journal entry, which is the one a freshly
 * generated migration always is. Naming it explicitly with --step=0019 turns
 * that convenience into an assertion.
 */
const requestedStep = flag('step')
const stepIndex = requestedStep
  ? journalAtStart.entries.findIndex((e) => e.tag.startsWith(requestedStep))
  : journalAtStart.entries.length - 1

if (stepIndex < 0) {
  console.error(`REFUSING: no journal entry matches --step=${requestedStep}.`)
  process.exit(1)
}
if (stepIndex !== journalAtStart.entries.length - 1) {
  console.error(
    `REFUSING: "${journalAtStart.entries[stepIndex].tag}" is not the last journal entry, so it is ` +
      'not the only unapplied migration. Rehearse one step at a time.',
  )
  process.exit(1)
}

const STEP_TAG = journalAtStart.entries[stepIndex].tag
/** Every entry BEFORE the step — the schema version production is on. */
const PRODUCTION_MIGRATION_COUNT = stepIndex
const BASELINE_LABEL = `${journalAtStart.entries[0].tag.slice(0, 4)}–${
  journalAtStart.entries[stepIndex - 1]?.tag.slice(0, 4) ?? '????'
}`

const stamp = Date.now()
const REHEARSAL_DB = `rehearsal_${stamp}`

/**
 * PROTECTION 2 - live deployment identity check.
 *
 * The recorded fingerprints are protection 1, but production can move before
 * this repository is updated. Ask the deployed application which database it
 * is actually using.
 *
 * FAIL CLOSED. An unreachable, non-successful, malformed, or fingerprint-less
 * health response is not enough evidence to permit CREATE/DROP DATABASE.
 */
async function refuseIfLiveProduction() {
  let response

  try {
    response = await fetch(`${BASE}/api/health`, {
      signal: AbortSignal.timeout(8000),
    })
  } catch (error) {
    throw new Error(
      `REFUSING: could not read ${BASE}/api/health (${error.message}). ` +
        'Live production identity cannot be verified.',
    )
  }

  if (!response.ok) {
    throw new Error(
      `REFUSING: ${BASE}/api/health returned HTTP ${response.status}. ` +
        'Live production identity cannot be verified.',
    )
  }

  let health

  try {
    health = await response.json()
  } catch (error) {
    throw new Error(
      `REFUSING: ${BASE}/api/health returned invalid JSON (${error.message}).`,
    )
  }

  const live = health?.database?.fingerprint ?? null

  if (!live) {
    throw new Error(
      'REFUSING: /api/health did not provide a database fingerprint.',
    )
  }

  if (live === fp(pooled)) {
    throw new Error(
      'REFUSING: DATABASE_URL is the database used by the deployed application. ' +
        'The rehearsal creates and drops databases.',
    )
  }

  console.log(`    live app fingerprint: ${live} (target differs)`)
}

const rehearsalUrl = (() => {
  const url = new URL(admin)
  url.pathname = `/${REHEARSAL_DB}`
  return url.toString()
})()

const results = []
/** Expectation failures from section [5]. A non-empty list fails the run. */
const stepFailures = []

/**
 * Journal safety.
 *
 * This script TRUNCATES `_journal.json` on disk to reach the baseline, then
 * restores it. The `finally` block covers a thrown error; it does not cover
 * Ctrl-C, and a half-restored journal is a genuinely nasty thing to be left
 * with — especially while the migration under review is still uncommitted,
 * because then `git checkout` cannot recover it either.
 *
 * So a copy is written to disk before the first truncation and the interrupt
 * signals are handled. The backup is removed only after a successful restore.
 */
function restoreJournal() {
  /*
   * Written only when it actually differs, so a run that aborted before the
   * truncation leaves `_journal.json` untouched down to its mtime rather than
   * rewritten with identical bytes.
   */
  let current
  try {
    current = readFileSync(journalPath, 'utf8')
  } catch {
    current = null
  }
  if (current !== originalJournal) writeFileSync(journalPath, originalJournal)

  if (existsSync(journalBackupPath)) {
    try {
      unlinkSync(journalBackupPath)
    } catch {
      /* leaving the backup behind is strictly safer than failing here */
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`\n${signal} — restoring ${journalPath} before exiting.`)
    restoreJournal()
    process.exit(130)
  })
}

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
  console.log('Migration sequence rehearsal\n')
  console.log(`  endpoint fingerprint: ${fp(admin)} (not the recorded production one)`)
  await refuseIfLiveProduction()
  console.log(`  rehearsal database:   ${REHEARSAL_DB}`)
  console.log(`  step under review:    ${STEP_TAG}`)
  console.log(`  starting schema:      ${PRODUCTION_MIGRATION_COUNT} journal entries (${BASELINE_LABEL}) — production is here\n`)

  writeFileSync(journalBackupPath, originalJournal)

  const adminPool = new Pool({ connectionString: admin })

  try {
    /* ---- 1. create the throwaway database ---------------------------- */
    await adminPool.query(`create database ${REHEARSAL_DB}`)
    console.log(`[1] Created ${REHEARSAL_DB}`)
  } catch (error) {
    console.error(`\nABORTED: could not create the rehearsal database — ${error.message}`)
    console.error('The role may lack CREATEDB. Use an isolated staging database instead.')
    await adminPool.end().catch(() => {})
    /*
     * Nothing has been truncated yet — the journal is still exactly as it was
     * found — so the backup written moments ago protects nothing and would
     * only block the next run by looking like an interrupted rehearsal.
     * `restoreJournal` removes it and leaves `_journal.json` byte-identical
     * (it rewrites only on a genuine difference). The backup must exist ONLY
     * while a rehearsal could actually need recovering from it.
     */
    restoreJournal()
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

    console.log(`[2] Applying ${BASELINE_LABEL} to reach production's schema version…`)
    const baseline = migrate(`${BASELINE_LABEL} (reaching production state)`)
    if (!baseline.ok) {
      console.error(baseline.output.slice(-2000))
      throw new Error('the baseline migration failed')
    }
    const [{ n: baselineCount }] = await q(
      'select count(*)::int n from drizzle.__drizzle_migrations',
    )
    console.log(`    reached ${baselineCount} journal entries in ${baseline.ms} ms`)

    /*
     * ASSERTED, NOT LOGGED. A printed number nobody compares is how the old
     * `PRODUCTION_MIGRATION_COUNT = 8` survived eleven migrations: the script
     * kept reporting a baseline that had stopped being production's schema
     * version, and it read as success every time.
     *
     * If this is wrong, the "production step" below is being applied on top of
     * the wrong starting schema, and everything it goes on to prove is about a
     * database production never looked like.
     */
    if (baselineCount !== PRODUCTION_MIGRATION_COUNT) {
      throw new Error(
        `baseline reached ${baselineCount} applied migrations, expected ` +
          `${PRODUCTION_MIGRATION_COUNT} (${BASELINE_LABEL}). The rehearsal is not ` +
          "starting from production's schema version.",
      )
    }

    /* ---- 3. THE PRODUCTION STEP ------------------------------------- */
    writeFileSync(journalPath, originalJournal)

    console.log(`\n[3] Applying ${STEP_TAG} — this is the production step, and the only one`)
    const before = Date.now()
    const step = migrate(`${STEP_TAG} (the production step)`)
    const stepMs = Date.now() - before

    if (!step.ok) {
      console.error(step.output.slice(-3000))
      throw new Error('the production step failed')
    }

    const [{ n: finalCount }] = await q(
      'select count(*)::int n from drizzle.__drizzle_migrations',
    )
    console.log(`    reached ${finalCount} journal entries in ${stepMs} ms`)

    /*
     * Two assertions, because they fail for different reasons.
     *
     * The absolute check catches a journal that does not end where the
     * repository says it should. The delta check catches the case the absolute
     * one cannot see: MORE THAN ONE migration having been applied in the step.
     * That is the failure mode this whole script exists to prevent — a stale
     * baseline silently turning "rehearse 0019" into "rehearse 0008 through
     * 0019" — and it is invisible unless the arithmetic is checked.
     *
     * For 0019: 19 applied before (0000..0018), 20 after (0000..0019).
     */
    const expectedFinal = journalAtStart.entries.length
    if (finalCount !== expectedFinal) {
      throw new Error(
        `after ${STEP_TAG} the database reports ${finalCount} applied migrations, ` +
          `expected ${expectedFinal}.`,
      )
    }
    if (finalCount !== baselineCount + 1) {
      throw new Error(
        `${finalCount - baselineCount} migrations were applied in the step, expected ` +
          `exactly 1 (${baselineCount} -> ${finalCount}). ${STEP_TAG} was supposed to be ` +
          'the only unapplied migration.',
      )
    }
    console.log(
      `    verified: ${baselineCount} -> ${finalCount} applied migrations, exactly one step`,
    )

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

    /*
     * Two groups. The FOUNDATION group is a smoke test that the long-applied
     * migrations still compose — it is not what this run is about. The STEP
     * group asserts what the migration under review was supposed to do, with an
     * expected value, so a wrong answer FAILS rather than merely being printed.
     *
     * The old version of this section listed only foundation objects from Phase
     * 4 and printed counts nobody compared against anything, which is why it
     * survived eleven migrations without anyone noticing it had stopped saying
     * something useful.
     */
    const foundation = [
      ['orders table', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='orders'`],
      ['user_permissions table', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='user_permissions'`],
      ['btree_gist extension', `select count(*)::int n from pg_extension where extname='btree_gist'`],
      ['invite_codes table', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='invite_codes'`],
      ['admin_backup table', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='admin_backup'`],
    ]
    for (const [label, sql] of foundation) {
      const [{ n }] = await q(sql)
      console.log(`    ${String(n).padStart(3)}  ${label}`)
    }

    /* Expectations for 0019 specifically. Empty database, so no data claims. */
    const stepChecks =
      STEP_TAG.startsWith('0019')
        ? [
            ['marketplace_access table', 1, `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='marketplace_access'`],
            ['marketplace_access columns', 6, `select count(*)::int n from information_schema.columns where table_name='marketplace_access'`],
            ['marketplace_access rows', 0, `select count(*)::int n from marketplace_access`],
            ['marketplace_access user FK', 1, `select count(*)::int n from pg_constraint where conrelid='marketplace_access'::regclass and contype='f' and confrelid='users'::regclass`],
            ['invite_codes.target_role', 1, `select count(*)::int n from information_schema.columns where table_name='invite_codes' and column_name='target_role'`],
            ["target_role default 'shopper'", 1, `select count(*)::int n from information_schema.columns where table_name='invite_codes' and column_name='target_role' and column_default like '%shopper%'`],
            ['target_role NOT NULL', 1, `select count(*)::int n from information_schema.columns where table_name='invite_codes' and column_name='target_role' and is_nullable='NO'`],
            ['composite redemption unique', 1, `select count(*)::int n from pg_indexes where tablename='invite_code_redemptions' and indexname='invite_code_redemptions_invite_user_unique'`],
            ['old user-only unique GONE', 0, `select count(*)::int n from pg_indexes where tablename='invite_code_redemptions' and indexname='invite_code_redemptions_user_unique'`],
            ['old invite-id index GONE', 0, `select count(*)::int n from pg_indexes where tablename='invite_code_redemptions' and indexname='invite_code_redemptions_invite_idx'`],
            ['invite_target_role values', 2, `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='invite_target_role'`],
            ['marketplace_scope values', 2, `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='marketplace_scope'`],
            ['marketplace_access_status values', 3, `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='marketplace_access_status'`],
            ['no MARKETPLACE_* audit values', 0, `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='audit_event' and e.enumlabel like 'MARKETPLACE_%'`],
          ]
        : []

    if (stepChecks.length > 0) {
      console.log(`\n    Expectations for ${STEP_TAG}:`)
      for (const [label, expected, sql] of stepChecks) {
        const [{ n }] = await q(sql)
        const ok = n === expected
        if (!ok) stepFailures.push(`${label}: expected ${expected}, got ${n}`)
        console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label} (${n})`)
      }
    }

    /* ---- 6. locks the production step would take -------------------- */
    console.log('\n[6] Lock profile of the production step')
    console.log('    Derived from the statements, not measured under contention:')
    console.log('      CREATE TYPE                       no table lock')
    console.log('      CREATE TABLE                      ACCESS EXCLUSIVE on the new object only')
    console.log('      ALTER TABLE ADD COLUMN + constant DEFAULT')
    console.log('                                        ACCESS EXCLUSIVE, metadata-only in PG 11+,')
    console.log('                                        NO table rewrite regardless of row count')
    console.log('      ALTER TABLE ADD CONSTRAINT ... FK  ACCESS EXCLUSIVE on both sides; the new')
    console.log('                                        table is empty so validation is trivial')
    console.log('      CREATE INDEX (non-concurrent)     SHARE — blocks writes, allows reads')
    console.log('      DROP INDEX                        ACCESS EXCLUSIVE, brief')
    console.log('    CONCURRENTLY is unavailable: drizzle-kit wraps each migration in one')
    console.log('    transaction, and at these table sizes it is not needed.')

    /* ---- 7. warnings ------------------------------------------------ */
    console.log('\n[7] Warnings for the production run')
    const warnings =
      STEP_TAG.startsWith('0019')
        ? [
            'DROP INDEX "invite_code_redemptions_user_unique" IS THE ONE-WAY DOOR. It is reversible only until one user holds two redemptions; after that the index cannot be recreated and there is no rollback, only a forward fix.',
            'Statement ORDER in 0019 is hand-corrected. The composite CREATE UNIQUE INDEX must precede both DROPs, so the table is never left without uniqueness protection. Regenerating the file restores drizzle-kit\'s unsafe order — check it before applying.',
            'ADD COLUMN target_role carries a constant DEFAULT, so it backfills every existing invite as a catalog change with no table rewrite. This is what makes it safe against a NON-EMPTY production invite_codes.',
            'CREATE TYPE is reversible, but only after every dependent column is dropped. No audit_event values are added by this step, by decision — those arrive with the actions that emit them.',
            'THIS RUN PROVES NOTHING ABOUT ROWS. The database is empty, so "every existing invite becomes shopper" is untested here. Run scripts/rehearse-migration-branch.mjs against a fresh clone of the default branch before considering production.',
            'The whole step runs in one transaction. A failure rolls all of it back, which is the desired behaviour and also means the lock is held for the full duration.',
          ]
        : [
            'ALTER TYPE ... ADD VALUE is IRREVERSIBLE wherever a step uses it; rolling back past one needs a restore, not a down migration.',
            'The whole step runs in one transaction. A failure rolls all of it back, which is the desired behaviour and also means the lock is held for the full duration.',
            'An empty rehearsal database proves SEQUENCE only. Anything that depends on production row shape or volume is untested here.',
          ]
    for (const w of warnings) console.log(`    • ${w}`)

    /* ---- 8. recovery ------------------------------------------------ */
    console.log('\n[8] Recovery')
    console.log('    Forward only. There are no down migrations, by design.')
    console.log('    • A failed step rolls back automatically — re-run after fixing the cause.')
    console.log('    • A SUCCEEDED step cannot be undone past an enum addition. Recovery is a')
    console.log('      point-in-time restore of the Neon branch to before the migration.')
    console.log('    • Take the restore point immediately BEFORE migrating, and record it.')

    if (stepFailures.length > 0) {
      console.error('\n==========================================================')
      console.error(`REHEARSAL FAILED — ${stepFailures.length} expectation(s) not met`)
      for (const f of stepFailures) console.error(`  • ${f}`)
      console.error('==========================================================')
      throw new Error('post-migration expectations were not met')
    }

    console.log('\n==========================================================')
    console.log('SEQUENCE REHEARSAL PASSED')
    console.log(`  baseline ${BASELINE_LABEL}        ${baseline.ms} ms`)
    console.log(`  step ${STEP_TAG}   ${stepMs} ms`)
    console.log(`  final journal entries   ${finalCount}`)
    console.log('\nThis proves the SEQUENCE applies cleanly from production\'s schema')
    console.log('version, and that the step produced the objects it was supposed to.')
    console.log('It proves NOTHING about production DATA — the database was empty.')
    console.log('Next: scripts/rehearse-migration-branch.mjs, against a fresh clone')
    console.log('of the current default branch.')
    console.log('==========================================================')
  } catch (error) {
    console.error(`\nREHEARSAL FAILED: ${error.message}`)
    process.exitCode = 1
  } finally {
    restoreJournal()
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
  restoreJournal()
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
