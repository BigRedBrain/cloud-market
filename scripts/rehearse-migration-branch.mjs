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
 * do the compared columns of the existing rows survive unchanged, does the new
 * uniqueness model behave.
 *
 * THE FIVE REFUSALS THAT MATTER
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
 *   5. A CLONE THAT WAS CREATED MUST BE DELETABLE, EVEN IF THE CALL THAT
 *      CREATED IT FAILED. Neon can commit a branch server-side and still fail
 *      the caller — a dropped socket, a non-JSON body, a body with no
 *      `branch.id`. The name is therefore generated BEFORE the request and
 *      cleanup is armed BEFORE the request, so that every one of those cases
 *      ends with the branch deleted by its exact generated name rather than
 *      with a copy of production data left in a branch nobody is watching.
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
 *   - touch `.env.local`, or print a connection string or credential — child
 *     stdout, child stderr, and every Error-derived string are redacted before
 *     they reach a terminal or a CI log
 *   - echo a rejected argument: the startup refusal reports an argument's
 *     position and shape, never its text, because a rejected URL is exactly the
 *     kind of string that carries userinfo or a token and the refusal happens
 *     before redaction has anything registered
 *   - accept a health origin from an argument or a variable: it is the frozen
 *     constant `https://cloudmarket.cc`, its `/api/health` route is fetched with
 *     redirects REFUSED rather than followed, and the response's own URL must be
 *     that URL character for character before anything it says is believed
 *   - claim more about the carried data than it compared
 *   - depend on the directory it was launched from: the repository root is
 *     derived from `import.meta.url`, the journal and migration files are read
 *     by absolute path, and the one migrate child process is given that root as
 *     its `cwd`
 *   - leave a branch, a row, an open transaction, or a connection behind, or
 *     report a branch "absent" because one listing did not mention it
 *
 * IMPORT SAFETY. `verify-migration-target.mjs` is imported for its pure
 * fingerprint helpers. Verified by inspection: every I/O call it makes sits
 * inside `main()`, which runs only behind an `import.meta.url` guard. Importing
 * it executes no CLI, reads no credential, and opens no connection.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  CARRIED_DIGEST_COLUMNS,
  CARRIED_TABLES,
  CLEANUP_RESOLUTION,
  HEALTH_REDIRECT_POLICY,
  MEDIA_BACKFILL_QUERY,
  PENDING_TAGS,
  PRODUCTION_HEALTH_ORIGIN,
  PRODUCTION_HEALTH_URL,
  RECORDED_TAGS,
  REQUIRED_PROBES,
  buildObservedKeys,
  buildPendingInventory,
  buildRepositoryMigrations,
  buildRowDigestQuery,
  confirmCleanupTarget,
  createMigrationGate,
  derivePendingStack,
  describeCarriedEvidence,
  evaluateApplied,
  evaluateBranchTopology,
  evaluateCarriedData,
  evaluateCloneMetadata,
  evaluateCloneTargets,
  evaluateDeletionGuard,
  evaluateDrift,
  evaluateHealthEndpointIdentity,
  evaluateHealthIdentity,
  evaluateMediaBackfill,
  evaluateProbeOutcomes,
  reconcileLedger,
  redactSecrets,
  rehearsalBranchName,
  resolveHealthOrigin,
  withProbeTransaction,
} from './rehearse-migration-branch-core.mjs'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const SELF = 'scripts/rehearse-migration-branch.mjs'

const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const PROJECT_NAME = process.env.NEON_PROJECT_NAME ?? 'cloud-market'
const PROJECT_ID = process.env.NEON_PROJECT_ID
const DATABASE = process.env.NEON_DATABASE ?? 'cloudmarket'
const ROLE = process.env.NEON_ROLE ?? 'neondb_owner'

/*
 * WHERE THE REPOSITORY IS, NOT WHERE THE OPERATOR WAS STANDING.
 *
 * Every path here used to be relative, which made the run depend on the shell's
 * current directory: launched from the parent folder that holds this checkout
 * (`…/GitHub/CloudMarket/cloud-market-ai-team`, say), `readFileSync` would miss
 * the journal and the rehearsal would report "the repository does not describe
 * the migration stack" about a repository that is perfectly fine — and, worse,
 * `npx drizzle-kit migrate` would inherit that same directory, find a different
 * `drizzle.config.ts` or none, and either fail or migrate from a migrations
 * folder nobody chose.
 *
 * This file lives in `<repo>/scripts/`, so the root is one level up from its own
 * module URL. That is a fact about the file, available before any I/O, and it is
 * true no matter where the process was started.
 */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

