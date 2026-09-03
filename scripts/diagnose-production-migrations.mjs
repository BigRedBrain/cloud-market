/**
 * Read-only diagnostic: what migration state is production ACTUALLY in?
 *
 *   NEON_API_KEY=neon_api_... NEON_PROJECT_ID=... node scripts/diagnose-production-migrations.mjs
 *
 * READS ONLY. Every statement runs inside `BEGIN TRANSACTION READ ONLY` and is
 * followed by `ROLLBACK`, so the database itself rejects a write rather than
 * this script merely intending not to make one. No DDL, no DML, no
 * `drizzle-kit`, no branch, no `.env.local`.
 *
 * WHY IT EXISTS
 *
 * A production-shaped rehearsal reported a default branch at 16 applied
 * migrations with no `invite_codes` table, where 19 and a populated
 * `invite_codes` were expected. Two explanations fit equally well from outside:
 * the project id points at the wrong Neon project, or PRODUCTION IS GENUINELY
 * THREE MIGRATIONS BEHIND THE REPOSITORY. Those call for completely different
 * responses, and guessing between them is not acceptable when the next step is
 * a migration.
 *
 * WHAT "16" DOES NOT MEAN
 *
 * `drizzle.__drizzle_migrations` holds one row per APPLIED migration, so 16 is
 * a COUNT. Journal tags are 0-BASED INDICES. A count of 16 means the highest
 * applied index is 15 — that is, `0015_…` — and that `0016_…` is the first one
 * MISSING. The number and the tag look like the same fact and are not.
 *
 * AND THE COUNT ALONE PROVES NOTHING ABOUT WHICH ONES
 *
 * "16 rows" does not establish "0000..0015". It establishes "sixteen rows".
 * Drizzle does not store tag names — the table holds `id`, `hash` and
 * `created_at`, where `hash` is `sha256` of the migration FILE'S CONTENT
 * (`node_modules/drizzle-orm/migrator.js`). So this script reconciles the
 * applied hashes against locally computed ones, in order, and reports which
 * tags are actually applied. If the two histories diverge at any position it
 * reports MISMATCH and stops drawing conclusions, because at that point the
 * count means nothing at all.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, neonConfig } from '@neondatabase/serverless'

import {
  assertEndpointShape,
  connectionUri,
  findDefaultBranch,
  listBranches,
  requireApiKey,
} from './neon-api.mjs'
import { hostFp } from './verify-migration-target.mjs'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const SELF = 'scripts/diagnose-production-migrations.mjs'
const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'https://cloudmarket.cc'

const API_KEY = requireApiKey(SELF)

/**
 * REQUIRED, not defaulted, and not resolvable by name.
 *
 * Looking a project up by name is exactly how the wrong project got selected in
 * the first place. Naming the id makes the choice deliberate.
 */
const PROJECT_ID = process.env.NEON_PROJECT_ID
if (!PROJECT_ID) {
  console.error(
    'NEON_PROJECT_ID is required.\n' +
      'This diagnostic will not resolve a project by name — selecting the wrong project\n' +
      'is the failure it exists to investigate.\n\n' +
      `  NEON_API_KEY=neon_api_... NEON_PROJECT_ID=... node ${SELF}`,
  )
  process.exit(1)
}

const DATABASE = process.env.NEON_DATABASE ?? 'cloudmarket'
const ROLE = process.env.NEON_ROLE ?? 'neondb_owner'

/* ----------------------------------------------------- local history ----- */

const DRIZZLE_DIR = 'drizzle'
const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'))

/**
 * Both hash variants for one migration file.
 *
 * Drizzle hashes the file exactly as read from disk, so LINE ENDINGS CHANGE THE
 * HASH. This repository has `core.autocrlf=true`, which means a migration
 * applied from a CRLF working tree and the same migration read as LF produce
 * different digests for identical SQL. Computing both and accepting either
 * prevents reporting "not applied" for a migration that plainly is.
 */
function hashVariants(tag) {
  const raw = readFileSync(join(DRIZZLE_DIR, `${tag}.sql`), 'utf8')
  const lf = raw.replace(/\r\n/g, '\n')
  const crlf = lf.replace(/\n/g, '\r\n')
  const sha = (s) => createHash('sha256').update(s).digest('hex')
  return { lf: sha(lf), crlf: sha(crlf) }
}

const localHistory = journal.entries.map((entry) => ({
  idx: entry.idx,
  tag: entry.tag,
  ...hashVariants(entry.tag),
}))

/* ------------------------------------------------------- live identity --- */

