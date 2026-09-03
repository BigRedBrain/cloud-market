/**
 * The production migration runner's refusals, proved without touching anything.
 *
 *   node scripts/verify-migrate-production-safe.mjs
 *
 * HERMETIC BY CONSTRUCTION. No network, no Neon, no Postgres, no credential, no
 * environment secret, no migration, no child process, no git, and no file this
 * process writes. The only I/O is READING files out of this repository — the
 * journal, the twenty-one migration files, and the two scripts themselves — because
 * the properties being proved are properties OF those files.
 *
 * It imports `migrate-production-safe.mjs` directly. That is safe, and it is
 * safe by design rather than by luck: the runner's `main()` is behind an
 * entry-point guard, and every module that could reach a database, the Neon
 * control plane, or a shell is imported dynamically INSIDE `main()`. Importing
 * the runner therefore loads `node:fs`, `node:path`, `node:url`, the frozen
 * fingerprints and the pure rehearsal core — and nothing else exists in this
 * process that could talk to production even if this file asked it to.
 *
 * WHY EVERY ONE OF THESE EXISTS
 *
 * The runner's entire value is what it refuses. It refuses to migrate without an
 * exact authorization naming both the frozen migration release base and the
 * restore branch; it refuses a restore branch whose metadata is merely
 * not-contradictory; it
 * refuses a ledger it cannot reconcile row by row; it refuses to build a
 * migration command before every proof has landed. A refusal that is only
 * reachable by pointing the script at production is a refusal nobody has ever
 * watched work — and this one may only ever be pointed at production once.
 *
 * SOURCE ORDER IS TESTED AS DOMINANCE, NOT AS PRESENCE. "The gate is built after
 * the checks" is not proved by finding both strings in the file. It is proved by
 * comparing offsets, over a copy of the source with comments and string literals
 * removed, so that prose describing a capability can never be mistaken for the
 * capability and a future edit that moves the child-process import upwards fails
 * here.
 *
 * SOURCE INSPECTION IS LINE-ENDING INDEPENDENT. Every structural comparison
 * below reads source text through `normalizeSourceText`, which rewrites CRLF and
 * lone CR to LF in memory and nowhere else — no file is rewritten, and the
 * runner's runtime SQL strings are untouched. Without it, a checkout made with
 * `core.autocrlf=true` reads a multi-line template literal out of the file as
 * `\r\n`-separated text while the module this verifier imports holds the
 * `\n`-separated string the parser produced from the same bytes, and the
 * SQL-literal assertion fails on a difference nobody wrote. The assertion itself
 * is unchanged and unweakened: section 18 proves that a genuinely added
 * statement is still caught in LF, CRLF, and lone-CR source alike.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PRODUCTION_HOST_FINGERPRINT } from './environment-fingerprints.mjs'
import {
  ALL_TAGS,
  HEALTH_REDIRECT_POLICY,
  PENDING_TAGS,
  PRODUCTION_HEALTH_URL,
  RECORDED_TAGS,
  REDACTED,
  STRAIN_EQUIVALENCE_TAG,
  STRAIN_TYPE_EXPECTED_ORDER,
  STRAIN_TYPE_ORDER_QUERY,
  assertMigrationCommand,
  buildPendingInventory,
  buildRepositoryMigrations,
  createMigrationGate,
  derivePendingStack,
  evaluateApplied,
  evaluateBranchTopology,
  evaluateDrift,
  evaluateStrainLeaningEquivalence,
  objectKey,
  reconcileLedger,
  redactSecrets,
  withProbeTransaction,
} from './rehearse-migration-branch-core.mjs'
import {
  ALTERNATE_AUTHORIZATION_FLAGS,
  AUTHORIZATION_ENVIRONMENT_NAMES,
  AUTHORIZATION_FLAG,
  EXECUTION_AUTHORIZATION,
  MODE_EXECUTE,
  MODE_PREFLIGHT,
  NEON_PROJECT_ID,
  NO_MIGRATION_NOTICE,
  PENDING_DECLARED_OBJECTS,
  PENDING_DROPPED_OBJECTS,
  PENDING_SURVIVING_OBJECTS,
  PERMITTED_PRE_EXISTING_KEYS,
  PRODUCTION_BRANCH_ID,
  PRODUCTION_READ_ONLY_SQL,
  READ_ONLY_BEGIN_SQL,
  READ_ONLY_END_SQL,
  READ_ONLY_SESSION_SQL,
  RESTORE_BRANCH_ID,
  RESTORE_BRANCH_NAME,
  RESTORE_PARENT_BRANCH_ID,
  ROLLOUT_COMMIT,
  evaluateEnvironmentOverrides,
  evaluateInventoryShape,
  evaluatePreExistingDrift,
  evaluateProductionConnectionIdentity,
  evaluateProductionProject,
  evaluateProductionTopology,
  evaluateRestoreBranch,
  resolveExecutionAuthorization,
} from './migrate-production-safe.mjs'

/**
 * The number of checks this file must run, declared rather than counted after
 * the fact. A section deleted by a careless merge would otherwise reduce the
 * coverage silently and still print a green summary.
 */
export const EXPECTED_CHECKS = 167

let pass = 0
let fail = 0
const failures = []

const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
  } else {
    fail += 1
    failures.push(name)
  }
  console.log(`    ${condition ? 'ok  ' : 'FAIL'}  ${name}${!condition && detail ? ` — ${detail}` : ''}`)
}
const section = (title) => console.log(`\n${title}`)
const has = (problems, fragment) => (problems ?? []).some((p) => p.includes(fragment))
const refused = (result) => (result?.problems ?? []).length > 0

const repoFile = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url))).toString()

/**
 * THE ONE CANONICAL TRANSFORM FOR SOURCE INSPECTION.
 *
 * CRLF and lone CR become LF, in memory, for text that is about to be compared
 * structurally. It exists so that "what the file says" and "what the JavaScript
 * parser made of the file" are the same text: a template literal's line
 * terminators are normalized to LF by the language itself, so a CRLF checkout
 * otherwise reads a declared statement as different from the string the runner
 * actually holds. Nothing is written back, and it is never applied to a value
 * this process compares as data rather than as source.
 */
const normalizeSourceText = (text) => String(text).replace(/\r\n?/g, '\n')

/*
 * Normalized at the moment they are read, so every downstream inspection —
 * codeOnly(), sqlLiteralsOf(), offsets, dominance, token counts, and the raw
 * `runnerSource.includes(...)` claims — sees one canonical form of the file.
 */
const runnerSource = normalizeSourceText(repoFile('scripts/migrate-production-safe.mjs'))
const verifierSource = normalizeSourceText(repoFile('scripts/verify-migrate-production-safe.mjs'))

/**
 * The source with comments and string literals removed.
 *
 * Every ordering claim below is made against THIS, not against the raw text: a
 * doc comment that mentions `node:child_process` must never be able to satisfy —
 * or to break — a check about where the child-process module is loaded.
 */
const codeOnly = (source) =>
  normalizeSourceText(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\n\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/"(?:[^"\n\\]|\\.)*"/g, '""')

const runnerCode = codeOnly(runnerSource)
const countOf = (haystack, needle) => haystack.split(needle).length - 1
const first = (needle) => runnerCode.indexOf(needle)
const last = (needle) => runnerCode.lastIndexOf(needle)
/** Present, and after every one of the things it must not precede. */
const dominates = (needle, prerequisites) =>
  first(needle) !== -1 && prerequisites.every((p) => first(p) !== -1 && first(needle) > first(p))

