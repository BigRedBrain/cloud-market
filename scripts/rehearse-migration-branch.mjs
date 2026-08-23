/**
 * Production-SHAPED migration rehearsal, on a fresh clone of production.
 *
 *   NEON_API_KEY=neon_api_... node scripts/rehearse-migration-branch.mjs
 *   NEON_API_KEY=neon_api_... node scripts/rehearse-migration-branch.mjs --step=0019 --keep
 *   NEON_API_KEY=neon_api_... node scripts/rehearse-migration-branch.mjs --cleanup=br-xxxx
 *
 * Creates a UNIQUELY NAMED Neon branch from the CURRENT default branch, applies
 * the one unapplied migration to the copy of `cloudmarket` that came with it,
 * and asserts what happened to the real rows. Then deletes the branch.
 *
 * WHY THIS EXISTS ALONGSIDE `rehearse-migration.mjs`
 *
 * That script creates an EMPTY database and proves the migration SEQUENCE
 * composes. It cannot prove anything about data, because there is none. For
 * 0019 the questions that matter are all data questions:
 *
 *   - does `ADD COLUMN target_role ... DEFAULT 'shopper' NOT NULL` actually
 *     succeed against a NON-EMPTY invite_codes, and does every existing row
 *     come out as `shopper`?
 *   - does swapping the redemption uniqueness rule leave existing redemption
 *     rows untouched?
 *
 * An empty database answers "yes" to both for the wrong reason. Only a copy
 * carrying production's rows answers them at all.
 *
 * WHY A FRESH BRANCH AND NEVER `development`
 *
 * `neon-dev-branch.mjs` deliberately REUSES a branch named `development` and
 * rewrites `.env.local` to point at it. Both behaviours are correct for its
 * job and disqualifying for this one: a reused branch is not a clone of current
 * production — it is a clone of production as it was whenever someone last
 * created it, plus whatever has been seeded into it since — and a rehearsal
 * that silently ran against stale, seeded data would produce confident, wrong
 * answers. This script refuses to reuse any branch, and never touches
 * `.env.local`.
 *
 * IMPORT SAFETY. `verify-migration-target.mjs` is imported for its constants
 * and pure helpers. Verified by inspection: its every I/O call (`loadEnv`,
 * `fetch`, `new Pool`, `query`) sits inside `main()`, and `main()` runs only
 * behind an `import.meta.url === pathToFileURL(process.argv[1]).href` guard.
 * Importing it executes no CLI, reads no credential and opens no connection.
 *
 * WHAT THIS NEVER DOES
 *
 *   - write to the default branch (asserted four ways before any mutation)
 *   - create or drop a database (the branch brings `cloudmarket` with it)
 *   - modify `_journal.json` (only 0019 is unapplied on a clone of production,
 *     so `drizzle-kit migrate` applies exactly it — asserted, not assumed)
 *   - write `.env.local`
 *   - print a connection string or a credential; fingerprints only
 *   - leave a row behind (the probes roll back, and that is then re-counted)
 *   - leave a connection open (the pool is closed in a `finally` that runs
 *     before branch deletion is attempted)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Pool, neonConfig } from '@neondatabase/serverless'

import {
  api,
  assertEndpointShape,
  connectionUri,
  findDefaultBranch,
  fingerprint,
  listBranches,
  requireApiKey,
  resolveProject,
} from './neon-api.mjs'
import { KNOWN_FINGERPRINTS, hostFp } from './verify-migration-target.mjs'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const SELF = 'scripts/rehearse-migration-branch.mjs'

const KEEP = process.argv.includes('--keep')
const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'https://cloudmarket.cc'
const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const API_KEY = requireApiKey(SELF)
const PROJECT_NAME = process.env.NEON_PROJECT_NAME ?? 'cloud-market'
const PROJECT_ID = process.env.NEON_PROJECT_ID
const DATABASE = process.env.NEON_DATABASE ?? 'cloudmarket'
const ROLE = process.env.NEON_ROLE ?? 'neondb_owner'

/**
 * A name that cannot collide with a previous run, and cannot be `development`.
 *
 * The timestamp is the freshness guarantee at the naming level; the assertions
 * below are the freshness guarantee that actually matters.
 */
