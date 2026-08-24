/**
 * The production migration runner for ONE approved rollout, and nothing else.
 *
 *   # what it does by default — a READ-ONLY preflight that migrates nothing
 *   NEON_API_KEY=neon_api_... node scripts/migrate-production-safe.mjs
 *
 *   # the only way it will ever write, and it is one exact value
 *   NEON_API_KEY=neon_api_... node scripts/migrate-production-safe.mjs \
 *     --i-authorize-production-migration=<full commit>+<restore branch id>
 *
 * PREFLIGHT IS THE DEFAULT, NOT A MODE YOU SELECT. Run with no arguments this
 * script performs identity reads against Neon and the live deployment, opens the
 * production database in an EXPLICIT READ ONLY transaction to prove what is
 * recorded there, and stops — with `NO PRODUCTION MIGRATION RAN.` printed where
 * nobody can miss it. In that mode the migration capability does not exist in
 * this process at all: `node:child_process` is never imported, no gate is
 * constructed, and there is no code path from a preflight to a write.
 *
 * WHAT THIS IS SCOPED TO. This file is not a general migration tool. It is
 * hard-coded to one rollout — one commit, one Neon project, one production
 * branch, one restore branch, one health URL, one pending stack — and every one
 * of those values is a constant that a wrong answer must fail against rather
 * than a parameter a caller may supply. When this rollout is done, this script
 * has no further use; the next one gets its own constants, reviewed again.
 *
 * THE ORDER IS THE SAFETY PROPERTY
 *
 *   1. The repository is snapshotted (journal + all 20 migration files) BEFORE
 *      any authorization is acted upon, so "the committed files are what ran"
 *      is checked afterwards against bytes captured beforehand.
 *   2. The live application at the fixed health URL must say, itself, that it is
 *      production and publish the expected database fingerprint. Redirects are
 *      refused rather than followed.
 *   3. The Neon project, the production branch, its default/primary topology,
 *      and the supplied restore branch's complete metadata are all proved from
 *      the control plane BEFORE a single production database connection exists.
 *   4. The production connection strings are fetched to be hashed and handed to
 *      one child process. They are never printed, and the pooled one must hash
 *      to exactly what the live application published.
 *   5. Only then is a connection opened, and only inside an explicit
 *      READ ONLY transaction: the ledger must reconcile exactly through 0015 by
 *      order, hash and timestamp; the pending stack must derive to exactly
 *      0016 … 0019; the complete pre-existing drift must be exactly
 *      `strain_type.hybrid_i` and `strain_type.hybrid_s`; and the 0018
 *      equivalence exception must prove itself against this run's own evidence.
 *   6. ONLY after all of that, and only with the one exact authorization value,
 *      is `node:child_process` imported and a single gated
 *      `npx drizzle-kit migrate` run for the whole stack.
 *   7. The postchecks are READ ONLY too.
 *
 * WHAT IT NEVER DOES
 *
 *   - migrate without the exact authorization value, which names the full commit
 *     AND the restore branch simultaneously; a shortened commit, a wrong restore
 *     id, a bare flag, a duplicate, an alternate flag, or an environment
 *     variable pretending to be one are all refusals
 *   - apply a subset: no `--step`, no `--to`, no per-file execution, no
 *     statement splitting, no `db:push`, no repair SQL
 *   - write to `drizzle.__drizzle_migrations` by any route other than
 *     drizzle-kit's own, or edit/truncate the journal or a migration file
 *   - run the rehearsal's behavioural probes, or ANY statement that inserts,
 *     changes or removes a row, against production — every statement this
 *     process can issue is in `PRODUCTION_READ_ONLY_SQL` and every one of them
 *     is a `select`
 *   - claim that carried production data is unchanged. Production serves live
 *     traffic during the run; a row-count or digest comparison across the
 *     migration would be comparing two different databases-in-time and any
 *     equality it reported would be luck. It is deliberately not claimed.
 *   - print a connection string, a credential, an API key, child stdout/stderr,
 *     or an unredacted Error string
 *
 * IMPORT SAFETY, AND WHY THE HEAVY IMPORTS ARE DYNAMIC. Everything imported at
 * the top of this file is pure: `node:fs`, `node:path`, `node:url`, the frozen
 * fingerprint constants, and the rehearsal's pure decision core. The Neon
 * driver, the Neon control-plane helpers, the fingerprint hashers, and
 * `node:child_process` are imported INSIDE `main()`, at the point they are
 * needed. That is what lets `scripts/verify-migrate-production-safe.mjs` import
 * this module and test its decisions with no ability to reach a network, a
 * database, or a credential — and it is also why a preflight cannot spawn a
 * process even in principle: the module that could is never loaded.
 *
 * `main()` runs only when this file is the process entry point, so importing it
 * does nothing at all.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PRODUCTION_HOST_FINGERPRINT, isProductionHostFingerprint } from './environment-fingerprints.mjs'
import {
  ALL_TAGS,
  HEALTH_REDIRECT_POLICY,
  PENDING_TAGS,
  PRODUCTION_HEALTH_ORIGIN,
  PRODUCTION_HEALTH_URL,
  RECORDED_TAGS,
  STRAIN_EQUIVALENCE_TAG,
  STRAIN_LEANING_VALUES,
  STRAIN_TYPE_EXPECTED_ORDER,
  STRAIN_TYPE_ORDER_QUERY,
  buildObservedKeys,
  buildPendingInventory,
  buildRepositoryMigrations,
  createMigrationGate,
  derivePendingStack,
  describeStrainLeaningEquivalence,
  evaluateApplied,
  evaluateBranchTopology,
  evaluateDrift,
  evaluateHealthEndpointIdentity,
  evaluateHealthIdentity,
  evaluateStrainLeaningEquivalence,
  interpretBranchFlag,
  objectKey,
  reconcileLedger,
  redactSecrets,
  resolveHealthOrigin,
  withProbeTransaction,
} from './rehearse-migration-branch-core.mjs'

/* ================================================== the rollout, hard-coded = */