/**
 * THE PROOFS, BY THEIR CALL SITES RATHER THAN BY THEIR NAMES.
 *
 * `reconcileLedger(` and `derivePendingStack(` are each called twice — once in
 * the preflight and once in the post-migration verification — so an offset
 * comparison against the bare name would be comparing the capability against
 * the LATER call and could pass or fail for the wrong reason. Each marker below
 * is the exact, unique assignment that performs the proof, so every ordering
 * claim is about the statement it names and no other.
 */
const CALL = Object.freeze({
  snapshot: 'const snapshot = readRepositorySnapshot()',
  authorization: 'const authorization = resolveExecutionAuthorization(',
  health: 'const identity = evaluateHealthIdentity(',
  endpoint: 'const endpointIdentity = health.reachable',
  topology: 'const production = evaluateProductionTopology(',
  restore: 'const restore = evaluateRestoreBranch(',
  connection: 'const connection = evaluateProductionConnectionIdentity(',
  ledger: 'const reconciliation = reconcileLedger(',
  pending: 'const pending = derivePendingStack(',
  drift: 'const drift = evaluateDrift(',
  bounded: 'const bounded = evaluatePreExistingDrift(',
  equivalence: 'const equivalence = evaluateStrainLeaningEquivalence(',
})
/** The statement at which the run either stops or becomes a migration. */
const PREFLIGHT_BRANCH = 'if (authorization.mode !== MODE_EXECUTE)'

/** Module specifiers, from import statements only. */
const importsOf = (source) =>
  [...new Set([...source.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]))].sort()

console.log('Production migration runner — hermetic verification')

/* ============================================ 1. THE ROLLOUT, HARD-CODED (8) */
section('[1] One rollout, hard-coded: migration release base, project, production, health, restore')

check(
  'the frozen migration release base — the reviewed migration artifact identity — is the full 40-character sha, written out',
  ROLLOUT_COMMIT === 'c211e69184bcf3425a3a913564cf6ffa8eb7bc38' && /^[0-9a-f]{40}$/.test(ROLLOUT_COMMIT),
  ROLLOUT_COMMIT,
)
check('the Neon project is the hard-coded one', NEON_PROJECT_ID === 'autumn-forest-66121161', NEON_PROJECT_ID)
check('the production branch is the hard-coded one', PRODUCTION_BRANCH_ID === 'br-morning-dust-axka99k2', PRODUCTION_BRANCH_ID)
check(
  'the health endpoint is the fixed URL, https, and refuses redirects',
  PRODUCTION_HEALTH_URL === 'https://cloudmarket.cc/api/health' && HEALTH_REDIRECT_POLICY === 'error',
  `${PRODUCTION_HEALTH_URL} / ${HEALTH_REDIRECT_POLICY}`,
)
check('the restore branch id is the hard-coded one', RESTORE_BRANCH_ID === 'br-damp-bird-axk2dy92', RESTORE_BRANCH_ID)
check(
  'the restore branch name is the hard-coded one',
  RESTORE_BRANCH_NAME === 'restore-pre-0016-0019-1787595530198',
  RESTORE_BRANCH_NAME,
)
check(
  'the restore branch parent is the production branch',
  RESTORE_PARENT_BRANCH_ID === 'br-morning-dust-axka99k2' && RESTORE_PARENT_BRANCH_ID === PRODUCTION_BRANCH_ID,
)
check(
  'the authorization value binds the full commit AND the restore branch, together',
  EXECUTION_AUTHORIZATION === `${ROLLOUT_COMMIT}+${RESTORE_BRANCH_ID}` &&
    EXECUTION_AUTHORIZATION.includes(ROLLOUT_COMMIT) &&
    EXECUTION_AUTHORIZATION.includes(RESTORE_BRANCH_ID),
  EXECUTION_AUTHORIZATION,
)

/* ======================= 2. PREFLIGHT BY DEFAULT, AND EXACT AUTHORIZATION (25) */
section('[2] Preflight is the default, and exactly one value ever changes that')

const authorize = (argv, env = {}) => resolveExecutionAuthorization({ argv, env })
const exactArg = `${AUTHORIZATION_FLAG}=${EXECUTION_AUTHORIZATION}`

{
  const none = authorize([])
  check(
    'no arguments at all is a READ-ONLY PREFLIGHT, with nothing to complain about',
    none.mode === MODE_PREFLIGHT && none.authorized === false && none.problems.length === 0,
    none.problems.join('; '),
  )

  const exact = authorize([exactArg])
  check(
    'the one exact authorization value, and only it, selects execution',
    exact.mode === MODE_EXECUTE && exact.authorized === true && exact.problems.length === 0,
    exact.problems.join('; '),
  )

  const nearMiss = (value) => authorize([`${AUTHORIZATION_FLAG}=${value}`])
  check(
    'an abbreviated commit refuses',
    nearMiss(`${ROLLOUT_COMMIT.slice(0, 7)}+${RESTORE_BRANCH_ID}`).authorized === false,
  )
  check(
    'a commit that differs by case refuses',
    nearMiss(`${ROLLOUT_COMMIT.toUpperCase()}+${RESTORE_BRANCH_ID}`).authorized === false,
  )
  check('a commit that differs by one character refuses', nearMiss(`${ROLLOUT_COMMIT.slice(0, 39)}0+${RESTORE_BRANCH_ID}`).authorized === false)
  check('a different restore branch id refuses', nearMiss(`${ROLLOUT_COMMIT}+br-some-other-branch-1234abcd`).authorized === false)
  check(
    'the production branch id in place of the restore branch id refuses',
    nearMiss(`${ROLLOUT_COMMIT}+${PRODUCTION_BRANCH_ID}`).authorized === false,
  )
  check('the two halves in the wrong order refuse', nearMiss(`${RESTORE_BRANCH_ID}+${ROLLOUT_COMMIT}`).authorized === false)
  check(
    'a different separator refuses',
    [' ', '-', ':', '', '++'].every((sep) => nearMiss(`${ROLLOUT_COMMIT}${sep}${RESTORE_BRANCH_ID}`).authorized === false),
  )
  check(
    'surrounding whitespace refuses',
    nearMiss(` ${EXECUTION_AUTHORIZATION}`).authorized === false &&
      nearMiss(`${EXECUTION_AUTHORIZATION} `).authorized === false &&
      nearMiss(`${EXECUTION_AUTHORIZATION}\n`).authorized === false,
  )
  check('only the commit, without the restore branch, refuses', nearMiss(ROLLOUT_COMMIT).authorized === false)
  check('only the restore branch, without the commit, refuses', nearMiss(RESTORE_BRANCH_ID).authorized === false)
  check('an empty value refuses', nearMiss('').authorized === false)

  const bare = authorize([AUTHORIZATION_FLAG])
  check(
    'the flag with no value at all refuses, and says the value IS the authorization',
    bare.authorized === false && has(bare.problems, 'supplied with no value'),
  )

  const duplicated = authorize([exactArg, exactArg])
  check(
    'the same authorization supplied twice refuses',
    duplicated.authorized === false && has(duplicated.problems, 'was supplied 2 times'),
  )
  const conflicting = authorize([exactArg, `${AUTHORIZATION_FLAG}=${ROLLOUT_COMMIT}+br-other-branch-0000zzzz`])
  check('two different authorizations refuse rather than one winning', conflicting.authorized === false)

  check(
    'every alternate "do it anyway" flag refuses, alone or alongside the real one',
    ALTERNATE_AUTHORIZATION_FLAGS.every(
      (flag) => authorize([flag]).authorized === false && authorize([exactArg, flag]).authorized === false,
    ),
  )
  check(
    'an unrecognised flag or positional argument refuses',
    authorize(['--anything-else']).authorized === false &&
      authorize(['production']).authorized === false &&
      authorize([exactArg, 'production']).authorized === false,
  )
  check('a non-string argument refuses', authorize([exactArg, 42]).authorized === false)
  check(
    'no argument list at all refuses instead of defaulting to execution',
    resolveExecutionAuthorization({}).authorized === false &&
      resolveExecutionAuthorization({ argv: null, env: {} }).mode === MODE_PREFLIGHT,
  )

  check(
    'no environment variable may substitute for the authorization',
    AUTHORIZATION_ENVIRONMENT_NAMES.every((name) => {
      const withEnv = authorize([], { [name]: EXECUTION_AUTHORIZATION })
      const alongside = authorize([exactArg], { [name]: EXECUTION_AUTHORIZATION })
      return (
        withEnv.authorized === false &&
        withEnv.mode === MODE_PREFLIGHT &&
        has(withEnv.problems, name) &&
        alongside.authorized === false
      )
    }),
  )
  check(
    'a blank environment variable is neither an authorization nor a refusal',
    authorize([], { [AUTHORIZATION_ENVIRONMENT_NAMES[0]]: '   ' }).problems.length === 0,
  )
  check(
    'a refused value is never echoed back into the terminal',
    (() => {
      const secretish = 'postgresql://user:hunter2@db.example.com/x'
      const result = authorize([`${AUTHORIZATION_FLAG}=${secretish}`, `--url=${secretish}`])
      return result.authorized === false && result.problems.every((p) => !p.includes('hunter2') && !p.includes('db.example.com'))
    })(),
  )
  check(
    'an environment variable that disagrees with the hard-coded identity refuses',
    refused(evaluateEnvironmentOverrides({ NEON_PROJECT_ID: 'some-other-project' })) &&
      refused(evaluateEnvironmentOverrides({ NEON_PROJECT_NAME: 'cloud-market' })) &&
      refused(evaluateEnvironmentOverrides({ NEON_DATABASE: 'not-cloudmarket' })) &&
      refused(evaluateEnvironmentOverrides({ NEON_ROLE: 'postgres' })),
  )
  check(
    'an environment that agrees, or says nothing, does not refuse',
    evaluateEnvironmentOverrides({}).problems.length === 0 &&
      evaluateEnvironmentOverrides({ NEON_PROJECT_ID, NEON_DATABASE: 'cloudmarket', NEON_ROLE: 'neondb_owner' })
        .problems.length === 0,
  )
}

