/**
 * The rehearsal's refusals, proved without a database.
 *
 *   node scripts/verify-rehearse-migration-branch.mjs
 *
 * HERMETIC BY CONSTRUCTION. No network, no Neon, no Postgres, no credential, no
 * environment variable, no migration, and no production diagnostic. The only I/O
 * is reading files out of this repository — the journal, the twenty migration
 * files, and the rehearsal scripts themselves — because the properties being
 * proved are properties OF those files.
 *
 * WHY THIS EXISTS
 *
 * Everything valuable about `rehearse-migration-branch.mjs` is a refusal: it
 * will not clone a parent that is not live production, will not migrate a ledger
 * it cannot reconcile exactly, will not read a pre-existing `hybrid_i` as
 * evidence that 0018 ran, will not invoke the migration command twice, and will
 * not call a skipped probe a pass. Refusals only reachable by pointing the
 * script at production are refusals nobody has ever watched work. Every one of
 * them is exercised here against literals, in milliseconds.
 *
 * THE LAST SECTION IS NOT DECORATION. It reads the runner's own source and
 * proves the absence of capabilities: no journal writing, no per-file SQL
 * executor, no ledger mutation, no `--step`, no second invocation path. An
 * absence is not testable by calling a function, so it is tested by inspection —
 * which is also the check that catches a future edit quietly reintroducing one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ALL_TAGS,
  CARRIED_DIGEST_COLUMNS,
  CARRIED_EVIDENCE_DISCLAIMER,
  CARRIED_TABLES,
  CLEANUP_RESOLUTION,
  NULL_SENTINEL_SQL,
  PENDING_TAGS,
  PRODUCTION_HEALTH_ORIGIN,
  PRODUCTION_HEALTH_URL,
  RECORDED_TAGS,
  REDACTED,
  REHEARSAL_BRANCH_PREFIX,
  REQUIRED_PROBES,
  STRAIN_LEANING_VALUES,
  assertMigrationCommand,
  buildObservedKeys,
  buildPendingInventory,
  buildRepositoryMigrations,
  buildRowDigestQuery,
  collectSecretLiterals,
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
  evaluateHealthIdentity,
  evaluateMediaBackfill,
  evaluateProbeOutcomes,
  extractDeclaredObjects,
  migrationHash,
  objectKey,
  reconcileLedger,
  redactSecrets,
  rehearsalBranchName,
  resolveCleanupTarget,
  resolveHealthOrigin,
  withProbeTransaction,
} from './rehearse-migration-branch-core.mjs'
import {
  PRODUCTION_HOST_FINGERPRINT,
  RETIRED_PRODUCTION_HOST_FINGERPRINTS,
} from './environment-fingerprints.mjs'

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
const has = (problems, fragment) => problems.some((p) => p.includes(fragment))

const repoFile = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url))).toString()

console.log('Production-shaped rehearsal — hermetic verification')

/* ===================================================== 1. REPOSITORY FACTS = */
section('[1] The repository migration set, read exactly as drizzle reads it')

const journal = JSON.parse(repoFile('drizzle/meta/_journal.json'))
const sources = {}
for (const tag of ALL_TAGS) sources[tag] = repoFile(`drizzle/${tag}.sql`)

const repository = buildRepositoryMigrations({ journal, sources })
check('the committed journal and files reconcile cleanly', repository.problems.length === 0, repository.problems.join('; '))
check('all 20 migrations are present', repository.migrations.length === 20)
check(
  '0019_demonic_rockslide is present and treated as part of the stack',
  ALL_TAGS.includes('0019_demonic_rockslide') &&
    repository.migrations.some((m) => m.tag === '0019_demonic_rockslide') &&
    PENDING_TAGS.includes('0019_demonic_rockslide'),
)
check(
  'the recorded and pending spans partition the stack',
  RECORDED_TAGS.length === 16 &&
    PENDING_TAGS.length === 4 &&
    [...RECORDED_TAGS, ...PENDING_TAGS].join(',') === ALL_TAGS.join(','),
)
check(
  'hashes are sha256 over the file text, and stable',
  repository.migrations.every((m) => /^[0-9a-f]{64}$/.test(m.hash)) &&
    repository.migrations[0].hash === migrationHash(sources[ALL_TAGS[0]]),
)
check(
  'a hash is a function of the exact bytes',
  migrationHash('select 1;') !== migrationHash('select 1;\n'),
)

{
  const withoutFile = { ...sources }
  delete withoutFile['0019_demonic_rockslide']
  const missing = buildRepositoryMigrations({ journal, sources: withoutFile })
  check('a missing migration file fails closed', has(missing.problems, '0019_demonic_rockslide.sql could not be read'))

  const shortJournal = { ...journal, entries: journal.entries.slice(0, 19) }
  check(
    'a journal short of the expected stack fails closed',
    buildRepositoryMigrations({ journal: shortJournal, sources }).problems.length > 0,
  )

  const reordered = {
    ...journal,
    entries: journal.entries.map((e, i) => (i === 4 ? { ...e, tag: '0009_lucky_cloak' } : e)),
  }
  check(
    'a journal whose tags are out of order fails closed',
    has(buildRepositoryMigrations({ journal: reordered, sources }).problems, 'expected "0004_true_amazoness"'),
  )

  const backwards = {
    ...journal,
    entries: journal.entries.map((e, i) => (i === 3 ? { ...e, when: 1 } : e)),
  }
  check(
    'a journal timestamp that goes backwards fails closed',
    buildRepositoryMigrations({ journal: backwards, sources }).problems.length > 0,
  )

  check(
    'a journal with no entries array fails closed',
    has(buildRepositoryMigrations({ journal: {}, sources }).problems, 'no repository evidence'),
  )
}

const migrations = repository.migrations
const ledgerRows = (count, mutate = (row) => row) =>
  migrations
    .slice(0, count)
    .map((m, i) => mutate({ id: i + 1, hash: m.hash, created_at: String(m.when) }, i))

/* ================================================ 2. EXACT RECONCILIATION = */
section('[2] The clone ledger reconciles exactly, or not at all')

check(
  'a correct 0000–0015 ledger reconciles',
  reconcileLedger({ migrations, rows: ledgerRows(16), expectedTags: RECORDED_TAGS }).problems.length === 0,
)
check(
  'a correct 0000–0019 ledger reconciles after migrating',
  reconcileLedger({ migrations, rows: ledgerRows(20), expectedTags: ALL_TAGS }).problems.length === 0,
)
check(
  'NO ledger at all fails closed',
  has(reconcileLedger({ migrations, rows: null, expectedTags: RECORDED_TAGS }).problems, 'no ledger evidence at all'),
)
check(
  'a ledger with the right COUNT but a wrong hash is refused',
  has(
    reconcileLedger({
      migrations,
      rows: ledgerRows(16, (row, i) => (i === 7 ? { ...row, hash: 'a'.repeat(64) } : row)),
      expectedTags: RECORDED_TAGS,
    }).problems,
    'expected "0007_cloudy_kulan_gath"',
  ),
)
check(
  'an unrecognised hash is named as unknown, not tolerated',
  has(
    reconcileLedger({
      migrations,
      rows: ledgerRows(16, (row, i) => (i === 2 ? { ...row, hash: 'b'.repeat(64) } : row)),
      expectedTags: RECORDED_TAGS,
    }).problems,
    'an unknown migration',
  ),
)
check(
  'a mismatched timestamp is refused',
  has(
    reconcileLedger({
      migrations,
      rows: ledgerRows(16, (row, i) => (i === 5 ? { ...row, created_at: '1' } : row)),
      expectedTags: RECORDED_TAGS,
    }).problems,
    'does not match the journal timestamp',
  ),
)
check(
  'an unreadable timestamp is refused rather than coerced',
  has(
    reconcileLedger({
      migrations,
      rows: ledgerRows(16, (row, i) => (i === 5 ? { ...row, created_at: null } : row)),
      expectedTags: RECORDED_TAGS,
    }).problems,
    'unusable created_at',
  ),
)
check(
  'bigint timestamps arriving as numbers or BigInt are accepted',
  reconcileLedger({
    migrations,
    rows: ledgerRows(16, (row, i) => ({
      ...row,
      created_at: i % 2 === 0 ? Number(row.created_at) : BigInt(row.created_at),
    })),
    expectedTags: RECORDED_TAGS,
  }).problems.length === 0,
)
check(
  'rows in the wrong ORDER are refused even though the set is right',
  reconcileLedger({
    migrations,
    rows: (() => {
      const rows = ledgerRows(16)
      const swapped = [...rows]
      const a = { ...swapped[3] }
      const b = { ...swapped[4] }
      swapped[3] = { ...b, id: a.id }
      swapped[4] = { ...a, id: b.id }
      return swapped
    })(),
    expectedTags: RECORDED_TAGS,
  }).problems.length > 0,
)
check(
  'ids that do not ascend are refused',
  has(
    reconcileLedger({
      migrations,
      rows: ledgerRows(16, (row, i) => (i === 9 ? { ...row, id: 2 } : row)),
      expectedTags: RECORDED_TAGS,
    }).problems,
    'not strictly ascending',
  ),
)
check(
  'a short ledger names the migration that is missing',
  has(reconcileLedger({ migrations, rows: ledgerRows(15), expectedTags: RECORDED_TAGS }).problems, '"0015_catalog_compliance" is not recorded'),
)
check(
  'a ledger already carrying a PENDING migration is refused loudly',
  has(
    reconcileLedger({
      migrations,
      rows: [...ledgerRows(16), { id: 17, hash: migrations[18].hash, created_at: String(migrations[18].when) }],
      expectedTags: RECORDED_TAGS,
    }).problems,
    'already records "0018_strain_leaning_types"',
  ),
)
check(
  'a post-migration ledger that is still short of 0019 is refused',
  reconcileLedger({ migrations, rows: ledgerRows(19), expectedTags: ALL_TAGS }).problems.length > 0,
)