/**
 * THE COMMIT THIS TOOLING WAS REVIEWED AT, IN FULL.
 *
 * Written out to forty characters because the authorization value below embeds
 * it, and a short SHA is exactly the kind of thing that gets copied out of a
 * terminal, ages, and later names a different commit. This script runs no git
 * command — it is not permitted to — so the commit is not something it reads
 * from the working tree. It is the identity an operator must type back,
 * unabbreviated, to say which reviewed rollout they are executing. What the
 * working tree actually contains is proved separately and far more strictly:
 * every migration file is hashed and reconciled against the production ledger,
 * and re-read byte-for-byte after the migration.
 */
export const ROLLOUT_COMMIT = 'c211e69184bcf3425a3a913564cf6ffa8eb7bc38'

/** The one Neon project. Not read from NEON_PROJECT_ID, and not overridable. */
export const NEON_PROJECT_ID = 'autumn-forest-66121161'

/** The one production branch. Its topology is still proved, never assumed. */
export const PRODUCTION_BRANCH_ID = 'br-morning-dust-axka99k2'

/** The database and role the production connection strings are fetched for. */
export const PRODUCTION_DATABASE = 'cloudmarket'
export const PRODUCTION_ROLE = 'neondb_owner'

/**
 * THE RESTORE POINT, VERIFIED THROUGH NEON BEFORE PRODUCTION IS TOUCHED.
 *
 * A restore branch an operator merely says exists is not a restore point. All
 * four facts are checked against the control plane's own metadata, and the two
 * flags must read explicitly `false` — an omitted, null, or non-boolean flag is
 * unproven, and this script does not migrate production on an inferred negative.
 */
export const RESTORE_BRANCH_ID = 'br-rough-dew-axs1gf3p'
export const RESTORE_BRANCH_NAME = 'restore-pre-0016-0019-1787540740418'
export const RESTORE_PARENT_BRANCH_ID = 'br-morning-dust-axka99k2'

/* ======================================================== the authorization = */

/** The only flag this script accepts at all. */
export const AUTHORIZATION_FLAG = '--i-authorize-production-migration'

/**
 * ONE VALUE, NAMING BOTH FACTS AT ONCE.
 *
 * The commit says WHICH reviewed change is being applied; the restore branch id
 * says the way back exists and the operator knows its name. Binding them into a
 * single string means neither can be supplied without the other, and it makes
 * the authorization impossible to produce by accident: nothing in a shell
 * history, a CI template, or a copy-pasted command yields this string unless
 * someone assembled it deliberately for this rollout.
 */
export const EXECUTION_AUTHORIZATION = `${ROLLOUT_COMMIT}+${RESTORE_BRANCH_ID}`

export const MODE_PREFLIGHT = 'preflight'
export const MODE_EXECUTE = 'execute'

/**
 * Flags that have historically meant "do it anyway" somewhere.
 *
 * None of them is implemented, so listing them changes no behaviour — every
 * unrecognised argument is refused regardless. They are named so that an
 * operator reaching for one gets a sentence explaining that there is exactly one
 * authorization and this is not it, rather than a generic parse error they might
 * read as "wrong syntax, try another flag".
 */
export const ALTERNATE_AUTHORIZATION_FLAGS = Object.freeze([
  '--force',
  '--yes',
  '-y',
  '--confirm',
  '--execute',
  '--apply',
  '--go',
  '--run',
  '--now',
  '--no-preflight',
  '--skip-preflight',
  '--skip-checks',
  '--allow-production',
  '--i-know-what-im-doing',
  '--dangerously-continue',
  '--step',
  '--to',
  '--push',
  '--repair',
  '--keep',
  '--skip',
])

/**
 * Environment variables that must NEVER authorize a production migration.
 *
 * An exported variable is inherited by every process in a shell, survives in CI
 * configuration, and is invisible in the command someone reads back to a
 * colleague. Authorization has to be a thing a person typed on the line that ran
 * this script, so a set variable from this list is not ignored — it is a
 * refusal, because its presence means somebody tried to make the write path
 * ambient.
 */
export const AUTHORIZATION_ENVIRONMENT_NAMES = Object.freeze([
  'I_AUTHORIZE_PRODUCTION_MIGRATION',
  'PRODUCTION_MIGRATION_AUTHORIZATION',
  'PRODUCTION_MIGRATION_AUTHORIZED',
  'MIGRATE_PRODUCTION',
  'MIGRATE_PRODUCTION_SAFE',
  'CONFIRM_PRODUCTION_MIGRATION',
  'ALLOW_PRODUCTION_MIGRATION',
])

/** Environment variables that must not disagree with the hard-coded identity. */
export const IDENTITY_ENVIRONMENT_EXPECTATIONS = Object.freeze({
  NEON_PROJECT_ID,
  NEON_DATABASE: PRODUCTION_DATABASE,
  NEON_ROLE: PRODUCTION_ROLE,
})

/* ============================================================ expectations == */

/**
 * The complete declared inventory of the pending stack, and the part of it that
 * must still exist afterwards.
 *
 * 0019 drops two indexes that 0017 creates, so the stack declares 75 objects of
 * which 73 survive it. Both numbers are asserted: a repository that declares a
 * different number of objects is not the reviewed rollout, whichever direction
 * it moved in.
 */
export const PENDING_DECLARED_OBJECTS = 75
export const PENDING_DROPPED_OBJECTS = 2
export const PENDING_SURVIVING_OBJECTS = PENDING_DECLARED_OBJECTS - PENDING_DROPPED_OBJECTS

/**
 * The complete set of pending-declared objects production is permitted to
 * already carry — and it is permitted only because
 * `evaluateStrainLeaningEquivalence` proves the whole state reconciles.
 */
export const PERMITTED_PRE_EXISTING_KEYS = Object.freeze(
  STRAIN_LEANING_VALUES.map((value) => objectKey.enumValue('strain_type', value)),
)

/** The message the default path exists to print. */
export const NO_MIGRATION_NOTICE = 'NO PRODUCTION MIGRATION RAN.'

/* ============================================== every statement, and no more */