/* ================== 3. PROJECT, PRODUCTION TOPOLOGY, RESTORE METADATA (25) == */
section('[3] The project, the production topology, and the restore point')

const without = (object, key) => {
  const copy = { ...object }
  delete copy[key]
  return copy
}
const productionBranch = (over = {}) => ({
  id: PRODUCTION_BRANCH_ID,
  name: 'production',
  default: true,
  primary: true,
  ...over,
})
const restoreBranchFixture = (over = {}) => ({
  id: RESTORE_BRANCH_ID,
  name: RESTORE_BRANCH_NAME,
  parent_id: RESTORE_PARENT_BRANCH_ID,
  default: false,
  primary: false,
  ...over,
})
const topologyOf = (branches) => {
  const topology = evaluateBranchTopology(branches)
  const production = evaluateProductionTopology({ branches, topology })
  return { refuses: topology.problems.length > 0 || production.problems.length > 0, topology, production }
}

check('the project Neon answers with must be the project asked for', evaluateProductionProject({ id: NEON_PROJECT_ID, name: 'cloud-market' }).problems.length === 0)
check('a different project id refuses', refused(evaluateProductionProject({ id: 'autumn-forest-00000000' })))
check('no project object at all refuses', refused(evaluateProductionProject(null)))

check(
  'the hard-coded production branch, marked default and primary, is accepted',
  topologyOf([productionBranch(), restoreBranchFixture()]).refuses === false,
)
check(
  'default alone identifies production when primary is not reported',
  topologyOf([without(productionBranch(), 'primary'), restoreBranchFixture()]).refuses === false,
)
check(
  'primary alone identifies production when default is not reported',
  topologyOf([without(productionBranch(), 'default'), restoreBranchFixture()]).refuses === false,
)
check(
  'a production branch that reports default:false refuses',
  topologyOf([productionBranch({ default: false }), restoreBranchFixture({ default: true })]).refuses === true,
)
check(
  'a different branch being the default refuses',
  topologyOf([productionBranch({ default: false, primary: false }), restoreBranchFixture({ default: true, primary: true })])
    .refuses === true,
)
check(
  'two branches claiming production refuses',
  topologyOf([productionBranch(), restoreBranchFixture({ default: true })]).refuses === true,
)
check(
  'no branch marked default or primary at all refuses',
  topologyOf([productionBranch({ default: false, primary: false }), restoreBranchFixture()]).refuses === true,
)
check(
  'a non-boolean default/primary refuses',
  topologyOf([productionBranch({ default: 'true' }), restoreBranchFixture()]).refuses === true &&
    topologyOf([productionBranch({ primary: 1 }), restoreBranchFixture()]).refuses === true,
)
check('an empty branch list refuses', topologyOf([]).refuses === true)

const restoreOf = (over) => evaluateRestoreBranch({ branches: [productionBranch(), restoreBranchFixture(over)] })

check(
  'the exact restore branch — id, name, parent, default:false, primary:false — is accepted',
  restoreOf({}).problems.length === 0 && restoreOf({}).restore?.id === RESTORE_BRANCH_ID,
  restoreOf({}).problems.join('; '),
)
check('a restore branch marked default:true refuses', refused(restoreOf({ default: true })))
check('a restore branch marked primary:true refuses', refused(restoreOf({ primary: true })))
check('a null default refuses — an unproven negative is not a negative', refused(restoreOf({ default: null })))
check('an omitted default refuses', refused(evaluateRestoreBranch({ branches: [productionBranch(), without(restoreBranchFixture(), 'default')] })))
check('a non-boolean default ("false" as a string) refuses', refused(restoreOf({ default: 'false' })))
check(
  'an omitted or null primary refuses',
  refused(evaluateRestoreBranch({ branches: [productionBranch(), without(restoreBranchFixture(), 'primary')] })) &&
    refused(restoreOf({ primary: null })),
)
check('a restore branch with the wrong name refuses', refused(restoreOf({ name: 'restore-pre-0016-0019-1787595530199' })))
check('a restore branch with the wrong parent refuses', refused(restoreOf({ parent_id: 'br-somewhere-else-0000aaaa' })))
check(
  'a restore branch that is not in the project at all refuses',
  refused(evaluateRestoreBranch({ branches: [productionBranch()] })),
)
check(
  'two branches with the restore id refuse rather than one being chosen',
  refused(evaluateRestoreBranch({ branches: [productionBranch(), restoreBranchFixture(), restoreBranchFixture({ name: 'other' })] })),
)
check('a branch listing that is not a list refuses', refused(evaluateRestoreBranch({ branches: null })))
check('the restore branch can never be the production branch', RESTORE_BRANCH_ID !== PRODUCTION_BRANCH_ID)

/* ============ 4. CONNECTION IDENTITY, AND IT DOMINATES THE CONNECTION (10) == */
section('[4] The production connection is proved before it is opened')