/* ==================================================== 3. THE PENDING STACK = */
section('[3] The pending stack is derived, then required to be exactly the four')

{
  const derived = derivePendingStack({ migrations, rows: ledgerRows(16) })
  check('a 0000–0015 ledger derives exactly the four pending migrations', derived.problems.length === 0)
  check(
    'the derived stack is 0016, 0017, 0018, 0019 in order',
    derived.pendingTags.join(',') ===
      '0016_yummy_tattoo,0017_phase_5_private_storefront,0018_strain_leaning_types,0019_demonic_rockslide',
  )
  check('a fully migrated ledger derives nothing pending', derivePendingStack({ migrations, rows: ledgerRows(20) }).pendingTags.length === 0)
  check(
    'a ledger one migration behind derives a stack that is refused',
    has(derivePendingStack({ migrations, rows: ledgerRows(15) }).problems, 'is not the expected'),
  )

  const gapped = [...ledgerRows(16), { id: 17, hash: migrations[17].hash, created_at: String(migrations[17].when) }]
  check(
    'a gap in history (0017 recorded, 0016 not) is refused as non-contiguous',
    has(derivePendingStack({ migrations, rows: gapped }).problems, 'not a contiguous tail'),
  )
  check('no ledger derives no stack, and says so', has(derivePendingStack({ migrations, rows: null }).problems, 'No ledger evidence'))
}

/* ================================================= 4. DECLARED OBJECTS ==== */
section('[4] Every object the four pending migrations declare is inventoried')

const { inventory, dropped, problems: inventoryProblems } = buildPendingInventory({ migrations })
const keys = new Set(inventory.map((o) => o.key))
const find = (key) => inventory.find((o) => o.key === key)

check('the pending stack inventories cleanly', inventoryProblems.length === 0, inventoryProblems.join('; '))
check(
  '0016 — the media and product_media columns and the media_kind type',
  [
    objectKey.type('media_kind'),
    objectKey.column('media', 'kind'),
    objectKey.column('media', 'bytes'),
    objectKey.column('media', 'duration_seconds'),
    objectKey.column('media', 'storage_key'),
    objectKey.column('product_media', 'alt_text_override'),
    objectKey.column('product_media', 'caption'),
    objectKey.column('product_media', 'updated_at'),
  ].every((k) => keys.has(k)),
)
check(
  '0017 — tables, types, enum values, indexes, constraints, the function and the trigger',
  [
    objectKey.table('admin_backup'),
    objectKey.table('invite_codes'),
    objectKey.table('invite_code_redemptions'),
    objectKey.table('payment_intents'),
    objectKey.table('payment_events'),
    objectKey.type('payment_provider'),
    objectKey.type('payment_intent_status'),
    objectKey.enumValue('audit_event', 'INVITE_CREATED'),
    objectKey.enumValue('audit_event', 'PAYMENT_CONFIG_CHANGED'),
    objectKey.index('invite_code_redemptions_user_unique'),
    objectKey.index('invite_code_redemptions_invite_idx'),
    objectKey.index('audit_log_rate_limit_idx'),
    objectKey.constraint('admin_backup_slot_is_one'),
    objectKey.constraint('invite_codes_created_by_users_id_fk'),
    objectKey.function('cloudmarket_enforce_max_two_admins'),
    objectKey.trigger('users_max_two_admins'),
  ].every((k) => keys.has(k)),
)
check(
  '0018 — both leaning strain values',
  STRAIN_LEANING_VALUES.every((value) => keys.has(objectKey.enumValue('strain_type', value))),
)
check(
  '0019 — the marketplace types, table, column and indexes',
  [
    objectKey.type('invite_target_role'),
    objectKey.type('marketplace_access_status'),
    objectKey.type('marketplace_scope'),
    objectKey.table('marketplace_access'),
    objectKey.column('invite_codes', 'target_role'),
    objectKey.constraint('marketplace_access_user_id_users_id_fk'),
    objectKey.index('marketplace_access_user_unique'),
    objectKey.index('invite_code_redemptions_invite_user_unique'),
  ].every((k) => keys.has(k)),
)
check(
  "0019's two dropped indexes are tracked separately from what it creates",
  dropped.length === 2 &&
    dropped.every((o) => o.tag === '0019_demonic_rockslide') &&
    dropped.some((o) => o.key === objectKey.index('invite_code_redemptions_user_unique')) &&
    dropped.some((o) => o.key === objectKey.index('invite_code_redemptions_invite_idx')),
)
check(
  'idempotent statements are marked as the SILENT conflicts they are',
  find(objectKey.enumValue('strain_type', 'hybrid_i'))?.conflictKind === 'silent' &&
    find(objectKey.index('audit_log_rate_limit_idx'))?.conflictKind === 'silent' &&
    find(objectKey.function('cloudmarket_enforce_max_two_admins'))?.conflictKind === 'silent' &&
    find(objectKey.trigger('users_max_two_admins'))?.conflictKind === 'silent',
)
check(
  'statements that would fail loudly are marked hard',
  find(objectKey.table('marketplace_access'))?.conflictKind === 'hard' &&
    find(objectKey.column('invite_codes', 'target_role'))?.conflictKind === 'hard' &&
    find(objectKey.enumValue('audit_event', 'INVITE_CREATED'))?.conflictKind === 'hard',
)
check('every inventoried object carries the migration that declares it', inventory.every((o) => PENDING_TAGS.includes(o.tag)))
check(
  'DDL mentioned in prose is not mistaken for a declaration',
  extractDeclaredObjects(
    'fixture',
    '-- CREATE TABLE "ghost" and CREATE TYPE "public"."phantom" AS ENUM(\'x\')\nCREATE TABLE "real" (\n\t"id" uuid\n);',
  )
    .map((o) => o.key)
    .join(',') === objectKey.table('real'),
)

/* ============================================================== 5. DRIFT == */
section('[5] Pre-existing objects are blocking drift, never evidence of application')

const cleanObservation = {
  types: ['user_role', 'strain_type'],
  enumValues: [
    { type: 'strain_type', value: 'indica' },
    { type: 'strain_type', value: 'cbd' },
  ],
  tables: ['users', 'media', 'product_media', 'products'],
  columns: [{ table: 'media', column: 'url' }],
  indexes: ['users_email_unique'],
  constraints: ['users_pkey'],
  functions: ['purchase_limit_rules_guard'],
  triggers: ['purchase_limit_rules_immutable'],
}