/**
 * READ ONLY IS DECLARED, NOT ASSUMED.
 *
 * Every proof query runs inside `begin transaction read only`, so a statement
 * that tried to write would raise 25006 rather than succeed — the guarantee is
 * enforced by PostgreSQL instead of by this file's good intentions. The session
 * is set read-only as well, which covers anything the driver might issue outside
 * the explicit transaction.
 */
export const READ_ONLY_SESSION_SQL = 'set session characteristics as transaction read only'
export const READ_ONLY_BEGIN_SQL = 'begin transaction read only'
/** Ended by rolling back: there is nothing to commit, and `rollback` says so. */
export const READ_ONLY_END_SQL = 'rollback'

/**
 * THE COMPLETE LIST OF STATEMENTS THIS PROCESS CAN ISSUE AGAINST PRODUCTION.
 *
 * Exported as data so the hermetic verifier can assert the property directly:
 * every one of them is a `select`. There is no statement builder, no interpolated
 * identifier, and no parameter — `query()` below takes text and nothing else, so
 * a caller cannot smuggle a value into a statement, and the statements are these.
 */
export const PRODUCTION_READ_ONLY_SQL = Object.freeze({
  ledgerPresent: `select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  ledgerRows: 'select id, hash, created_at from drizzle.__drizzle_migrations order by id asc',
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
  triggers: 'select tgname from pg_trigger where not tgisinternal',
  strainTypeOrder: STRAIN_TYPE_ORDER_QUERY,
})

/* ==================================================== pure decision helpers = */

const flagNameOf = (arg) => {
  const text = String(arg)
  const eq = text.indexOf('=')
  return eq === -1 ? text : text.slice(0, eq)
}

/**
 * PREFLIGHT UNLESS ONE EXACT STRING SAYS OTHERWISE.
 *
 * The refusals never echo the value they refused. A rejected authorization is a
 * string somebody just pasted, and the thing people paste into a terminal by
 * mistake is whatever was on the clipboard — a token, a DSN, a URL with
 * userinfo. This runs before any secret is registered with the redactor, so an
 * echo here would be an echo in the clear. What is reported is the argument's
 * position and the shape of the mistake, both of which come from this module.
 *
 * @param {object} input
 * @param {readonly unknown[]} input.argv  user-supplied arguments only
 * @param {Record<string,unknown>} input.env  the environment, read but never trusted
 */
export function resolveExecutionAuthorization({ argv, env } = {}) {
  const problems = []

  if (!Array.isArray(argv)) {
    return {
      problems: ['No argument list was supplied, so no authorization can be read from one.'],
      mode: MODE_PREFLIGHT,
      authorized: false,
    }
  }

  for (const name of AUTHORIZATION_ENVIRONMENT_NAMES) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim().length > 0) {
      problems.push(
        `The environment variable ${name} is set. A production migration is authorized by a value typed ` +
          'on the command line for this run and by nothing else — an exported variable is ambient, ' +
          'inherited, and invisible in the command a person reads back. Its value is deliberately not ' +
          'shown. Unset it and re-run.',
      )
    }
  }

  const authorizationArgs = []

  argv.forEach((arg, index) => {
    if (typeof arg !== 'string') {
      problems.push(`Argument #${index + 1} is not a string, so it cannot be read as anything.`)
      return
    }
    const name = flagNameOf(arg)
    if (name === AUTHORIZATION_FLAG) {
      authorizationArgs.push(arg)
      return
    }
    if (ALTERNATE_AUTHORIZATION_FLAGS.includes(name)) {
      problems.push(
        `Refusing argument #${index + 1} (${name}): there is exactly one authorization for this rollout ` +
          `and it is ${AUTHORIZATION_FLAG}=<full commit>+<restore branch id>. No other flag makes this ` +
          'script write, applies a subset of the stack, or skips a check.',
      )
      return
    }
    problems.push(
      `Refusing argument #${index + 1} (${name.startsWith('-') ? `the ${name} flag` : 'a positional argument'}): ` +
        `this script takes no arguments other than ${AUTHORIZATION_FLAG}. The value is not repeated here, ` +
        'because a mistyped argument may carry a token or a credential.',
    )
  })

  if (authorizationArgs.length > 1) {
    problems.push(
      `${AUTHORIZATION_FLAG} was supplied ${authorizationArgs.length} times. A duplicated or conflicting ` +
        'authorization is not a stronger one — it means two different intentions are on the command line, ' +
        'and this script will not choose between them.',
    )
  } else if (authorizationArgs.length === 1) {
    const arg = authorizationArgs[0]
    if (!arg.startsWith(`${AUTHORIZATION_FLAG}=`)) {
      problems.push(
        `${AUTHORIZATION_FLAG} was supplied with no value. The authorization IS the value: it names the ` +
          'full 40-character commit and the restore branch id together.',
      )
    } else if (arg.slice(AUTHORIZATION_FLAG.length + 1) !== EXECUTION_AUTHORIZATION) {
      problems.push(
        `The value supplied to ${AUTHORIZATION_FLAG} is not the authorization for this rollout. It must be ` +
          `the full commit ${ROLLOUT_COMMIT} and the restore branch ${RESTORE_BRANCH_ID}, joined by "+", ` +
          'exactly — an abbreviated commit, a different restore branch, a different order, different case, ' +
          'or any surrounding whitespace is a different string and is refused. The value received is not ' +
          'printed.',
      )
    }
  }

  const authorized = problems.length === 0 && authorizationArgs.length === 1
  return { problems, mode: authorized ? MODE_EXECUTE : MODE_PREFLIGHT, authorized }
}

/**
 * Variables that name a project, database, or role are not consulted anywhere in
 * this script — but one set to something else is evidence that the operator
 * believes they are pointing this run somewhere it will not go, and that
 * disagreement is worth stopping for.
 */
export function evaluateEnvironmentOverrides(env) {
  const problems = []
  for (const [name, expected] of Object.entries(IDENTITY_ENVIRONMENT_EXPECTATIONS)) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim().length > 0 && value.trim() !== expected) {
      problems.push(
        `${name} is set to something other than "${expected}". This script is hard-coded to one rollout ` +
          'and reads no target from the environment, so the variable would have no effect — which is ' +
          'exactly why a disagreement stops the run instead of being ignored.',
      )
    }
  }
  if (typeof env?.NEON_PROJECT_NAME === 'string' && env.NEON_PROJECT_NAME.trim().length > 0) {
    problems.push(
      'NEON_PROJECT_NAME is set. This script resolves the project by its hard-coded id ' +
        `(${NEON_PROJECT_ID}) and never by name; a name in the environment can only mean the operator ` +
        'expects a different resolution than the one that will happen.',
    )
  }
  return { problems }
}

