/**
 * Production-SHAPED migration rehearsal, on a disposable clone of production.
 *
 *   NEON_API_KEY=neon_api_... node scripts/rehearse-migration-branch.mjs
 *   NEON_API_KEY=neon_api_... node scripts/rehearse-migration-branch.mjs --cleanup=br-xxxx
 *
 * Clones the Neon branch the DEPLOYED APPLICATION IS ACTUALLY USING, proves the
 * clone is a clone and not production, reconciles its migration ledger against
 * this repository exactly, applies the pending stack ONCE through the
 * repository's own `drizzle-kit migrate`, reconciles again, proves the resulting
 * behaviour, and deletes the clone. Production is never written to and never
 * connected to.
 *
 * WHY IT IS SHAPED THIS WAY
 *
 * `rehearse-migration.mjs` builds an EMPTY database and proves the sequence
 * composes. It cannot prove anything about data, because there is none. This
 * script answers the questions an empty database answers for the wrong reason:
 * does `ADD COLUMN ... DEFAULT ... NOT NULL` succeed against populated tables,
 * do existing rows survive byte-identical, does the new uniqueness model behave.
 *
 * THE FOUR REFUSALS THAT MATTER
 *
 *   1. THE PARENT MUST BE LIVE PRODUCTION. Every other identity check is of the
 *      form "X is not production", and a clone of the wrong database passes all
 *      of them — because it genuinely is not production either. A run that
 *      cloned an unrelated project's `production` branch once got three stages
 *      in before a schema assertion caught it. Had that branch been at the
 *      expected migration count, the rehearsal would have reported PASS about a
 *      database nobody uses, which is worse than failing because it would have
 *      been believed.
 *
 *   2. THE LEDGER MUST RECONCILE EXACTLY. Not "sixteen rows" — the sixteen
 *      rows, in order, with this repository's hashes and this repository's
 *      timestamps. A count cannot tell "production is at 0015" apart from
 *      "production is at sixteen migrations that are not these".
 *
 *   3. PRE-EXISTING OBJECTS ARE DRIFT, NEVER PROGRESS. If `hybrid_i` already
 *      exists while 0018 is unrecorded, that is a schema and a ledger
 *      disagreeing, and `ADD VALUE IF NOT EXISTS` is exactly the statement that
 *      would paper over it. The run stops before any migration command exists in
 *      the process.
 *
 *   4. A PROBE THAT DID NOT RUN IS A FAILED PROBE. The previous version printed
 *      "SKIPPED — needs at least one redemption" and went on to report PASS.
 *      Every probe here builds its own rows inside a transaction that is rolled
 *      back, so SKIP is not a state it can reach; if one is missing, not
 *      reached, or failed, the verdict is FAILED.
 *
 * WHAT THIS NEVER DOES
 *
 *   - connect to production (its connection URI is fetched only to be hashed,
 *     never printed, never logged, never handed to a Pool)
 *   - write to the default branch, or create or drop a database
 *   - execute a migration file itself, split SQL, or write the drizzle ledger
 *   - truncate `_journal.json`, pass `--step`, skip a migration, or edit any
 *     migration file (the repository files are re-read afterwards and proved
 *     unchanged)
 *   - touch `.env.local`, or print a connection string or credential
 *   - leave a branch, a row, or a connection behind
 *
 * IMPORT SAFETY. `verify-migration-target.mjs` is imported for its pure
 * fingerprint helpers. Verified by inspection: every I/O call it makes sits
 * inside `main()`, which runs only behind an `import.meta.url` guard. Importing
 * it executes no CLI, reads no credential, and opens no connection.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool, neonConfig } from '@neondatabase/serverless'

import { PRODUCTION_HOST_FINGERPRINT } from './environment-fingerprints.mjs'
import {
  api,
  assertEndpointShape,
  connectionUri,
  listBranches,
  requireApiKey,
  resolveProject,
} from './neon-api.mjs'
import { endpointFp, hostFp } from './verify-migration-target.mjs'
import {
  ALL_TAGS,
  PENDING_TAGS,
  RECORDED_TAGS,
  REQUIRED_PROBES,
  buildObservedKeys,
  buildPendingInventory,
  buildRepositoryMigrations,
  createMigrationGate,
  derivePendingStack,
  evaluateApplied,
  evaluateBranchTopology,
  evaluateCloneMetadata,
  evaluateCloneTargets,
  evaluateDeletionGuard,
  evaluateDrift,
  evaluateHealthIdentity,
  evaluateProbeOutcomes,
  reconcileLedger,
  rehearsalBranchName,
} from './rehearse-migration-branch-core.mjs'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const SELF = 'scripts/rehearse-migration-branch.mjs'

const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'https://cloudmarket.cc'
const PROJECT_NAME = process.env.NEON_PROJECT_NAME ?? 'cloud-market'
const PROJECT_ID = process.env.NEON_PROJECT_ID
const DATABASE = process.env.NEON_DATABASE ?? 'cloudmarket'
const ROLE = process.env.NEON_ROLE ?? 'neondb_owner'

const JOURNAL_PATH = 'drizzle/meta/_journal.json'
const migrationPath = (tag) => `drizzle/${tag}.sql`

/*
 * STEP MODE IS GONE, AND ITS ABSENCE IS ENFORCED.
 *
 * `--step` used to truncate the work to the last journal entry. A partial
 * application is not what production will do, and a rehearsal that applies a
 * different set of migrations than the release will is not a rehearsal of the
 * release. Refused explicitly so an operator with the old command in their shell
 * history gets an explanation rather than a silently different run.
 */