const observe = (extra = {}) => {
  const merged = { ...cleanObservation }
  for (const [kind, rows] of Object.entries(extra)) merged[kind] = [...(merged[kind] ?? []), ...rows]
  return buildObservedKeys(merged)
}

{
  const clean = observe()
  check('a clean production-shaped clone shows no drift', clean.problems.length === 0)
  check(
    'nothing the pending stack declares is present on a clean clone',
    evaluateDrift({ inventory, recordedTags: RECORDED_TAGS, observedKeys: clean.keys }).problems.length === 0,
  )
  check(
    'every declared object of the four unrecorded migrations is actually checked',
    evaluateDrift({ inventory, recordedTags: RECORDED_TAGS, observedKeys: clean.keys }).checked === inventory.length,
  )

  for (const value of STRAIN_LEANING_VALUES) {
    const drifted = evaluateDrift({
      inventory,
      recordedTags: RECORDED_TAGS,
      observedKeys: observe({ enumValues: [{ type: 'strain_type', value }] }).keys,
    })
    check(
      `an existing ${value} with 0018 unrecorded is BLOCKING drift`,
      drifted.problems.length === 1 && has(drifted.problems, `enum value "strain_type.${value}"`),
    )
    check(
      `${value} is never read as evidence that 0018 was applied`,
      has(drifted.problems, 'never evidence') && has(drifted.problems, 'is NOT recorded in the ledger'),
    )
  }

  check(
    'an existing marketplace_access table with 0019 unrecorded is blocking drift',
    evaluateDrift({
      inventory,
      recordedTags: RECORDED_TAGS,
      observedKeys: observe({ tables: ['marketplace_access'] }).keys,
    }).problems.length === 1,
  )
  check(
    'an existing target_role column with 0019 unrecorded is blocking drift',
    evaluateDrift({
      inventory,
      recordedTags: RECORDED_TAGS,
      observedKeys: observe({ columns: [{ table: 'invite_codes', column: 'target_role' }] }).keys,
    }).problems.length === 1,
  )
  check(
    'drift anywhere in the stack blocks, not only in the last migration',
    evaluateDrift({
      inventory,
      recordedTags: RECORDED_TAGS,
      observedKeys: observe({
        types: ['media_kind'],
        tables: ['invite_codes'],
        triggers: ['users_max_two_admins'],
      }).keys,
    }).problems.length === 3,
  )
  check(
    'objects belonging to a RECORDED migration are not reported as drift',
    evaluateDrift({
      inventory,
      recordedTags: [...RECORDED_TAGS, '0016_yummy_tattoo'],
      observedKeys: observe({ types: ['media_kind'] }).keys,
    }).problems.length === 0,
  )

  const incomplete = buildObservedKeys({ ...cleanObservation, indexes: undefined })
  check('a catalog kind that was never collected fails closed', has(incomplete.problems, 'indexes were not collected'))
  check(
    'a missing observation entirely fails closed',
    has(evaluateDrift({ inventory, recordedTags: RECORDED_TAGS, observedKeys: null }).problems, 'No catalog observation'),
  )
}

section('[6] After migrating, the declared objects must exist and the dropped ones must not')
{
  const everything = buildObservedKeys({
    types: [...new Set(inventory.filter((o) => o.kind === 'type').map((o) => o.key.split(':')[1]))],
    enumValues: inventory
      .filter((o) => o.kind === 'enumValue')
      .map((o) => ({ type: o.key.split(':')[1], value: o.key.split(':')[2] })),
    tables: inventory.filter((o) => o.kind === 'table').map((o) => o.key.slice('table:'.length)),
    columns: inventory
      .filter((o) => o.kind === 'column')
      .map((o) => ({ table: o.key.slice('column:'.length).split('.')[0], column: o.key.split('.').pop() })),
    indexes: inventory
      .filter((o) => o.kind === 'index')
      .map((o) => o.key.slice('index:'.length))
      .filter((name) => !dropped.some((d) => d.key === objectKey.index(name))),
    constraints: inventory.filter((o) => o.kind === 'constraint').map((o) => o.key.slice('constraint:'.length)),
    functions: inventory.filter((o) => o.kind === 'function').map((o) => o.key.slice('function:'.length)),
    triggers: inventory.filter((o) => o.kind === 'trigger').map((o) => o.key.slice('trigger:'.length)),
  })

  check('a fully migrated schema satisfies the applied check', evaluateApplied({ inventory, dropped, observedKeys: everything.keys }).problems.length === 0)

  const withoutOne = new Set(everything.keys)
  withoutOne.delete(objectKey.table('marketplace_access'))
  check(
    'a declared object that did not appear is a failure',
    has(evaluateApplied({ inventory, dropped, observedKeys: withoutOne }).problems, 'does not exist'),
  )

  const withDropSurviving = new Set(everything.keys)
  withDropSurviving.add(objectKey.index('invite_code_redemptions_user_unique'))
  check(
    'an index 0019 was supposed to drop surviving is a failure',
    has(evaluateApplied({ inventory, dropped, observedKeys: withDropSurviving }).problems, 'is still present'),
  )
  check('no observation after migrating fails closed', evaluateApplied({ inventory, dropped, observedKeys: null }).problems.length > 0)
}

/* ================================================ 7. PRODUCTION IDENTITY == */
section('[7] The deployment must say "production" AND publish the expected fingerprint')

const healthBody = (overrides = {}) => ({
  status: 'ok',
  environment: 'production',
  database: { configured: true, reachable: true, fingerprint: PRODUCTION_HOST_FINGERPRINT, latencyMs: 12 },
  ...overrides,
})
const health = (input) =>
  evaluateHealthIdentity({
    reachable: true,
    httpStatus: 200,
    expectedFingerprint: PRODUCTION_HOST_FINGERPRINT,
    ...input,
  })

check('a healthy production deployment anchors the run', health({ body: healthBody() }).problems.length === 0)
check(
  'an unreachable health endpoint fails closed rather than warning',
  has(
    evaluateHealthIdentity({ reachable: false, httpStatus: 0, body: null, expectedFingerprint: PRODUCTION_HOST_FINGERPRINT }).problems,
    'could not be reached',
  ),
)
check('a non-200 response fails closed', has(health({ httpStatus: 503, body: healthBody() }).problems, 'HTTP 503'))
check('a non-JSON body fails closed', has(health({ body: null }).problems, 'did not return a JSON object'))
check(
  'a preview deployment is refused even with the right fingerprint',
  has(health({ body: healthBody({ environment: 'preview' }) }).problems, 'not "production"'),
)
check(
  'a deployment with no environment at all is refused',
  has(health({ body: healthBody({ environment: undefined }) }).problems, 'not "production"'),
)
check(
  'a fingerprint that is not the expected one is refused',
  has(health({ body: healthBody({ database: { configured: true, reachable: true, fingerprint: 'deadbeefcafe' } }) }).problems, 'expects'),
)
check(
  'no published fingerprint is refused',
  has(health({ body: healthBody({ database: { configured: true, reachable: true, fingerprint: null } }) }).problems, 'published no database fingerprint'),
)
check(
  'a degraded or unreachable database is refused',
  has(health({ body: healthBody({ status: 'degraded', database: { configured: true, reachable: false, fingerprint: PRODUCTION_HOST_FINGERPRINT } }) }).problems, 'configured, reachable database'),
)

/* ============================================== 8. BRANCH METADATA ======== */
section('[8] Ambiguous parent/default/primary metadata stops the run')

const branch = (over) => ({ id: 'br-child', name: 'other', default: false, primary: false, ...over })
const production = branch({ id: 'br-prod', name: 'production', default: true, primary: true })