/** Fail-closed, identical policy to the production-shaped rehearsal. */
async function requireLiveProductionFingerprint() {
  let res
  try {
    res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    throw new Error(
      `Could not reach ${BASE}/api/health (${error.message}). Production identity cannot ` +
        'be established, and this diagnostic will not connect to a database it cannot identify.',
    )
  }
  if (!res.ok) {
    throw new Error(`${BASE}/api/health returned HTTP ${res.status}; production identity unverifiable.`)
  }

  let body
  try {
    body = await res.json()
  } catch (error) {
    throw new Error(`${BASE}/api/health did not return JSON (${error.message}).`)
  }

  const live = body?.database?.fingerprint
  if (typeof live !== 'string' || live.trim().length === 0) {
    throw new Error(`${BASE}/api/health returned no database fingerprint.`)
  }
  return { fingerprint: live.trim(), environment: body?.environment ?? null }
}

/* ------------------------------------------------------------- queries --- */

const short = (h) => (typeof h === 'string' ? h.slice(0, 12) : String(h))

async function main() {
  console.log('Production migration-state diagnostic (READ ONLY)\n')

  /* ---- 1. control plane ------------------------------------------------ */
  const branches = await listBranches(API_KEY, PROJECT_ID)
  const parent = findDefaultBranch(branches)
  console.log('[1] Neon control plane')
  console.log(`    project id            ${PROJECT_ID}`)
  console.log(`    default branch        "${parent.name}" (${parent.id})`)

  /* ---- 2. live identity, fail-closed ----------------------------------- */
  console.log('\n[2] Live deployed application')
  const live = await requireLiveProductionFingerprint()
  console.log(`    ${BASE}/api/health`)
  console.log(`    environment           ${live.environment ?? '(not reported)'}`)
  console.log(`    database fingerprint  ${live.fingerprint}`)

  /* ---- 3. the parent must BE that database, before any connection ------ */
  console.log('\n[3] Parent branch identity (required before any query)')
  const pooled = await connectionUri(API_KEY, PROJECT_ID, parent.id, {
    database: DATABASE,
    role: ROLE,
    pooled: true,
  })
  const direct = await connectionUri(API_KEY, PROJECT_ID, parent.id, {
    database: DATABASE,
    role: ROLE,
    pooled: false,
  })
  assertEndpointShape(pooled, direct)

  /* URIs are hashed and discarded. Neither is printed, logged, or stored. */
  const parentPooled = hostFp(pooled)
  const parentDirect = hostFp(direct)
  console.log(`    parent pooled         ${parentPooled}`)
  console.log(`    parent direct         ${parentDirect}`)

  if (parentPooled !== live.fingerprint) {
    throw new Error(
      `The default branch "${parent.name}" of project ${PROJECT_ID} is NOT the database the ` +
        'deployed CloudMarket app is using.\n\n' +
        `    parent pooled : ${parentPooled}\n` +
        `    live app      : ${live.fingerprint}\n\n` +
        'NEON_PROJECT_ID points at the wrong project, or the app is served by a non-default ' +
        'branch. No connection was opened.',
    )
  }
  console.log('    MATCH — this is the live production database')

  /* ---- 4. read, and only read ------------------------------------------ */
  const pool = new Pool({ connectionString: direct })
  let client
  try {
    client = await pool.connect()

    /*
     * The database enforces this, not us. Any accidental write inside the
     * transaction fails with 25006 rather than succeeding against production.
     */
    await client.query('begin transaction read only')

    const q = async (text) => (await client.query(text)).rows
    const one = async (text) => (await q(text))[0]

    console.log('\n[4] Database identity')
    const dbRow = await one('select current_database() as db, version() as v')
    console.log(`    current_database()    ${dbRow.db}`)
    console.log(`    server                ${String(dbRow.v).split(' ').slice(0, 2).join(' ')}`)

    /* ---- 5. the migration ledger --------------------------------------- */
    console.log('\n[5] Applied migrations')
    const ledgerExists = (
      await one(
        `select count(*)::int n from information_schema.tables
          where table_schema='drizzle' and table_name='__drizzle_migrations'`,
      )
    ).n

    if (ledgerExists === 0) {
      console.log('    drizzle.__drizzle_migrations DOES NOT EXIST.')
      console.log('    This database has never been migrated by drizzle-kit.')
      await client.query('rollback')
      return
    }

    const applied = await q(
      `select hash, created_at, to_timestamp(created_at / 1000) at time zone 'UTC' as applied_at
         from drizzle.__drizzle_migrations
        order by created_at`,
    )
    console.log(`    row count             ${applied.length}`)
    console.log(`    repository journal    ${journal.entries.length} entries (${journal.entries[0].tag} … ${journal.entries.at(-1).tag})`)

    console.log('\n    latest 8 rows (hash abbreviated; hashes are not secrets):')
    for (const row of applied.slice(-8)) {
      console.log(`      ${short(row.hash)}  ${row.applied_at?.toISOString?.() ?? row.applied_at}`)
    }

    /* ---- 6. reconcile against the repository, IN ORDER ------------------ */
    console.log('\n[6] History reconciliation')
    console.log('    Drizzle stores hashes, never tag names, so tags are resolved by')
    console.log('    matching sha256 of each local migration file (CRLF and LF variants).')

    let matched = 0
    let divergedAt = null
    for (let i = 0; i < applied.length; i += 1) {
      const localEntry = localHistory[i]
      const dbHash = applied[i].hash
      if (!localEntry) {
        divergedAt = i
        console.log(`    position ${i}: applied ${short(dbHash)} — the repository has no entry here`)
        break
      }
      if (dbHash === localEntry.crlf || dbHash === localEntry.lf) {
        matched += 1
      } else {
        divergedAt = i
        console.log(`    position ${i}: applied ${short(dbHash)} does NOT match ${localEntry.tag}`)
        console.log(`                  expected ${short(localEntry.crlf)} (CRLF) or ${short(localEntry.lf)} (LF)`)
        break
      }
    }

    if (divergedAt !== null) {
      console.log('')
      console.log('    ############ MISMATCH ############')
      console.log(`    Repository and database history diverge at position ${divergedAt}.`)
      console.log('    NO CONCLUSION IS DRAWN about which migrations are applied: once the')
      console.log('    sequences differ, the row count describes a history this repository')
      console.log('    does not contain. A migration file edited after being applied produces')
      console.log('    exactly this symptom and is NOT the same thing as an unapplied')
      console.log('    migration — establish which before going further.')
      console.log('    ##################################')
      await client.query('rollback')
      return
    }

    console.log(`    ${matched} of ${applied.length} applied rows match the repository, in order.`)
    const appliedTags = localHistory.slice(0, matched).map((e) => e.tag)
    console.log(`    applied  ${appliedTags[0]} … ${appliedTags.at(-1)}`)

    const pending = localHistory.slice(matched)
    if (pending.length === 0) {
      console.log('    pending  (none — the database is at the repository head)')
    } else {
      console.log(`    pending  ${pending.length} migration(s) NOT applied:`)
      for (const entry of pending) console.log(`               ${entry.tag}`)
    }

    /* ---- 7. corroborating object probes -------------------------------- */
    console.log('\n[7] Schema objects (independent corroboration)')
    const probes = [
      ['0016  media_kind type', `select count(*)::int n from pg_type where typname='media_kind'`],
      ['0016  media.storage_key', `select count(*)::int n from information_schema.columns where table_name='media' and column_name='storage_key'`],
      ['0017  invite_codes', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='invite_codes'`],
      ['0017  invite_code_redemptions', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='invite_code_redemptions'`],
      ['0017  admin_backup', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='admin_backup'`],
      ['0017  payment_intents', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='payment_intents'`],
      ['0017  audit INVITE_CREATED', `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='audit_event' and e.enumlabel='INVITE_CREATED'`],
      ['0017  audit ADMIN_ACCESS_DENIED', `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='audit_event' and e.enumlabel='ADMIN_ACCESS_DENIED'`],
      ['0018  strain hybrid_i', `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='strain_type' and e.enumlabel='hybrid_i'`],
      ['0018  strain hybrid_s', `select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='strain_type' and e.enumlabel='hybrid_s'`],
      ['0019  invite_codes.target_role', `select count(*)::int n from information_schema.columns where table_name='invite_codes' and column_name='target_role'`],
      ['0019  marketplace_access', `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='marketplace_access'`],
    ]
    for (const [label, sql] of probes) {
      const n = (await one(sql)).n
      console.log(`    ${n === 1 ? 'present' : 'ABSENT '}  ${label}`)
    }

    /* ---- 8. what it means ---------------------------------------------- */
    console.log('\n[8] Reading')
    if (pending.length === 0) {
      console.log('    Production is at the repository head. Nothing is outstanding.')
    } else {
      console.log(`    Production is ${pending.length} migration(s) behind the repository.`)
      console.log('')
      console.log('    Applying the newest migration would apply ALL of the pending list in')
      console.log('    one transaction, not just the newest. Any plan that assumed a single')
      console.log('    step needs revisiting, including the derived baseline in')
      console.log('    scripts/rehearse-migration.mjs, which infers production\'s schema')
      console.log('    version from the repository journal rather than from production.')
    }

    await client.query('rollback')
    console.log('\n    transaction rolled back (it was READ ONLY throughout)')
  } finally {
    if (client) {
      try {
        await client.query('rollback')
      } catch {
        /* already rolled back, or the connection is gone; nothing was written either way */
      }
      client.release()
    }
    await pool.end().catch(() => {})
    console.log('    connection closed')
  }
}

main().catch((error) => {
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