const identityOf = (over = {}) =>
  evaluateProductionConnectionIdentity({
    pooledHost: PRODUCTION_HOST_FINGERPRINT,
    directHost: 'aaaaaaaaaaaa',
    pooledEndpoint: 'bbbbbbbbbbbb',
    directEndpoint: 'bbbbbbbbbbbb',
    liveFingerprint: PRODUCTION_HOST_FINGERPRINT,
    ...over,
  })

check('the production pair, anchored to the live fingerprint, is accepted', identityOf().problems.length === 0, identityOf().problems.join('; '))
check('a pooled string that is not what the live app publishes refuses', refused(identityOf({ liveFingerprint: 'cccccccccccc' })))
check(
  'a pooled string that is not the recorded production fingerprint refuses',
  refused(identityOf({ pooledHost: 'dddddddddddd', liveFingerprint: 'dddddddddddd' })),
)
check('pooled and direct strings on different endpoints refuse', refused(identityOf({ directEndpoint: 'eeeeeeeeeeee' })))
check('pooled and direct strings that hash to one host refuse', refused(identityOf({ directHost: PRODUCTION_HOST_FINGERPRINT })))
check(
  'a missing fingerprint anywhere refuses',
  refused(identityOf({ pooledHost: null })) &&
    refused(identityOf({ directHost: '' })) &&
    refused(identityOf({ pooledEndpoint: undefined })),
)
check('no live fingerprint at all refuses', refused(identityOf({ liveFingerprint: null })))

check(
  'the database connection is constructed only after identity is proved',
  dominates('new Pool(', [CALL.health, CALL.endpoint, CALL.topology, CALL.restore, CALL.connection]),
)
check(
  'there is exactly one connection, and its string comes from the control plane rather than the environment',
  countOf(runnerCode, 'new Pool(') === 1 &&
    runnerSource.includes('new Pool({ connectionString: directUri })') &&
    !runnerCode.includes('process.env.DATABASE_URL'),
)
check(
  'the production connection strings are fetched only after the live deployment proved itself',
  first('await connectionUri(') > first(CALL.health) && countOf(runnerCode, 'await connectionUri(') === 2,
)

/* ============================== 5. THE LEDGER RECONCILES EXACTLY, OR NOT (10) */
section('[5] The production ledger reconciles exactly through 0015 — not by count')

const journal = JSON.parse(repoFile('drizzle/meta/_journal.json'))

/**
 * A MISSING MIGRATION FILE ENDS THIS RUN WITH AN INSTRUCTION, NOT A STACK TRACE.
 *
 * `ALL_TAGS` is the reviewed stack, and it now names `0020_notifications`. Until
 * that migration has been GENERATED — by drizzle-kit, from the schema, never by
 * hand — every assertion below is about a repository that does not exist yet,
 * and an ENOENT out of `readFileSync` says so in the least useful way available.
 *
 * This is a stop, not a skip: nothing about the rollout may be reported as
 * verified while a migration it is defined against is absent.
 */
const readMigrationSource = (tag) => {
  try {
    return repoFile(`drizzle/${tag}.sql`)
  } catch {
    console.error(
      `\nSTOPPED: drizzle/${tag}.sql is not in this repository.\n\n` +
        `  This rollout is certified for ${ALL_TAGS.length} migrations, ${ALL_TAGS[0]} … ` +
        `${ALL_TAGS[ALL_TAGS.length - 1]}, and one of them has not been generated yet.\n` +
        '  Drizzle metadata is never written by hand. Run the generation step documented at the top of\n' +
        '  scripts/verify-notification-schema.ts, commit the result, and run this verifier again.\n\n' +
        '  NOTHING WAS VERIFIED. No production migration is authorized by this run.',
    )
    process.exit(1)
  }
}

const sources = {}
for (const tag of ALL_TAGS) sources[tag] = readMigrationSource(tag)
const repository = buildRepositoryMigrations({ journal, sources })
const migrations = repository.migrations

/*
 * A FILE THAT EXISTS BUT IS NOT IN THE JOURNAL IS THE SAME STOP.
 *
 * `buildRepositoryMigrations` builds only what the journal declares, so a
 * generated 0020 whose journal entry was not committed leaves this file with a
 * migration it cannot hash — and every fixture below would fail on `undefined`
 * rather than on the thing that is actually wrong. Said plainly, once.
 */
if (migrations.length !== ALL_TAGS.length) {
  console.error(
    `\nSTOPPED: drizzle/meta/_journal.json declares ${migrations.length} usable migration(s); this rollout ` +
      `is certified for ${ALL_TAGS.length} (${ALL_TAGS[0]} … ${ALL_TAGS[ALL_TAGS.length - 1]}).\n\n` +
      (repository.problems.map((p) => `  • ${p}`).join('\n') || '  • the journal and the reviewed stack disagree') +
      '\n\n  The journal is a GENERATED artifact and is never edited by hand. Run the generation step\n' +
      '  documented at the top of scripts/verify-notification-schema.ts and commit its full output.\n\n' +
      '  NOTHING WAS VERIFIED. No production migration is authorized by this run.',
  )
  process.exit(1)
}

const migrationOf = (tag) => migrations.find((m) => m.tag === tag)
const rowsFor = (tags, mutate = (row) => row) =>
  tags.map((tag, index) => mutate({ id: index + 1, hash: migrationOf(tag).hash, created_at: String(migrationOf(tag).when) }, index))
const recordedRows = rowsFor(RECORDED_TAGS)
const reconcile = (rows, expectedTags = RECORDED_TAGS) => reconcileLedger({ migrations, rows, expectedTags })

check(
  'the committed journal and all 21 files reconcile cleanly, ending at 0020_notifications',
  repository.problems.length === 0 &&
    migrations.length === 21 &&
    ALL_TAGS.length === 21 &&
    ALL_TAGS[ALL_TAGS.length - 1] === '0020_notifications',
  repository.problems.join('; '),
)
check('a production ledger of exactly 0000 … 0015 reconciles', reconcile(recordedRows).problems.length === 0, reconcile(recordedRows).problems.join('; '))
check('a ledger one row short refuses', refused(reconcile(recordedRows.slice(0, 15))))
check('a ledger carrying a migration this run is about to apply refuses', refused(reconcile(rowsFor([...RECORDED_TAGS, PENDING_TAGS[0]]))))
check(
  'a ledger with the right rows in the wrong order refuses',
  refused(reconcile(rowsFor([...RECORDED_TAGS.slice(0, 3), RECORDED_TAGS[4], RECORDED_TAGS[3], ...RECORDED_TAGS.slice(5)]))),
)
check(
  'a ledger row whose hash is not this repository\'s refuses',
  refused(reconcile(rowsFor(RECORDED_TAGS, (row, i) => (i === 7 ? { ...row, hash: 'f'.repeat(64) } : row)))),
)
check(
  'a ledger row whose timestamp is not the journal\'s refuses',
  refused(reconcile(rowsFor(RECORDED_TAGS, (row, i) => (i === 2 ? { ...row, created_at: '1' } : row)))),
)
check('no ledger at all refuses rather than reading as a baseline', refused(reconcile(null)))
check(
  'ledger ids that do not ascend refuse, because the recorded order cannot be trusted',
  refused(reconcile(rowsFor(RECORDED_TAGS, (row, i) => (i === 9 ? { ...row, id: 1 } : row)))),
)
check(
  'sixteen rows that are sixteen OTHER migrations refuse — a count is not a reconciliation',
  refused(reconcile(rowsFor(ALL_TAGS.slice(4, 20)))) && rowsFor(ALL_TAGS.slice(4, 20)).length === RECORDED_TAGS.length,
)