{
  const topology = evaluateBranchTopology([production, branch()])
  check('one default branch, agreeing with primary, identifies production', topology.problems.length === 0 && topology.parent.id === 'br-prod')
  check('the flags are recorded as observed, so omission elsewhere can be read', topology.flagEvidence.default === true && topology.flagEvidence.primary === true)

  check('no branches at all is refused', evaluateBranchTopology([]).problems.length > 0)
  check(
    'two default branches are refused as ambiguous',
    has(evaluateBranchTopology([production, branch({ default: true })]).problems, 'branches are marked default'),
  )
  check(
    'no default and no primary branch is refused',
    has(evaluateBranchTopology([branch(), branch({ id: 'br-2' })]).problems, 'No branch in this project is marked default'),
  )
  {
    /* A control plane that populates only one of the pair is answerable; it is contradiction that is not. */
    const defaultOnly = evaluateBranchTopology([branch({ id: 'br-p', name: 'production', default: true }), branch()])
    const primaryOnly = evaluateBranchTopology([branch({ id: 'br-p', name: 'production', primary: true }), branch()])
    check(
      'a project reporting only "default" identifies production',
      defaultOnly.problems.length === 0 && defaultOnly.parent.id === 'br-p' && defaultOnly.flagEvidence.primary === false,
    )
    check(
      'a project reporting only "primary" identifies production',
      primaryOnly.problems.length === 0 && primaryOnly.parent.id === 'br-p' && primaryOnly.flagEvidence.default === false,
    )
  }
  check(
    'default and primary disagreeing is refused',
    has(
      evaluateBranchTopology([branch({ id: 'br-a', name: 'a', default: true }), branch({ id: 'br-b', name: 'b', primary: true })]).problems,
      'are different branches',
    ),
  )
  check(
    'a non-boolean flag is refused',
    has(evaluateBranchTopology([production, branch({ default: 'yes' })]).problems, 'non-boolean "default"'),
  )
  check('a branch without an id is refused', evaluateBranchTopology([production, { name: 'x' }]).problems.length > 0)
}

section('[9] The clone must prove it is a disposable child, not production')
{
  const parent = production
  const evidence = { default: true, primary: true }
  const clone = { id: 'br-clone', name: `${REHEARSAL_BRANCH_PREFIX}0016-0019-1`, default: false, primary: false, parent_id: 'br-prod' }

  check('a proper clone passes', evaluateCloneMetadata({ clone, parent, flagEvidence: evidence }).problems.length === 0)
  check(
    'a clone marked default is refused',
    has(evaluateCloneMetadata({ clone: { ...clone, default: true }, parent, flagEvidence: evidence }).problems, 'is marked default'),
  )
  check(
    'a clone marked primary is refused',
    has(evaluateCloneMetadata({ clone: { ...clone, primary: true }, parent, flagEvidence: evidence }).problems, 'is marked primary'),
  )
  check(
    'an omitted flag is refused even when the API reports that flag elsewhere',
    has(
      evaluateCloneMetadata({ clone: { ...clone, primary: undefined }, parent, flagEvidence: evidence }).problems,
      'must explicitly report "primary: false"',
    ),
  )
  check(
    'an omitted flag is refused regardless of project-wide flag evidence',
    has(
      evaluateCloneMetadata({
        clone: { ...clone, primary: undefined },
        parent,
        flagEvidence: { default: true, primary: false },
      }).problems,
      'must explicitly report "primary: false"',
    ),
  )
  check(
    'a clone whose parent_id is not the verified parent is refused',
    has(evaluateCloneMetadata({ clone: { ...clone, parent_id: 'br-somewhere' }, parent, flagEvidence: evidence }).problems, 'not the verified production'),
  )
  check(
    'a clone with no parent_id at all is refused',
    evaluateCloneMetadata({ clone: { ...clone, parent_id: undefined }, parent, flagEvidence: evidence }).problems.length > 0,
  )
  check(
    'a clone that is not named rehearsal-* is refused',
    has(evaluateCloneMetadata({ clone: { ...clone, name: 'development' }, parent, flagEvidence: evidence }).problems, 'not a rehearsal-* name'),
  )
  check(
    'a clone reporting the parent id is refused',
    evaluateCloneMetadata({ clone: { ...clone, id: 'br-prod' }, parent, flagEvidence: evidence }).problems.length > 0,
  )
  check('generated rehearsal names carry the prefix and the stack span', rehearsalBranchName(1).startsWith(`${REHEARSAL_BRANCH_PREFIX}0016-0019-`))
}

section('[10] The clone\'s write targets can never be current or retired production')
{
  const safe = {
    pooledHost: '48d2998d7060',
    directHost: '033993dbfcb0',
    pooledEndpoint: 'a53081efb29d',
    directEndpoint: 'a53081efb29d',
    parentPooledHost: PRODUCTION_HOST_FINGERPRINT,
    parentEndpoint: 'c0ffee111111',
    liveFingerprint: PRODUCTION_HOST_FINGERPRINT,
  }
  check('an isolated clone passes', evaluateCloneTargets(safe).problems.length === 0)
  check(
    'a pooled target that is current production is refused',
    has(evaluateCloneTargets({ ...safe, pooledHost: PRODUCTION_HOST_FINGERPRINT }).problems, 'current or retired production'),
  )
  check(
    'a direct target that is RETIRED production is refused',
    has(evaluateCloneTargets({ ...safe, directHost: RETIRED_PRODUCTION_HOST_FINGERPRINTS[0] }).problems, 'current or retired production'),
  )
  check(
    'a target that is the live database is refused even if no constant knows it',
    has(
      evaluateCloneTargets({ ...safe, liveFingerprint: safe.pooledHost, parentPooledHost: safe.pooledHost }).problems,
      'IS the database the live application is using',
    ),
  )
  check(
    "a target on production's compute endpoint is refused",
    has(evaluateCloneTargets({ ...safe, pooledEndpoint: 'c0ffee111111', directEndpoint: 'c0ffee111111' }).problems, "production's compute endpoint"),
  )
  check(
    'pooled and direct strings from different branches are refused',
    has(evaluateCloneTargets({ ...safe, directEndpoint: 'ffffffffffff' }).problems, 'not one branch'),
  )
  check('a target with no fingerprint at all is refused', evaluateCloneTargets({ ...safe, pooledHost: null }).problems.length > 0)
}

/* ========================================== 11. EXACTLY ONE INVOCATION ==== */
section('[11] The real drizzle-kit migrate path, once, and only after a clean preflight')

{
  const calls = []
  const gate = createMigrationGate((file, args) => {
    calls.push([file, ...args].join(' '))
    return 'migrated'
  })

  let refusedBeforeClear = false
  try {
    gate.run('npx', ['drizzle-kit', 'migrate'], {})
  } catch (error) {
    refusedBeforeClear = error.message.includes('without a drift-free preflight')
  }
  check('the command cannot run before the preflight clears it', refusedBeforeClear && calls.length === 0)

  gate.clear()
  check('a cleared gate runs the repository migrate path', gate.run('npx', ['drizzle-kit', 'migrate'], {}) === 'migrated')
  check('exactly one invocation was recorded', gate.invocations === 1 && calls.join('|') === 'npx drizzle-kit migrate')

  let refusedSecond = false
  try {
    gate.run('npx', ['drizzle-kit', 'migrate'], {})
  } catch (error) {
    refusedSecond = error.message.includes('already run once')
  }
  check('a second invocation is refused', refusedSecond && gate.invocations === 1 && calls.length === 1)
}

{
  const refuses = (file, args) => {
    try {
      assertMigrationCommand(file, args)
      return false
    } catch {
      return true
    }
  }
  check('npx drizzle-kit migrate is the accepted command', assertMigrationCommand('npx', ['drizzle-kit', 'migrate']) === true)
  check('--step is refused', refuses('npx', ['drizzle-kit', 'migrate', '--step=0019']))
  check('a targeted --to is refused', refuses('npx', ['drizzle-kit', 'migrate', '--to', '0018']))
  check('drizzle-kit push is refused', refuses('npx', ['drizzle-kit', 'push']))
  check('drizzle-kit generate is refused', refuses('npx', ['drizzle-kit', 'generate']))
  check('running psql or node directly is refused', refuses('psql', ['-f', 'drizzle/0019_demonic_rockslide.sql']) && refuses('node', ['-e', 'x']))
  check('an empty argument list is refused', refuses('npx', []))

  const gate = createMigrationGate(() => 'ran')
  gate.clear()
  let blocked = false
  try {
    gate.run('npx', ['drizzle-kit', 'migrate', '--step=0019'], {})
  } catch {
    blocked = true
  }
  check('a refused command does not consume the single invocation', blocked && gate.invocations === 0)
}