/** The project the control plane answered with must be the project asked for. */
export function evaluateProductionProject(project) {
  const problems = []
  if (!project || typeof project !== 'object') {
    problems.push('Neon returned no project object for the hard-coded project id.')
    return { problems }
  }
  if (project.id !== NEON_PROJECT_ID) {
    problems.push(
      `Neon answered with project "${project.id ?? '(no id)'}" for a request naming ${NEON_PROJECT_ID}. ` +
        'Nothing further may be read from that answer.',
    )
  }
  return { problems }
}

/**
 * The production topology, proved exactly.
 *
 * `evaluateBranchTopology` has already refused a project where the flags are
 * ambiguous, contradictory, non-boolean, or claimed by two branches. What is
 * added here is the identity: the branch those flags point at must be THIS
 * rollout's production branch, no other branch may claim either flag, and
 * neither flag may read explicitly `false` on it.
 */
export function evaluateProductionTopology({ branches, topology }) {
  const problems = []

  if (!Array.isArray(branches) || branches.length === 0) {
    return { problems: ['Neon returned no branch list, so production cannot be identified.'], flags: null }
  }
  const parent = topology?.parent ?? null
  if (!parent || typeof parent.id !== 'string') {
    return { problems: ['Neon\'s branch metadata did not resolve to a single production branch.'], flags: null }
  }
  if (parent.id !== PRODUCTION_BRANCH_ID) {
    problems.push(
      `The unambiguous default/primary branch of this project is "${parent.id}", not the production ` +
        `branch this rollout is defined against (${PRODUCTION_BRANCH_ID}).`,
    )
  }

  const flags = {}
  for (const flag of ['default', 'primary']) {
    flags[flag] = interpretBranchFlag(parent[flag])
    if (flags[flag] === 'clear') {
      problems.push(`The production branch reports "${flag}": false, which contradicts it being production.`)
    }
  }
  if (flags.default !== 'set' && flags.primary !== 'set') {
    problems.push(
      'Neither "default" nor "primary" is explicitly true on the production branch. At least one of them ' +
        'must positively identify it; an inferred production branch is not one.',
    )
  }

  for (const branch of branches) {
    if (branch?.id === PRODUCTION_BRANCH_ID) continue
    for (const flag of ['default', 'primary']) {
      if (branch?.[flag] === true) {
        problems.push(
          `Branch "${branch?.id ?? '(no id)'}" also reports "${flag}": true. Two branches claiming ` +
            'production is not a state anything may be migrated in.',
        )
      }
    }
  }

  return { problems, flags: problems.length === 0 ? flags : null }
}

/**
 * The restore point, from the control plane's own metadata, before production is
 * connected to.
 *
 * Every one of the four facts is required, and both flags must read explicitly
 * `false`. Missing, null, non-boolean, ambiguous, or mismatched metadata refuses:
 * the entire value of a restore branch is that it is the thing that still exists
 * when the migration went wrong, and a branch that cannot be positively
 * identified beforehand is not that thing.
 */
export function evaluateRestoreBranch({ branches }) {
  const problems = []

  if (!Array.isArray(branches)) {
    return { problems: ['Neon returned no branch list, so the restore branch cannot be verified.'], restore: null }
  }

  const matches = branches.filter((branch) => branch?.id === RESTORE_BRANCH_ID)
  if (matches.length === 0) {
    return {
      problems: [
        `No branch in project ${NEON_PROJECT_ID} has the id ${RESTORE_BRANCH_ID}. The restore point this ` +
          'rollout is authorized against does not exist where it is supposed to be.',
      ],
      restore: null,
    }
  }
  if (matches.length > 1) {
    return {
      problems: [`${matches.length} branches report the id ${RESTORE_BRANCH_ID}, so the restore point is ambiguous.`],
      restore: null,
    }
  }

  const restore = matches[0]

  if (restore.id === PRODUCTION_BRANCH_ID) {
    problems.push('The restore branch id is the production branch id. Production is not its own restore point.')
  }
  if (restore.name !== RESTORE_BRANCH_NAME) {
    problems.push(
      `The restore branch is named "${restore.name ?? '(no name)'}", not "${RESTORE_BRANCH_NAME}". A branch ` +
        'with the right id and the wrong name is not the branch that was reviewed.',
    )
  }
  if (restore.parent_id !== RESTORE_PARENT_BRANCH_ID) {
    problems.push(
      `The restore branch reports parent_id "${restore.parent_id ?? '(none)'}", not ` +
        `${RESTORE_PARENT_BRANCH_ID}. A restore point taken from something other than production restores ` +
        'something other than production.',
    )
  }
  for (const flag of ['default', 'primary']) {
    const state = interpretBranchFlag(restore[flag])
    if (state === 'set') {
      problems.push(`The restore branch is marked ${flag}: true. It must be a plain, non-serving branch.`)
    } else if (state === 'ambiguous') {
      problems.push(
        `The restore branch does not explicitly report "${flag}": false — it reports ` +
          `${String(restore[flag])}. Omitted, null, and non-boolean metadata are unproven, and this rollout ` +
          'is not authorized against an unproven restore point.',
      )
    }
  }

  return { problems, restore: problems.length === 0 ? restore : null }
}

/**
 * The connection strings must be production's, must be one branch, and the
 * pooled one must hash to exactly what the live application published.
 *
 * Only fingerprints cross this boundary. The URIs themselves are registered with
 * the redactor the moment they exist and are never an argument to this function.
 */