const JOURNAL_PATH = join(REPO_ROOT, 'drizzle', 'meta', '_journal.json')
const migrationPath = (tag) => join(REPO_ROOT, 'drizzle', `${tag}.sql`)

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

/*
 * THE HEALTH ORIGIN IS NOT AN ARGUMENT, AND SAYING SO IS THE POINT.
 *
 * This used to be the first argument that looked like a URL, falling back to the
 * production address — which meant any operator could aim the identity check
 * anywhere: a preview deployment, an unencrypted origin on an untrusted network,
 * a host with credentials in it, or a look-alike domain. Everything after stage
 * [1] is anchored to what THAT deployment published, so a redirectable origin
 * makes every later refusal refuse the wrong thing while still reporting PASS.
 *
 * The origin is a frozen constant in the core module. There is no replacement
 * override — not a flag, not a variable — and an attempt to supply one stops the
 * run here rather than being quietly ignored.
 *
 * AND THE REFUSAL DOES NOT PRINT THE ARGUMENT. This runs before `redact` exists
 * and before a single secret is registered with it, so anything echoed here is
 * echoed raw — and the argument being refused is a URL somebody just pasted,
 * which is exactly where userinfo, a token, or a query secret lives. The core
 * builds a refusal out of the argument's position and shape and nothing else;
 * this loop prints those strings and never `process.argv`.
 */
const origin = resolveHealthOrigin(process.argv.slice(2))
if (origin.problems.length > 0) {
  for (const problem of origin.problems) console.error(problem)
  process.exit(1)
}

/*
 * EVERY SECRET THIS PROCESS TOUCHES, SO NOTHING PRINTS ONE.
 *
 * The clone's connection string is a live credential to a byte-for-byte copy of
 * production, and it is handed to `drizzle-kit` as DATABASE_URL and
 * DATABASE_URL_UNPOOLED. When that child fails it prints the configuration it
 * was given; when the driver fails the URI is usually in `error.message`. The
 * previous runner echoed the tail of that output verbatim into the terminal and
 * into whatever CI log was watching.
 *
 * Values are registered the moment they are fetched, and every print in this
 * file — including the ones that only run on the success path — goes through
 * `redact`.
 */
const SECRETS = new Set()
const remember = (secret) => {
  if (typeof secret === 'string' && secret.length > 0) SECRETS.add(secret)
  return secret
}
const redact = (value) => redactSecrets(value, SECRETS)

const stage = (title) => console.log(`\n${redact(title)}`)
const note = (text) => console.log(`    ${redact(text)}`)
const ok = (text) => console.log(`    ok    ${redact(text)}`)

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

/**
 * Row counts, and a null-safe digest of the columns that are actually compared.
 *
 * NULLS ARE VALUES HERE, NOT GAPS. The digests this replaces were built with
 * `id::text||':'||email||…` over columns that are genuinely nullable
 * (`users.email`, `media.alt_text`). One NULL makes the whole concatenation
 * NULL, and `string_agg` drops it — so every row carrying a NULL fell out of the
 * aggregate on both sides and compared equal no matter what happened to it.
 *
 * NOR DOES ANY BOUNDARY DEPEND ON A BYTE THE DATA COULD CONTAIN. The queries are
 * built by the core module, which length-frames every field and every row —
 * `S<len>:<text>` for a value, `N:` for NULL — so NULL and the empty string are
 * distinguishable, control characters are ordinary content, and no value can
 * move a column or row boundary. The number of rows the digest covered comes
 * back with it, so the coverage can be checked against the table's own count.
 */
async function readDataSignature(query) {
  const [counts] = await query(
    `select ${CARRIED_TABLES.map((table) => `(select count(*)::int from "${table}") as "${table}"`).join(',\n           ')}`,
  )

  const digests = {}
  for (const [table, columns] of Object.entries(CARRIED_DIGEST_COLUMNS)) {
    const [row] = await query(buildRowDigestQuery({ table, columns }))
    digests[table] = { rows: row?.n ?? null, digest: row?.d ?? null }
  }

  return { counts, digests }
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

  const probes = async () => {
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
  }

  /*
   * ROLLBACK, THEN RELEASE, ON EVERY PATH THERE IS.
   *
   * The rollback used to be the last statement of the try block, with only
   * `client.release()` in the finally. Any unexpected exception above it — a
   * driver error, a null dereference inside a `settle` expression, a socket
   * dropping — skipped the rollback entirely and handed a connection carrying an
   * open write transaction back to the pool. "Nothing persists" is the whole
   * basis on which it is safe to run these probes against a copy of production,
   * and that path is precisely where it stopped being true.
   *
   * `withProbeTransaction` rolls back from a finally, before the release, and
   * lets a rollback failure propagate: it is the one error that means the probe
   * rows may still be there, so it fails the rehearsal rather than being
   * swallowed by the path that was already unwinding.
   */
  return withProbeTransaction({
    begin: () => client.query('begin'),
    body: probes,
    rollback: () => client.query('rollback'),
    release: () => client.release(),
  })
}