/* ======================================================== 12. THE PROBES == */
section('[12] SKIP, NOT-REACHED, missing, or FAIL all prevent PASS')

const allPassing = REQUIRED_PROBES.map((id) => ({ id, status: 'PASS', detail: '' }))
check('every required probe passing is the only way through', evaluateProbeOutcomes(allPassing).problems.length === 0)
check('the probe set covers all four pending migrations', ['0016.', '0017.', '0018.', '0019.'].every((p) => REQUIRED_PROBES.some((id) => id.startsWith(p))))
check(
  'a SKIPPED probe prevents PASS',
  has(evaluateProbeOutcomes(allPassing.map((r, i) => (i === 0 ? { ...r, status: 'SKIP' } : r))).problems, 'reported SKIP'),
)
check(
  'a NOT-REACHED probe prevents PASS',
  has(evaluateProbeOutcomes(allPassing.map((r, i) => (i === 3 ? { ...r, status: 'NOT-REACHED' } : r))).problems, 'reported NOT-REACHED'),
)
check(
  'a FAILED probe prevents PASS',
  has(evaluateProbeOutcomes(allPassing.map((r, i) => (i === 5 ? { ...r, status: 'FAIL', detail: 'code 23505' } : r))).problems, 'reported FAIL'),
)
check(
  'a probe that produced no result at all is MISSING, not absent',
  has(evaluateProbeOutcomes(allPassing.slice(1)).problems, `Probe "${REQUIRED_PROBES[0]}" is MISSING`),
)
check('no probe results at all prevents PASS', evaluateProbeOutcomes([]).problems.length === REQUIRED_PROBES.length)
check(
  'a duplicated probe result is refused',
  has(evaluateProbeOutcomes([...allPassing, { id: REQUIRED_PROBES[0], status: 'PASS' }]).problems, 'reported more than once'),
)
check(
  'an undeclared probe is refused rather than counted',
  has(evaluateProbeOutcomes([...allPassing, { id: 'made.up', status: 'PASS' }]).problems, 'not a declared probe'),
)
check('the isolation probe is required, so "nothing persisted" is proved', REQUIRED_PROBES.includes('probe.isolation'))

/* ===================================================== 13. CLEANUP GUARD == */
section('[13] Deletion is guarded strictly to the verified disposable branch')

{
  const name = `${REHEARSAL_BRANCH_PREFIX}0016-0019-123`
  const target = { id: 'br-clone', name, default: false, primary: false }
  check('the verified rehearsal branch may be deleted', evaluateDeletionGuard({ target, parentId: 'br-prod', expectedName: name }).problems.length === 0)
  check(
    'the production parent may never be deleted',
    has(evaluateDeletionGuard({ target: { ...target, id: 'br-prod' }, parentId: 'br-prod', expectedName: name }).problems, 'REFUSING to delete the production parent'),
  )
  check(
    'a branch marked default may never be deleted',
    has(evaluateDeletionGuard({ target: { ...target, default: true }, parentId: 'br-prod' }).problems, 'marked default/primary'),
  )
  check(
    'a branch marked primary may never be deleted',
    has(evaluateDeletionGuard({ target: { ...target, primary: true }, parentId: 'br-prod' }).problems, 'marked default/primary'),
  )
  check(
    'a branch that is not named rehearsal-* may never be deleted',
    has(evaluateDeletionGuard({ target: { ...target, name: 'development' }, parentId: 'br-prod' }).problems, 'not a rehearsal-*'),
  )
  check(
    'a rehearsal branch from some OTHER run may not be deleted by this one',
    has(
      evaluateDeletionGuard({ target: { ...target, name: `${REHEARSAL_BRANCH_PREFIX}0016-0019-999` }, parentId: 'br-prod', expectedName: name }).problems,
      'not the expected',
    ),
  )
  check('a branch that could not be found is refused, not assumed gone', evaluateDeletionGuard({ target: null, parentId: 'br-prod' }).problems.length > 0)
}

/* ============================================ 14. ABSENCE OF CAPABILITIES = */
section('[14] The runner does not contain the capabilities it must not have')

const runnerSource = repoFile('scripts/rehearse-migration-branch.mjs')
const coreSource = repoFile('scripts/rehearse-migration-branch-core.mjs')
const verifierSource = repoFile('scripts/verify-rehearse-migration-branch.mjs')
const countOf = (haystack, needle) => haystack.split(needle).length - 1
/** Module specifiers, from import statements only — anchored so a regex literal elsewhere is not one. */
const importsOf = (source) =>
  [...new Set([...source.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]))].sort()