export function evaluateProductionConnectionIdentity({
  pooledHost,
  directHost,
  pooledEndpoint,
  directEndpoint,
  liveFingerprint,
}) {
  const problems = []

  for (const [label, value] of [
    ['pooled host', pooledHost],
    ['direct host', directHost],
    ['pooled endpoint', pooledEndpoint],
    ['direct endpoint', directEndpoint],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`The production ${label} produced no fingerprint, so identity cannot be established.`)
    }
  }
  if (problems.length > 0) return { problems }

  if (pooledEndpoint !== directEndpoint) {
    problems.push(
      'The pooled and direct production strings are on different Neon endpoints, so they are not one ' +
        'branch and cannot both be handed to the migration.',
    )
  }
  if (pooledHost === directHost) {
    problems.push(
      'The pooled and direct production strings hash to the same host. One of them is not what it is ' +
        'supposed to be, and DDL over a pooler can fail mid-run.',
    )
  }
  if (typeof liveFingerprint !== 'string' || liveFingerprint.length === 0) {
    problems.push('No live application fingerprint was established, so nothing anchors this connection.')
  } else if (pooledHost !== liveFingerprint) {
    problems.push(
      `The production pooled fingerprint (${pooledHost}) is not the database the live application ` +
        `publishes (${liveFingerprint}). The branch Neon calls production is not the one serving traffic, ` +
        'and this rollout is defined against the one serving traffic.',
    )
  }
  if (pooledHost !== PRODUCTION_HOST_FINGERPRINT) {
    problems.push(
      `The production pooled fingerprint (${pooledHost}) is not the recorded production fingerprint ` +
        `(${PRODUCTION_HOST_FINGERPRINT}). Either production moved or the recorded constant is stale — a ` +
        'person must decide which.',
    )
  }
  if (!isProductionHostFingerprint(pooledHost)) {
    problems.push(`The production pooled fingerprint (${pooledHost}) is not a known production fingerprint at all.`)
  }

  return { problems }
}

/**
 * The complete pre-existing drift must be exactly the two leaning enum values.
 *
 * This is a bound on the WHOLE set, not a search for two members of it: a third
 * pre-existing object, one of the two missing, or an object without a readable
 * key all refuse. `evaluateStrainLeaningEquivalence` then proves, independently,
 * that this exact state is a reconcilable one.
 */
export function evaluatePreExistingDrift(driftPresent) {
  const problems = []
  const expected = [...PERMITTED_PRE_EXISTING_KEYS].sort().join(' + ')

  if (!Array.isArray(driftPresent)) {
    return { problems: ['No inventory of pre-existing objects was produced, so drift cannot be bounded.'] }
  }
  const keys = driftPresent.map((object) => (typeof object?.key === 'string' ? object.key : null))
  if (keys.some((key) => key === null)) {
    problems.push('A pre-existing object was reported without a usable key, so the drifted set is unreadable.')
    return { problems }
  }
  if (keys.length !== PERMITTED_PRE_EXISTING_KEYS.length || [...keys].sort().join(' + ') !== expected) {
    problems.push(
      `This rollout is defined against a production schema whose complete pre-existing pending drift is ` +
        `exactly ${expected}. It reads [${keys.join(', ') || 'empty'}], which is a different database than ` +
        'the one that was reviewed and rehearsed.',
    )
  }
  return { problems }
}

/** The repository must declare the reviewed number of objects, in both directions. */
export function evaluateInventoryShape({ inventory, dropped }) {
  const problems = []
  if (!Array.isArray(inventory) || !Array.isArray(dropped)) {
    return { problems: ['The pending stack produced no inventory, so nothing about it can be required.'] }
  }
  if (inventory.length !== PENDING_DECLARED_OBJECTS) {
    problems.push(
      `The pending stack declares ${inventory.length} objects; this rollout was reviewed against ` +
        `${PENDING_DECLARED_OBJECTS}.`,
    )
  }
  if (dropped.length !== PENDING_DROPPED_OBJECTS) {
    problems.push(
      `The pending stack drops ${dropped.length} objects; this rollout was reviewed against ` +
        `${PENDING_DROPPED_OBJECTS}.`,
    )
  }
  return { problems }
}

/* ================================================================== paths == */

const SELF = fileURLToPath(import.meta.url)
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const JOURNAL_PATH = join(REPO_ROOT, 'drizzle', 'meta', '_journal.json')
const migrationPath = (tag) => join(REPO_ROOT, 'drizzle', `${tag}.sql`)

/* ============================================================== the runner = */

const SECRETS = new Set()
const remember = (secret) => {
  if (typeof secret === 'string' && secret.length > 0) SECRETS.add(secret)
  return secret
}
const redact = (value) => redactSecrets(value, SECRETS)

const stage = (title) => console.log(`\n${redact(title)}`)
const note = (text) => console.log(`    ${redact(text)}`)
const ok = (text) => console.log(`    ok    ${redact(text)}`)

/** Every failure path goes through here. There is no "warn and continue". */
function stop(headline, problems) {
  throw new Error(`${headline}\n${problems.map((p) => `  • ${p}`).join('\n')}`)
}

/**
 * The journal and every migration file, captured BEFORE anything else happens.
 *
 * The bytes are retained so that "drizzle-kit applied the committed files" is
 * something this run checks afterwards rather than something it asserts.
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
    problems.push('drizzle/meta/_journal.json changed during this run.')
  }
  for (const [tag, text] of Object.entries(snapshot.sources)) {
    let current
    try {
      current = readFileSync(migrationPath(tag)).toString()
    } catch (error) {
      problems.push(`drizzle/${tag}.sql could not be re-read (${redact(error)}).`)
      continue
    }
    if (current !== text) problems.push(`drizzle/${tag}.sql changed during this run.`)
  }
  if (problems.length > 0) {
    stop('The repository changed during the run, so what was applied is not what was reviewed:', problems)
  }
}

/**
 * One explicit READ ONLY transaction, and the guarantee that it always ends.
 *
 * `withProbeTransaction` is the rehearsal's own lifecycle helper: it rolls back
 * from a `finally`, before the release, propagates a rollback failure rather
 * than letting the release displace it, and never returns a connection to the
 * pool with an open transaction on it. Reused rather than re-written, because
 * the ordering is the property that matters and it is already proved.
 */