const BRANCH_NAME =
  process.env.NEON_REHEARSAL_BRANCH ?? `rehearsal-${flag('step') ?? 'step'}-${Date.now()}`

const journalPath = 'drizzle/meta/_journal.json'
const journal = JSON.parse(readFileSync(journalPath, 'utf8'))

const requestedStep = flag('step')
const stepIndex = requestedStep
  ? journal.entries.findIndex((e) => e.tag.startsWith(requestedStep))
  : journal.entries.length - 1

const failures = []
const record = (ok, label, detail = '') => {
  if (!ok) failures.push(detail ? `${label} — ${detail}` : label)
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------- live identity ---- */

/**
 * The fingerprint of the database the DEPLOYED application is using.
 *
 * FAILS CLOSED, AND THIS IS THE POINT. An earlier version warned and carried on
 * when `/api/health` was unreachable, which quietly inverted the guarantee: the
 * recorded `KNOWN_FINGERPRINTS.productionHost` only protects against the
 * production database SOMEONE WROTE DOWN, so the live check is the only thing
 * that still works if production has moved to an endpoint no constant knows
 * about. Treating its absence as "proceed" means the one scenario the check
 * exists for — nobody updated the constant — is also the scenario in which
 * nothing is checked.
 *
 * Called BEFORE the branch is created and therefore long before any database
 * connection: an unverifiable production identity should cost nothing and
 * change nothing.
 */
async function requireLiveProductionFingerprint() {
  let res
  try {
    res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    throw new Error(
      `Could not reach ${BASE}/api/health (${error.message}). ` +
        'The live production identity is a required guard for this rehearsal and ' +
        'will not be downgraded to a warning. Fix connectivity, or pass a reachable ' +
        'base URL as the first argument.',
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
    throw new Error(
      `${BASE}/api/health returned no database fingerprint. ` +
        'Production identity cannot be established, so the rehearsal will not start.',
    )
  }

  return live.trim()
}

/**
 * Prove the branch about to be cloned IS the database the deployed app uses.
 *
 * THE GAP THIS CLOSES. Every other identity check in this script is of the form
 * "X is not production". None of them was of the form "the PARENT is
 * production", so the script would faithfully clone whatever branch happened to
 * be marked default in whatever project it was pointed at, and every downstream
 * check would pass — because a clone of the wrong database genuinely is not
 * production either.
 *
 * That is not hypothetical. A run against project `autumn-forest-66121161`
 * cloned a `production` branch sitting at 16 applied migrations with no
 * `invite_codes` table, and was caught only by a schema assertion three stages
 * later. Had that branch happened to be at the expected migration count, the
 * rehearsal would have reported PASS against a database unrelated to
 * production — which is worse than failing, because it would have been believed.
 *
 * NO SECRET LEAVES THIS FUNCTION. The connection URIs are fetched solely as
 * input to a hash: never printed, never logged, never written to disk, never
 * given to a Pool. Only the 12-hex digests are returned. This is the first
 * place in the rehearsal that holds a production credential at all, and it must
 * stay the only one.
 *
 * NO FALLBACK. A mismatch throws before anything is created.
 */
async function requireParentIsLiveProduction(projectId, parent, liveFingerprint) {
  const pooled = await connectionUri(API_KEY, projectId, parent.id, {
    database: DATABASE,
    role: ROLE,
    pooled: true,
  })
  const direct = await connectionUri(API_KEY, projectId, parent.id, {
    database: DATABASE,
    role: ROLE,
    pooled: false,
  })

  assertEndpointShape(pooled, direct)

  const parentPooled = hostFp(pooled)
  const parentDirect = hostFp(direct)
  console.log(`    parent pooled fingerprint ${parentPooled}`)
  console.log(`    parent direct fingerprint ${parentDirect}`)

  if (parentPooled !== liveFingerprint) {
    throw new Error(
      `The default branch "${parent.name}" (${parent.id}) of Neon project ${projectId} is ` +
        'NOT the database the deployed CloudMarket app is currently using.\n\n' +
        `    parent pooled fingerprint : ${parentPooled}\n` +
        `    live app fingerprint      : ${liveFingerprint}\n\n` +
        'Either NEON_PROJECT_ID points at the wrong Neon project, or the deployed app is ' +
        'served by a branch other than this project\'s default. Cloning this parent would ' +
        'rehearse the migration against data that has nothing to do with production, and ' +
        'a PASS would mean nothing.\n\n' +
        'Nothing has been created. No branch, no connection.',
    )
  }

  return { parentPooled, parentDirect }
}

/* ------------------------------------------------------------ cleanup ---- */

/**
 * Delete a rehearsal branch, refusing anything that is not one.
 *
 * The default-branch check is repeated here rather than trusted from the create
 * path, because this is also the manual recovery entry point (`--cleanup=`) and
 * a mistyped id at that moment would be unrecoverable.
 */
async function deleteBranch(projectId, branchId, expectedDefaultId) {
  if (branchId === expectedDefaultId) {
    throw new Error('REFUSING to delete the default (production) branch.')
  }
  const branches = await listBranches(API_KEY, projectId)
  const target = branches.find((b) => b.id === branchId)
  if (!target) {
    console.log(`    branch ${branchId} no longer exists`)
    return
  }
  if (target.default || target.primary) {
    throw new Error(`REFUSING: branch ${branchId} is marked default/primary.`)
  }
  if (!target.name.startsWith('rehearsal-')) {
    throw new Error(
      `REFUSING: branch "${target.name}" was not created by this script ` +
        '(name does not start with "rehearsal-").',
    )
  }
  await api(API_KEY, `/projects/${projectId}/branches/${branchId}`, { method: 'DELETE' })
  console.log(`    deleted branch ${branchId} ("${target.name}")`)
}

/* ------------------------------------------------------------- queries --- */

const BEFORE_QUERIES = {
  journalEntries: `select count(*)::int n from drizzle.__drizzle_migrations`,
  inviteCodes: `select count(*)::int n from invite_codes`,
  redemptions: `select count(*)::int n from invite_code_redemptions`,
  targetRoleColumn: `select count(*)::int n from information_schema.columns
                      where table_name='invite_codes' and column_name='target_role'`,
  marketplaceAccessTable: `select count(*)::int n from information_schema.tables
                            where table_schema='public' and table_name='marketplace_access'`,
}

/**
 * A digest over every redemption row, so "unchanged" means unchanged and not
 * merely "the same number of rows".
 */
const REDEMPTION_DIGEST = `
  select coalesce(
    md5(string_agg(id::text||':'||invite_code_id::text||':'||user_id::text||':'||redeemed_at::text,
                   ',' order by id)),
    'empty') d
    from invite_code_redemptions`

/**
 * ONE insert, in ITS OWN transaction, always rolled back.
 *
 * SEPARATE TRANSACTIONS ARE MANDATORY, NOT TIDINESS. Postgres puts a
 * transaction into an aborted state as soon as a statement raises, and every
 * subsequent statement in it fails with 25P02 until rollback. An earlier
 * version ran both probes inside one transaction: the duplicate insert raised
 * 23505 as intended, and the second insert then failed with "current
 * transaction is aborted" — which would have been reported as "the new
 * uniqueness model rejects a legitimate second invite". The probe would have
 * failed the rehearsal for a correct migration, every time.
 *
 * A dedicated connection per probe also means the expected failure cannot leak
 * into anything else running on a shared session.
 *
 * The ROLLBACK is awaited rather than fire-and-forget, and a failure propagates
 * to the caller. "Nothing persists" is the whole basis on which this probe is
 * safe to run against a clone of production data, and an unrolled-back
 * transaction is precisely the case where that stops being true.
 */
async function probeRedemptionInsert(pool, inviteCodeId, userId) {
  const client = await pool.connect()
  try {
    await client.query('begin')

    let outcome
    try {
      await client.query(
        'insert into invite_code_redemptions (invite_code_id, user_id) values ($1, $2)',
        [inviteCodeId, userId],
      )
      outcome = { accepted: true, code: null, message: null }
    } catch (error) {
      outcome = { accepted: false, code: error.code ?? null, message: error.message }
    }

    await client.query('rollback')
    return outcome
  } finally {
    client.release()
  }
}

async function main() {
  console.log('Production-shaped migration rehearsal\n')

  const project = await resolveProject(API_KEY, {
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
  })
  console.log(`  project: ${project.name} (${project.id})`)

  const branches = await listBranches(API_KEY, project.id)
  const parent = findDefaultBranch(branches)
  console.log(`  default (production) branch: "${parent.name}" (${parent.id})`)

  /* ---- manual recovery path -------------------------------------------- */
  const cleanupId = flag('cleanup')
  if (cleanupId) {
    console.log(`\n[cleanup] removing ${cleanupId}`)
    await deleteBranch(project.id, cleanupId, parent.id)
    return
  }

  /* ---- 0. the step under review ---------------------------------------- */
  if (stepIndex < 0) {
    throw new Error(`No journal entry matches --step=${requestedStep}.`)
  }
  if (stepIndex !== journal.entries.length - 1) {
    throw new Error(
      `"${journal.entries[stepIndex].tag}" is not the last journal entry, so it is not ` +
        'the only unapplied migration. Rehearse one step at a time.',
    )
  }
  const STEP_TAG = journal.entries[stepIndex].tag
  const EXPECTED_BEFORE = stepIndex // entries applied on production
  const EXPECTED_AFTER = journal.entries.length
  console.log(`  step under review: ${STEP_TAG}`)
  console.log(`  expecting ${EXPECTED_BEFORE} applied migrations on the clone, ${EXPECTED_AFTER} after\n`)

  /* ---- 1. live production identity, before anything else --------------- */
  console.log('[1] Live production identity (required)')
  const liveFingerprint = await requireLiveProductionFingerprint()
  console.log(`    live app database fingerprint: ${liveFingerprint}`)

  /*
   * ---- 2. THE PARENT MUST BE THAT DATABASE ----------------------------
   *
   * Runs before the freshness checks and long before branch creation: if the
   * parent is the wrong database, nothing else about this run is worth
   * evaluating, and nothing should be created to find that out.
   */
  console.log('\n[2] Parent branch identity (required)')
  await requireParentIsLiveProduction(project.id, parent, liveFingerprint)
  console.log('    parent IS the database the deployed app is using')

  /* ---- 3. FRESHNESS: refuse to reuse anything -------------------------- */
  console.log('\n[3] Branch freshness')
  record(BRANCH_NAME !== 'development', 'name is not "development"', BRANCH_NAME)
  record(BRANCH_NAME !== parent.name, 'name is not the default branch name', BRANCH_NAME)
  record(BRANCH_NAME.startsWith('rehearsal-'), 'name is a rehearsal name', BRANCH_NAME)
  record(
    !branches.some((b) => b.name === BRANCH_NAME),
    'no existing branch has this name',
    'a reused branch is not a clone of CURRENT production',
  )
  if (failures.length > 0) throw new Error('freshness checks failed — nothing was created')

  /* ---- 4. create the clone --------------------------------------------- */
  console.log(`\n[4] Creating "${BRANCH_NAME}" from "${parent.name}" (copy-on-write)…`)
  const created = await api(API_KEY, `/projects/${project.id}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: { name: BRANCH_NAME, parent_id: parent.id },
      endpoints: [{ type: 'read_write' }],
    }),
  })

  /*
   * Taken from the POST response only. A follow-up list lookup could return a
   * pre-existing branch of the same name, which is the exact thing the
   * freshness checks are there to prevent.
   */
  const branch = created.branch
  if (!branch?.id) throw new Error('Branch creation returned no branch.')
  console.log(`    created ${branch.id}`)
  console.log(`    parent_lsn ${branch.parent_lsn ?? '(none reported)'}`)
  console.log(`    parent_timestamp ${branch.parent_timestamp ?? '(none reported)'}`)

  let exitCode = 0
  /* Hoisted so the verdict can be printed after the pool has been closed. */
  let inviteCodesCarried = 0
  let redemptionsCarried = 0
  let migrationMs = 0

  try {
    /* ---- 5. PROVE THE CHILD IS NOT PRODUCTION, before any connection --- */
    console.log('\n[5] Child branch identity — before any database connection')
    record(branch.id !== parent.id, 'branch id differs from the default branch')
    record(branch.default !== true, 'branch is not marked default')
    record(branch.primary !== true, 'branch is not marked primary')
    record(branch.parent_id === parent.id, 'branch was cloned from the default branch')

    const pooled = await connectionUri(API_KEY, project.id, branch.id, {
      database: DATABASE,
      role: ROLE,
      pooled: true,
    })
    const direct = await connectionUri(API_KEY, project.id, branch.id, {
      database: DATABASE,
      role: ROLE,
      pooled: false,
    })
    assertEndpointShape(pooled, direct)

    console.log(`    pooled fingerprint ${fingerprint(pooled)}`)
    console.log(`    direct fingerprint ${fingerprint(direct)}`)

    /* Recorded constant — protects against the production database written down. */
    record(
      hostFp(direct) !== KNOWN_FINGERPRINTS.productionHost,
      'direct target is not the recorded production host',
    )
    record(
      hostFp(pooled) !== KNOWN_FINGERPRINTS.productionHost,
      'pooled target is not the recorded production host',
    )

    /* Live check — independent of every constant in this repository. */
    record(
      hostFp(pooled) !== liveFingerprint,
      'pooled target is not the database the live app uses',
    )
    record(
      hostFp(direct) !== liveFingerprint,
      'direct target is not the database the live app uses',
    )

    if (failures.length > 0) throw new Error('identity checks failed — nothing was written')

    /* ---- 6..9 all run against one pool, closed in the inner finally ---- */
    const pool = new Pool({ connectionString: direct })
    try {
      const q = async (text) => (await pool.query(text)).rows
      const one = async (text) => (await q(text))[0]

      /* ---- 6. BEFORE -------------------------------------------------- */
      console.log('\n[6] Before migrating')
      const before = {}
      for (const [key, sql] of Object.entries(BEFORE_QUERIES)) {
        before[key] = (await one(sql)).n
        console.log(`    ${String(before[key]).padStart(6)}  ${key}`)
      }
      before.redemptionDigest = (await one(REDEMPTION_DIGEST)).d
      console.log(`    ${before.redemptionDigest.slice(0, 12)}…  redemption digest`)

      inviteCodesCarried = before.inviteCodes
      redemptionsCarried = before.redemptions

      const beforeIndexes = (
        await q(`select indexname from pg_indexes where tablename='invite_code_redemptions' order by 1`)
      ).map((r) => r.indexname)
      console.log(`    redemption indexes: ${beforeIndexes.join(', ') || '(none)'}`)

      record(
        before.journalEntries === EXPECTED_BEFORE,
        `clone is at ${EXPECTED_BEFORE} applied migrations`,
        `found ${before.journalEntries} — this branch is NOT a clone of current production`,
      )
      record(before.targetRoleColumn === 0, 'target_role does not exist yet')
      record(before.marketplaceAccessTable === 0, 'marketplace_access does not exist yet')

      if (failures.length > 0) {
        throw new Error('pre-migration state is not what production looks like')
      }

      /* ---- 7. apply ONLY the unapplied migration ---------------------- */
      console.log(`\n[7] Applying ${STEP_TAG}`)
      console.log('    (only unapplied migrations run; the journal is NOT modified)')
      const started = Date.now()
      let migrateOk = true
      let output = ''
      try {
        output = execFileSync('npx', ['drizzle-kit', 'migrate'], {
          env: { ...process.env, DATABASE_URL: direct, DATABASE_URL_UNPOOLED: direct },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        })
      } catch (error) {
        migrateOk = false
        output = `${error.stdout ?? ''}${error.stderr ?? ''}`
      }
      migrationMs = Date.now() - started
      if (!migrateOk) {
        console.error(output.slice(-3000))
        throw new Error('the migration failed')
      }
      console.log(`    applied in ${migrationMs} ms`)

      /* ---- 8. AFTER ---------------------------------------------------- */
      console.log('\n[8] After migrating')

      const afterJournal = (await one(BEFORE_QUERIES.journalEntries)).n
      record(
        afterJournal === EXPECTED_AFTER,
        `exactly one migration was applied (${EXPECTED_BEFORE} -> ${EXPECTED_AFTER})`,
        `journal is at ${afterJournal}`,
      )

      const afterCodes = (await one(BEFORE_QUERIES.inviteCodes)).n
      record(
        afterCodes === before.inviteCodes,
        'invite_codes row count unchanged',
        `${before.inviteCodes} -> ${afterCodes}`,
      )

      const afterRedemptions = (await one(BEFORE_QUERIES.redemptions)).n
      record(
        afterRedemptions === before.redemptions,
        'invite_code_redemptions row count unchanged',
        `${before.redemptions} -> ${afterRedemptions}`,
      )

      const afterDigest = (await one(REDEMPTION_DIGEST)).d
      record(
        afterDigest === before.redemptionDigest,
        'every redemption row is byte-identical',
        'the digest changed',
      )

      const notShopper = (
        await one(`select count(*)::int n from invite_codes where target_role is distinct from 'shopper'`)
      ).n
      record(
        notShopper === 0,
        `all ${afterCodes} pre-existing invites are target_role='shopper'`,
        `${notShopper} row(s) are not`,
      )

      const defaultRow = await one(
        `select column_default, is_nullable from information_schema.columns
          where table_name='invite_codes' and column_name='target_role'`,
      )
      record(
        String(defaultRow?.column_default ?? '').includes('shopper'),
        "target_role default is 'shopper'",
        String(defaultRow?.column_default),
      )
      record(defaultRow?.is_nullable === 'NO', 'target_role is NOT NULL')

      const maTable = (await one(BEFORE_QUERIES.marketplaceAccessTable)).n
      record(maTable === 1, 'marketplace_access exists')
      if (maTable === 1) {
        const maRows = (await one(`select count(*)::int n from marketplace_access`)).n
        record(
          maRows === 0,
          'marketplace_access is empty — no user was silently granted access',
          `${maRows} row(s)`,
        )
      }

      const afterIndexes = (
        await q(`select indexname from pg_indexes where tablename='invite_code_redemptions' order by 1`)
      ).map((r) => r.indexname)
      console.log(`    redemption indexes: ${afterIndexes.join(', ') || '(none)'}`)
      record(
        afterIndexes.includes('invite_code_redemptions_invite_user_unique'),
        'composite unique index exists',
      )
      record(
        !afterIndexes.includes('invite_code_redemptions_user_unique'),
        'old user-only unique index is absent',
      )
      record(
        !afterIndexes.includes('invite_code_redemptions_invite_idx'),
        'old invite-id index is absent',
      )

      const composite = await one(
        `select indexdef from pg_indexes
          where indexname='invite_code_redemptions_invite_user_unique'`,
      )
      record(
        /UNIQUE/i.test(composite?.indexdef ?? '') &&
          /\(invite_code_id,\s*user_id\)/i.test(composite?.indexdef ?? ''),
        'composite index is UNIQUE on (invite_code_id, user_id)',
        composite?.indexdef ?? '(not found)',
      )

      /* ---- 9. the invariant itself, two independent transactions ------- */
      console.log('\n[9] Behavioural probe — separate transactions, each rolled back')
      const sample = await one(
        `select invite_code_id, user_id from invite_code_redemptions limit 1`,
      )
      const otherInvite = sample
        ? await one(`select id from invite_codes where id <> '${sample.invite_code_id}' limit 1`)
        : null

      if (!sample || !otherInvite) {
        console.log('    SKIPPED — needs at least one redemption and two invites on the clone')
      } else {
        try {
          const duplicate = await probeRedemptionInsert(
            pool,
            sample.invite_code_id,
            sample.user_id,
          )
          record(
            duplicate.accepted === false && duplicate.code === '23505',
            'TEST A: same user + SAME invite is rejected (23505)',
            `accepted=${duplicate.accepted} code=${duplicate.code ?? 'none'}`,
          )

          const alternate = await probeRedemptionInsert(pool, otherInvite.id, sample.user_id)
          record(
            alternate.accepted === true,
            'TEST B: same user + DIFFERENT invite is allowed (shopper -> vendor path)',
            `code=${alternate.code ?? 'none'} ${alternate.message ?? ''}`,
          )
        } catch (error) {
          /* A rollback that did not succeed. Rows may still be live. */
          record(false, 'both probe transactions rolled back cleanly', error.message)
        }

        /* Proof, not assumption: the row count must be exactly where it was. */
        const afterProbes = (await one(BEFORE_QUERIES.redemptions)).n
        record(
          afterProbes === afterRedemptions,
          'probes left ZERO persistent rows',
          `${afterRedemptions} -> ${afterProbes}`,
        )
      }
    } finally {
      /*
       * Runs on every path out of the block above, including a thrown
       * assertion, and BEFORE the outer finally attempts to delete the branch.
       * Deleting a branch with a live connection against it is the kind of
       * thing that half-works.
       */
      await pool.end().catch(() => {})
      console.log('\n    database pool closed')
    }

    /* ---- 10. verdict --------------------------------------------------- */
    console.log('\n==========================================================')
    if (failures.length > 0) {
      exitCode = 1
      console.error(`REHEARSAL FAILED — ${failures.length} check(s) did not pass`)
      for (const f of failures) console.error(`  • ${f}`)
      console.error('\nDO NOT APPLY THIS MIGRATION TO PRODUCTION.')
    } else {
      console.log('PRODUCTION-SHAPED REHEARSAL PASSED')
      console.log(`  invites carried            ${inviteCodesCarried}`)
      console.log(`  redemptions carried        ${redemptionsCarried}`)
      console.log(`  migration duration         ${migrationMs} ms`)
      console.log('\nThis ran against a clone of production taken at')
      console.log(`  parent_lsn ${branch.parent_lsn ?? '(unreported)'}`)
      console.log('Production has not been touched. Take a restore point before')
      console.log('the real run, and record it.')
    }
    console.log('==========================================================')
  } finally {
    if (KEEP) {
      console.log(`\nKept branch ${branch.id} ("${BRANCH_NAME}") — --keep.`)
      console.log(`Remove it with: node ${SELF} --cleanup=${branch.id}`)
    } else {
      console.log('\n[cleanup]')
      try {
        await deleteBranch(project.id, branch.id, parent.id)
      } catch (error) {
        console.error(`    WARNING: could not delete ${branch.id} — ${error.message}`)
        console.error(`    Remove it by hand: node ${SELF} --cleanup=${branch.id}`)
        exitCode = 1
      }
    }
  }

  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