/* =================================== 6. THE PENDING STACK IS EXACTLY FIVE (5) */
section('[6] The pending stack is derived from the ledger and required to be the five')

const pendingFrom = (rows) => derivePendingStack({ migrations, rows })

check(
  'the pending stack derived from a 0000 … 0015 ledger is exactly 0016 … 0020',
  pendingFrom(recordedRows).problems.length === 0 &&
    pendingFrom(recordedRows).pendingTags.join(',') === PENDING_TAGS.join(','),
)
check('a ledger one migration behind derives six pending and refuses', refused(pendingFrom(recordedRows.slice(0, 15))))
check('a ledger one migration ahead derives four pending and refuses', refused(pendingFrom(rowsFor([...RECORDED_TAGS, PENDING_TAGS[0]]))))
check(
  'an unapplied migration in the middle of history refuses',
  refused(pendingFrom(rowsFor([...RECORDED_TAGS.slice(0, 15), PENDING_TAGS[0]]))),
)
check(
  'the five pending tags are exactly the reviewed ones, in order',
  PENDING_TAGS.join(',') ===
    [
      '0016_yummy_tattoo',
      '0017_phase_5_private_storefront',
      '0018_strain_leaning_types',
      '0019_demonic_rockslide',
      '0020_notifications',
    ].join(','),
)

/* ================== 7. THE COMPLETE PRE-EXISTING DRIFT IS EXACTLY TWO (8) === */
section('[7] Pre-existing drift is bounded to exactly the two leaning enum values')

const { inventory, dropped } = buildPendingInventory({ migrations })
const strainObjects = inventory.filter((object) => PERMITTED_PRE_EXISTING_KEYS.includes(object.key))
const otherPendingObject = inventory.find((object) => !PERMITTED_PRE_EXISTING_KEYS.includes(object.key))
const driftWith = (keys) =>
  evaluateDrift({ inventory, recordedTags: [...RECORDED_TAGS], observedKeys: new Set(keys) })

check(
  'the two leaning values are declared by 0018 with idempotent semantics',
  strainObjects.length === 2 && strainObjects.every((o) => o.tag === STRAIN_EQUIVALENCE_TAG && o.conflictKind === 'silent'),
)
check(
  'a production schema carrying exactly those two is bounded, and nothing wider',
  evaluatePreExistingDrift(driftWith(PERMITTED_PRE_EXISTING_KEYS).present).problems.length === 0 &&
    driftWith(PERMITTED_PRE_EXISTING_KEYS).present.length === 2,
)
check('only one of the two present refuses', refused(evaluatePreExistingDrift(driftWith([PERMITTED_PRE_EXISTING_KEYS[0]]).present)))
check('neither of them present refuses — this rollout is defined against that exact state', refused(evaluatePreExistingDrift(driftWith([]).present)))
check(
  'a third pre-existing object refuses',
  refused(evaluatePreExistingDrift(driftWith([...PERMITTED_PRE_EXISTING_KEYS, otherPendingObject.key]).present)),
)
check(
  'an unrelated pending object instead of one of them refuses',
  refused(evaluatePreExistingDrift(driftWith([PERMITTED_PRE_EXISTING_KEYS[0], otherPendingObject.key]).present)),
)
check(
  'a pre-existing object without a readable key refuses',
  refused(evaluatePreExistingDrift([{ key: undefined }])) && refused(evaluatePreExistingDrift(null)),
)
check(
  'general drift is still reported as blocking, whichever migration declares it',
  has(driftWith([otherPendingObject.key]).problems, 'DRIFT:') &&
    has(driftWith(PERMITTED_PRE_EXISTING_KEYS).problems, 'DRIFT:'),
)

/* ============= 8. 0018 SOURCE SEMANTICS AND THE COMPLETE ENUM ORDER (14) ==== */
section('[8] The committed 0018 and the live enum order are proved, from this run\'s evidence')

const source0018 = sources[STRAIN_EQUIVALENCE_TAG]
const enumRows = (...labels) => labels.map((label) => ({ label }))
const equivalence = (over = {}) =>
  evaluateStrainLeaningEquivalence({
    recordedTags: [...RECORDED_TAGS],
    pendingTags: [...PENDING_TAGS],
    driftPresent: strainObjects,
    source: source0018,
    strainTypeRows: enumRows(...STRAIN_TYPE_EXPECTED_ORDER),
    ...over,
  })

check('the committed 0018, against the reviewed state, proves equivalent', equivalence().equivalent === true, equivalence().problems.join('; '))
check('an additional executable statement in 0018 refuses', equivalence({ source: `${source0018}\nSELECT 1;` }).equivalent === false)
check(
  'changing the anchor direction in 0018 refuses',
  equivalence({ source: source0018.replace("BEFORE 'cbd'", "AFTER 'cbd'") }).equivalent === false,
)
check(
  'dropping IF NOT EXISTS from 0018 refuses',
  equivalence({ source: source0018.replace(/IF NOT EXISTS /g, '') }).equivalent === false,
)
check(
  'renaming a value in 0018 refuses',
  equivalence({ source: source0018.replace("'hybrid_i'", "'hybrid_x'") }).equivalent === false,
)
check(
  'a missing or unreadable 0018 refuses',
  equivalence({ source: undefined }).equivalent === false && equivalence({ source: '' }).equivalent === false,
)
check(
  'an enum whose order differs refuses, even with the same members',
  equivalence({ strainTypeRows: enumRows('indica', 'sativa', 'hybrid', 'hybrid_s', 'hybrid_i', 'cbd') }).equivalent === false,
)
check(
  'an enum missing a value refuses',
  equivalence({ strainTypeRows: enumRows('indica', 'sativa', 'hybrid', 'hybrid_i', 'cbd') }).equivalent === false,
)
check(
  'an enum with an extra value refuses',
  equivalence({ strainTypeRows: enumRows(...STRAIN_TYPE_EXPECTED_ORDER, 'hybrid_z') }).equivalent === false,
)
check(
  'no catalog reading at all refuses',
  equivalence({ strainTypeRows: null }).equivalent === false && equivalence({ strainTypeRows: [] }).equivalent === false,
)
check(
  'a catalog row with no usable label refuses',
  equivalence({ strainTypeRows: [{ label: 'indica' }, { label: null }] }).equivalent === false,
)
check(
  'the expected enum order is exactly the six values, in that order',
  STRAIN_TYPE_EXPECTED_ORDER.join(',') === 'indica,sativa,hybrid,hybrid_i,hybrid_s,cbd',
)
check(
  'the enum is read by its own sort order, read-only, and about one type',
  /order by e\.enumsortorder asc/.test(STRAIN_TYPE_ORDER_QUERY) &&
    /^select\b/.test(STRAIN_TYPE_ORDER_QUERY.trim()) &&
    STRAIN_TYPE_ORDER_QUERY.includes("t.typname = 'strain_type'") &&
    PRODUCTION_READ_ONLY_SQL.strainTypeOrder === STRAIN_TYPE_ORDER_QUERY,
)
check(
  'the exception is judged on the run\'s own reconciliation and pending stack',
  equivalence({ recordedTags: RECORDED_TAGS.slice(0, 15) }).equivalent === false &&
    equivalence({ pendingTags: PENDING_TAGS.slice(1) }).equivalent === false &&
    equivalence({ recordedTags: null }).equivalent === false &&
    equivalence({ driftPresent: null }).equivalent === false,
)