async function withReadOnlyProduction(pool, body) {
  const client = await pool.connect()
  const query = async (text) => (await client.query(text)).rows

  return withProbeTransaction({
    begin: async () => {
      await client.query(READ_ONLY_SESSION_SQL)
      await client.query(READ_ONLY_BEGIN_SQL)
    },
    body: () => body(query),
    rollback: () => client.query(READ_ONLY_END_SQL),
    release: () => client.release(),
  })
}

/** The ledger, or nothing — "no ledger" and "an empty ledger" are different facts. */
async function readLedger(query) {
  const [{ present }] = await query(PRODUCTION_READ_ONLY_SQL.ledgerPresent)
  if (!present) return null
  return query(PRODUCTION_READ_ONLY_SQL.ledgerRows)
}

/** Everything the drift and post-migration checks need, in one read-only pass. */
async function observeCatalog(query) {
  return {
    tables: (await query(PRODUCTION_READ_ONLY_SQL.tables)).map((r) => r.table_name),
    columns: (await query(PRODUCTION_READ_ONLY_SQL.columns)).map((r) => ({
      table: r.table_name,
      column: r.column_name,
    })),
    types: (await query(PRODUCTION_READ_ONLY_SQL.types)).map((r) => r.typname),
    enumValues: (await query(PRODUCTION_READ_ONLY_SQL.enumValues)).map((r) => ({
      type: r.typname,
      value: r.enumlabel,
    })),
    indexes: (await query(PRODUCTION_READ_ONLY_SQL.indexes)).map((r) => r.indexname),
    constraints: (await query(PRODUCTION_READ_ONLY_SQL.constraints)).map((r) => r.conname),
    functions: (await query(PRODUCTION_READ_ONLY_SQL.functions)).map((r) => r.proname),
    triggers: (await query(PRODUCTION_READ_ONLY_SQL.triggers)).map((r) => r.tgname),
  }
}

/* ==================================================================== main = */