for (const banned of ['step', 'to', 'keep', 'skip', 'repair', 'force']) {
  if (process.argv.some((a) => a === `--${banned}` || a.startsWith(`--${banned}=`))) {
    console.error(
      `--${banned} is not supported. This rehearsal applies the whole pending stack ` +
        `(${PENDING_TAGS.join(', ')}) through the repository's own drizzle-kit migrate, once, or it ` +
        'does not run at all.',
    )
    process.exit(1)
  }
}

const stage = (title) => console.log(`\n${title}`)
const note = (text) => console.log(`    ${text}`)
const ok = (text) => console.log(`    ok    ${text}`)

/** Every failure path in this script goes through here. There is no "warn and continue". */
function stop(headline, problems) {
  const detail = problems.map((p) => `  • ${p}`).join('\n')
  throw new Error(`${headline}\n${detail}`)
}

/* =========================================================== the repository */

/**
 * The migration files and journal, read exactly as drizzle reads them.
 *
 * The raw text is retained so that, after the migration, the same files can be
 * proved byte-identical: "the journal was not modified" is a claim this script
 * makes, so it is a claim this script checks.
 */
function readRepositorySnapshot() {
  const journalText = readFileSync(JOURNAL_PATH).toString()
  const journal = JSON.parse(journalText)
  const sources = {}
  for (const entry of journal.entries ?? []) {
    try {
      sources[entry.tag] = readFileSync(migrationPath(entry.tag)).toString()
    } catch {
      /* Left absent on purpose: buildRepositoryMigrations fails closed on it. */
    }
  }
  return { journalText, journal, sources }
}

function assertRepositoryUnchanged(snapshot) {
  const problems = []
  if (readFileSync(JOURNAL_PATH).toString() !== snapshot.journalText) {
    problems.push(`${JOURNAL_PATH} changed during the run. The migration was not applied from the committed journal.`)
  }
  for (const [tag, text] of Object.entries(snapshot.sources)) {
    let current
    try {
      current = readFileSync(migrationPath(tag)).toString()
    } catch (error) {
      problems.push(`drizzle/${tag}.sql could not be re-read (${error.message}).`)
      continue
    }
    if (current !== text) problems.push(`drizzle/${tag}.sql changed during the run.`)
  }
  if (problems.length > 0) stop('The repository was modified by this run, which it must never be:', problems)
}

/* ================================================================== reading */

const CATALOG_QUERIES = {
  tables: `select table_name from information_schema.tables where table_schema='public'`,
  columns: `select table_name, column_name from information_schema.columns where table_schema='public'`,
  types: `select t.typname from pg_type t
            join pg_namespace n on n.oid = t.typnamespace
           where n.nspname='public' and t.typtype='e'`,
  enumValues: `select t.typname, e.enumlabel from pg_enum e
                 join pg_type t on t.oid = e.enumtypid
                 join pg_namespace n on n.oid = t.typnamespace
                where n.nspname='public'`,
  indexes: `select indexname from pg_indexes where schemaname='public'`,
  constraints: `select c.conname from pg_constraint c
                  join pg_namespace n on n.oid = c.connamespace
                 where n.nspname='public'`,
  functions: `select p.proname from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
               where n.nspname='public'`,
  triggers: `select tgname from pg_trigger where not tgisinternal`,
}

/** Everything the drift and post-migration checks need, in one pass. */
async function observeCatalog(query) {
  const raw = {}
  for (const [kind, sql] of Object.entries(CATALOG_QUERIES)) {
    const rows = await query(sql)
    switch (kind) {
      case 'columns':
        raw.columns = rows.map((r) => ({ table: r.table_name, column: r.column_name }))
        break
      case 'enumValues':
        raw.enumValues = rows.map((r) => ({ type: r.typname, value: r.enumlabel }))
        break
      case 'tables':
        raw.tables = rows.map((r) => r.table_name)
        break
      case 'types':
        raw.types = rows.map((r) => r.typname)
        break
      case 'indexes':
        raw.indexes = rows.map((r) => r.indexname)
        break
      case 'constraints':
        raw.constraints = rows.map((r) => r.conname)
        break
      case 'functions':
        raw.functions = rows.map((r) => r.proname)
        break
      case 'triggers':
        raw.triggers = rows.map((r) => r.tgname)
        break
      default:
        break
    }
  }
  return raw
}

/**
 * The ledger, or nothing.
 *
 * A missing table returns null rather than an empty array, because "there is no
 * ledger" and "the ledger is empty" are different facts and only one of them is
 * survivable. Both stop the run; conflating them would make the report wrong.
 */