/* ================================================================= cleanup = */

/**
 * Delete the disposable clone — by id when one came back, otherwise by the exact
 * name this run generated before the branch was ever requested.
 *
 * THE SECOND PATH IS THE ORPHAN FIX. Neon can commit a branch server-side and
 * still fail the caller: the socket drops after the write, the response is not
 * JSON, or the JSON carries no `branch.id`. Any of those used to leave a
 * complete copy of production data in a branch nobody was watching. `branchName`
 * is generated before the request, so it is available in exactly those cases;
 * `confirmCleanupTarget` re-lists the project and puts each listing through
 * `resolveCleanupTarget(...)`, accepting a name only on an EXACT match with
 * exactly one candidate.
 *
 * AND ONE LISTING IS NOT PROOF OF ABSENCE. A listing that did not mention the
 * created id used to end this function with "branch … no longer exists" and a
 * zero exit — an announcement of a clean-up that may never have happened.
 * `confirmCleanupTarget` re-lists a bounded number of times, falls back to the
 * exact generated name, and reports UNCONFIRMED rather than absent when it still
 * cannot tell. UNCONFIRMED fails the run, because the alternative is a copy of
 * production nobody has been told to look for.
 *
 * Whatever is identified still goes through `evaluateDeletionGuard`, which is
 * what refuses the production parent, a default or primary branch, a branch that
 * is not named `rehearsal-*`, and a branch whose name is not the expected one.
 */