async function main() {
  console.log('CloudMarket production migration — READ-ONLY PREFLIGHT unless explicitly authorized\n')

  let migrationRan = false

  try {
    /* ---- 0. arguments, before anything else exists ---------------------- */
    const argv = process.argv.slice(2)

    /*
     * The health origin is a constant. An argument shaped like an attempt to
     * supply one is refused here, by position and shape, with the value never
     * echoed — this runs before a single secret is registered with the redactor.
     */
    const origin = resolveHealthOrigin(argv)
    if (origin.problems.length > 0) stop('Refusing to start:', origin.problems)

    const authorization = resolveExecutionAuthorization({ argv, env: process.env })
    const overrides = evaluateEnvironmentOverrides(process.env)
    if (authorization.problems.length > 0 || overrides.problems.length > 0) {
      stop('Refusing to start:', [...authorization.problems, ...overrides.problems])
    }

    stage('[0] Mode')
    ok(
      authorization.mode === MODE_EXECUTE
        ? 'EXECUTION authorized for this rollout — every check below must still pass'
        : 'READ-ONLY PREFLIGHT (the default). Nothing will be migrated by this run.',
    )

    /* ---- 1. the repository, snapshotted before any of it matters --------- */
    stage('[1] Repository migration set — snapshotted before anything is acted upon')
    const snapshot = readRepositorySnapshot()
    const { problems: repositoryProblems, migrations } = buildRepositoryMigrations({
      journal: snapshot.journal,
      sources: snapshot.sources,
    })
    if (repositoryProblems.length > 0) {
      stop('The repository does not describe the migration stack this rollout is defined against:', repositoryProblems)
    }
    const { inventory, dropped, problems: inventoryProblems } = buildPendingInventory({ migrations })
    const shape = evaluateInventoryShape({ inventory, dropped })
    if (inventoryProblems.length > 0 || shape.problems.length > 0) {
      stop('The pending stack is not the reviewed one:', [...inventoryProblems, ...shape.problems])
    }
    ok(`${migrations.length} migrations, ${ALL_TAGS[0]} … ${ALL_TAGS[ALL_TAGS.length - 1]}, journal and files snapshotted`)
    note(`rollout commit (authorization identity): ${ROLLOUT_COMMIT}`)
    note(`pending stack: ${PENDING_TAGS.join(', ')}`)
    note(
      `${inventory.length} declared objects, ${dropped.length} of them dropped again by the stack, ` +
        `${PENDING_SURVIVING_OBJECTS} expected to survive it`,
    )

    /* ---- 2. the live deployment must say it is production ---------------- */
    stage(`[2] Live production identity at ${PRODUCTION_HEALTH_URL} (fixed, and not configurable)`)
    let health
    try {
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
      health = { reachable: false, httpStatus: 0, body: null, url: null, redirected: false, error: redact(error) }
    }

    const identity = evaluateHealthIdentity({
      reachable: health.reachable,
      httpStatus: health.httpStatus,
      body: health.body,
      expectedFingerprint: PRODUCTION_HOST_FINGERPRINT,
    })
    const endpointIdentity = health.reachable
      ? evaluateHealthEndpointIdentity({ url: health.url, redirected: health.redirected })
      : { problems: [] }
    if (identity.problems.length > 0 || endpointIdentity.problems.length > 0) {
      stop(`The deployment at ${PRODUCTION_HEALTH_ORIGIN} did not establish production identity:`, [
        ...endpointIdentity.problems,
        ...identity.problems,
        'Identity may only be established by that exact URL answering directly; a redirect is refused ' +
          'rather than followed.',
      ])
    }
    const liveFingerprint = identity.fingerprint
    ok(`${PRODUCTION_HEALTH_ORIGIN} reports environment "production" and database ${liveFingerprint}`)

    /* ---- 3. the Neon project and the production topology ----------------- */
    stage('[3] Neon project, production topology, and the restore point')
    const { api, assertEndpointShape, connectionUri, listBranches, requireApiKey } = await import('./neon-api.mjs')
    const apiKey = remember(requireApiKey(SELF))

    const { project } = await api(apiKey, `/projects/${NEON_PROJECT_ID}`)
    const projectIdentity = evaluateProductionProject(project)
    if (projectIdentity.problems.length > 0) stop('The Neon project could not be resolved:', projectIdentity.problems)
    note(`project ${project.name} (${project.id})`)

    const branches = await listBranches(apiKey, NEON_PROJECT_ID)
    const topology = evaluateBranchTopology(branches)
    const production = evaluateProductionTopology({ branches, topology })
    if (topology.problems.length > 0 || production.problems.length > 0) {
      stop('Neon\'s branch metadata does not prove the production topology of this rollout:', [
        ...topology.problems,
        ...production.problems,
      ])
    }
    ok(`production branch ${PRODUCTION_BRANCH_ID} is unambiguously default/primary, and nothing else is`)

    /* ---- 4. the restore point, before production is connected to --------- */
    stage('[4] The restore point, from Neon metadata alone')
    const restore = evaluateRestoreBranch({ branches })
    if (restore.problems.length > 0) {
      stop('The restore point this rollout is authorized against is not verifiable:', restore.problems)
    }
    ok(
      `restore branch ${RESTORE_BRANCH_ID} ("${RESTORE_BRANCH_NAME}") exists, is a child of ` +
        `${RESTORE_PARENT_BRANCH_ID}, and reports default:false primary:false`,
    )

    /* ---- 5. the connection strings, hashed and never printed ------------- */
    stage('[5] Production connection identity — still no database connection')
    const { endpointFp, hostFp } = await import('./verify-migration-target.mjs')

    const pooledUri = remember(
      await connectionUri(apiKey, NEON_PROJECT_ID, PRODUCTION_BRANCH_ID, {
        database: PRODUCTION_DATABASE,
        role: PRODUCTION_ROLE,
        pooled: true,
      }),
    )
    const directUri = remember(
      await connectionUri(apiKey, NEON_PROJECT_ID, PRODUCTION_BRANCH_ID, {
        database: PRODUCTION_DATABASE,
        role: PRODUCTION_ROLE,
        pooled: false,
      }),
    )
    try {
      assertEndpointShape(pooledUri, directUri)
    } catch (error) {
      stop('The production connection strings are not a pooled/direct pair:', [redact(error)])
    }

    const connection = evaluateProductionConnectionIdentity({
      pooledHost: hostFp(pooledUri),
      directHost: hostFp(directUri),
      pooledEndpoint: endpointFp(pooledUri),
      directEndpoint: endpointFp(directUri),
      liveFingerprint,
    })
    if (connection.problems.length > 0) {
      stop('The production connection is not provably the live production database:', connection.problems)
    }
    ok(`pooled fingerprint ${hostFp(pooledUri)} equals the live application fingerprint; both strings are one branch`)

    /* ---- 6. READ ONLY proof, through the production connection ----------- */
    stage('[6] Production preflight — one explicit READ ONLY transaction')
    const { Pool, neonConfig } = await import('@neondatabase/serverless')
    if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

    const pool = new Pool({ connectionString: directUri })
    let evidence
    try {
      evidence = await withReadOnlyProduction(pool, async (query) => {
        const ledger = await readLedger(query)
        const observation = await observeCatalog(query)
        const strainTypeRows = await query(PRODUCTION_READ_ONLY_SQL.strainTypeOrder)
        return { ledger, observation, strainTypeRows }
      })

      const reconciliation = reconcileLedger({
        migrations,
        rows: evidence.ledger,
        expectedTags: RECORDED_TAGS,
      })
      if (reconciliation.problems.length > 0) {
        stop('The production ledger does not reconcile with this repository:', reconciliation.problems)
      }
      ok(`${RECORDED_TAGS.length} ledger rows match by order, hash, and timestamp through ${RECORDED_TAGS[RECORDED_TAGS.length - 1]}`)

      const pending = derivePendingStack({ migrations, rows: evidence.ledger })
      if (pending.problems.length > 0) {
        stop('The pending stack derived from production is not the reviewed one:', pending.problems)
      }
      ok(`pending, derived from the ledger: ${pending.pendingTags.join(', ')}`)

      const observed = buildObservedKeys(evidence.observation)
      if (observed.problems.length > 0) {
        stop('Production\'s catalogs could not be read completely:', observed.problems)
      }
      const drift = evaluateDrift({
        inventory,
        recordedTags: reconciliation.recordedTags,
        observedKeys: observed.keys,
      })
      const bounded = evaluatePreExistingDrift(drift.present)
      if (bounded.problems.length > 0) {
        stop('BLOCKING DRIFT — production is not in the state this rollout was reviewed against:', [
          ...drift.problems,
          ...bounded.problems,
        ])
      }

      /*
       * THE ONE EXCEPTION, PROVED FROM THIS RUN'S OWN EVIDENCE.
       *
       * Drift stays blocking. What is permitted is one fully proved state, and
       * every input below is the actual reading taken above: the reconciled
       * ledger, the derived pending stack, the complete drift set, the
       * snapshotted repository copy of 0018, and a direct READ ONLY catalog
       * query of the live enum's own sort order. This is many statements above
       * anything that could construct a migration command.
       */
      const equivalence = evaluateStrainLeaningEquivalence({
        recordedTags: reconciliation.recordedTags,
        pendingTags: pending.pendingTags,
        driftPresent: drift.present,
        source: snapshot.sources[STRAIN_EQUIVALENCE_TAG],
        strainTypeRows: evidence.strainTypeRows,
      })
      if (equivalence.equivalent !== true) {
        stop('BLOCKING DRIFT — the pre-existing objects do not reconcile:', [
          ...drift.problems,
          ...equivalence.problems,
          'A pre-existing object is a schema and a ledger disagreeing. It is never evidence that a ' +
            'migration was applied, and it is never something to migrate over.',
        ])
      }
      note(`${drift.present.length} pre-existing object(s) — the ${STRAIN_EQUIVALENCE_TAG} equivalence exception applies`)
      for (const line of describeStrainLeaningEquivalence(equivalence)) ok(line)
      ok(`public.strain_type reads exactly ${STRAIN_TYPE_EXPECTED_ORDER.join(', ')}`)

      /* ---- 7. authorization, acted upon only now --------------------- */
      if (authorization.mode !== MODE_EXECUTE) {
        stage('[7] Execution authorization')
        note(`not supplied — ${AUTHORIZATION_FLAG}=<full commit>+<restore branch id> is required to migrate`)
        console.log('\n==========================================================')
        console.log('PREFLIGHT PASSED — READ ONLY')
        console.log(`  ${NO_MIGRATION_NOTICE}`)
        console.log('  Production was read inside an explicit READ ONLY transaction and nothing else.')
        console.log('  No migration command was constructed, spawned, or made available to this process.')
        console.log(`  pending stack still to apply   ${PENDING_TAGS.join(', ')}`)
        console.log(`  restore point verified         ${RESTORE_BRANCH_ID}`)
        console.log('==========================================================')
        return
      }

      /* ---- 8. THE ONE MIGRATION COMMAND ------------------------------ */
      stage('[8] Applying the pending stack — the repository\'s own drizzle-kit migrate, once')
      /*
       * THE CAPABILITY IS CREATED HERE AND NOWHERE ELSE.
       *
       * Every line above ran in a process that could not spawn anything: this
       * is the only place the child-process module is ever loaded, and it is
       * unreachable until the ledger reconciled, the pending stack derived, the
       * drift was bounded and proved, the restore point was verified, the
       * repository was snapshotted, and the one exact authorization was supplied.
       */
      const { execFileSync } = await import('node:child_process')
      const gate = createMigrationGate((file, args, options) =>
        execFileSync(file, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      )
      gate.clear()

      const started = Date.now()
      let failure = null
      try {
        migrationRan = true
        gate.run('npx', ['drizzle-kit', 'migrate'], {
          cwd: REPO_ROOT,
          /*
           * The production credentials exist in exactly one child environment
           * and nowhere else in this process's own. dotenv does not override a
           * variable that is already set, so `drizzle.config.ts` cannot fall back
           * to `.env.local` for either of them.
           */
          env: { ...process.env, DATABASE_URL: pooledUri, DATABASE_URL_UNPOOLED: directUri },
          shell: process.platform === 'win32',
        })
      } catch (error) {
        /* Redacted at capture: a failing drizzle-kit prints the config it was given. */
        failure = redact(`${error.stdout ?? ''}${error.stderr ?? ''}` || error.message)
      }
      const migrationMs = Date.now() - started

      if (failure !== null) {
        console.error(String(failure).slice(-3000))
        stop('The production migration failed:', [
          'drizzle-kit migrate exited non-zero — the redacted tail of its output is above.',
          `The restore point for this rollout is ${RESTORE_BRANCH_ID} ("${RESTORE_BRANCH_NAME}").`,
        ])
      }
      ok(`applied in ${migrationMs} ms, ${gate.invocations} invocation`)

      /* ---- 9. postchecks, READ ONLY ---------------------------------- */
      stage('[9] Post-migration verification — READ ONLY')
      assertRepositoryUnchanged(snapshot)
      ok(`the journal and all ${ALL_TAGS.length} migration files are byte-identical to the pre-execution snapshot`)

      const after = await withReadOnlyProduction(pool, async (query) => ({
        ledger: await readLedger(query),
        observation: await observeCatalog(query),
      }))

      const afterReconciliation = reconcileLedger({ migrations, rows: after.ledger, expectedTags: ALL_TAGS })
      if (afterReconciliation.problems.length > 0) {
        stop('After migrating, the production ledger does not reconcile with this repository:', afterReconciliation.problems)
      }
      const afterPending = derivePendingStack({ migrations, rows: after.ledger })
      if (afterPending.pendingTags.length !== 0) {
        stop('After migrating, migrations are still pending:', [afterPending.pendingTags.join(', ')])
      }
      ok(`${ALL_TAGS.length} ledger rows match by order, hash, and timestamp; 0 pending`)

      const afterObserved = buildObservedKeys(after.observation)
      if (afterObserved.problems.length > 0) {
        stop('Production\'s catalogs could not be re-read after migrating:', afterObserved.problems)
      }
      const applied = evaluateApplied({ inventory, dropped, observedKeys: afterObserved.keys })
      if (applied.problems.length > 0) stop('The migrated schema is not what the pending stack declares:', applied.problems)
      ok(
        `all ${PENDING_SURVIVING_OBJECTS} surviving declared objects of ${inventory.length} exist, and both ` +
          'declared drops are absent',
      )

      console.log('\n==========================================================')
      console.log('PRODUCTION MIGRATION COMPLETE')
      console.log(`  applied                    ${PENDING_TAGS.join(', ')}`)
      console.log(`  duration                   ${migrationMs} ms`)
      console.log(`  ledger                     ${ALL_TAGS.length} rows reconciled, 0 pending`)
      console.log(`  restore point              ${RESTORE_BRANCH_ID} ("${RESTORE_BRANCH_NAME}")`)
      /*
       * SAID PLAINLY, BECAUSE THE ALTERNATIVE IS AN UNSOUND CLAIM. Production
       * serves live traffic throughout; rows are written by the application
       * during the migration. Any before/after row comparison would be comparing
       * two different databases-in-time, so equality is not claimed here. The
       * rehearsal made that comparison where it is sound: on a frozen clone.
       */
      console.log('  carried-data equality      intentionally NOT claimed: production takes live writes')
      console.log('                             throughout, so a before/after comparison would be unsound.')
      console.log('==========================================================')
    } finally {
      await pool.end().catch(() => {})
      console.log('\n    database pool closed')
    }
  } catch (error) {
    process.exitCode = 1
    console.error('\n==========================================================')
    if (migrationRan) {
      console.error('THE MIGRATION COMMAND RAN AND THE RUN THEN FAILED')
      console.error(redact(error))
      console.error(`\nDo not assume a clean state. The restore point is ${RESTORE_BRANCH_ID}.`)
    } else {
      console.error('REFUSED')
      console.error(redact(error))
      console.error(`\n${NO_MIGRATION_NOTICE} Nothing was written to production.`)
    }
    console.error('==========================================================')
  }
}

/** Only when this file is the entry point, so importing it does nothing. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\nABORTED: ${redact(error)}`)
    console.error(NO_MIGRATION_NOTICE)
    process.exitCode = 1
  })
}