/* ================== 9. THE DECLARED INVENTORY AND THE POST-SCHEMA (8) ======= */
section('[9] 79 declared objects, 2 of them dropped again, 77 required to survive')

const survivingKeys = new Set(
  inventory.filter((object) => !dropped.some((d) => d.key === object.key)).map((object) => object.key),
)

check(
  'the committed pending stack declares exactly the reviewed inventory',
  evaluateInventoryShape({ inventory, dropped }).problems.length === 0 &&
    inventory.length === PENDING_DECLARED_OBJECTS &&
    dropped.length === PENDING_DROPPED_OBJECTS,
  `${inventory.length} declared / ${dropped.length} dropped`,
)
check(
  'the survivor count is the declared count minus the drops',
  PENDING_DECLARED_OBJECTS === 79 &&
    PENDING_DROPPED_OBJECTS === 2 &&
    PENDING_SURVIVING_OBJECTS === 77 &&
    survivingKeys.size === PENDING_SURVIVING_OBJECTS,
  `${survivingKeys.size}`,
)
/*
 * 0020 IS CERTIFIED BY WHAT IT DECLARES, NOT BY BEING PRESENT. The four objects
 * are named here so that a regenerated 0020 which renamed an index, lost the
 * foreign key, or quietly added a column, type, or trigger fails this file
 * rather than sliding into the rollout on the strength of its filename.
 */
check(
  'the newly certified 0020 declares exactly the notifications table, its foreign key, and its two indexes — and drops nothing',
  inventory
    .filter((object) => object.tag === '0020_notifications')
    .map((object) => object.key)
    .sort()
    .join(' + ') ===
    [
      objectKey.table('notifications'),
      objectKey.constraint('notifications_user_id_users_id_fk'),
      objectKey.index('notifications_user_created_idx'),
      objectKey.index('notifications_user_unread_idx'),
    ]
      .sort()
      .join(' + ') && dropped.every((object) => object.tag !== '0020_notifications'),
  inventory
    .filter((object) => object.tag === '0020_notifications')
    .map((object) => object.key)
    .join(' | '),
)
check('a stack that declares fewer objects refuses', refused(evaluateInventoryShape({ inventory: inventory.slice(1), dropped })))
check('a stack that drops a different number of objects refuses', refused(evaluateInventoryShape({ inventory, dropped: [...dropped, dropped[0]] })))
check(
  'every surviving declared object present, and both drops absent, passes',
  evaluateApplied({ inventory, dropped, observedKeys: new Set(survivingKeys) }).problems.length === 0,
)
check(
  'one missing survivor refuses',
  refused(evaluateApplied({ inventory, dropped, observedKeys: new Set([...survivingKeys].slice(1)) })),
)
check(
  'a declared drop that is still present refuses',
  refused(evaluateApplied({ inventory, dropped, observedKeys: new Set([...survivingKeys, dropped[0].key]) })),
)

/* ================================= 10. THE POST-MIGRATION LEDGER (4) ======== */
section('[10] After migrating: all 21 reconciled, and nothing pending')

check(
  'a ledger of all 21 migrations reconciles by order, hash, and timestamp',
  reconcile(rowsFor(ALL_TAGS), ALL_TAGS).problems.length === 0,
  reconcile(rowsFor(ALL_TAGS), ALL_TAGS).problems.join('; '),
)
check('a ledger one migration short of the stack refuses', refused(reconcile(rowsFor(ALL_TAGS.slice(0, 20)), ALL_TAGS)))
check('the derived pending stack after all 21 is empty', pendingFrom(rowsFor(ALL_TAGS)).pendingTags.length === 0)
check('the zero-pending check is real: 20 applied still derives one pending', pendingFrom(rowsFor(ALL_TAGS.slice(0, 20))).pendingTags.length === 1)

/* ===================== 11. EXACTLY ONE WRITE-CAPABLE INVOCATION (8) ========= */
section('[11] One gated npx drizzle-kit migrate, and no other write path')