async function deleteBranch(apiKey, projectId, { cloneId, branchName, parentId }) {
  const resolution = await confirmCleanupTarget({
    cloneId,
    branchName,
    parentId,
    listBranches: () => listBranches(apiKey, projectId),
  })

  if (resolution.status === CLEANUP_RESOLUTION.UNCONFIRMED) {
    stop(
      `Cleanup could not confirm a branch to delete after ${resolution.attemptsMade} branch listing(s). ` +
        'This is NOT a report that the branch is gone — inspect the project by hand:',
      resolution.problems,
    )
  }
  if (resolution.status !== CLEANUP_RESOLUTION.IDENTIFIED) {
    stop('Refusing to delete anything during cleanup:', resolution.problems)
  }

  const target = resolution.target
  const { problems } = evaluateDeletionGuard({ target, parentId, expectedName: branchName })
  if (problems.length > 0) stop(`Refusing to delete ${target.id}:`, problems)

  await api(apiKey, `/projects/${projectId}/branches/${target.id}`, { method: 'DELETE' })
  note(
    `deleted branch ${target.id} ("${target.name}"), matched by ${resolution.matchedBy} after ` +
      `${resolution.attemptsMade} listing(s)`,
  )
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
  stage(`[1] Live production identity at ${PRODUCTION_HEALTH_ORIGIN} (required, and not configurable)`)
  let health
  try {
    /*
     * REDIRECTS ARE REFUSED, NOT FOLLOWED. A 3xx would move this check to
     * whatever the Location header named — plain HTTP, another host, a port, a
     * credentialed URL — and everything after this stage is anchored to what the
     * answering deployment published. `redirect: 'error'` turns the hop into a
     * transport failure, and the response's own URL is then required to be the
     * constant, character for character.
     */
    const res = await fetch(PRODUCTION_HEALTH_URL, {
      redirect: HEALTH_REDIRECT_POLICY,
      signal: AbortSignal.timeout(10_000),
    })
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    health = { reachable: true, httpStatus: res.status, body, url: res.url, redirected: res.redirected === true }
  } catch (error) {
    health = { reachable: false, httpStatus: 0, body: null, url: null, redirected: false, error: error.message }
  }

  const identity = evaluateHealthIdentity({
    reachable: health.reachable,
    httpStatus: health.httpStatus,
    body: health.body,
    expectedFingerprint: PRODUCTION_HOST_FINGERPRINT,
  })
  const endpoint = health.reachable
    ? evaluateHealthEndpointIdentity({ url: health.url, redirected: health.redirected })
    : { problems: [] }
  const identityProblems = [...endpoint.problems, ...identity.problems]
  if (identityProblems.length > 0) {
    stop(
      `The deployment at ${PRODUCTION_HEALTH_ORIGIN} did not establish production identity. Nothing has ` +
        'been created:',
      [
        ...identityProblems,
        `This rehearsal talks to ${PRODUCTION_HEALTH_URL} and to nothing else. If that address now ` +
          'answers with a redirect, the redirect is refused rather than followed: identity may only be ' +
          'established by that exact URL answering directly.',
      ],
    )
  }
  const liveFingerprint = identity.fingerprint
  ok(`${PRODUCTION_HEALTH_ORIGIN} reports environment "production" and database ${liveFingerprint}`)

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
  const parentPooled = remember(
    await connectionUri(apiKey, project.id, parent.id, { database: DATABASE, role: ROLE, pooled: true }),
  )
  const parentDirect = remember(
    await connectionUri(apiKey, project.id, parent.id, { database: DATABASE, role: ROLE, pooled: false }),
  )
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

  /*
   * CLEANUP IS ARMED BEFORE THE BRANCH IS REQUESTED, NOT AFTER IT ANSWERS.
   *
   * The name is generated first and the try/finally is entered first, because
   * the dangerous window is the one between Neon committing a branch and this
   * process learning about it. A dropped socket, a non-JSON response, or a body
   * with no `branch.id` all used to throw out here — outside the finally — and
   * leave a full copy of production data behind. Now every one of those lands in
   * the catch, and the finally deletes the branch by the name it generated.
   */
  let cloneId = null
  let exitCode = 0

  try {
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
     * above exists to prevent. (Cleanup may look the name up, because by then
     * "delete whatever is called this" is the safe answer, not the risky one.)
     */
    const clone = created?.branch ?? null
    if (typeof clone?.id === 'string' && clone.id.length > 0) cloneId = clone.id
    if (cloneId === null) {
      throw new Error(
        'Branch creation returned no usable branch id. If Neon created a branch anyway, cleanup will ' +
          `find it by its exact name ("${branchName}") and delete it.`,
      )
    }
    note(`created ${cloneId} ("${clone.name}")`)
    note(`parent_lsn ${clone.parent_lsn ?? '(none reported)'}`)

    /* ---- 5. the clone is provably not production --------------------- */
    stage('[5] Clone identity — before any database connection')
    const metadata = evaluateCloneMetadata({ clone, parent, flagEvidence: topology.flagEvidence })
    if (metadata.problems.length > 0) stop('The created branch is not provably a disposable clone:', metadata.problems)
    ok(`non-default, non-primary, parent_id ${clone.parent_id}`)

    /*
     * Registered as secrets the moment they exist. The clone is a byte-for-byte
     * copy of production, so its credentials are production's data behind a
     * different hostname.
     */
    const pooled = remember(
      await connectionUri(apiKey, project.id, cloneId, { database: DATABASE, role: ROLE, pooled: true }),
    )
    const direct = remember(
      await connectionUri(apiKey, project.id, cloneId, { database: DATABASE, role: ROLE, pooled: false }),
    )
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
      note(`carried rows — ${CARRIED_TABLES.map((table) => `${table} ${before.counts[table]}`).join(', ')}`)

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
          /*
           * THE CHILD IS GIVEN THE REPOSITORY, NOT THE OPERATOR'S DIRECTORY.
           * `drizzle-kit` resolves `drizzle.config.ts` — and through it the
           * migrations folder and the journal — relative to its cwd. Inheriting
           * this process's cwd meant the command applied whatever stack the
           * shell happened to be standing in, which is not necessarily the one
           * the twenty files above were hashed from.
           */
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: direct, DATABASE_URL_UNPOOLED: direct },
          shell: process.platform === 'win32',
        })
      } catch (error) {
        migrateOk = false
        /*
         * REDACTED AT CAPTURE, NOT AT PRINT. The child was handed the clone's
         * connection string as DATABASE_URL and DATABASE_URL_UNPOOLED, and a
         * failing drizzle-kit prints the configuration it was given. Whatever
         * this variable holds may end up in an exception message or a CI log, so
         * it never holds a credential in the first place.
         */
        output = redact(`${error.stdout ?? ''}${error.stderr ?? ''}` || error.message)
      }
      migrationMs = Date.now() - started

      if (!migrateOk) {
        console.error(redact(String(output)).slice(-3000))
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
      /*
       * NULL-SAFE, AND THAT IS THE WHOLE CHECK. A plain inequality against
       * 'image' counts nothing when `kind` is NULL, because a comparison with
       * NULL is NULL — so the query that was supposed to prove the backfill
       * reached every row would have reported zero on a table where it reached
       * none of them. The core's predicate is `IS DISTINCT FROM`, which counts
       * NULL and any other value alike.
       */
      const [{ n: notImage }] = await query(MEDIA_BACKFILL_QUERY)
      const dataProblems = [
        ...evaluateCarriedData({ before, after }).problems,
        ...evaluateMediaBackfill(notImage).problems,
      ]
      if (dataProblems.length > 0) stop('The migration changed data it was not supposed to change:', dataProblems)
      /*
       * THE WORDING IS THE EVIDENCE, SO IT IS BUILT FROM THE EVIDENCE. This line
       * used to assert universal byte-identity across the carried rows on the
       * strength of five row counts and two partial-column digests that silently
       * dropped every row containing a NULL. What is proved is stated, and what
       * was not compared is said to be not compared.
       */
      ok(describeCarriedEvidence(after))
      ok(
        `the media backfill covered every row: 0 of ${after.counts.media} rows have a kind that is NULL or ` +
          "anything other than 'image'",
      )

      /* ---- 12. behavioural probes ------------------------------------ */
      stage('[12] Behavioural probes — one transaction, always rolled back')
      await runProbes(pool)

      /*
       * The same comparison, so the isolation probe is exactly as strong as the
       * carried-data check: same tables, same null-safe digests, same refusal to
       * conclude anything from a digest that did not cover every row.
       */
      const afterProbes = await readDataSignature(query)
      const isolation = evaluateCarriedData({ before: after, after: afterProbes })
      probeResults.set('probe.isolation', {
        id: 'probe.isolation',
        status: isolation.problems.length === 0 ? 'PASS' : 'FAIL',
        detail: isolation.problems.join('; '),
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
    console.log(`  carried users / media      ${before.counts.users} / ${before.counts.media}`)
    console.log(`  probes passed              ${REQUIRED_PROBES.length}/${REQUIRED_PROBES.length}`)
    console.log(`\nThis ran against a clone of production taken at parent_lsn ${clone.parent_lsn ?? '(unreported)'}.`)
    console.log('Production was never connected to. Take a restore point before the real')
    console.log('run, and record it.')
    console.log('==========================================================')
  } catch (error) {
    exitCode = 1
    console.error(`\n==========================================================`)
    console.error('REHEARSAL FAILED')
    console.error(redact(error.message))
    console.error('\nDO NOT APPLY THIS MIGRATION TO PRODUCTION.')
    console.error('==========================================================')
  } finally {
    /*
     * ALWAYS, AND REACHABLE FROM EVERY FAILURE INCLUDING THE CREATE CALL ITSELF.
     * A disposable clone that outlives its run is a copy of production data
     * sitting in a branch nobody is watching.
     */
    console.log('\n[cleanup]')
    try {
      await deleteBranch(apiKey, project.id, { cloneId, branchName, parentId: parent.id })
    } catch (error) {
      console.error(`    WARNING: the rehearsal branch was not deleted — ${redact(error.message)}`)
      console.error(`    Look for a branch named exactly "${branchName}" in project ${project.id}.`)
      console.error(`    Remove it by hand: node ${SELF} --cleanup=${cloneId ?? '<its branch id>'}`)
      exitCode = 1
    }
  }

  process.exitCode = exitCode
}

/**
 * Manual recovery for a clone a crashed run could not delete.
 *
 * There is no generated name to fall back on here, so an id that no listing
 * carries ends as UNCONFIRMED and a non-zero exit: this command will not tell an
 * operator a branch is gone on the strength of a control-plane response that
 * simply did not mention it.
 */
async function cleanupOnly(branchId) {
  const apiKey = requireApiKey(SELF)
  const project = await resolveProject(apiKey, { projectId: PROJECT_ID, projectName: PROJECT_NAME })
  const branches = await listBranches(apiKey, project.id)
  const topology = evaluateBranchTopology(branches)
  if (topology.problems.length > 0) {
    stop('Neon\'s branch metadata is ambiguous, so nothing may be deleted:', topology.problems)
  }
  console.log(`[cleanup] removing ${branchId} from ${project.name} (${project.id})`)
  await deleteBranch(apiKey, project.id, { cloneId: branchId, parentId: topology.parent.id })
}

const cleanupId = flag('cleanup')
const entry = cleanupId ? cleanupOnly(cleanupId) : main()

entry.catch((error) => {
  console.error(`\nABORTED: ${redact(error.message)}`)
  process.exitCode = 1
})