async function readLedger(query) {
  const [{ present }] = await query(
    `select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  )
  if (!present) return null
  return query('select id, hash, created_at from drizzle.__drizzle_migrations order by id asc')
}

/** Row counts and digests over the tables the pending stack touches or claims not to touch. */
async function readDataSignature(query) {
  const [counts] = await query(`
    select (select count(*)::int from users) as users,
           (select count(*)::int from media) as media,
           (select count(*)::int from product_media) as product_media,
           (select count(*)::int from products) as products,
           (select count(*)::int from product_variants) as product_variants`)
  const [{ d: usersDigest }] = await query(`
    select coalesce(md5(string_agg(id::text||':'||email||':'||role::text||':'||status::text, ',' order by id)),
                    'empty') d
      from users`)
  const [{ d: mediaDigest }] = await query(`
    select coalesce(md5(string_agg(id::text||':'||url||':'||alt_text, ',' order by id)), 'empty') d
      from media`)
  return { ...counts, usersDigest, mediaDigest }
}

/* ================================================================== probes = */

const probeResults = new Map(
  REQUIRED_PROBES.map((id) => [id, { id, status: 'NOT-REACHED', detail: 'the probe stage did not reach it' }]),
)
const settle = (id, passed, detail) =>
  probeResults.set(id, { id, status: passed ? 'PASS' : 'FAIL', detail: passed ? '' : detail })

/**
 * One statement, in a savepoint, whose failure is data rather than an accident.
 *
 * SAVEPOINTS ARE LOAD-BEARING. Postgres aborts a transaction the moment a
 * statement raises, and every later statement fails with 25P02 until rollback.
 * A previous version ran two probes in one transaction: the duplicate insert
 * raised 23505 as designed, and the NEXT probe then failed with "current
 * transaction is aborted" — reported as "the new uniqueness model rejects a
 * legitimate second invite". It would have failed the rehearsal for a correct
 * migration, every time.
 */
async function attempt(client, sql, params = []) {
  await client.query('savepoint probe_step')
  try {
    const { rows } = await client.query(sql, params)
    await client.query('release savepoint probe_step')
    return { ok: true, code: null, message: null, rows }
  } catch (error) {
    await client.query('rollback to savepoint probe_step')
    await client.query('release savepoint probe_step')
    return { ok: false, code: error.code ?? null, message: error.message, rows: [] }
  }
}

const hash64 = () => createHash('sha256').update(randomUUID()).digest('hex')
const probeEmail = () => `rehearsal-probe-${randomUUID()}@invalid.test`

/**
 * Every behavioural claim the pending stack makes, against production-shaped
 * data, in ONE transaction that is always rolled back.
 *
 * The fixtures are built here rather than borrowed from the clone's rows on
 * purpose: a probe that needs "at least one redemption to exist" is a probe that
 * reports SKIP on a database that has none, and SKIP is indistinguishable from
 * a failure nobody looked at.
 */
async function runProbes(pool) {
  const client = await pool.connect()
  try {
    await client.query('begin')

    /* ---- 0016: the media columns, against the existing media table ------- */
    const defaults = await attempt(
      client,
      `insert into media (url) values ($1) returning kind, bytes, duration_seconds, storage_key`,
      [`https://rehearsal.invalid/${randomUUID()}`],
    )
    settle(
      '0016.media_defaults',
      defaults.ok &&
        defaults.rows[0]?.kind === 'image' &&
        defaults.rows[0]?.bytes === null &&
        defaults.rows[0]?.duration_seconds === null &&
        defaults.rows[0]?.storage_key === null,
      defaults.ok ? JSON.stringify(defaults.rows[0]) : `${defaults.code} ${defaults.message}`,
    )

    const explicit = await attempt(
      client,
      `insert into media (url, kind, bytes, duration_seconds, storage_key)
       values ($1, 'video', 1024, 12.5, 'rehearsal/key')
       returning kind, bytes, duration_seconds, storage_key`,
      [`https://rehearsal.invalid/${randomUUID()}`],
    )
    settle(
      '0016.media_explicit_kind',
      explicit.ok &&
        explicit.rows[0]?.kind === 'video' &&
        Number(explicit.rows[0]?.bytes) === 1024 &&
        Number(explicit.rows[0]?.duration_seconds) === 12.5 &&
        explicit.rows[0]?.storage_key === 'rehearsal/key',
      explicit.ok ? JSON.stringify(explicit.rows[0]) : `${explicit.code} ${explicit.message}`,
    )

    const badKind = await attempt(
      client,
      `insert into media (url, kind) values ($1, 'audio')`,
      [`https://rehearsal.invalid/${randomUUID()}`],
    )
    settle(
      '0016.media_kind_rejects_unknown',
      badKind.ok === false && badKind.code === '22P02',
      `accepted=${badKind.ok} code=${badKind.code ?? 'none'}`,
    )

    /* ---- 0017: the invite-code invariants -------------------------------- */
    const sharedHash = hash64()
    const firstInvite = await attempt(
      client,
      `insert into invite_codes (code_hash, code_prefix) values ($1, 'RPB') returning id`,
      [sharedHash],
    )
    const duplicateInvite = firstInvite.ok
      ? await attempt(
          client,
          `insert into invite_codes (code_hash, code_prefix) values ($1, 'RPB')`,
          [sharedHash],
        )
      : null
    settle(
      '0017.invite_code_hash_unique',
      firstInvite.ok && duplicateInvite?.ok === false && duplicateInvite.code === '23505',
      firstInvite.ok
        ? `duplicate accepted=${duplicateInvite?.ok} code=${duplicateInvite?.code ?? 'none'}`
        : `the first insert failed: ${firstInvite.code} ${firstInvite.message}`,
    )

    const overBudget = await attempt(
      client,
      `insert into invite_codes (code_hash, code_prefix, max_uses, use_count) values ($1, 'RPB', 1, 2)`,
      [hash64()],
    )
    settle(
      '0017.invite_code_budget_check',
      overBudget.ok === false && overBudget.code === '23514',
      `accepted=${overBudget.ok} code=${overBudget.code ?? 'none'}`,
    )

    /*
     * The administrator ceiling, expectation DERIVED from the clone's own rows.
     *
     * Production-shaped data means the answer is whatever production's live
     * administrator count makes it, so the probe reads that count first and
     * asserts the outcome it implies. Either branch is a genuine assertion; the
     * probe cannot pass by not knowing.
     */
    const adminCount = await attempt(
      client,
      `select count(*)::int n from users where role='admin' and deleted_at is null`,
    )
    const liveAdmins = adminCount.ok ? (adminCount.rows[0]?.n ?? null) : null
    const promotion = await attempt(
      client,
      `insert into users (email, role) values ($1, 'admin') returning id`,
      [probeEmail()],
    )
    const ceilingHolds =
      liveAdmins === null
        ? false
        : liveAdmins >= 2
          ? promotion.ok === false && promotion.code === '23514'
          : promotion.ok === true
    settle(
      '0017.admin_ceiling_trigger',
      ceilingHolds,
      `live admins=${liveAdmins} accepted=${promotion.ok} code=${promotion.code ?? 'none'}`,
    )

    /* ---- 0018: the leaning strain values --------------------------------- */
    const leaning = await attempt(
      client,
      `select 'hybrid_i'::strain_type::text a, 'hybrid_s'::strain_type::text b`,
    )
    settle(
      '0018.strain_leaning_accepted',
      leaning.ok && leaning.rows[0]?.a === 'hybrid_i' && leaning.rows[0]?.b === 'hybrid_s',
      leaning.ok ? JSON.stringify(leaning.rows[0]) : `${leaning.code} ${leaning.message}`,
    )

    const ordering = await attempt(
      client,
      `select ('hybrid'::strain_type < 'hybrid_i'::strain_type)
          and ('hybrid_i'::strain_type < 'hybrid_s'::strain_type)
          and ('hybrid_s'::strain_type < 'cbd'::strain_type) as ok`,
    )
    settle(
      '0018.strain_leaning_ordering',
      ordering.ok && ordering.rows[0]?.ok === true,
      ordering.ok ? `ordering=${ordering.rows[0]?.ok}` : `${ordering.code} ${ordering.message}`,
    )

    /* ---- 0019: target_role, redemptions, marketplace access -------------- */
    const targeted = await attempt(
      client,
      `insert into invite_codes (code_hash, code_prefix) values ($1, 'RPB') returning id, target_role`,
      [hash64()],
    )
    settle(
      '0019.invite_target_role_default',
      targeted.ok && targeted.rows[0]?.target_role === 'shopper',
      targeted.ok ? `target_role=${targeted.rows[0]?.target_role}` : `${targeted.code} ${targeted.message}`,
    )

    const secondInvite = await attempt(
      client,
      `insert into invite_codes (code_hash, code_prefix) values ($1, 'RPB') returning id`,
      [hash64()],
    )
    const fixtureUser = await attempt(
      client,
      `insert into users (email) values ($1) returning id`,
      [probeEmail()],
    )

    if (fixtureUser.ok && targeted.ok && secondInvite.ok) {
      const userId = fixtureUser.rows[0].id
      const inviteA = targeted.rows[0].id
      const inviteB = secondInvite.rows[0].id

      const firstRedemption = await attempt(
        client,
        `insert into invite_code_redemptions (invite_code_id, user_id) values ($1, $2)`,
        [inviteA, userId],
      )
      const sameInvite = firstRedemption.ok
        ? await attempt(
            client,
            `insert into invite_code_redemptions (invite_code_id, user_id) values ($1, $2)`,
            [inviteA, userId],
          )
        : null
      settle(
        '0019.redemption_same_invite_rejected',
        firstRedemption.ok && sameInvite?.ok === false && sameInvite.code === '23505',
        firstRedemption.ok
          ? `duplicate accepted=${sameInvite?.ok} code=${sameInvite?.code ?? 'none'}`
          : `the first redemption failed: ${firstRedemption.code} ${firstRedemption.message}`,
      )

      const otherInvite = await attempt(
        client,
        `insert into invite_code_redemptions (invite_code_id, user_id) values ($1, $2)`,
        [inviteB, userId],
      )
      settle(
        '0019.redemption_other_invite_allowed',
        firstRedemption.ok && otherInvite.ok === true,
        `accepted=${otherInvite.ok} code=${otherInvite.code ?? 'none'} ${otherInvite.message ?? ''}`,
      )

      const firstAccess = await attempt(
        client,
        `insert into marketplace_access (user_id, scope) values ($1, 'shopper')`,
        [userId],
      )
      const secondAccess = firstAccess.ok
        ? await attempt(
            client,
            `insert into marketplace_access (user_id, scope) values ($1, 'vendor')`,
            [userId],
          )
        : null
      settle(
        '0019.marketplace_access_user_unique',
        firstAccess.ok && secondAccess?.ok === false && secondAccess.code === '23505',
        firstAccess.ok
          ? `second scope accepted=${secondAccess?.ok} code=${secondAccess?.code ?? 'none'}`
          : `the first grant failed: ${firstAccess.code} ${firstAccess.message}`,
      )

      const removal = await attempt(client, `delete from users where id = $1`, [userId])
      const survivors = removal.ok
        ? await attempt(client, `select count(*)::int n from marketplace_access where user_id = $1`, [userId])
        : null
      settle(
        '0019.marketplace_access_user_cascade',
        firstAccess.ok && removal.ok && survivors?.ok === true && survivors.rows[0]?.n === 0,
        removal.ok
          ? `rows left=${survivors?.rows[0]?.n}`
          : `deleting the fixture user failed: ${removal.code} ${removal.message}`,
      )
    } else {
      const detail = 'the probe fixtures (user + two invite codes) could not be created'
      for (const id of [
        '0019.redemption_same_invite_rejected',
        '0019.redemption_other_invite_allowed',
        '0019.marketplace_access_user_unique',
        '0019.marketplace_access_user_cascade',
      ]) {
        probeResults.set(id, { id, status: 'NOT-REACHED', detail })
      }
    }

    /*
     * AWAITED, AND ITS FAILURE PROPAGATES. "Nothing persists" is the entire
     * basis on which these probes are safe, and an un-rolled-back transaction is
     * precisely the case where that stops being true.
     */
    await client.query('rollback')
  } finally {
    client.release()
  }
}