check(
  'there is exactly one gate, one gated invocation, and one process call site',
  countOf(runnerCode, 'createMigrationGate(') === 1 &&
    countOf(runnerCode, 'gate.run(') === 1 &&
    countOf(runnerCode, 'execFileSync(') === 1 &&
    countOf(runnerCode, 'gate.clear()') === 1,
)
check(
  'the invocation is literally npx drizzle-kit migrate, for the whole stack',
  /gate\.run\(\s*'npx',\s*\['drizzle-kit',\s*'migrate'\]/.test(runnerSource),
)
check(
  'the shared command guard refuses push, --step, a subset, or another binary',
  assertMigrationCommand('npx', ['drizzle-kit', 'migrate']) === true &&
    [
      ['npx', ['drizzle-kit', 'push']],
      ['npx', ['drizzle-kit', 'migrate', '--step', '1']],
      ['npx', ['drizzle-kit', 'migrate', '--to', '0018_strain_leaning_types']],
      ['npx', ['drizzle-kit']],
      ['node', ['drizzle-kit', 'migrate']],
      ['psql', ['-f', 'drizzle/0018_strain_leaning_types.sql']],
    ].every(([file, args]) => {
      try {
        assertMigrationCommand(file, args)
        return false
      } catch {
        return true
      }
    }),
)
check(
  'the gate refuses before it is cleared, and refuses a second invocation',
  (() => {
    let invoked = 0
    const gate = createMigrationGate(() => {
      invoked += 1
      return ''
    })
    let refusedEarly = false
    try {
      gate.run('npx', ['drizzle-kit', 'migrate'])
    } catch {
      refusedEarly = true
    }
    gate.clear()
    gate.run('npx', ['drizzle-kit', 'migrate'])
    let refusedSecond = false
    try {
      gate.run('npx', ['drizzle-kit', 'migrate'])
    } catch {
      refusedSecond = true
    }
    return refusedEarly && refusedSecond && invoked === 1 && gate.invocations === 1
  })(),
)
check(
  'no step, subset, or push argument exists anywhere in the runner\'s code',
  !/--step|--to\b|'push'|db:push|drizzle-kit push/.test(runnerCode),
)
check(
  'the child is given the repository root and both production URLs, explicitly',
  runnerSource.includes('cwd: REPO_ROOT') &&
    runnerSource.includes('env: { ...process.env, DATABASE_URL: pooledUri, DATABASE_URL_UNPOOLED: directUri }'),
)
check(
  'no other process-spawning capability exists in the runner',
  ['spawn(', 'spawnSync(', 'execSync(', 'exec(', 'fork(', 'shelljs'].every((token) => !runnerCode.includes(token)),
)
check(
  'the child-process module is loaded dynamically, once, and never at import time',
  !/^import[^\n]*node:child/m.test(runnerSource) &&
    countOf(runnerSource, "await import('node:child_process')") === 1 &&
    countOf(runnerCode, 'const { execFileSync } = await import(') === 1,
)

/* ============ 12. THE CAPABILITY IS BUILT AFTER EVERYTHING ELSE (7) ========= */
section('[12] Nothing that can write exists until every proof has landed')

const PREREQUISITES = Object.freeze(Object.values(CALL))
const CAPABILITY = 'const { execFileSync } = await import('

check('the exact authorization is resolved before the capability is loaded', dominates(CAPABILITY, [CALL.authorization]))
check('the repository is snapshotted before the capability is loaded', dominates(CAPABILITY, [CALL.snapshot]))
check(
  'the ledger, pending stack, drift bound, and 0018 equivalence all precede the capability',
  dominates(CAPABILITY, [CALL.ledger, CALL.pending, CALL.drift, CALL.bounded, CALL.equivalence]),
)
check(
  'identity, topology, restore, and connection proofs all precede the capability',
  dominates(CAPABILITY, [CALL.health, CALL.endpoint, CALL.topology, CALL.restore, CALL.connection]),
)
check('the migration gate is constructed after every prerequisite', dominates('createMigrationGate(', PREREQUISITES))
check(
  'every proof happens before the run may become a migration, and the preflight returns first',
  PREREQUISITES.every((marker) => first(marker) !== -1 && first(marker) < first(PREFLIGHT_BRANCH)) &&
    first(PREFLIGHT_BRANCH) < first(CAPABILITY) &&
    first(PREFLIGHT_BRANCH) < first('createMigrationGate('),
)
check(
  'the gate is cleared after it is built and immediately before the single run',
  last('gate.clear()') > first('createMigrationGate(') && last('gate.clear()') < first('gate.run('),
)

/* ========================= 13. THE REPOSITORY, SNAPSHOT AND AFTER (4) ======= */
section('[13] The committed files are captured first and proved unchanged after')

check(
  'the snapshot is taken before the authorization is acted upon',
  first(CALL.snapshot) !== -1 &&
    first(CALL.snapshot) < first(PREFLIGHT_BRANCH) &&
    countOf(runnerCode, 'readRepositorySnapshot()') === 2,
)
check('byte-identity is asserted after the migration ran', last('assertRepositoryUnchanged(') > first('gate.run('))
check(
  'the snapshot covers the journal and every migration file',
  runnerSource.includes('journalText') &&
    Object.keys(sources).length === ALL_TAGS.length &&
    /readFileSync\(migrationPath\(entry\.tag\)\)/.test(runnerSource),
)
check(
  'the runner never writes a file, and never rewrites the journal',
  ['writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'createWriteStream', 'renameSync'].every(
    (token) => !runnerCode.includes(token),
  ),
)

/* ============================ 14. PRODUCTION ACCESS IS READ ONLY (7) ======== */
section('[14] Every statement this runner can issue against production is a read')

const ALLOWED_SQL = new Set([
  ...Object.values(PRODUCTION_READ_ONLY_SQL),
  READ_ONLY_SESSION_SQL,
  READ_ONLY_BEGIN_SQL,
  READ_ONLY_END_SQL,
])
const SQL_SHAPED =
  /^\s*(select|insert|update|delete|create|alter|drop|truncate|begin|start|commit|rollback|grant|revoke|set)\b[\s(]/i
const sqlLiteralsOf = (source) => {
  const body = normalizeSourceText(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
  return [
    ...[...body.matchAll(/'((?:[^'\n\\]|\\.)*)'/g)].map((m) => m[1]),
    ...[...body.matchAll(/`((?:[^`\\]|\\[\s\S])*)`/g)].map((m) => m[1]),
  ].filter((text) => SQL_SHAPED.test(text))
}
const strayLiterals = sqlLiteralsOf(runnerSource).filter((text) => !ALLOWED_SQL.has(text))

check(
  'every declared production statement is a select',
  Object.values(PRODUCTION_READ_ONLY_SQL).every((sql) => /^\s*select\b/i.test(sql)) &&
    Object.keys(PRODUCTION_READ_ONLY_SQL).length === 11,
)
check(
  'the transaction is opened READ ONLY, the session is set READ ONLY, and it ends by rolling back',
  READ_ONLY_SESSION_SQL === 'set session characteristics as transaction read only' &&
    READ_ONLY_BEGIN_SQL === 'begin transaction read only' &&
    READ_ONLY_END_SQL === 'rollback',
)
check(
  'no SQL-shaped literal exists in the runner outside that declared set',
  strayLiterals.length === 0,
  strayLiterals.join(' | '),
)
check(
  'the drizzle ledger is only ever read, and no migration file is ever executed',
  [...runnerSource.matchAll(/^.*__drizzle_migrations.*$/gm)].every(
    (line) => !/insert\s+into|update\s+"|delete\s+from|truncate|drop\s+table/i.test(line[0]),
  ) &&
    !/query\([^)]*sources\[/.test(runnerCode) &&
    !runnerCode.includes('statement-breakpoint'),
)
check(
  'no behavioural probe, fixture, or savepoint exists in the runner',
  ['REQUIRED_PROBES', 'runProbes', 'savepoint', 'probeEmail', 'evaluateProbeOutcomes', 'evaluateCarriedData'].every(
    (token) => !runnerCode.includes(token),
  ),
)
check(
  'every production read runs inside the shared read-only transaction helper',
  countOf(runnerCode, 'withProbeTransaction(') === 1 &&
    countOf(runnerCode, 'pool.connect()') === 1 &&
    countOf(runnerCode, 'withReadOnlyProduction(') === 3,
)
check(
  'that helper always rolls back and then releases, on success and on failure',
  await (async () => {
    const order = []
    await withProbeTransaction({
      begin: async () => order.push('begin'),
      body: async () => order.push('body'),
      rollback: async () => order.push('rollback'),
      release: async () => order.push('release'),
    })
    const clean = order.join(',') === 'begin,body,rollback,release'
    const afterFailure = []
    try {
      await withProbeTransaction({
        begin: async () => afterFailure.push('begin'),
        body: async () => {
          throw new Error('read failed')
        },
        rollback: async () => afterFailure.push('rollback'),
        release: async () => afterFailure.push('release'),
      })
    } catch {
      /* expected */
    }
    return clean && afterFailure.join(',') === 'begin,rollback,release'
  })(),
)

/* ================================ 15. NOTHING SECRET IS EVER PRINTED (7) ==== */
section('[15] Credentials, keys, and child output never reach a terminal')

const secret = 'postgresql://neondb_owner:npg_SECRET@ep-prod-1234-pooler.eu-central-1.aws.neon.tech/cloudmarket'

check(
  'a connection URI inside an error message is redacted',
  redactSecrets(new Error(`connect failed for ${secret}`), [secret]).includes(REDACTED) &&
    !redactSecrets(new Error(`connect failed for ${secret}`), [secret]).includes('npg_SECRET'),
)
check(
  'userinfo, the password alone, named variables, and API keys are all redacted',
  !redactSecrets('user npg_SECRET@ep-prod-1234.aws.neon.tech', [secret]).includes('npg_SECRET') &&
    redactSecrets('DATABASE_URL=postgres://a:b@c/d', []).includes(REDACTED) &&
    redactSecrets('NEON_API_KEY=neon_api_abcdefgh', []).includes(REDACTED) &&
    redactSecrets('password=hunter2', []).includes(REDACTED),
)
check('the API key is registered as a secret the moment it is obtained', runnerSource.includes('remember(requireApiKey(SELF))'))
check(
  'both production connection strings are registered at capture',
  countOf(runnerCode, 'remember(') === 3 &&
    /const pooledUri = remember\(/.test(runnerSource) &&
    /const directUri = remember\(/.test(runnerSource),
)
check(
  'child output is redacted where it is captured, not where it is printed',
  /failure = redact\(/.test(runnerSource) &&
    /error\.stdout/.test(runnerSource) &&
    runnerSource.includes('String(failure).slice(-3000)'),
)
check(
  'no console call is ever handed a connection string or the API key',
  !/console\.(log|error)\([^)]*(pooledUri|directUri|apiKey)/.test(runnerCode),
)
check(
  'every print helper and every error path redacts first',
  runnerSource.includes('${redact(title)}') &&
    runnerSource.includes('${redact(text)}') &&
    countOf(runnerSource, 'console.error(redact(error))') === 2 &&
    runnerSource.includes('${redact(error)}'),
)

/* ======================= 16. THE PREFLIGHT SAYS SO, UNMISTAKABLY (4) ======== */
section('[16] A preflight ends by saying that nothing was migrated')

check('the notice says exactly that no production migration ran', NO_MIGRATION_NOTICE === 'NO PRODUCTION MIGRATION RAN.')
check(
  'the passing preflight prints it inside its own banner',
  /PREFLIGHT PASSED — READ ONLY[\s\S]{0,400}\$\{NO_MIGRATION_NOTICE\}/.test(runnerSource),
)
check(
  'the refusal path prints it too, and distinguishes a run that had already migrated',
  runnerSource.includes(`\${NO_MIGRATION_NOTICE} Nothing was written to production.`) &&
    runnerSource.includes('THE MIGRATION COMMAND RAN AND THE RUN THEN FAILED'),
)
check(
  'the preflight banner states that no migration command was even constructed',
  runnerSource.includes('No migration command was constructed, spawned, or made available to this process.') &&
    runnerSource.includes('intentionally NOT claimed'),
)

/* ============================= 17. THIS VERIFIER IS HERMETIC (5) ============ */
section('[17] This verifier, and importing the runner, can reach nothing')

const verifierCode = codeOnly(verifierSource)

check(
  'this verifier imports only pure modules — no Neon, no driver, no dotenv',
  importsOf(verifierSource).join(',') ===
    './environment-fingerprints.mjs,./migrate-production-safe.mjs,./rehearse-migration-branch-core.mjs,node:fs,node:url',
  importsOf(verifierSource).join(','),
)
check(
  'this verifier performs no network, child, dynamic-import, write, or environment-secret operation',
  ['fetch(', 'import(', 'child_process', 'process.env', 'writeFileSync', 'execFileSync', 'spawn', 'new Pool'].every(
    (token) => !verifierCode.includes(token),
  ),
)
check(
  'the runner\'s import-time surface is pure: fs, path, url, fingerprints, and the rehearsal core',
  importsOf(runnerSource).join(',') ===
    './environment-fingerprints.mjs,./rehearse-migration-branch-core.mjs,node:fs,node:path,node:url',
  importsOf(runnerSource).join(','),
)
check(
  'the runner reads the environment only inside main(), never at import time',
  first('process.env') > first('async function main()'),
)
check(
  'importing the runner runs nothing: main() is behind an entry-point guard',
  /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\)/.test(runnerSource) &&
    countOf(runnerCode, 'main()') === 2,
)

/* ============ 18. SOURCE INSPECTION IS LINE-ENDING INDEPENDENT (8) ========== */
section('[18] LF, CRLF, and lone CR are inspected as the same source — and nothing is let through')

/**
 * Three spellings of one file, differing only in how their lines end.
 *
 * The SQL here is a multi-line template literal on purpose: that is the exact
 * shape the runner declares its production statements in, and the exact shape a
 * CRLF checkout makes read differently from the string the parser produced.
 */
const LINE_ENDING_FIXTURE = [
  'const PRODUCTION_READ_ONLY_SQL = Object.freeze({',
  '  ledgerRows: `select id, hash, created_at from drizzle.__drizzle_migrations',
  '                 order by id asc`,',
  '})',
  'const plain = `not a statement at all`',
].join('\n')
const asCrlf = (text) => text.replace(/\n/g, '\r\n')
const asLoneCr = (text) => text.replace(/\n/g, '\r')

check(
  'an LF source is already canonical: normalizing it changes nothing',
  normalizeSourceText(LINE_ENDING_FIXTURE) === LINE_ENDING_FIXTURE,
)
check(
  'the equivalent CRLF source normalizes to exactly the LF source',
  asCrlf(LINE_ENDING_FIXTURE) !== LINE_ENDING_FIXTURE &&
    normalizeSourceText(asCrlf(LINE_ENDING_FIXTURE)) === LINE_ENDING_FIXTURE,
)
check(
  'the equivalent lone-CR source normalizes to exactly the LF source',
  asLoneCr(LINE_ENDING_FIXTURE) !== LINE_ENDING_FIXTURE &&
    normalizeSourceText(asLoneCr(LINE_ENDING_FIXTURE)) === LINE_ENDING_FIXTURE,
)
check(
  'sqlLiteralsOf classifies LF, CRLF, and lone-CR source identically',
  (() => {
    const classify = (text) => sqlLiteralsOf(text).join(' | ')
    return (
      sqlLiteralsOf(LINE_ENDING_FIXTURE).length === 1 &&
      classify(LINE_ENDING_FIXTURE) === classify(asCrlf(LINE_ENDING_FIXTURE)) &&
      classify(LINE_ENDING_FIXTURE) === classify(asLoneCr(LINE_ENDING_FIXTURE))
    )
  })(),
  sqlLiteralsOf(LINE_ENDING_FIXTURE).join(' | '),
)

/**
 * NORMALIZATION MUST NOT BE AN EXEMPTION.
 *
 * Each of these appends one statement the runner does not declare, in all three
 * line endings, and requires it to come back out as a stray literal every time.
 * If normalization ever started swallowing writes instead of line endings, these
 * are what fail — the assertion in section 14 keeps its full strength here.
 */
const withAddedLiteral = (statement) => `${runnerSource}\nconst added = \`${statement}\`\n`
const strayFrom = (source) => sqlLiteralsOf(source).filter((text) => !ALLOWED_SQL.has(text))
const detectsAddedStatement = (statement) =>
  [withAddedLiteral(statement), asCrlf(withAddedLiteral(statement)), asLoneCr(withAddedLiteral(statement))].every(
    (source) => strayFrom(source).join(' | ') === statement,
  )

check(
  'a genuinely added INSERT statement is still detected as a stray literal, in all three line endings',
  detectsAddedStatement('insert into drizzle.__drizzle_migrations (id, hash)\n  values (99, 0)'),
)
check(
  'a genuinely added UPDATE statement is still detected as a stray literal, in all three line endings',
  detectsAddedStatement('update public.products\n  set slug = slug'),
)
check(
  'a genuinely added DELETE statement is still detected as a stray literal, in all three line endings',
  detectsAddedStatement('delete from drizzle.__drizzle_migrations\n  where id = 1'),
)
check(
  'a genuinely added DDL statement is still detected as a stray literal, in all three line endings',
  detectsAddedStatement('create index idx_never_reviewed\n  on public.products (slug)'),
)

/* ================================================================ summary = */
console.log('\n==========================================================')
console.log(`RESULT: ${pass} passed, ${fail} failed`)
for (const name of failures) console.log(`  • ${name}`)
if (pass + fail !== EXPECTED_CHECKS) {
  console.log(`  • MANIFEST: ${pass + fail} checks ran, ${EXPECTED_CHECKS} declared. Coverage changed.`)
}
if (fail > 0 || pass + fail !== EXPECTED_CHECKS) process.exitCode = 1
console.log(`checks declared: ${EXPECTED_CHECKS}`)
console.log('This verifier touched no network, no Neon, no database, and no credential.')
console.log('==========================================================')