check('the core is pure: no filesystem, network, environment, or database access', ['node:fs', 'fetch(', 'process.env', 'new Pool', 'execFileSync', 'child_process'].every((token) => !coreSource.includes(token)))
check(
  'the core imports nothing but node:crypto and the fingerprint constants',
  importsOf(coreSource).join(',') === './environment-fingerprints.mjs,node:crypto',
  importsOf(coreSource).join(','),
)
check(
  'this verifier imports nothing that could reach a database, Neon, or the network',
  importsOf(verifierSource).join(',') ===
    './environment-fingerprints.mjs,./rehearse-migration-branch-core.mjs,node:fs,node:url',
  importsOf(verifierSource).join(','),
)
check('the runner never writes a file', ['writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'mkdirSync'].every((token) => !runnerSource.includes(token)))
check('the runner has exactly one process-spawning call site', countOf(runnerSource, 'execFileSync(') === 1 && countOf(runnerSource, 'gate.run(') === 1)
check(
  'the runner never passes --step, --to, or a migration file to anything',
  !runnerSource.includes('--step') || runnerSource.includes("for (const banned of ['step'"),
)
check(
  'the runner refuses the old step/keep flags explicitly',
  ['step', 'to', 'keep', 'skip', 'repair', 'force'].every((f) => runnerSource.includes(`'${f}'`)) &&
    runnerSource.includes('is not supported'),
)
check(
  'the runner never mutates the drizzle ledger',
  [...runnerSource.matchAll(/^.*__drizzle_migrations.*$/gm)].every(
    (line) => !/insert\s+into|update\s+|delete\s+from|truncate|drop\s+table/i.test(line[0]),
  ),
)
check(
  'the runner executes no migration SQL of its own',
  !/\bfrom\s+['"]drizzle\/\d{4}/.test(runnerSource) && !runnerSource.includes('statement-breakpoint'),
)
check(
  'the runner reads migration files only to hash and compare them',
  countOf(runnerSource, 'readFileSync(') === 4 && runnerSource.includes('assertRepositoryUnchanged'),
)
check('the runner proves the journal and files were not modified by the run', runnerSource.includes('byte-identical to the committed ones'))
check(
  'the runner opens a pool only against the clone',
  countOf(runnerSource, 'new Pool(') === 1 && runnerSource.includes('new Pool({ connectionString: direct })'),
)
check(
  'the parent connection strings are fetched to be hashed, never connected to',
  runnerSource.includes('hostFp(parentPooled)') && !runnerSource.includes('connectionString: parent'),
)
check('cleanup runs in a finally block', /finally \{[\s\S]*deleteBranch\(/.test(runnerSource))
check('the deletion path goes through the shared guard', runnerSource.includes('evaluateDeletionGuard('))
check(
  'the migration command is gated behind the preflight, and cleared exactly once',
  countOf(runnerSource, 'gate.clear()') === 1 && runnerSource.includes('createMigrationGate('),
)
check(
  'the runner holds a production credential only long enough to hash it',
  countOf(runnerSource, 'connectionUri(') === 4 && !runnerSource.includes('console.log(parentPooled'),
)

/* ================================================ 15. THE HEALTH ORIGIN == */
section('[15] The health origin is a constant, and nothing may redirect it')

{
  const url = new URL(PRODUCTION_HEALTH_ORIGIN)
  check('the origin is exactly https://cloudmarket.cc', PRODUCTION_HEALTH_ORIGIN === 'https://cloudmarket.cc')
  check('the origin is https, so production identity is never established over plaintext', url.protocol === 'https:')
  check('the origin names cloudmarket.cc exactly — not a subdomain, not a look-alike', url.hostname === 'cloudmarket.cc')
  check(
    'the origin carries no port, no credentials, and no path of its own',
    url.port === '' && url.username === '' && url.password === '' && url.pathname === '/',
  )
  check('the health URL is that origin and the health route, and nothing else', PRODUCTION_HEALTH_URL === 'https://cloudmarket.cc/api/health')

  check(
    'an ordinary run supplies no origin and is not obstructed',
    resolveHealthOrigin([]).problems.length === 0 && resolveHealthOrigin([]).url === PRODUCTION_HEALTH_URL,
  )
  check(
    'a missing or non-array argv still yields exactly the constant',
    resolveHealthOrigin(undefined).origin === PRODUCTION_HEALTH_ORIGIN &&
      resolveHealthOrigin(null).problems.length === 0,
  )

  /*
   * Every shape an override has ever taken. The assertion is deliberately in two
   * halves: the attempt is REFUSED, and — separately — the origin it returns is
   * still the constant, so a caller that ignored the refusal gains nothing.
   */
  const hostile = [
    'http://cloudmarket.cc',
    'http://cloudmarket.cc/api/health',
    'https://staging.cloudmarket.cc',
    'https://cloudmarket.cc.attacker.test',
    'https://cloudmarket.cc:8443',
    'https://user:secret@cloudmarket.cc',
    'http://127.0.0.1:3000',
    'https://evil.example/api/health',
    'file:///etc/hosts',
    '--base=https://evil.example',
    '--base-url=http://localhost:3000',
    '--url=https://evil.example',
    '--origin=https://evil.example',
    '--host=evil.example',
    '--endpoint=https://evil.example',
    '--health=http://localhost:3000/api/health',
  ]
  for (const argument of hostile) {
    const resolved = resolveHealthOrigin([argument])
    check(
      `"${argument}" is refused and still cannot change the origin`,
      resolved.problems.length === 1 &&
        resolved.origin === PRODUCTION_HEALTH_ORIGIN &&
        resolved.url === PRODUCTION_HEALTH_URL,
    )
  }
  check(
    'all of them at once are all refused, and the origin is still the constant',
    resolveHealthOrigin(hostile).problems.length === hostile.length &&
      resolveHealthOrigin(hostile).origin === PRODUCTION_HEALTH_ORIGIN,
  )
  check('the legitimate --cleanup flag is not mistaken for an origin override', resolveHealthOrigin(['--cleanup=br-abc123']).problems.length === 0)
  check('non-string arguments are ignored rather than crashing the refusal', resolveHealthOrigin([null, 42, undefined, {}]).problems.length === 0)

  check('the runner no longer takes its base from whichever argument looked like a URL', !runnerSource.includes("startsWith('http')"))
  check(
    'the runner performs exactly one fetch, against the constant health URL',
    countOf(runnerSource, 'fetch(') === 1 && runnerSource.includes('fetch(PRODUCTION_HEALTH_URL'),
  )
  check(
    'the runner reads no environment variable that could redirect the health origin',
    [...runnerSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)].every((m) =>
      ['NEON_PROJECT_NAME', 'NEON_PROJECT_ID', 'NEON_DATABASE', 'NEON_ROLE'].includes(m[1]),
    ),
  )
  check(
    'the runner refuses a supplied origin at startup rather than ignoring it silently',
    runnerSource.includes('resolveHealthOrigin(process.argv.slice(2))') && /origin\.problems\.length > 0/.test(runnerSource),
  )
}

/* ==================================================== 16. REDACTED OUTPUT = */
section('[16] No credential reaches stdout, stderr, or an error message')

{
  const password = 'np_S3cr3t-P4ssw0rd'
  const pooledUri = `postgresql://neondb_owner:${password}@ep-rehearsal-clone-pooler.eu-central-1.aws.neon.tech/cloudmarket?sslmode=require`
  const directUri = `postgresql://neondb_owner:${password}@ep-rehearsal-clone.eu-central-1.aws.neon.tech/cloudmarket?sslmode=require`
  const secrets = [pooledUri, directUri]

  /* The representative secrets: the whole URI, its userinfo, and the password alone. */
  const leaks = [password, pooledUri, directUri, `neondb_owner:${password}`, 'ep-rehearsal-clone.eu-central-1.aws.neon.tech']
  const clean = (text) => {
    const redacted = redactSecrets(text, secrets)
    return leaks.every((leak) => !redacted.includes(leak))
  }

  const childStdout =
    "> drizzle-kit migrate\nReading config file '/app/drizzle.config.ts'\n" +
    `Using DATABASE_URL=${directUri}\n` +
    `Using DATABASE_URL_UNPOOLED="${directUri}"\n` +
    `error: connection to ${pooledUri} failed\n`
  check('a child stdout blob quoting both connection strings is fully redacted', clean(childStdout))
  check('the redaction is visible rather than a silent deletion', redactSecrets(childStdout, secrets).includes(REDACTED))
  check('text that is not a secret survives redaction', redactSecrets(childStdout, secrets).includes('drizzle-kit migrate'))

  const childStderr =
    'PostgresError: password authentication failed\n' +
    `  dsn: host=ep-rehearsal-clone.eu-central-1.aws.neon.tech user=neondb_owner password=${password} dbname=cloudmarket\n`
  check('a child stderr blob carrying a DSN password is redacted', clean(childStderr))
  check('a bare password= assignment is redacted even with no secrets registered', !redactSecrets(childStderr, []).includes(password))

  const failure = new Error(`drizzle-kit migrate failed for ${directUri}`)
  check('an Error message is redacted before printing', clean(failure.message))
  check('an Error handed in directly is redacted, not stringified around', !redactSecrets(failure, secrets).includes(password) && redactSecrets(failure, secrets).includes('migrate failed'))

  const unregistered = 'Error: could not connect to postgresql://someone:hunter2000@ep-elsewhere.aws.neon.tech/db'
  check(
    'a connection URI this run never held is still redacted, by shape',
    !redactSecrets(unregistered, []).includes('hunter2000') && !redactSecrets(unregistered, []).includes('ep-elsewhere.aws.neon.tech'),
  )
  check('a credentialed URI in any scheme is redacted', !redactSecrets('see https://admin:letmein99@internal.example/x', []).includes('letmein99'))
  check('a DATABASE_URL assignment with no scheme at all is redacted', !redactSecrets('DATABASE_URL=totally-opaque-token-value', []).includes('totally-opaque-token-value'))
  check('a DATABASE_URL_UNPOOLED assignment is redacted', !redactSecrets('DATABASE_URL_UNPOOLED: opaque-unpooled-token', []).includes('opaque-unpooled-token'))
  check('a NEON_API_KEY that reached the output is redacted', !redactSecrets('NEON_API_KEY=neon_api_abc123def456', []).includes('neon_api_abc123def456'))
  check('a null or undefined value redacts to an empty string rather than throwing', redactSecrets(null, secrets) === '' && redactSecrets(undefined, secrets) === '')
  check('a non-string value is stringified before redaction', redactSecrets(1234, secrets) === '1234')

  const literals = collectSecretLiterals([pooledUri])
  check('the password alone is a secret, not only the whole URI', literals.includes(password))
  check('the userinfo pair is a secret', literals.includes(`neondb_owner:${password}`))
  check('the clone host is a secret too, so a DSN cannot disclose it', literals.includes('ep-rehearsal-clone-pooler.eu-central-1.aws.neon.tech'))
  check('the longest literals are replaced first, so none is chopped up before it matches', literals[0].length >= literals[literals.length - 1].length)
  check('empty, short, and non-string secrets are ignored rather than blanking the log', collectSecretLiterals([null, '', 'abc', 42]).length === 0)

  const errorPrints = [...runnerSource.matchAll(/console\.error\(([^\n]*)\)/g)]
    .map((m) => m[1])
    .filter((argument) => /error\.message|error\.stdout|error\.stderr|\boutput\b/.test(argument))
  check('the runner has error-derived prints for this check to be about', errorPrints.length >= 4)
  check('every error-derived print in the runner is redacted first', errorPrints.every((argument) => argument.includes('redact(')))
  check('child output is redacted at capture, not only at print', runnerSource.includes('output = redact('))
  check('every connection string the runner fetches is registered as a secret', countOf(runnerSource, 'remember(') === 4)
  check(
    'no print in the runner interpolates a raw connection string',
    [...runnerSource.matchAll(/(?:console\.(?:log|error)|note|ok|stage)\(([^\n]*)/g)].every(
      (m) => !/\$\{\s*(?:direct|pooled|parentDirect|parentPooled)\s*\}/.test(m[1]),
    ),
  )
}

/* ============================================ 17. THE ORPHANED CLONE ====== */
section('[17] A clone created by a call that FAILED is still found and deleted')

{
  const name = `${REHEARSAL_BRANCH_PREFIX}0016-0019-1770000000000`
  const parentBranch = { id: 'br-prod', name: 'production', default: true, primary: true }
  const orphan = { id: 'br-clone', name, default: false, primary: false, parent_id: 'br-prod' }
  const project = [parentBranch, orphan]

  const byId = resolveCleanupTarget({ cloneId: 'br-clone', branchName: name, branches: project })
  check(
    'a run that got an id deletes that exact branch',
    byId.status === CLEANUP_RESOLUTION.IDENTIFIED && byId.target.id === 'br-clone' && byId.matchedBy === 'id',
  )

  const byName = resolveCleanupTarget({ cloneId: null, branchName: name, branches: project })
  check(
    'a run whose create call threw finds the orphan by its generated name',
    byName.status === CLEANUP_RESOLUTION.IDENTIFIED && byName.target.id === 'br-clone' && byName.matchedBy === 'name',
  )
  check(
    'a response carrying no branch.id is the same case, not a lost branch',
    resolveCleanupTarget({ cloneId: undefined, branchName: name, branches: project }).target?.id === 'br-clone',
  )
  check('a blank id is not mistaken for an id', resolveCleanupTarget({ cloneId: '   ', branchName: name, branches: project }).matchedBy === 'name')

  const none = resolveCleanupTarget({ cloneId: null, branchName: name, branches: [parentBranch] })
  check(
    'ZERO exact matches reports that cleanup could not confirm a branch',
    none.status === CLEANUP_RESOLUTION.UNCONFIRMED && has(none.problems, 'could not confirm a branch'),
  )
  check('zero matches deletes nothing at all', none.target === null)

  const twins = resolveCleanupTarget({
    cloneId: null,
    branchName: name,
    branches: [parentBranch, orphan, { ...orphan, id: 'br-twin' }],
  })
  check(
    'MULTIPLE exact matches is a refusal, not a choice',
    twins.status === CLEANUP_RESOLUTION.AMBIGUOUS && twins.target === null && has(twins.problems, 'REFUSING'),
  )

  check(
    'a differently named branch is never an exact match',
    resolveCleanupTarget({ cloneId: null, branchName: name, branches: [parentBranch, { ...orphan, name: `${name}-2` }] }).status ===
      CLEANUP_RESOLUTION.UNCONFIRMED,
  )
  check(
    'another rehearsal branch sharing the prefix is not an exact match',
    resolveCleanupTarget({
      cloneId: null,
      branchName: name,
      branches: [parentBranch, { ...orphan, name: `${REHEARSAL_BRANCH_PREFIX}0016-0019-9` }],
    }).status === CLEANUP_RESOLUTION.UNCONFIRMED,
  )
  check(
    'a name this tooling did not generate may not be used to find anything',
    resolveCleanupTarget({ cloneId: null, branchName: 'production', branches: project }).status === CLEANUP_RESOLUTION.AMBIGUOUS,
  )
  check(
    'no id and no generated name deletes nothing',
    resolveCleanupTarget({ cloneId: null, branchName: null, branches: project }).status === CLEANUP_RESOLUTION.AMBIGUOUS,
  )
  check(
    'a branch list that is not a list deletes nothing',
    resolveCleanupTarget({ cloneId: 'br-clone', branchName: name, branches: null }).status === CLEANUP_RESOLUTION.AMBIGUOUS,
  )
  check(
    'a known id that is already gone is ABSENT, which is not the same as unconfirmed',
    resolveCleanupTarget({ cloneId: 'br-clone', branchName: name, branches: [parentBranch] }).status === CLEANUP_RESOLUTION.ABSENT,
  )
  check(
    'two branches reporting the same id is a refusal',
    resolveCleanupTarget({ cloneId: 'br-clone', branchName: name, branches: [orphan, orphan] }).status === CLEANUP_RESOLUTION.AMBIGUOUS,
  )

  /*
   * The layering, proved: resolution only ever nominates a candidate, and the
   * guard is what refuses. A branch that matched the name exactly and IS the
   * production parent is nominated and then refused twice over.
   */
  const impostor = { id: 'br-prod', name, default: true, primary: true }
  const nominated = resolveCleanupTarget({ cloneId: null, branchName: name, branches: [impostor] })
  const guarded = evaluateDeletionGuard({ target: nominated.target, parentId: 'br-prod', expectedName: name })
  check(
    'an exact-name match that is the production parent is still refused by the guard',
    nominated.status === CLEANUP_RESOLUTION.IDENTIFIED &&
      has(guarded.problems, 'REFUSING to delete the production parent') &&
      has(guarded.problems, 'marked default/primary'),
  )
  check(
    'a branch found by id but wearing another name is refused by the guard',
    has(
      evaluateDeletionGuard({
        target: { id: 'br-clone', name: 'development', default: false, primary: false },
        parentId: 'br-prod',
        expectedName: name,
      }).problems,
      'not a rehearsal-*',
    ),
  )

  check(
    'the runner generates the branch name before it posts the create request',
    runnerSource.indexOf('const branchName = rehearsalBranchName(') < runnerSource.indexOf("method: 'POST'"),
  )
  check(
    'cleanup is armed before the create request is made',
    runnerSource.indexOf('let cloneId = null') < runnerSource.indexOf("method: 'POST'"),
  )
  check(
    'the create request itself sits inside the try whose finally deletes the branch',
    /try \{\s*\n\s*const created = await api\(/.test(runnerSource) && /finally \{[\s\S]*deleteBranch\(/.test(runnerSource),
  )
  check(
    'cleanup is handed both the id and the generated name',
    runnerSource.includes('deleteBranch(apiKey, project.id, { cloneId, branchName, parentId: parent.id })'),
  )
  check(
    'the deletion path resolves a candidate and then guards it',
    runnerSource.includes('resolveCleanupTarget(') && runnerSource.includes('evaluateDeletionGuard('),
  )
}

/* ======================================== 18. THE PROBE TRANSACTION ======= */
section('[18] The probe transaction rolls back from a finally, before the release')

{
  const trace = async ({ beginThrows, bodyThrows, rollbackThrows } = {}) => {
    const order = []
    const step = (name, throws) => async () => {
      order.push(name)
      if (throws) throw new Error(`${name} failed`)
      return name
    }
    let thrown = null
    try {
      await withProbeTransaction({
        begin: step('begin', beginThrows),
        body: step('body', bodyThrows),
        rollback: step('rollback', rollbackThrows),
        release: step('release', false),
      })
    } catch (error) {
      thrown = error.message
    }
    return { order: order.join(','), thrown }
  }

  const happy = await trace()
  check('the ordinary path is begin, body, rollback, release', happy.order === 'begin,body,rollback,release' && happy.thrown === null)

  const bodyFailed = await trace({ bodyThrows: true })
  check('an unexpected exception in the probes still rolls back BEFORE releasing', bodyFailed.order === 'begin,body,rollback,release')
  check('the probe failure still propagates', bodyFailed.thrown === 'body failed')

  const rollbackFailed = await trace({ rollbackThrows: true })
  check('a rollback failure fails the rehearsal instead of being swallowed', rollbackFailed.thrown === 'rollback failed')
  check('the connection is released even when the rollback fails', rollbackFailed.order === 'begin,body,rollback,release')

  const bothFailed = await trace({ bodyThrows: true, rollbackThrows: true })
  check('a rollback failure is never swallowed by the error that caused the unwind', bothFailed.thrown === 'rollback failed')
  check('the release still happens when both fail', bothFailed.order === 'begin,body,rollback,release')

  const beginFailed = await trace({ beginThrows: true })
  check('a transaction that never began is not rolled back', beginFailed.order === 'begin,release')
  check('a failure to begin propagates, and the connection is still released', beginFailed.thrown === 'begin failed')

  let refusedIncomplete = false
  try {
    await withProbeTransaction({ begin: () => {}, body: () => {}, rollback: () => {} })
  } catch (error) {
    refusedIncomplete = error.message.includes('requires a release function')
  }
  check('a lifecycle missing its release is refused rather than half-run', refusedIncomplete)

  check('the runner runs its probes through the shared lifecycle', countOf(runnerSource, 'withProbeTransaction(') === 1)
  check('the runner no longer releases the client from a finally of its own', !/finally \{\s*\n\s*client\.release\(\)/.test(runnerSource))
  check(
    'the runner hands over rollback and release as a pair, rollback first',
    runnerSource.indexOf("rollback: () => client.query('rollback')") < runnerSource.indexOf('release: () => client.release()'),
  )
  check(
    'the core rolls back inside a finally that still reaches the release',
    /finally \{[\s\S]*?if \(began\) await rollback\(\)[\s\S]*?finally \{[\s\S]*?await release\(\)/.test(coreSource),
  )
}

/* ======================================== 19. THE CARRIED-DATA EVIDENCE === */
section('[19] The carried-data report claims exactly what was compared, and no more')

{
  const signature = (over = {}) => ({
    counts: { users: 4, media: 7, product_media: 3, products: 2, product_variants: 5 },
    digests: { users: { rows: 4, digest: 'u1' }, media: { rows: 7, digest: 'm1' } },
    ...over,
  })

  check('an unchanged signature passes', evaluateCarriedData({ before: signature(), after: signature() }).problems.length === 0)
  check(
    'a row count that changed is a failure',
    has(
      evaluateCarriedData({
        before: signature(),
        after: signature({ counts: { users: 5, media: 7, product_media: 3, products: 2, product_variants: 5 } }),
      }).problems,
      'users row count changed: 4 -> 5',
    ),
  )
  check(
    'a digest that changed is a failure',
    has(
      evaluateCarriedData({
        before: signature(),
        after: signature({ digests: { users: { rows: 4, digest: 'u2' }, media: { rows: 7, digest: 'm1' } } }),
      }).problems,
      'The digest of "users"',
    ),
  )
  {
    /*
     * The null-collapse failure, as data: a digest whose row coverage is short of
     * the table's own count is refused even though both sides agree, because
     * "identical over the rows we happened to aggregate" is not an answer.
     */
    const short = signature({ digests: { users: { rows: 3, digest: 'u1' }, media: { rows: 7, digest: 'm1' } } })
    check(
      'a digest that covered fewer rows than the table holds is a failure on both sides',
      has(evaluateCarriedData({ before: short, after: short }).problems, 'covered 3 of 4 row(s)') &&
        evaluateCarriedData({ before: short, after: short }).problems.length === 2,
    )
  }
  check(
    'a count that was not observed fails closed rather than passing',
    has(evaluateCarriedData({ before: signature({ counts: { users: 4 } }), after: signature() }).problems, 'was not observed on both sides'),
  )
  check(
    'a digest that was not observed fails closed rather than passing',
    has(evaluateCarriedData({ before: signature({ digests: {} }), after: signature() }).problems, 'No usable digest'),
  )
  check(
    'a null digest value fails closed',
    evaluateCarriedData({
      before: signature({ digests: { users: { rows: 4, digest: null }, media: { rows: 7, digest: 'm1' } } }),
      after: signature(),
    }).problems.length > 0,
  )
  check('no signature at all fails closed', evaluateCarriedData({ before: null, after: null }).problems.length >= CARRIED_TABLES.length)
  check(
    'every carried table and every digested table is actually accounted for',
    CARRIED_TABLES.length === 5 &&
      evaluateCarriedData({ before: { counts: {}, digests: {} }, after: { counts: {}, digests: {} } }).problems.length ===
        CARRIED_TABLES.length + Object.keys(CARRIED_DIGEST_COLUMNS).length,
  )

  check('a fully backfilled media table passes', evaluateMediaBackfill(0).problems.length === 0)
  check('a single un-backfilled media row is a failure', has(evaluateMediaBackfill(1).problems, "did not backfill to 'image'"))
  check('a backfill that was never observed fails closed', has(evaluateMediaBackfill(null).problems, 'was not observed'))

  const report = describeCarriedEvidence(signature())
  check('the report does not claim byte-identity', !report.includes('byte-identical'))
  check('the report does not claim that every carried row was compared', !/every carried row/i.test(report))
  check('the report names every table whose row count was checked', CARRIED_TABLES.every((table) => report.includes(table)))
  check(
    'the report names the exact columns that were digested',
    Object.entries(CARRIED_DIGEST_COLUMNS).every(([table, columns]) => report.includes(`${table}(${columns.join(', ')})`)),
  )
  check(
    'the report says, in the same breath, what it did NOT compare',
    report.includes(CARRIED_EVIDENCE_DISCLAIMER) && CARRIED_EVIDENCE_DISCLAIMER.includes('not compared'),
  )
  check(
    'the report states that the digest is null-safe and covers every row of those tables',
    report.includes('null-safe') && report.includes('covering every row of those tables'),
  )
  check('the runner no longer prints the old universal claim', !runnerSource.includes('every carried row is byte-identical'))
  check('the runner prints the built report rather than a hand-written sentence', runnerSource.includes('ok(describeCarriedEvidence(after))'))

  const usersSql = buildRowDigestQuery({ table: 'users', columns: [...CARRIED_DIGEST_COLUMNS.users] })
  check(
    'every digested column is coalesced to a null sentinel',
    CARRIED_DIGEST_COLUMNS.users.every((column) => usersSql.includes(`coalesce("${column}"::text, ${NULL_SENTINEL_SQL})`)),
  )
  check(
    'the nullable columns that used to vanish from the digest are the ones being covered',
    CARRIED_DIGEST_COLUMNS.users.includes('email') && CARRIED_DIGEST_COLUMNS.media.includes('alt_text'),
  )
  check('the digest is ordered deterministically', usersSql.includes('order by "id"'))
  check('the digest reports how many rows it covered', usersSql.includes('count(*)::int as n'))
  check('an empty table digests to a stable value rather than null', usersSql.includes("'empty'"))
  check('the column and row separators cannot be forged by the data', usersSql.includes('concat_ws(chr(2)') && usersSql.includes('chr(3) order by'))

  const refuses = (input) => {
    try {
      buildRowDigestQuery(input)
      return false
    } catch {
      return true
    }
  }
  check('an unsafe table name is refused rather than interpolated', refuses({ table: 'users"; drop table users; --', columns: ['id'] }))
  check('an unsafe column name is refused rather than interpolated', refuses({ table: 'users', columns: ['id', 'email"'] }))
  check('a digest over no columns is refused', refuses({ table: 'users', columns: [] }))
  check('an order key that is not one of the digested columns is refused', refuses({ table: 'users', columns: ['email'], orderBy: 'id' }))

  check(
    'the runner builds its digests from the core rather than by hand',
    runnerSource.includes('buildRowDigestQuery({ table, columns })') && countOf(runnerSource, 'md5(') === 0,
  )
  check(
    'the runner compares carried data through the core evaluators',
    runnerSource.includes('evaluateCarriedData({ before, after })') && runnerSource.includes('evaluateMediaBackfill(notImage)'),
  )
  check(
    'the isolation probe reuses exactly the same comparison',
    runnerSource.includes('evaluateCarriedData({ before: after, after: afterProbes })'),
  )
}

/* ================================================================ summary = */
console.log('\n==========================================================')
if (fail === 0) {
  console.log(`RESULT: ${pass} passed, 0 failed`)
} else {
  console.log(`RESULT: ${pass} passed, ${fail} failed`)
  for (const f of failures) console.log(`  • ${f}`)
  process.exitCode = 1
}
console.log('==========================================================')