/* ================================================================= cleanup = */

async function deleteBranch(apiKey, projectId, branchId, { parentId, expectedName }) {
  const branches = await listBranches(apiKey, projectId)
  const target = branches.find((b) => b.id === branchId)

  if (!target) {
    note(`branch ${branchId} no longer exists`)
    return
  }

  const { problems } = evaluateDeletionGuard({ target, parentId, expectedName })
  if (problems.length > 0) stop(`Refusing to delete ${branchId}:`, problems)

  await api(apiKey, `/projects/${projectId}/branches/${branchId}`, { method: 'DELETE' })
  note(`deleted branch ${branchId} ("${target.name}")`)
}

/* ==================================================================== main = */

async function main() {
  console.log('Production-shaped migration rehearsal — disposable Neon clone\n')

  const apiKey = requireApiKey(SELF)

  /* ---- 0. the repository, before anything external -------------------- */
  stage('[0] Repository migration set')
  const snapshot = readRepositorySnapshot()
  const { problems: repositoryProblems, migrations } = buildRepositoryMigrations({
    journal: snapshot.journal,
    sources: snapshot.sources,
  })
  if (repositoryProblems.length > 0) {
    stop('The repository does not describe the migration stack this rehearsal is defined against:', repositoryProblems)
  }
  ok(`${migrations.length} migrations, ${ALL_TAGS[0]} … ${ALL_TAGS[ALL_TAGS.length - 1]}`)
  note(`recorded stack expected on production: ${RECORDED_TAGS.length} (0000 … 0015)`)
  note(`pending stack to be applied here:      ${PENDING_TAGS.join(', ')}`)

  const { inventory, dropped, problems: inventoryProblems } = buildPendingInventory({ migrations })
  if (inventoryProblems.length > 0) stop('The pending stack could not be inventoried:', inventoryProblems)
  ok(`${inventory.length} declared objects and ${dropped.length} dropped objects inventoried from the pending stack`)

  /* ---- 1. live production identity ------------------------------------ */
  stage('[1] Live production identity (required)')
  let health
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10_000) })
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    health = { reachable: true, httpStatus: res.status, body }
  } catch (error) {
    health = { reachable: false, httpStatus: 0, body: null, error: error.message }
  }

  const identity = evaluateHealthIdentity({
    reachable: health.reachable,
    httpStatus: health.httpStatus,
    body: health.body,
    expectedFingerprint: PRODUCTION_HOST_FINGERPRINT,
  })
  if (identity.problems.length > 0) {
    stop(
      `The deployment at ${BASE} did not establish production identity. Nothing has been created:`,
      identity.problems,
    )
  }
  const liveFingerprint = identity.fingerprint
  ok(`${BASE} reports environment "production" and database ${liveFingerprint}`)

  /* ---- 2. which Neon branch is production ------------------------------ */
  stage('[2] Neon project and branch topology')
  const project = await resolveProject(apiKey, { projectId: PROJECT_ID, projectName: PROJECT_NAME })
  note(`project ${project.name} (${project.id})`)

  const branches = await listBranches(apiKey, project.id)
  const topology = evaluateBranchTopology(branches)
  if (topology.problems.length > 0) {
    stop('Neon\'s branch metadata is ambiguous about which branch is production:', topology.problems)
  }
  const parent = topology.parent
  ok(`default branch "${parent.name}" (${parent.id}) is unambiguously production`)

  /* ---- 3. that branch must BE the live production database ------------- */
  stage('[3] The parent must be the database the deployed app is using')
  /*
   * These two URIs are the only production credentials this process ever holds.
   * They exist to be hashed and are never printed, logged, stored, or given to a
   * Pool. Production is not connected to at any point in this run.
   */
  const parentPooled = await connectionUri(apiKey, project.id, parent.id, {
    database: DATABASE,
    role: ROLE,
    pooled: true,
  })
  const parentDirect = await connectionUri(apiKey, project.id, parent.id, {
    database: DATABASE,
    role: ROLE,
    pooled: false,
  })
  assertEndpointShape(parentPooled, parentDirect)

  const parentPooledFp = hostFp(parentPooled)
  const parentEndpointFp = endpointFp(parentPooled)
  note(`parent pooled fingerprint ${parentPooledFp}`)
  if (parentPooledFp !== liveFingerprint) {
    stop('The Neon branch about to be cloned is NOT the database the deployed app is using. Nothing has been created:', [
      `parent pooled fingerprint : ${parentPooledFp}`,
      `live app fingerprint      : ${liveFingerprint}`,
      'Either NEON_PROJECT_ID points at the wrong project, or the deployed app is served by a branch ' +
        'other than this project\'s default. A PASS from cloning this parent would mean nothing.',
    ])
  }
  ok('the parent IS live production')

  /* ---- 4. a disposable clone, and nothing reused ----------------------- */
  stage('[4] Creating the disposable clone')
  const branchName = rehearsalBranchName(Date.now())
  const freshness = []
  if (branches.some((b) => b.name === branchName)) {
    freshness.push(`a branch named "${branchName}" already exists; a reused branch is not a clone of CURRENT production`)
  }
  if (branchName === parent.name) freshness.push('the rehearsal name collides with the production branch name')
  if (freshness.length > 0) stop('Refusing to create the clone:', freshness)

  const created = await api(apiKey, `/projects/${project.id}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: { name: branchName, parent_id: parent.id },
      endpoints: [{ type: 'read_write' }],
    }),
  })

  /*
   * Read from the POST response only. A follow-up list lookup could return a
   * pre-existing branch of the same name — the exact thing the freshness check
   * above exists to prevent.
   */
  const clone = created.branch
  if (!clone?.id) throw new Error('Branch creation returned no branch.')
  note(`created ${clone.id} ("${clone.name}")`)
  note(`parent_lsn ${clone.parent_lsn ?? '(none reported)'}`)

  let exitCode = 0

  try {
    /* ---- 5. the clone is provably not production --------------------- */
    stage('[5] Clone identity — before any database connection')
    const metadata = evaluateCloneMetadata({ clone, parent, flagEvidence: topology.flagEvidence })
    if (metadata.problems.length > 0) stop('The created branch is not provably a disposable clone:', metadata.problems)
    ok(`non-default, non-primary, parent_id ${clone.parent_id}`)

    const pooled = await connectionUri(apiKey, project.id, clone.id, {
      database: DATABASE,
      role: ROLE,
      pooled: true,
    })
    const direct = await connectionUri(apiKey, project.id, clone.id, {
      database: DATABASE,
      role: ROLE,
      pooled: false,
    })
    assertEndpointShape(pooled, direct)

    note(`clone pooled fingerprint ${hostFp(pooled)}`)
    note(`clone direct fingerprint ${hostFp(direct)}`)

    const targets = evaluateCloneTargets({
      pooledHost: hostFp(pooled),
      directHost: hostFp(direct),
      pooledEndpoint: endpointFp(pooled),
      directEndpoint: endpointFp(direct),
      parentPooledHost: parentPooledFp,
      parentEndpoint: parentEndpointFp,
      liveFingerprint,
    })
    if (targets.problems.length > 0) stop('The clone\'s connection targets are not safe to write to:', targets.problems)
    ok('neither target is current production, retired production, or the live database')

    const pool = new Pool({ connectionString: direct })
    let migrationMs = 0
    let before

    try {
      const query = async (text, params) => (await pool.query(text, params)).rows

      /* ---- 6. exact-history reconciliation, 0000 … 0015 -------------- */
      stage('[6] Clone ledger — exact reconciliation against 0000 … 0015')
      const ledger = await readLedger(query)
      const reconciliation = reconcileLedger({ migrations, rows: ledger, expectedTags: RECORDED_TAGS })
      if (reconciliation.problems.length > 0) {
        stop('The clone ledger does not reconcile with this repository. NO migration command has run:', reconciliation.problems)
      }
      ok(`${RECORDED_TAGS.length} ledger rows match by order, hash, and timestamp`)

      /* ---- 7. the pending stack, derived ----------------------------- */
      stage('[7] Pending stack, derived from the ledger')
      const pending = derivePendingStack({ migrations, rows: ledger })
      if (pending.problems.length > 0) {
        stop('The derived pending stack is not the one this rehearsal is defined against. NO migration command has run:', pending.problems)
      }
      ok(`pending: ${pending.pendingTags.join(', ')}`)

      /* ---- 8. drift inventory ---------------------------------------- */
      stage('[8] Pre-existing objects declared by the pending stack')
      const observation = await observeCatalog(query)
      const observed = buildObservedKeys(observation)
      if (observed.problems.length > 0) {
        stop('The clone\'s catalogs could not be read completely. NO migration command has run:', observed.problems)
      }
      const drift = evaluateDrift({
        inventory,
        recordedTags: reconciliation.recordedTags,
        observedKeys: observed.keys,
      })
      note(`${drift.checked} declared objects checked across ${PENDING_TAGS.length} unrecorded migrations`)
      if (drift.problems.length > 0) {
        stop(
          'BLOCKING DRIFT — the clone already carries objects the pending stack declares. NO migration ' +
            'command has run, and none will:',
          [
            ...drift.problems,
            'A pre-existing object is a schema and a ledger disagreeing. It is never evidence that a ' +
              'migration was applied, and it is never something to migrate over.',
          ],
        )
      }
      ok('no declared object of the pending stack exists yet')

      before = await readDataSignature(query)
      note(
        `carried rows — users ${before.users}, media ${before.media}, product_media ${before.product_media}, ` +
          `products ${before.products}, product_variants ${before.product_variants}`,
      )

      /* ---- 9. THE ONE MIGRATION COMMAND ------------------------------ */
      stage('[9] Applying the pending stack — the repository\'s own drizzle-kit migrate, once')
      const gate = createMigrationGate((file, args, options) =>
        execFileSync(file, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      )
      /*
       * The gate opens HERE and nowhere else: after the ledger reconciled, after
       * the pending stack was derived, and after the drift inventory came back
       * empty. Everything above this line runs with the command unavailable.
       */
      gate.clear()

      const started = Date.now()
      let output = ''
      let migrateOk = true
      try {
        output = gate.run('npx', ['drizzle-kit', 'migrate'], {
          env: { ...process.env, DATABASE_URL: direct, DATABASE_URL_UNPOOLED: direct },
          shell: process.platform === 'win32',
        })
      } catch (error) {
        migrateOk = false
        output = `${error.stdout ?? ''}${error.stderr ?? ''}` || error.message
      }
      migrationMs = Date.now() - started

      if (!migrateOk) {
        console.error(String(output).slice(-3000))
        stop('The migration failed on the clone:', ['drizzle-kit migrate exited non-zero — see the output above.'])
      }
      ok(`applied in ${migrationMs} ms, ${gate.invocations} invocation`)

      /* The claim "the journal was not modified" is checked, not asserted. */
      assertRepositoryUnchanged(snapshot)
      ok('the journal and all 20 migration files are byte-identical to the committed ones')

      /* ---- 10. exact reconciliation, 0000 … 0019 --------------------- */
      stage('[10] Clone ledger — exact reconciliation against all 20 migrations')
      const afterLedger = await readLedger(query)
      const afterReconciliation = reconcileLedger({ migrations, rows: afterLedger, expectedTags: ALL_TAGS })
      if (afterReconciliation.problems.length > 0) {
        stop('After migrating, the clone ledger does not reconcile with this repository:', afterReconciliation.problems)
      }
      /*
       * Only the derived list is consulted here. `derivePendingStack` also
       * reports "this is not the expected pending stack", which is true and
       * desirable BEFORE the migration and meaningless after it — the expected
       * stack has just been applied, so the only acceptable answer is none.
       */
      const afterPending = derivePendingStack({ migrations, rows: afterLedger })
      if (afterPending.pendingTags.length !== 0) {
        stop('After migrating, migrations are still pending:', [afterPending.pendingTags.join(', ')])
      }
      ok(`${ALL_TAGS.length} ledger rows match by order, hash, and timestamp; 0 pending`)

      const afterObservation = await observeCatalog(query)
      const afterObserved = buildObservedKeys(afterObservation)
      if (afterObserved.problems.length > 0) {
        stop('The clone\'s catalogs could not be re-read after migrating:', afterObserved.problems)
      }
      const applied = evaluateApplied({ inventory, dropped, observedKeys: afterObserved.keys })
      if (applied.problems.length > 0) stop('The migrated schema is not what the pending stack declares:', applied.problems)
      ok(`all ${inventory.length} declared objects exist; all ${dropped.length} dropped objects are gone`)

      /* ---- 11. the data that was carried ----------------------------- */
      stage('[11] Carried data')
      const after = await readDataSignature(query)
      const dataProblems = []
      for (const key of ['users', 'media', 'product_media', 'products', 'product_variants']) {
        if (after[key] !== before[key]) dataProblems.push(`${key} row count changed: ${before[key]} -> ${after[key]}`)
      }
      if (after.usersDigest !== before.usersDigest) dataProblems.push('the users digest changed')
      if (after.mediaDigest !== before.mediaDigest) dataProblems.push('the media digest changed')
      const [{ n: notImage }] = await query(`select count(*)::int n from media where kind <> 'image'`)
      if (notImage !== 0) dataProblems.push(`${notImage} pre-existing media row(s) did not backfill to 'image'`)
      if (dataProblems.length > 0) stop('The migration changed data it was not supposed to change:', dataProblems)
      ok(`every carried row is byte-identical; all ${after.media} media rows backfilled to 'image'`)

      /* ---- 12. behavioural probes ------------------------------------ */
      stage('[12] Behavioural probes — one transaction, always rolled back')
      await runProbes(pool)

      const afterProbes = await readDataSignature(query)
      const isolated =
        ['users', 'media', 'product_media', 'products', 'product_variants'].every(
          (key) => afterProbes[key] === after[key],
        ) &&
        afterProbes.usersDigest === after.usersDigest &&
        afterProbes.mediaDigest === after.mediaDigest
      probeResults.set('probe.isolation', {
        id: 'probe.isolation',
        status: isolated ? 'PASS' : 'FAIL',
        detail: isolated ? '' : 'the probes left rows behind',
      })

      const outcomes = evaluateProbeOutcomes([...probeResults.values()])
      for (const result of probeResults.values()) {
        console.log(
          `    ${result.status === 'PASS' ? 'ok  ' : 'FAIL'}  ${result.id}${
            result.status === 'PASS' ? '' : ` — ${result.status}${result.detail ? `: ${result.detail}` : ''}`
          }`,
        )
      }
      if (outcomes.problems.length > 0) {
        stop('The behavioural probes did not all pass. A probe that was skipped or never reached is a failure:', outcomes.problems)
      }
      ok(`${outcomes.passed}/${REQUIRED_PROBES.length} probes passed`)
    } finally {
      /*
       * Before the outer finally attempts deletion. Deleting a branch with a
       * live connection against it is the kind of thing that half-works.
       */
      await pool.end().catch(() => {})
      console.log('\n    database pool closed')
    }

    console.log('\n==========================================================')
    console.log('PRODUCTION-SHAPED REHEARSAL PASSED')
    console.log(`  pending stack applied      ${PENDING_TAGS.join(', ')}`)
    console.log(`  migration duration         ${migrationMs} ms`)
    console.log(`  carried users / media      ${before.users} / ${before.media}`)
    console.log(`  probes passed              ${REQUIRED_PROBES.length}/${REQUIRED_PROBES.length}`)
    console.log(`\nThis ran against a clone of production taken at parent_lsn ${clone.parent_lsn ?? '(unreported)'}.`)
    console.log('Production was never connected to. Take a restore point before the real')
    console.log('run, and record it.')
    console.log('==========================================================')
  } catch (error) {
    exitCode = 1
    console.error(`\n==========================================================`)
    console.error('REHEARSAL FAILED')
    console.error(error.message)
    console.error('\nDO NOT APPLY THIS MIGRATION TO PRODUCTION.')
    console.error('==========================================================')
  } finally {
    /*
     * ALWAYS. A disposable clone that outlives its run is a copy of production
     * data sitting in a branch nobody is watching.
     */
    console.log('\n[cleanup]')
    try {
      await deleteBranch(apiKey, project.id, clone.id, { parentId: parent.id, expectedName: branchName })
    } catch (error) {
      console.error(`    WARNING: could not delete ${clone.id} — ${error.message}`)
      console.error(`    Remove it by hand: node ${SELF} --cleanup=${clone.id}`)
      exitCode = 1
    }
  }

  process.exitCode = exitCode
}

/** Manual recovery for a clone a crashed run could not delete. */
async function cleanupOnly(branchId) {
  const apiKey = requireApiKey(SELF)
  const project = await resolveProject(apiKey, { projectId: PROJECT_ID, projectName: PROJECT_NAME })
  const branches = await listBranches(apiKey, project.id)
  const topology = evaluateBranchTopology(branches)
  if (topology.problems.length > 0) {
    stop('Neon\'s branch metadata is ambiguous, so nothing may be deleted:', topology.problems)
  }
  console.log(`[cleanup] removing ${branchId} from ${project.name} (${project.id})`)
  await deleteBranch(apiKey, project.id, branchId, { parentId: topology.parent.id })
}

const cleanupId = flag('cleanup')
const entry = cleanupId ? cleanupOnly(cleanupId) : main()

entry.catch((error) => {
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
