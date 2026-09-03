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
  CLEANUP_LIST_ATTEMPTS,
  CLEANUP_RESOLUTION,
  DIGEST_NULL_FIELD_SQL,
  HEALTH_REDIRECT_POLICY,
  MEDIA_BACKFILL_QUERY,
  MEDIA_NON_IMAGE_PREDICATE_SQL,
  PENDING_TAGS,
  PRODUCTION_HEALTH_ORIGIN,
  PRODUCTION_HEALTH_URL,
  RECORDED_TAGS,
  REDACTED,
  REHEARSAL_BRANCH_PREFIX,
  REQUIRED_PROBES,
  STRAIN_EQUIVALENCE_OPERATIONS,
  STRAIN_EQUIVALENCE_TAG,
  STRAIN_LEANING_VALUES,
  STRAIN_TYPE_EXPECTED_ORDER,
  STRAIN_TYPE_ORDER_QUERY,
  assertMigrationCommand,
  buildObservedKeys,
  buildPendingInventory,
  buildRepositoryMigrations,
  buildRowDigestQuery,
  collectSecretLiterals,
  confirmCleanupTarget,
  createMigrationGate,
  decodeDigestRows,
  derivePendingStack,
  describeAddValueOperation,
  describeCarriedEvidence,
  describeOriginSafely,
  describeStrainLeaningEquivalence,
  digestFieldSql,
  encodeDigestField,
  encodeDigestRow,
  encodeDigestRows,
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
  evaluateStrainLeaningEquivalence,
  extractDeclaredObjects,
  interpretBranchFlag,
  isNonImageKind,
  migrationHash,
  normalizeCatalogEnumOrder,
  objectKey,
  parseAddValueScript,
  reconcileLedger,
  redactSecrets,
  rehearsalBranchName,
  resolveCleanupTarget,
  resolveHealthOrigin,
  tokenizeMigrationSql,
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

  /*
   * THE REFUSAL MUST NOT BECOME THE DISCLOSURE.
   *
   * The rejected argument is the one string this tooling is guaranteed to print
   * about, it is a URL a human just pasted, and the refusal happens at startup —
   * before the runner has registered a single secret with `redact`. Every
   * fixture below carries fake credentials in a different position: userinfo, a
   * query token, a fragment token, and a whole DSN.
   */
  const credentialed = [
    'https://admin:sup3r-s3cret-pw@cloudmarket.cc/api/health?token=tok_live_ABC123',
    '--host=https://operator:hunter2-password@evil.example/api/health#access_token=frag_9Z',
    '--base-url=http://127.0.0.1:3000/api/health?apikey=neon_api_leakedkey123',
    'postgresql://neondb_owner:np_S3cr3t-P4ss@ep-leak.eu-central-1.aws.neon.tech/cloudmarket',
  ]
  const credentialFragments = [
    'sup3r-s3cret-pw',
    'tok_live_ABC123',
    'hunter2-password',
    'frag_9Z',
    'neon_api_leakedkey123',
    'np_S3cr3t-P4ss',
    'admin:',
    'operator:',
    'neondb_owner:',
    'evil.example',
    '127.0.0.1',
    'ep-leak.eu-central-1.aws.neon.tech',
  ]
  const credentialedRefusals = resolveHealthOrigin(credentialed)
  check('every credentialed override attempt is refused', credentialedRefusals.problems.length === credentialed.length)
  check(
    'no rejected argument is echoed back in full',
    credentialed.every((argument) => !credentialedRefusals.problems.join('\n').includes(argument)),
  )
  check(
    'no password, token, userinfo, or hostile host survives into the refusal',
    credentialFragments.every((fragment) => !credentialedRefusals.problems.join('\n').includes(fragment)),
  )
  check(
    'the refusal still says WHAT was refused and where',
    credentialedRefusals.problems[0].includes('Refusing argument #1') &&
      credentialedRefusals.problems[1].includes('the --host flag') &&
      credentialedRefusals.problems.every((problem) => problem.includes(PRODUCTION_HEALTH_ORIGIN)),
  )
  check(
    'the refusal says why the value is withheld, so it does not read as a bug',
    credentialedRefusals.problems.every((problem) => problem.includes('not repeated here')),
  )
  check(
    'the credentialed origin still cannot be changed by any of them',
    credentialedRefusals.origin === PRODUCTION_HEALTH_ORIGIN && credentialedRefusals.url === PRODUCTION_HEALTH_URL,
  )
  {
    /* The whole hostile corpus from above, checked the same way for leaked text. */
    const echoed = resolveHealthOrigin(hostile).problems.join('\n')
    check('none of the hostile origins is reproduced in its own refusal', hostile.every((argument) => !echoed.includes(argument)))
    check('the look-alike hosts are not repeated either', !echoed.includes('cloudmarket.cc.attacker.test') && !echoed.includes('user:secret'))
  }
  {
    const originSource = coreSource.slice(
      coreSource.indexOf('export function resolveHealthOrigin'),
      coreSource.indexOf('export function describeOriginSafely'),
    )
    check('the refusal is built without interpolating the argument at all', originSource.length > 0 && !/\$\{[^}]*\barg\b[^}]*\}/.test(originSource))
    check('the runner prints only the core-built refusal at startup', runnerSource.includes('for (const problem of origin.problems) console.error(problem)'))
    check(
      'nothing in the runner prints raw argv before redaction exists',
      !runnerSource.includes('console.error(process.argv') && !runnerSource.includes('console.log(process.argv'),
    )
  }

  /* ---- redirects are refused, and the answering URL must be the exact one --- */
  check('the fetch redirect policy is "error", so a 3xx is a failure and never a hop', HEALTH_REDIRECT_POLICY === 'error')
  check(
    'the runner hands that policy to its one fetch',
    runnerSource.includes('redirect: HEALTH_REDIRECT_POLICY') &&
      !runnerSource.includes("redirect: 'follow'") &&
      !runnerSource.includes("redirect: 'manual'"),
  )
  check(
    'the runner verifies where the response came from, not only what it said',
    runnerSource.includes('evaluateHealthEndpointIdentity({ url: health.url, redirected: health.redirected })') &&
      runnerSource.includes('const identityProblems = [...endpoint.problems, ...identity.problems]'),
  )
  check(
    'a redirect or a wrong response URL stops the run exactly like a wrong body does',
    /if \(identityProblems\.length > 0\) \{\s*\n\s*stop\(/.test(runnerSource),
  )

  const endpoint = (input) => evaluateHealthEndpointIdentity(input)
  check(
    'a direct answer from the exact URL is accepted',
    endpoint({ url: PRODUCTION_HEALTH_URL, redirected: false }).problems.length === 0,
  )
  check(
    'a response that was redirected is refused even when it ends at the right URL',
    has(endpoint({ url: PRODUCTION_HEALTH_URL, redirected: true }).problems, 'was redirected'),
  )
  check(
    'a response with no URL of its own is refused rather than assumed',
    has(endpoint({ url: null, redirected: false }).problems, 'reported no URL'),
  )
  check('an empty response URL is refused', endpoint({ url: '', redirected: false }).problems.length > 0)
  for (const wrong of [
    'http://cloudmarket.cc/api/health',
    'https://cloudmarket.cc:443/api/health',
    'https://staging.cloudmarket.cc/api/health',
    'https://cloudmarket.cc.attacker.test/api/health',
    'https://cloudmarket.cc/api/health/',
    'https://cloudmarket.cc/api/health?ok=1',
    'https://cloudmarket.cc/api/health#x',
    'https://cloudmarket.cc/api/health2',
    'https://127.0.0.1:3000/api/health',
    'https://cloudmarket.cc/',
  ]) {
    check(
      `a response from "${wrong}" cannot establish production identity`,
      endpoint({ url: wrong, redirected: false }).problems.length === 1,
    )
  }
  {
    const leaky = 'https://root:redirect-p4ssword@evil.example/api/health?session=sess_LEAKED'
    const refusal = endpoint({ url: leaky, redirected: true }).problems.join('\n')
    check('a credentialed response URL is refused', refusal.includes('did not come from'))
    check(
      'and its userinfo and query are not echoed while refusing it',
      !refusal.includes('redirect-p4ssword') && !refusal.includes('sess_LEAKED') && !refusal.includes('root:'),
    )
    check('only the origin of an unexpected URL is reported', refusal.includes('https://evil.example'))
    check('the origin description strips userinfo, path, and query', describeOriginSafely(leaky) === 'https://evil.example')
    check('an unparseable URL is described without being repeated', describeOriginSafely('::not a url::') === '(an unparseable URL)')
  }

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

  /*
   * ONE LISTING IS NOT PROOF OF ABSENCE.
   *
   * `resolveCleanupTarget` answers about the snapshot in its hand, and `ABSENT`
   * there means only "this response did not carry the id". `confirmCleanupTarget`
   * is what a caller uses, and it must never turn that into "there is nothing to
   * clean up": it re-lists within a bound, falls back to the exact generated
   * name, refuses on any conflict, and otherwise reports UNCONFIRMED so a human
   * is sent to look.
   */
  const listing = (...pages) => {
    const seen = []
    const list = async () => {
      const page = pages[Math.min(seen.length, pages.length - 1)]
      seen.push(page)
      if (page instanceof Error) throw page
      return page
    }
    list.calls = seen
    return list
  }
  const noWait = async () => {}
  const confirm = (input) =>
    confirmCleanupTarget({ parentId: 'br-prod', attempts: CLEANUP_LIST_ATTEMPTS, wait: noWait, ...input })

  check('the retry bound is a fixed, small number of listings', CLEANUP_LIST_ATTEMPTS === 3)

  {
    const found = await confirm({ cloneId: 'br-clone', branchName: name, listBranches: listing(project) })
    check(
      'a branch that is listed straight away is identified on the first attempt',
      found.status === CLEANUP_RESOLUTION.IDENTIFIED && found.target.id === 'br-clone' && found.matchedBy === 'id' && found.attemptsMade === 1,
    )
  }
  {
    /* Eventual consistency: the branch exists, the first listing simply had not caught up. */
    const lister = listing([parentBranch], [parentBranch], project)
    const late = await confirm({ cloneId: 'br-clone', branchName: name, listBranches: lister })
    check(
      'a branch that only appears in a later listing is still found and deleted',
      late.status === CLEANUP_RESOLUTION.IDENTIFIED && late.target.id === 'br-clone' && late.attemptsMade === 3,
    )
    check('the re-listing is bounded, not a spin', lister.calls.length === CLEANUP_LIST_ATTEMPTS)
  }
  {
    const missing = await confirm({ cloneId: 'br-clone', branchName: name, listBranches: listing([parentBranch]) })
    check(
      'a known id absent from EVERY listing is UNCONFIRMED, never ABSENT',
      missing.status === CLEANUP_RESOLUTION.UNCONFIRMED && missing.status !== CLEANUP_RESOLUTION.ABSENT,
    )
    check('nothing is nominated for deletion when nothing was confirmed', missing.target === null && missing.matchedBy === null)
    check('the bound was actually exhausted before giving up', missing.attemptsMade === CLEANUP_LIST_ATTEMPTS)
    check(
      'the operator is told this is not a report that the branch is gone',
      has(missing.problems, 'is NOT proof that the branch') && has(missing.problems, 'Inspect the project by hand'),
    )
    check('the exact name to look for is named in the instruction', has(missing.problems, name))
    check('each failed attempt is accounted for individually', missing.problems.filter((p) => p.startsWith('Attempt ')).length === CLEANUP_LIST_ATTEMPTS)
  }
  {
    /* The orphan case: the create call failed, so there is no id — only the generated name. */
    const recovered = await confirm({ cloneId: null, branchName: name, listBranches: listing(project) })
    check(
      'with no id at all, the exact generated name recovers the orphan',
      recovered.status === CLEANUP_RESOLUTION.IDENTIFIED && recovered.target.id === 'br-clone' && recovered.matchedBy === 'name',
    )
    const late = await confirm({ cloneId: null, branchName: name, listBranches: listing([parentBranch], project) })
    check(
      'name recovery is retried too, for a listing that had not caught up',
      late.status === CLEANUP_RESOLUTION.IDENTIFIED && late.matchedBy === 'name' && late.attemptsMade === 2,
    )
    const never = await confirm({ cloneId: null, branchName: name, listBranches: listing([parentBranch]) })
    check('a name that never appears is UNCONFIRMED, not absent', never.status === CLEANUP_RESOLUTION.UNCONFIRMED && never.target === null)
  }
  {
    /* The recovered candidate is guarded before it is even nominated. */
    const impostorProject = [{ id: 'br-prod', name, default: true, primary: true }]
    const guarded = await confirm({ cloneId: null, branchName: name, listBranches: listing(impostorProject) })
    check(
      'a name match that IS the production parent is refused, not nominated',
      guarded.status === CLEANUP_RESOLUTION.AMBIGUOUS &&
        guarded.target === null &&
        has(guarded.problems, 'REFUSING to delete the production parent'),
    )
    const flagged = await confirm({
      cloneId: null,
      branchName: name,
      listBranches: listing([{ id: 'br-other', name, default: false, primary: true }]),
    })
    check(
      'a name match marked primary is refused before deletion is considered',
      flagged.status === CLEANUP_RESOLUTION.AMBIGUOUS && has(flagged.problems, 'marked default/primary'),
    )
    const misnamed = await confirm({
      cloneId: null,
      branchName: 'production',
      listBranches: listing(project),
    })
    check(
      'a name this tooling never generated may not drive recovery',
      misnamed.status === CLEANUP_RESOLUTION.AMBIGUOUS && misnamed.target === null,
    )
  }
  {
    /* Two facts that cannot both be true about one run's clone. */
    const conflicting = await confirm({
      cloneId: 'br-clone',
      branchName: name,
      listBranches: listing([parentBranch, { ...orphan, id: 'br-different' }]),
    })
    check(
      'a branch wearing the generated name but another id is a refusal, not a recovery',
      conflicting.status === CLEANUP_RESOLUTION.AMBIGUOUS &&
        conflicting.target === null &&
        has(conflicting.problems, 'Two branches cannot both be it'),
    )
    check('the conflicting refusal happens at once rather than after the bound', conflicting.attemptsMade === 1)

    const twins = await confirm({
      cloneId: null,
      branchName: name,
      listBranches: listing([parentBranch, orphan, { ...orphan, id: 'br-twin' }]),
    })
    check(
      'two branches sharing the generated name is a refusal that is never retried away',
      twins.status === CLEANUP_RESOLUTION.AMBIGUOUS && twins.attemptsMade === 1 && has(twins.problems, 'REFUSING'),
    )
    const duplicateIds = await confirm({ cloneId: 'br-clone', branchName: name, listBranches: listing([orphan, orphan]) })
    check(
      'two branches reporting one id is refused rather than re-listed',
      duplicateIds.status === CLEANUP_RESOLUTION.AMBIGUOUS && duplicateIds.attemptsMade === 1,
    )
  }
  {
    /* A control plane that errors, or answers with something that is not a list. */
    const broken = await confirm({
      cloneId: 'br-clone',
      branchName: name,
      listBranches: listing(new Error('502 Bad Gateway')),
    })
    check(
      'a listing that keeps failing ends UNCONFIRMED, and says why',
      broken.status === CLEANUP_RESOLUTION.UNCONFIRMED && has(broken.problems, '502 Bad Gateway'),
    )
    check('a failing listing is retried within the bound', broken.attemptsMade === CLEANUP_LIST_ATTEMPTS)

    const recovers = await confirm({
      cloneId: 'br-clone',
      branchName: name,
      listBranches: listing(new Error('502 Bad Gateway'), project),
    })
    check('a listing that fails once and then answers still finds the branch', recovers.status === CLEANUP_RESOLUTION.IDENTIFIED)

    const notAList = await confirm({ cloneId: 'br-clone', branchName: name, listBranches: listing(null) })
    check('a response that is not a branch list deletes nothing', notAList.status === CLEANUP_RESOLUTION.AMBIGUOUS && notAList.target === null)

    const noLister = await confirmCleanupTarget({ cloneId: 'br-clone', branchName: name, parentId: 'br-prod' })
    check(
      'no way to list branches at all is UNCONFIRMED rather than a shrug',
      noLister.status === CLEANUP_RESOLUTION.UNCONFIRMED && has(noLister.problems, 'Inspect the project by hand'),
    )
  }
  {
    /* The manual-recovery entry point has an id and no generated name. */
    const manual = await confirm({ cloneId: 'br-clone', branchName: undefined, listBranches: listing(project) })
    check('manual cleanup by id alone still works when the branch is listed', manual.status === CLEANUP_RESOLUTION.IDENTIFIED && manual.matchedBy === 'id')
    const manualMissing = await confirm({ cloneId: 'br-gone', branchName: undefined, listBranches: listing(project) })
    check(
      'manual cleanup of an id nobody lists is UNCONFIRMED, so it exits non-zero',
      manualMissing.status === CLEANUP_RESOLUTION.UNCONFIRMED && has(manualMissing.problems, 'no generated name'),
    )
  }
  {
    const waits = []
    await confirmCleanupTarget({
      cloneId: 'br-clone',
      branchName: name,
      parentId: 'br-prod',
      listBranches: listing([parentBranch]),
      wait: async (ms) => {
        waits.push(ms)
      },
    })
    check('a delay separates the re-listings, and none precedes the first', waits.length === CLEANUP_LIST_ATTEMPTS - 1 && waits.every((ms) => ms > 0))
  }

  check(
    'the runner confirms its target through the bounded resolver, not a single listing',
    runnerSource.includes('await confirmCleanupTarget({') && countOf(runnerSource, 'confirmCleanupTarget(') === 1,
  )
  check('the bounded resolver is layered on the single-snapshot resolution', coreSource.includes('resolveCleanupTarget({ cloneId: knownId, branchName, branches })'))
  check(
    'the runner no longer announces that a branch is gone on the strength of one listing',
    !/if\s*\(\s*resolution\.status\s*===\s*CLEANUP_RESOLUTION\.ABSENT\s*\)/.test(runnerSource) &&
      !/\bnote\s*\([^)]*no longer exists/.test(runnerSource),
  )
  check(
    'an unconfirmed cleanup fails the run and sends a person to look',
    /resolution\.status === CLEANUP_RESOLUTION\.UNCONFIRMED\) \{\s*\n\s*stop\(/.test(runnerSource) &&
      runnerSource.includes('inspect the project by hand'),
  )
  check('cleanup is handed the parent id, so a recovered candidate is guarded on the way out', /confirmCleanupTarget\(\{[\s\S]*?parentId,\s*listBranches:\s*\(\)\s*=>\s*listBranches\(apiKey,\s*projectId\)/.test(runnerSource))

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
  const trace = async ({ beginThrows, bodyThrows, rollbackThrows, releaseThrows } = {}) => {
    const order = []
    const step = (name, throws) => async () => {
      order.push(name)
      if (throws) throw new Error(`${name} failed`)
      return name
    }
    let thrown = null
    let error = null
    try {
      await withProbeTransaction({
        begin: step('begin', beginThrows),
        body: step('body', bodyThrows),
        rollback: step('rollback', rollbackThrows),
        release: step('release', releaseThrows),
      })
    } catch (caught) {
      error = caught
      thrown = caught.message
    }
    return {
      order: order.join(','),
      thrown,
      cause: error?.cause?.message ?? null,
      aggregated: (error?.errors ?? []).map((e) => e.message).join(','),
    }
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
  check('the probe failure that caused the unwind is kept as the cause, not discarded', bothFailed.cause === 'body failed')

  const beginFailed = await trace({ beginThrows: true })
  check('a transaction that never began is not rolled back', beginFailed.order === 'begin,release')
  check('a failure to begin propagates, and the connection is still released', beginFailed.thrown === 'begin failed')

  /*
   * THE RELEASE MUST NOT BURY THE ROLLBACK.
   *
   * `try { rollback() } finally { release() }` means that when both fail, the
   * release's error is the one that leaves the function — so the terminal would
   * have shown "the connection could not be returned to the pool" where "the
   * probe rows may still be in this database" belonged. That is the more
   * alarming of the two failures being replaced by the less alarming one.
   */
  const rollbackAndRelease = await trace({ rollbackThrows: true, releaseThrows: true })
  check('rollback is still attempted before the release when both will fail', rollbackAndRelease.order === 'begin,body,rollback,release')
  check('a rollback failure is not replaced by a release failure', rollbackAndRelease.thrown.startsWith('rollback failed'))
  check('the release failure is not lost either — both are named', rollbackAndRelease.thrown === 'rollback failed; additionally, release failed')
  check('both failures are carried as errors, rollback first', rollbackAndRelease.aggregated === 'rollback failed,release failed')

  const allThree = await trace({ bodyThrows: true, rollbackThrows: true, releaseThrows: true })
  check('body, rollback and release all failing still runs every step in order', allThree.order === 'begin,body,rollback,release')
  check('the rollback failure still leads when all three fail', allThree.thrown === 'rollback failed; additionally, release failed')
  check('and the original probe failure is still recoverable from the cause', allThree.cause === 'body failed')

  const releaseOnly = await trace({ releaseThrows: true })
  check('a release failure alone fails the rehearsal rather than passing quietly', releaseOnly.thrown === 'release failed')
  check('the successful rollback still happened before it', releaseOnly.order === 'begin,body,rollback,release')
  check('a lone release failure carries no invented cause', releaseOnly.cause === null && releaseOnly.aggregated === 'release failed')

  const beginAndRelease = await trace({ beginThrows: true, releaseThrows: true })
  check('a transaction that never began is still not rolled back when the release fails too', beginAndRelease.order === 'begin,release')
  check('the release failure fails the run', beginAndRelease.thrown === 'release failed')
  check('the begin failure is preserved as the cause', beginAndRelease.cause === 'begin failed')

  check(
    'the core collects cleanup failures instead of letting one overwrite the other',
    coreSource.includes('const cleanupFailures = []') && coreSource.includes('new AggregateError('),
  )
  check(
    'the rollback and the release are each caught, so neither can skip the other',
    /catch \(error\) \{\s*\n\s*rollbackError = asError\(error\)/.test(coreSource) &&
      /catch \(error\) \{\s*\n\s*releaseError = asError\(error\)/.test(coreSource),
  )

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

  /*
   * THE EXHAUSTIVE CHECK MUST SEE NULL.
   *
   * `kind <> 'image'` is not a check for "every row is 'image'". A comparison
   * against NULL is NULL, never true, so that predicate counts zero rows on a
   * table where the backfill left every `kind` NULL — the single outcome the
   * check exists to catch — and the rehearsal would then have printed "the media
   * backfill covered every row" about a column full of nulls.
   */
  check('the media check uses the null-safe predicate', MEDIA_NON_IMAGE_PREDICATE_SQL === `"kind" is distinct from 'image'`)
  check(
    'it is not the inequality that cannot see NULL',
    !MEDIA_BACKFILL_QUERY.includes("<> 'image'") &&
      !MEDIA_BACKFILL_QUERY.includes("!= 'image'") &&
      MEDIA_BACKFILL_QUERY.includes('is distinct from'),
  )
  check(
    'it still counts rows of media, as an integer, and nothing else',
    MEDIA_BACKFILL_QUERY.includes('count(*)::int as n') && MEDIA_BACKFILL_QUERY.includes('from media where'),
  )
  check('a NULL kind counts as a row that did not backfill', isNonImageKind(null) === true)
  check('a missing kind counts too, rather than being read as absent', isNonImageKind(undefined) === true)
  check("only the exact value 'image' is a backfilled row", isNonImageKind('image') === false)
  check(
    'any other value counts, including the empty string and a different case',
    isNonImageKind('video') === true && isNonImageKind('') === true && isNonImageKind('Image') === true,
  )
  check(
    'the runner runs the core query rather than one of its own',
    runnerSource.includes('await query(MEDIA_BACKFILL_QUERY)') && !runnerSource.includes("kind <> 'image'"),
  )
  check(
    'the success line no longer claims only non-image values were looked for',
    runnerSource.includes("rows have a kind that is NULL or ") && runnerSource.includes("anything other than 'image'"),
  )

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
  check(
    'the report says HOW the digest is unambiguous, rather than asserting that it is',
    report.includes('length-framed') && report.includes('boundaries are lengths rather than delimiter bytes'),
  )
  check(
    'the report distinguishes NULL from the empty string in words as well as in bytes',
    report.includes('NULL and the empty string encode differently'),
  )
  check(
    'the report claims nothing about bytes it never read',
    !report.includes('no value can forge') && !/every column/i.test(report),
  )
  check('the runner no longer prints the old universal claim', !runnerSource.includes('every carried row is byte-identical'))
  check('the runner prints the built report rather than a hand-written sentence', runnerSource.includes('ok(describeCarriedEvidence(after))'))

  const usersSql = buildRowDigestQuery({ table: 'users', columns: [...CARRIED_DIGEST_COLUMNS.users] })
  check(
    'every digested column is framed by its own length, and NULL is a tag rather than a value',
    CARRIED_DIGEST_COLUMNS.users.every((column) => usersSql.includes(digestFieldSql(column))),
  )
  check(
    'the nullable columns that used to vanish from the digest are the ones being covered',
    CARRIED_DIGEST_COLUMNS.users.includes('email') && CARRIED_DIGEST_COLUMNS.media.includes('alt_text'),
  )
  check('the digest is ordered deterministically', usersSql.includes('order by "id"'))
  check('the digest reports how many rows it covered', usersSql.includes('count(*)::int as n'))
  check('an empty table digests to a stable value rather than null', usersSql.includes("'empty'"))
  check(
    'no field or row boundary is a byte the data could contain',
    !usersSql.includes('chr(1)') &&
      !usersSql.includes('chr(2)') &&
      !usersSql.includes('chr(3)') &&
      !usersSql.includes('concat_ws'),
  )

  /* ---- the encoding, proved rather than asserted --------------------------- */
  check('a NULL field and an empty string field are different encodings', encodeDigestField(null) === 'N:' && encodeDigestField('') === 'S0:')
  check('the NULL tag in SQL is the same tag the model uses', DIGEST_NULL_FIELD_SQL === "'N:'" && encodeDigestField(null) === 'N:')
  check('a value is framed by its own length', encodeDigestField('abc') === 'S3:abc')
  check('a row is framed by its own length too, so no row separator is needed', encodeDigestRow(['a']) === 'R4:S1:a')
  check('the SQL frames rows the same way the model does', usersSql.includes(`'R' || length("row_body") || ':' || "row_body"`))
  check('the SQL aggregates with no delimiter at all, because the frames are the boundaries', usersSql.includes(", '' order by"))

  {
    /*
     * THE CORPUS IS THE POINT. `chr(1)`, `chr(2)` and `chr(3)` were asserted to
     * be impossible in PostgreSQL text; they are not — every code point except
     * U+0000 is storable, and so are the old sentinel and the new tags. A digest
     * whose boundaries are bytes can be forged with any of them; a digest whose
     * boundaries are lengths cannot, and the round trip is the proof.
     *
     * They appear twice over: as the raw code points written into the literals
     * below, and again built with String.fromCharCode just after them, so that
     * an editor which hides such characters or a tool which rewrites them cannot
     * quietly weaken this test.
     */
    const hostileValues = [
      null,
      '',
      'ordinary',
      '',
      '',
      '',
      'NULL',
      'N:',
      'S3:abc',
      'R4:S1:a',
      ':',
      '::::',
      'abc',
      'line\nbreak\ttab',
      '12:34',
      'S',
      'N',
      '999:',
      'value with spaces',
      "quote'and\"double",
      '',
      '',
      '',
      'NULL',
      'columnrow',
      'beforeafter',
      'bellunit',
    ]
    /* Built rather than typed, so no editor or normaliser can turn them into something else. */
    const chr = (code) => String.fromCharCode(code)
    const controlValues = [
      chr(1),
      chr(2),
      chr(3),
      chr(1) + 'NULL',
      'a' + chr(2) + 'b' + chr(3) + 'c',
      chr(7) + chr(27) + chr(31),
      'S3:' + chr(2) + 'abc',
    ]
    const corpus = [...hostileValues, ...controlValues]

    const rows = [corpus, [null, null, null, null], ['', '', '', ''], corpus.slice().reverse()]
    const encoded = encodeDigestRows(rows)
    const decoded = decodeDigestRows(encoded)
    check(
      'chr(1), chr(2) and chr(3) are ordinary content, not boundaries',
      [1, 2, 3].every((code) => decodeDigestRows(encodeDigestRow([chr(code)]))[0][0] === chr(code)),
    )
    check(
      'a value carrying chr(2) and chr(3) cannot split itself into more fields or rows',
      decodeDigestRows(encodeDigestRow(['a' + chr(2) + 'b' + chr(3) + 'c'])).length === 1 &&
        decodeDigestRows(encodeDigestRow(['a' + chr(2) + 'b' + chr(3) + 'c']))[0].length === 1,
    )
    check(
      'the old chr(1) sentinel, as data, is still not NULL',
      encodeDigestField(chr(1) + 'NULL') !== encodeDigestField(null),
    )
    check(
      'every control character, delimiter-like value, NULL and empty string round-trips exactly',
      JSON.stringify(decoded) === JSON.stringify(rows.map((row) => row.map((v) => (v === null ? null : String(v))))),
    )
    check('the round trip preserves the row count', decoded.length === rows.length)
    check('the round trip preserves each row\'s field count', decoded.every((row, i) => row.length === rows[i].length))
    check('an empty table encodes to an empty string, and back to no rows', encodeDigestRows([]) === '' && decodeDigestRows('').length === 0)

    /* Field boundaries cannot be moved by field contents. */
    check(
      'a value that looks like a NULL tag is not read as NULL',
      encodeDigestField('N:') !== encodeDigestField(null) && decodeDigestRows(encodeDigestRow(['N:']))[0][0] === 'N:',
    )
    check(
      'a value that looks like a framed field is not read as one',
      decodeDigestRows(encodeDigestRow(['S3:abc']))[0][0] === 'S3:abc',
    )
    check(
      'the old chr(1) NULL sentinel is now just text, and distinguishable from NULL',
      encodeDigestField('NULL') !== encodeDigestField(null),
    )
    check(
      'two rows cannot be made to look like one by their contents',
      encodeDigestRows([['a', 'b']]) !== encodeDigestRows([['a'], ['b']]),
    )
    check(
      'a field cannot absorb the field after it',
      encodeDigestRows([['ab', 'c']]) !== encodeDigestRows([['a', 'bc']]),
    )
    check(
      'a field cannot absorb the row after it',
      encodeDigestRows([['ab'], ['c']]) !== encodeDigestRows([['a'], ['bc']]),
    )
    check(
      'NULL, the empty string, and the string "NULL" are three different things',
      new Set([encodeDigestField(null), encodeDigestField(''), encodeDigestField('NULL')]).size === 3,
    )
    check(
      'the same values in a different order encode differently, so ordering still matters',
      encodeDigestRows([['a'], ['b']]) !== encodeDigestRows([['b'], ['a']]),
    )

    const malformed = (input) => {
      try {
        decodeDigestRows(input)
        return false
      } catch {
        return true
      }
    }
    check('a truncated frame is refused rather than guessed at', malformed('R9:S1:a'))
    check('an unknown row tag is refused', malformed('X4:S1:a'))
    check('a length that is not a count is refused', malformed('Rx:S1:a'))
    check('a non-string digest input is refused', malformed(null))
  }

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

/* ================================ 20. THE REPOSITORY, NOT THE CALLER'S CWD = */
section('[20] Every path is derived from the module, so the launch directory cannot change the run')

{
  /*
   * WHY THIS IS A CORRECTNESS PROBLEM AND NOT A CONVENIENCE ONE.
   *
   * Relative paths made the run depend on where the shell happened to be. From
   * the folder above this checkout — `…/GitHub/CloudMarket/cloud-market-ai-team`,
   * or any unrelated directory — `readFileSync('drizzle/meta/_journal.json')`
   * misses, and the rehearsal reports that the repository does not describe its
   * migration stack when the repository is perfectly intact. Worse, the child
   * `drizzle-kit migrate` inherited that same directory, so it resolved
   * `drizzle.config.ts`, the migrations folder and the journal from wherever the
   * operator was standing rather than from the twenty files this run hashed.
   *
   * The root is a fact about this file's own location: `<repo>/scripts/…`, one
   * level up. It is derived here exactly as the runner derives it, and then USED
   * to read the journal, so the derivation is proved rather than described.
   */
  const derivedRoot = fileURLToPath(new URL('../', new URL('./rehearse-migration-branch.mjs', import.meta.url)))
  check('the derived root is an absolute path', /^(?:[a-zA-Z]:[\\/]|\/)/.test(derivedRoot))
  check(
    'the derived root really is this repository — the committed journal is there',
    readFileSync(`${derivedRoot}drizzle/meta/_journal.json`).toString() === repoFile('drizzle/meta/_journal.json'),
  )
  check(
    'and so are the migration files the run hashes',
    readFileSync(`${derivedRoot}drizzle/0018_strain_leaning_types.sql`).toString() ===
      repoFile('drizzle/0018_strain_leaning_types.sql'),
  )
  check(
    'the runner, the core and this verifier all resolve to the same repository root',
    derivedRoot === fileURLToPath(new URL('../', import.meta.url)) &&
      derivedRoot === fileURLToPath(new URL('../', new URL('./rehearse-migration-branch-core.mjs', import.meta.url))),
  )
  check(
    'the derived root is a directory the run can read from wherever it was launched, because it is not relative',
    !/^\.\.?[\\/]/.test(derivedRoot) && derivedRoot.length > 1,
  )

  check(
    'the runner derives its root from import.meta.url, not from where it was launched',
    runnerSource.includes("const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))"),
  )
  check('the runner never consults the current working directory', !runnerSource.includes('process.cwd()'))
  check(
    'the journal is read by absolute path, not by a relative literal',
    runnerSource.includes("join(REPO_ROOT, 'drizzle', 'meta', '_journal.json')") &&
      !runnerSource.includes("'drizzle/meta/_journal.json'"),
  )
  check(
    'each migration file is read by absolute path too',
    runnerSource.includes("join(REPO_ROOT, 'drizzle', `${tag}.sql`)") && !runnerSource.includes('`drizzle/${tag}.sql`'),
  )
  check(
    'the one migrate child process is given the repository as its cwd',
    /gate\.run\('npx', \['drizzle-kit', 'migrate'\], \{[\s\S]{0,1500}?cwd: REPO_ROOT,/.test(runnerSource),
  )
  check(
    'the migrate invocation is still exactly one gated npx drizzle-kit migrate',
    countOf(runnerSource, "gate.run('npx', ['drizzle-kit', 'migrate']") === 1 && countOf(runnerSource, 'gate.run(') === 1,
  )
  check(
    'cwd does not become a new way to point the command somewhere else',
    countOf(runnerSource, 'cwd:') === 1 && !runnerSource.includes('cwd: process'),
  )
  check(
    'the paths the runner reads are all built from the derived root',
    [...runnerSource.matchAll(/readFileSync\(([^)]*)\)/g)].every((m) => /JOURNAL_PATH|migrationPath\(/.test(m[1])),
  )
  check(
    'this verifier reads the repository the same way, from its own module URL',
    verifierSource.includes("readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)))"),
  )
  check(
    'the core, which decides everything, has no notion of a path or a directory at all',
    importsOf(coreSource).join(',') === './environment-fingerprints.mjs,node:crypto' &&
      !coreSource.includes('import.meta.url') &&
      !coreSource.includes('process.cwd()') &&
      !coreSource.includes('REPO_ROOT') &&
      !coreSource.includes('JOURNAL_PATH') &&
      !coreSource.includes('migrationPath'),
  )
}

/* ============ 21. DELETION FAILS CLOSED ON DEFAULT/PRIMARY METADATA ======= */
section('[21] Deletion is permitted only on metadata that PROVES the branch is neither default nor primary')

{
  /*
   * THE BUG THIS CLOSES.
   *
   * The guard asked `target.default === true || target.primary === true`, which
   * is a test for "the control plane said yes". Every other answer — the flag
   * omitted from the listing, `null`, the STRING "false", `0`, an object — fell
   * through as permission, and the call on the other side of that permission
   * deletes a Neon branch. The safety-critical reading is the opposite one:
   * deletion requires both flags to be literally `false`, and anything else is
   * unproven and therefore refused.
   *
   * `interpretBranchFlag` is the same strict reading that admits the clone at
   * creation time, so there is one definition of "provably not production"
   * rather than two that can drift apart.
   */
  const name = `${REHEARSAL_BRANCH_PREFIX}0016-0019-1770000000123`
  const deletable = { id: 'br-clone', name, default: false, primary: false }
  const guard = (over) =>
    evaluateDeletionGuard({ target: { ...deletable, ...over }, parentId: 'br-prod', expectedName: name })
  const unproven = (over, flag) => {
    const { problems } = guard(over)
    return problems.length > 0 && has(problems, `does not explicitly report "${flag}": false`)
  }

  check('explicit false/false is metadata that permits deletion', guard({}).problems.length === 0)
  check(
    'and it is the ONLY shape that does — a proven negative, both flags, literally false',
    guard({}).problems.length === 0 &&
      guard({ default: undefined }).problems.length === 1 &&
      guard({ primary: undefined }).problems.length === 1,
  )
  check('a branch reporting default: true may never be deleted', has(guard({ default: true }).problems, 'marked default/primary'))
  check('a branch reporting primary: true may never be deleted', has(guard({ primary: true }).problems, 'marked default/primary'))
  check('a branch reporting both flags true is refused once for each', guard({ default: true, primary: true }).problems.length === 2)

  check(
    'a listing that omits "default" entirely is refused, not read as false',
    evaluateDeletionGuard({ target: { id: 'br-clone', name, primary: false }, parentId: 'br-prod', expectedName: name })
      .problems.length === 1,
  )
  check(
    'a listing that omits "primary" entirely is refused too',
    has(
      evaluateDeletionGuard({ target: { id: 'br-clone', name, default: false }, parentId: 'br-prod', expectedName: name })
        .problems,
      'does not explicitly report "primary": false',
    ),
  )
  check(
    'metadata carrying no flags at all is refused twice over, once per flag',
    evaluateDeletionGuard({ target: { id: 'br-clone', name }, parentId: 'br-prod', expectedName: name }).problems.length === 2,
  )

  check('an explicitly undefined flag is not a false', unproven({ default: undefined }, 'default') && unproven({ primary: undefined }, 'primary'))
  check('a null flag is not a false', unproven({ default: null }, 'default') && unproven({ primary: null }, 'primary'))
  check('the STRING "false" is not a false', unproven({ default: 'false' }, 'default') && unproven({ primary: 'false' }, 'primary'))
  check('the string "true" is unproven rather than merely not-true', unproven({ default: 'true' }, 'default'))
  check('the empty string is not a false', unproven({ default: '' }, 'default'))
  check('the number 0 is not a false', unproven({ default: 0 }, 'default') && unproven({ primary: 0 }, 'primary'))
  check('the number 1 is not a false either', unproven({ primary: 1 }, 'primary'))
  check('NaN is not a false', unproven({ default: NaN }, 'default'))
  check('an object or an array in a flag is refused', unproven({ default: {} }, 'default') && unproven({ primary: [] }, 'primary'))
  check('a boxed Boolean object is not a primitive false', unproven({ default: Object(false) }, 'default'))
  check(
    'no truthiness is consulted anywhere: every non-boolean is refused whatever it coerces to',
    [undefined, null, '', 'false', 'true', 0, 1, NaN, {}, [], Object(false)].every(
      (value) => guard({ default: value }).problems.length > 0 && guard({ primary: value }).problems.length > 0,
    ),
  )
  check(
    'the refusal names the flag it could not prove, so an operator knows what to look at',
    has(guard({ default: null }).problems, '"default": false') && has(guard({ primary: null }).problems, '"primary": false'),
  )
  check('the refusal reports the value it was actually given', has(guard({ default: null }).problems, 'it reports null'))
  check(
    'an unproven flag refuses on its own, even when the id, the name and the parent are all correct',
    guard({ default: undefined }).problems.length === 1 && has(guard({ default: undefined }).problems, 'REFUSING'),
  )

  /* The reading itself, and the fact that both ends of the branch's life share it. */
  check('only a literal true reads as set', interpretBranchFlag(true) === 'set')
  check('only a literal false reads as clear', interpretBranchFlag(false) === 'clear')
  check(
    'everything else reads as ambiguous rather than as either',
    [undefined, null, '', 'false', 'true', 0, 1, NaN, {}, [], Object(false)].every(
      (value) => interpretBranchFlag(value) === 'ambiguous',
    ),
  )
  check('the deletion guard uses that reading rather than a second, weaker one', coreSource.includes('interpretBranchFlag(target[flag])'))
  check('the clone admission at creation time uses the same reading', coreSource.includes('interpretBranchFlag(clone[flag])'))
  check(
    'the old "not literally true is good enough" test is gone',
    !coreSource.includes('target.default === true || target.primary === true'),
  )

  /*
   * THE SAME GUARD ON ALL THREE ROADS TO A DELETE: ordinary cleanup, orphan
   * recovery by the generated name, and the manual `--cleanup` entry point.
   */
  const parentBranch = { id: 'br-prod', name: 'production', default: true, primary: true }
  const flagless = { id: 'br-clone', name, parent_id: 'br-prod' }
  const lister = (branches) => async () => branches
  const noWait = async () => {}
  const confirmWith = (input) =>
    confirmCleanupTarget({ parentId: 'br-prod', attempts: CLEANUP_LIST_ATTEMPTS, wait: noWait, ...input })

  {
    const ordinary = await confirmWith({
      cloneId: 'br-clone',
      branchName: name,
      listBranches: lister([parentBranch, { ...flagless, default: false, primary: false }]),
    })
    check(
      'ordinary cleanup of a fully-attested clone still identifies it',
      ordinary.status === CLEANUP_RESOLUTION.IDENTIFIED && ordinary.target.id === 'br-clone',
    )

    const incomplete = await confirmWith({
      cloneId: 'br-clone',
      branchName: name,
      listBranches: lister([parentBranch, flagless]),
    })
    check(
      'ordinary cleanup of a clone whose flags the listing omitted deletes nothing',
      incomplete.status === CLEANUP_RESOLUTION.AMBIGUOUS &&
        incomplete.target === null &&
        has(incomplete.problems, 'does not explicitly report "default": false'),
    )
  }
  {
    /* The orphan road: no id at all, recovered by the exact generated name. */
    const recovered = await confirmWith({
      cloneId: null,
      branchName: name,
      listBranches: lister([parentBranch, flagless]),
    })
    check(
      'a recovered exact-name candidate with incomplete flag metadata is refused, not nominated',
      recovered.status === CLEANUP_RESOLUTION.AMBIGUOUS &&
        recovered.target === null &&
        has(recovered.problems, 'does not explicitly report'),
    )
    const nulled = await confirmWith({
      cloneId: null,
      branchName: name,
      listBranches: lister([parentBranch, { ...flagless, default: null, primary: false }]),
    })
    check(
      'a recovered candidate reporting a null flag is refused as unproven',
      nulled.status === CLEANUP_RESOLUTION.AMBIGUOUS && has(nulled.problems, 'does not explicitly report "default": false'),
    )
    const attested = await confirmWith({
      cloneId: null,
      branchName: name,
      listBranches: lister([parentBranch, { ...flagless, default: false, primary: false }]),
    })
    check(
      'a recovered candidate that DOES attest both flags is still recoverable',
      attested.status === CLEANUP_RESOLUTION.IDENTIFIED && attested.matchedBy === 'name',
    )
  }
  {
    /* The manual road: `--cleanup=<id>`, which has an id and no generated name. */
    const manual = await confirmWith({
      cloneId: 'br-clone',
      branchName: undefined,
      listBranches: lister([parentBranch, flagless]),
    })
    check(
      'manual --cleanup recovery refuses a branch whose flags are not proved false',
      manual.status === CLEANUP_RESOLUTION.AMBIGUOUS && manual.target === null,
    )
    const manualAttested = await confirmWith({
      cloneId: 'br-clone',
      branchName: undefined,
      listBranches: lister([parentBranch, { ...flagless, default: false, primary: false }]),
    })
    check(
      'manual --cleanup recovery of an attested clone still works',
      manualAttested.status === CLEANUP_RESOLUTION.IDENTIFIED && manualAttested.matchedBy === 'id',
    )
  }
  check(
    'no candidate is ever returned as deletable without the guard having seen it first',
    coreSource.includes('const guard = evaluateDeletionGuard({ target: candidate, parentId, expectedName: branchName })'),
  )
  check(
    'and the runner guards again at the moment of deletion, after resolution',
    runnerSource.includes('const { problems } = evaluateDeletionGuard({ target, parentId, expectedName: branchName })') &&
      runnerSource.indexOf('evaluateDeletionGuard(') < runnerSource.indexOf("{ method: 'DELETE' }"),
  )
}

/* ========== 22. THE RUNNER NAMES ITSELF BY MODULE PATH, NOT BY CWD ======== */
section('[22] The runner names itself from its own module URL, so recovery instructions work from anywhere')

{
  /*
   * WHY A RELATIVE SELF WAS A REAL DEFECT.
   *
   * `SELF` is printed in exactly two places, and both are instructions an
   * operator is meant to act on immediately: the "NEON_API_KEY is not set" usage
   * line, and — far more importantly — the manual recovery command printed when
   * a rehearsal branch could NOT be deleted, i.e. when a byte-for-byte copy of
   * production may still be sitting in Neon. `scripts/rehearse-migration-branch.mjs`
   * is a valid command only from the repository root; run from `scripts/`, from
   * a sibling checkout, or from a CI step with a different working directory, it
   * names a file that is not there.
   *
   * The fix is the same one already applied to REPO_ROOT: a path derived from
   * `import.meta.url`, which is a property of the module and not of the shell.
   */
  const derivedRoot = fileURLToPath(new URL('../', import.meta.url))
  const selfUrl = new URL('./rehearse-migration-branch.mjs', import.meta.url)
  const derivedSelf = fileURLToPath(selfUrl)

  check('the runner derives SELF from its own module URL', runnerSource.includes('const SELF = fileURLToPath(import.meta.url)'))
  check(
    'the relative literal that assumed a launch directory is gone',
    !runnerSource.includes("SELF = 'scripts/rehearse-migration-branch.mjs'") && !/const SELF = ['"`]/.test(runnerSource),
  )
  check(
    'SELF is not overridable by a flag, an argument, or a variable',
    !/SELF\s*=\s*[^\n]*(?:flag\(|process\.argv|process\.env)/.test(runnerSource),
  )
  check(
    'SELF consults no working directory, here or anywhere else in the runner',
    !runnerSource.includes('process.cwd()') && !/SELF\s*=\s*[^\n]*cwd/i.test(runnerSource),
  )
  check('the derivation yields an absolute path', /^(?:[a-zA-Z]:[\\/]|\/)/.test(derivedSelf))
  check(
    'and never a relative one, which is what made the old value directory-dependent',
    !/^\.\.?[\\/]/.test(derivedSelf) &&
      !derivedSelf.startsWith('scripts') &&
      !/^(?:[a-zA-Z]:[\\/]|\/)/.test('scripts/rehearse-migration-branch.mjs'),
  )
  check('the path it derives IS the runner, byte for byte', readFileSync(derivedSelf).toString() === runnerSource)
  check(
    'the runner sits under the same derived repository root the migrations are read from',
    selfUrl.href === new URL('scripts/rehearse-migration-branch.mjs', new URL('../', import.meta.url)).href &&
      derivedSelf.startsWith(derivedRoot),
  )

  /*
   * THE PROPERTY, EXERCISED RATHER THAN DESCRIBED.
   *
   * The derivation is re-run from three different working directories — the
   * repository root, `scripts/`, and wherever this process was actually started
   * — and must produce one identical absolute path. The original directory is
   * restored in a `finally`, and nothing is written anywhere.
   */
  let derivations = []
  const originalCwd = process.cwd()
  try {
    for (const directory of [derivedRoot, `${derivedRoot}scripts`, originalCwd]) {
      process.chdir(directory)
      derivations.push(fileURLToPath(new URL('./rehearse-migration-branch.mjs', import.meta.url)))
    }
  } catch {
    derivations = []
  } finally {
    process.chdir(originalCwd)
  }
  check(
    'the same derivation from three different working directories yields one identical path',
    derivations.length === 3 && new Set(derivations).size === 1 && derivations[0] === derivedSelf,
  )
  check('and the process was left in the directory it started in', process.cwd() === originalCwd)

  check(
    'the manual recovery instruction interpolates that module-derived path',
    /Remove it by hand: node "\$\{SELF\}" --cleanup=/.test(runnerSource),
  )
  check(
    'the recovery instruction is not a relative command that only works from the repository root',
    !/Remove it by hand: node scripts\//.test(runnerSource) && !/Remove it by hand: node \$\{SELF\}/.test(runnerSource),
  )
  check('the usage line an operator is given names the runner the same way', countOf(runnerSource, 'requireApiKey(SELF)') === 2)
  check(
    'the manual --cleanup entry point is told the same path as the full run',
    /async function cleanupOnly\([\s\S]*?requireApiKey\(SELF\)/.test(runnerSource),
  )
  check(
    'nothing in the runner still names the runner by a quoted relative path',
    !/['"`]scripts\/rehearse-migration-branch\.mjs['"`]/.test(runnerSource),
  )
}

/* ===== 23. THE ONE 0018 EQUIVALENCE EXCEPTION, AND EVERY WAY IT REFUSES === */
section('[23] Pre-existing 0018 values reconcile only when every condition is independently proven')

{
  /*
   * WHAT THIS SECTION IS ABOUT, AND WHAT IT IS NOT.
   *
   * Section [5] proves the general rule and keeps proving it: an object that
   * exists while its migration is unrecorded is blocking drift, never evidence.
   * Nothing here weakens that. What is added is one narrowly scoped, fully
   * proved reconciliation — the confirmed `strain_type.hybrid_i` /
   * `strain_type.hybrid_s` state — and the point of the section is the refusals:
   * every neighbouring state, differing by one label, one position, one object,
   * one ledger row, one statement, or one unread catalog answer, must still
   * block.
   *
   * The accepted fixture is deliberately not a fixture at all: it is the
   * committed 0018 file, the real declared-object inventory, and the real drift
   * evaluation of a clone carrying exactly those two values.
   */
  const source0018 = sources[STRAIN_EQUIVALENCE_TAG]
  const strainKeys = STRAIN_LEANING_VALUES.map((value) => objectKey.enumValue('strain_type', value))
  const preExisting = inventory.filter((object) => strainKeys.includes(object.key))
  const unrelated = inventory.find((object) => object.key === objectKey.table('marketplace_access'))
  const orderedRows = STRAIN_TYPE_EXPECTED_ORDER.map((label) => ({ label }))
  const rowsOf = (...labels) => labels.map((label) => ({ label }))

  const accepted = () => ({
    recordedTags: [...RECORDED_TAGS],
    pendingTags: [...PENDING_TAGS],
    driftPresent: preExisting,
    source: source0018,
    strainTypeRows: orderedRows,
  })
  const evaluate = (over = {}) => evaluateStrainLeaningEquivalence({ ...accepted(), ...over })
  const refuses = (over, fragment) => {
    const result = evaluate(over)
    return (
      result.equivalent === false &&
      result.problems.length > 0 &&
      (fragment === undefined || has(result.problems, fragment))
    )
  }

  /** One `ALTER TYPE … ADD VALUE …` statement, varied one property at a time. */
  const alterStatement = ({
    type = '"public"."strain_type"',
    guard = 'IF NOT EXISTS ',
    value = 'hybrid_i',
    tail = "BEFORE 'cbd'",
  } = {}) => `ALTER TYPE ${type}\nADD VALUE ${guard}'${value}'${tail === '' ? '' : ` ${tail}`};`
  const pair = (first, second) => `${first}\n--> statement-breakpoint\n${second}`
  const secondStatement = alterStatement({ value: 'hybrid_s' })

  /* ---- the accepted state, and the fact that it is the real one --------- */
  const proven = evaluate()
  check(
    'the exact accepted equivalence state is accepted',
    proven.equivalent === true && proven.problems.length === 0,
    proven.problems.join('; '),
  )
  check(
    'all five proofs are established independently, and all five are required',
    Object.keys(proven.proofs).length === 5 && Object.values(proven.proofs).every((proved) => proved === true),
  )
  check(
    'the accepted state is built from the committed 0018 and the real declared inventory',
    source0018 === repoFile('drizzle/0018_strain_leaning_types.sql') &&
      preExisting.length === 2 &&
      preExisting.every((object) => object.tag === STRAIN_EQUIVALENCE_TAG && object.conflictKind === 'silent'),
  )
  check(
    'the exception is scoped to 0018 and to no other migration',
    STRAIN_EQUIVALENCE_TAG === '0018_strain_leaning_types' && PENDING_TAGS.includes(STRAIN_EQUIVALENCE_TAG),
  )
  check(
    'the required enum sequence is the complete six, in that order',
    STRAIN_TYPE_EXPECTED_ORDER.join(',') === 'indica,sativa,hybrid,hybrid_i,hybrid_s,cbd',
  )
  check(
    'the permitted 0018 semantics are exactly two idempotent BEFORE-cbd additions',
    STRAIN_EQUIVALENCE_OPERATIONS.length === 2 &&
      STRAIN_EQUIVALENCE_OPERATIONS.every(
        (operation) =>
          operation.schema === 'public' &&
          operation.type === 'strain_type' &&
          operation.ifNotExists === true &&
          operation.position === 'before' &&
          operation.anchor === 'cbd',
      ) &&
      STRAIN_EQUIVALENCE_OPERATIONS[0].value === 'hybrid_i' &&
      STRAIN_EQUIVALENCE_OPERATIONS[1].value === 'hybrid_s',
  )
  check(
    'an operation is described as the statement it stands for, so a refusal can name it',
    describeAddValueOperation(STRAIN_EQUIVALENCE_OPERATIONS[0]) ===
      "ALTER TYPE public.strain_type ADD VALUE IF NOT EXISTS 'hybrid_i' BEFORE 'cbd'",
  )
  check(
    'the exception describes what it proved only when it actually proved it',
    describeStrainLeaningEquivalence(proven).length === 5 &&
      describeStrainLeaningEquivalence(evaluate({ strainTypeRows: null })).length === 0 &&
      describeStrainLeaningEquivalence(undefined).length === 0,
  )

  /* ---- the general rule still reports it, and still calls it drift ------ */
  const drifted = evaluateDrift({
    inventory,
    recordedTags: RECORDED_TAGS,
    observedKeys: observe({ enumValues: STRAIN_LEANING_VALUES.map((value) => ({ type: 'strain_type', value })) }).keys,
  })
  check(
    'the real drift evaluation of this state still reports both objects',
    drifted.problems.length === 2 && drifted.present.length === 2,
  )
  check(
    'and still says they are drift that is never evidence a migration was applied',
    has(drifted.problems, 'never evidence') && has(drifted.problems, 'is NOT recorded in the ledger'),
  )
  check('the exception accepts exactly that drift set, and nothing wider', evaluate({ driftPresent: drifted.present }).equivalent === true)

  /* ---- the pre-existing set must be exactly the two -------------------- */
  check('only hybrid_i pre-existing refuses', refuses({ driftPresent: [preExisting[0]] }, 'complete'))
  check('only hybrid_s pre-existing refuses', refuses({ driftPresent: [preExisting[1]] }, 'complete'))
  check('no pre-existing object at all refuses', refuses({ driftPresent: [] }, 'empty'))
  check('a third pre-existing pending object refuses', refuses({ driftPresent: [...preExisting, unrelated] }))
  check('unrelated pending drift on its own refuses', refuses({ driftPresent: [unrelated] }))
  check('a pre-existing object with no usable key refuses', refuses({ driftPresent: [{ kind: 'enumValue' }] }, 'without a usable key'))
  check(
    'a pre-existing value that is not declared idempotently refuses',
    refuses({ driftPresent: [{ ...preExisting[0], conflictKind: 'hard' }, preExisting[1]] }, 'idempotent'),
  )
  check(
    'a pre-existing value attributed to another migration refuses',
    refuses({ driftPresent: [{ ...preExisting[0], tag: '0016_yummy_tattoo' }, preExisting[1]] }, 'idempotent'),
  )
  check('no inventory of pre-existing objects at all refuses', refuses({ driftPresent: null }, 'cannot bound what drifted'))

  /* ---- the ledger must be exactly 0000 … 0015 -------------------------- */
  check('a ledger short of 0015 refuses', refuses({ recordedTags: RECORDED_TAGS.slice(0, 15) }, 'only to a ledger of exactly'))
  check('a ledger already carrying a pending migration refuses', refuses({ recordedTags: [...RECORDED_TAGS, '0016_yummy_tattoo'] }))
  check(
    'a ledger holding the right tags in the wrong order refuses',
    refuses({ recordedTags: [...RECORDED_TAGS].reverse() }),
  )
  check('missing ledger evidence refuses', refuses({ recordedTags: undefined }, 'No ledger evidence'))
  check('a null ledger refuses', refuses({ recordedTags: null }, 'No ledger evidence'))

  /* ---- the pending stack must be exactly 0016 … 0019 ------------------- */
  check(
    'a pending stack missing 0018 refuses',
    refuses({ pendingTags: PENDING_TAGS.filter((tag) => tag !== STRAIN_EQUIVALENCE_TAG) }, 'pending stack of exactly'),
  )
  check('a pending stack in the wrong order refuses', refuses({ pendingTags: [...PENDING_TAGS].reverse() }))
  check('an extra pending migration refuses', refuses({ pendingTags: [...PENDING_TAGS, '0020_invented'] }))
  check('missing pending evidence refuses', refuses({ pendingTags: undefined }, 'No pending-stack evidence'))

  /* ---- the catalog must prove the complete ordered sequence ------------- */
  check(
    'the enum in the wrong order refuses even though the set is right',
    refuses({ strainTypeRows: rowsOf('indica', 'sativa', 'hybrid', 'hybrid_s', 'hybrid_i', 'cbd') }, 'in that order'),
  )
  check('hybrid_i missing from the enum refuses', refuses({ strainTypeRows: rowsOf('indica', 'sativa', 'hybrid', 'hybrid_s', 'cbd') }))
  check('hybrid_s missing from the enum refuses', refuses({ strainTypeRows: rowsOf('indica', 'sativa', 'hybrid', 'hybrid_i', 'cbd') }))
  check(
    'an extra enum value refuses',
    refuses({ strainTypeRows: rowsOf('indica', 'sativa', 'hybrid', 'hybrid_i', 'hybrid_s', 'hybrid_x', 'cbd') }),
  )
  check('the anchor value missing from the enum refuses', refuses({ strainTypeRows: rowsOf('indica', 'sativa', 'hybrid', 'hybrid_i', 'hybrid_s') }))
  check('a null catalog observation refuses', refuses({ strainTypeRows: null }, 'missing catalog observation is a refusal'))
  check('a missing catalog observation refuses', refuses({ strainTypeRows: undefined }, 'missing catalog observation is a refusal'))
  check('an empty catalog answer refuses', refuses({ strainTypeRows: [] }, 'no public.strain_type values at all'))
  check('a catalog row carrying no usable label refuses', refuses({ strainTypeRows: [{ label: null }] }, 'malformed'))
  check('a catalog row that is neither a labelled row nor a label refuses', refuses({ strainTypeRows: [1, 2, 3] }, 'malformed'))
  check(
    'the normalizer reads either row shape and invents neither',
    normalizeCatalogEnumOrder(orderedRows).labels.join(',') === STRAIN_TYPE_EXPECTED_ORDER.join(',') &&
      normalizeCatalogEnumOrder([...STRAIN_TYPE_EXPECTED_ORDER]).labels.join(',') === STRAIN_TYPE_EXPECTED_ORDER.join(',') &&
      normalizeCatalogEnumOrder(null).labels === null,
  )

  /* ---- the repository's 0018 must PARSE to the two intended operations -- */
  const parsedReal = parseAddValueScript(source0018)
  check(
    'the committed 0018 parses to exactly the two intended operations',
    parsedReal.operations?.length === 2 &&
      parsedReal.operations.every((operation, index) =>
        JSON.stringify(operation) === JSON.stringify(STRAIN_EQUIVALENCE_OPERATIONS[index]),
      ),
    JSON.stringify(parsedReal),
  )
  check(
    'a changed type name refuses',
    refuses({ source: pair(alterStatement({ type: '"public"."strain_kind"' }), secondStatement) }, 'no longer carries exactly'),
  )
  check(
    'a changed schema refuses',
    refuses({ source: pair(alterStatement({ type: '"private"."strain_type"' }), secondStatement) }, 'no longer carries exactly'),
  )
  check('a changed enum label refuses', refuses({ source: pair(alterStatement({ value: 'hybrid_x' }), secondStatement) }, 'no longer carries exactly'))
  check(
    'a changed BEFORE anchor refuses',
    refuses({ source: pair(alterStatement({ tail: "BEFORE 'hybrid'" }), secondStatement) }, 'no longer carries exactly'),
  )
  check(
    'AFTER where BEFORE was refuses',
    refuses({ source: pair(alterStatement({ tail: "AFTER 'hybrid'" }), secondStatement) }, 'no longer carries exactly'),
  )
  check('a dropped anchor refuses', refuses({ source: pair(alterStatement({ tail: '' }), secondStatement) }, 'no longer carries exactly'))
  check(
    'reversed statement order refuses',
    refuses({ source: pair(secondStatement, alterStatement()) }, 'no longer carries exactly'),
  )
  check(
    'a dropped IF NOT EXISTS refuses, because the statements would no longer be no-ops',
    refuses({ source: pair(alterStatement({ guard: '' }), secondStatement) }, 'no longer carries exactly'),
  )
  check('only one of the two statements refuses', refuses({ source: alterStatement() }, 'no longer carries exactly'))
  check('a source that is missing entirely refuses', refuses({ source: undefined }, 'No SQL text was supplied'))
  check('a source that is not a string refuses', refuses({ source: 42 }, 'No SQL text was supplied'))
  check(
    'an unquoted type name refuses, because the parser and the drift inventory must read the same file',
    parseAddValueScript(
      pair(
        alterStatement({ type: 'public.strain_type' }),
        alterStatement({ type: 'public.strain_type', value: 'hybrid_s' }),
      ),
    ).operations?.length === 2 &&
      refuses(
        {
          source: pair(
            alterStatement({ type: 'public.strain_type' }),
            alterStatement({ type: 'public.strain_type', value: 'hybrid_s' }),
          ),
        },
        'must agree exactly',
      ),
  )
  check(
    'a quoted identifier in another case is another identifier, and refuses',
    refuses({ source: pair(alterStatement({ type: '"PUBLIC"."STRAIN_TYPE"' }), secondStatement) }, 'no longer carries exactly'),
  )

  /* ---- extra executable SQL, and the substring test that would miss it -- */
  const withDrop = `${source0018}\n--> statement-breakpoint\nDROP TABLE "users";`
  check(
    'an extra executable statement refuses even though the file still contains the committed text verbatim',
    withDrop.includes(source0018) && refuses({ source: withDrop }, 'cannot be proved equivalent'),
  )
  check('an appended SELECT refuses', refuses({ source: `${source0018}\nSELECT 1;` }, 'cannot be proved equivalent'))
  check(
    'a tail after the anchor refuses',
    refuses({ source: pair(alterStatement({ tail: "BEFORE 'cbd' CASCADE" }), secondStatement) }, 'cannot be proved equivalent'),
  )

  /* ---- comments and whitespace, inert only because they are recognised -- */
  const commented =
    '/* the two leaning values, and nothing else */\n\n' +
    'ALTER TYPE   "public"."strain_type"   -- the enum this migration widens\n' +
    "  ADD VALUE IF NOT EXISTS 'hybrid_i'   BEFORE 'cbd' ;\n" +
    '--> statement-breakpoint\n' +
    "/* and the second */ ALTER TYPE \"public\".\"strain_type\" ADD VALUE IF NOT EXISTS 'hybrid_s' BEFORE 'cbd';\n" +
    '-- trailing commentary\n'
  check('comments and whitespace that cannot change execution are inert', evaluate({ source: commented }).equivalent === true)
  check(
    'the statement-breakpoint marker is a comment, not a statement',
    parseAddValueScript(pair(alterStatement(), secondStatement)).operations?.length === 2,
  )
  check('an empty trailing statement is not an executable one', evaluate({ source: `${source0018}\n;\n` }).equivalent === true)

  const dashedLabel = pair(alterStatement({ value: 'hy--brid_i' }), secondStatement)
  const parsedDashed = parseAddValueScript(dashedLabel)
  check(
    'a "--" inside a string literal is data, not a comment — and the changed label is refused',
    parsedDashed.operations?.length === 2 &&
      parsedDashed.operations[0].value === 'hy--brid_i' &&
      refuses({ source: dashedLabel }, 'no longer carries exactly'),
  )
  const blockInLabel = pair(alterStatement({ value: 'hybrid/*x*/_i' }), secondStatement)
  check(
    'a block-comment marker inside a string literal is data too',
    parseAddValueScript(blockInLabel).operations?.[0]?.value === 'hybrid/*x*/_i' && refuses({ source: blockInLabel }),
  )
  check(
    'nested block comments are read the way PostgreSQL reads them',
    parseAddValueScript(`/* a /* nested */ comment */ ${alterStatement()}`).operations?.length === 1,
  )

  /* ---- anything the parser cannot prove ------------------------------- */
  const unreadable = (sql) => {
    const parsed = parseAddValueScript(sql)
    return parsed.operations === null && parsed.problems.length > 0
  }
  check(
    'an unterminated string literal refuses',
    unreadable(`ALTER TYPE "public"."strain_type" ADD VALUE IF NOT EXISTS 'hybrid_i`) &&
      has(tokenizeMigrationSql(`ADD VALUE 'x`).problems, 'string literal is never closed'),
  )
  check(
    'an unterminated quoted identifier refuses',
    unreadable('ALTER TYPE "public"."strain_type ADD VALUE IF NOT EXISTS \'hybrid_i\' BEFORE \'cbd\';') &&
      has(tokenizeMigrationSql('ALTER TYPE "public').problems, 'quoted identifier is never closed'),
  )
  check(
    'an unterminated block comment refuses',
    unreadable(`/* unclosed ${alterStatement()}`) &&
      has(tokenizeMigrationSql('/* unclosed').problems, 'block comment is never closed'),
  )
  check('a dollar-quoted body refuses', unreadable('DO $$ BEGIN END $$;'))
  check('an E-string escape refuses', unreadable(`ALTER TYPE "public"."strain_type" ADD VALUE IF NOT EXISTS E'hybrid_i' BEFORE 'cbd';`))
  check('a parenthesised form refuses', unreadable(`ALTER TYPE "public"."strain_type" ADD VALUE IF NOT EXISTS ('hybrid_i') BEFORE 'cbd';`))
  check('a file with no executable statement refuses', unreadable('-- nothing at all\n') && unreadable(''))
  check('a non-string source refuses at the tokenizer', tokenizeMigrationSql(null).statements === null && unreadable(42))
  check(
    'a statement this grammar cannot name yields NO operations, never the ones it understood',
    unreadable(`${alterStatement()}\nCREATE TABLE "ghost" ;`),
  )

  /* ---- the wiring: proved before the gate can possibly exist ----------- */
  check(
    'the runner proves equivalence inside the drift branch, not somewhere of its own',
    runnerSource.indexOf('const drift = evaluateDrift({') < runnerSource.indexOf('evaluateStrainLeaningEquivalence({') &&
      runnerSource.indexOf('evaluateStrainLeaningEquivalence({') > 0,
  )
  check(
    'the equivalence is proved BEFORE the migration gate is even constructed',
    runnerSource.indexOf('evaluateStrainLeaningEquivalence({') < runnerSource.indexOf('createMigrationGate('),
  )
  check(
    'and before the one gate.clear() that makes the command reachable',
    runnerSource.indexOf('evaluateStrainLeaningEquivalence({') < runnerSource.indexOf('gate.clear()') &&
      countOf(runnerSource, 'gate.clear()') === 1,
  )
  check(
    'there is exactly one equivalence call site, fed the run\'s own evidence',
    countOf(runnerSource, 'evaluateStrainLeaningEquivalence(') === 1 &&
      runnerSource.includes('pendingTags: pending.pendingTags,') &&
      runnerSource.includes('driftPresent: drift.present,') &&
      runnerSource.includes('source: snapshot.sources[STRAIN_EQUIVALENCE_TAG],'),
  )
  check(
    'the ordered enum is read straight from the clone, once, by the core query',
    countOf(runnerSource, 'query(STRAIN_TYPE_ORDER_QUERY)') === 1 &&
      runnerSource.includes('strainTypeRows: await query(STRAIN_TYPE_ORDER_QUERY),'),
  )
  check(
    'anything short of proven equivalence still stops the run as blocking drift',
    /if \(equivalence\.equivalent !== true\) \{\s*\n\s*stop\(/.test(runnerSource) &&
      countOf(runnerSource, 'BLOCKING DRIFT') === 1 &&
      runnerSource.includes('...drift.problems,') &&
      runnerSource.includes('...equivalence.problems,'),
  )
  check(
    'the migrate path is still one gated npx drizzle-kit migrate for the whole stack',
    countOf(runnerSource, "gate.run('npx', ['drizzle-kit', 'migrate']") === 1 &&
      countOf(runnerSource, 'execFileSync(') === 1 &&
      runnerSource.includes("for (const banned of ['step'") &&
      !runnerSource.includes('statement-breakpoint'),
  )
  check(
    'the exception writes no ledger row and adds no repair statement to either file',
    [runnerSource, coreSource].every(
      (source) =>
        !/insert\s+into\s+(?:"?drizzle"?\.)?"?__drizzle_migrations/i.test(source) &&
        !/update\s+(?:"?drizzle"?\.)?"?__drizzle_migrations/i.test(source) &&
        !/delete\s+from\s+(?:"?drizzle"?\.)?"?__drizzle_migrations/i.test(source),
    ),
  )

  const exceptionSource = coreSource.slice(
    coreSource.indexOf('export const STRAIN_EQUIVALENCE_TAG'),
    coreSource.indexOf('/* ========================================================== carried data === */'),
  )
  check(
    'the exception is a decision and nothing else: it cannot run, clear, or invoke anything',
    exceptionSource.length > 0 &&
      !exceptionSource.includes('createMigrationGate') &&
      !exceptionSource.includes('gate.clear') &&
      !exceptionSource.includes('gate.run') &&
      !exceptionSource.includes('assertMigrationCommand'),
  )

  const driftSource = coreSource.slice(
    coreSource.indexOf('export function evaluateDrift'),
    coreSource.indexOf('/** Post-migration:'),
  )
  check(
    'evaluateDrift itself knows nothing about the exception, so the general rule is unchanged',
    driftSource.length > 0 &&
      !driftSource.includes('STRAIN') &&
      !driftSource.includes('quivalen') &&
      driftSource.includes('never evidence that the migration was applied'),
  )
  check(
    'the catalog question is a read-only, ordered one about a single type',
    STRAIN_TYPE_ORDER_QUERY.startsWith('select ') &&
      STRAIN_TYPE_ORDER_QUERY.includes('order by e.enumsortorder asc') &&
      STRAIN_TYPE_ORDER_QUERY.includes("n.nspname = 'public' and t.typname = 'strain_type'") &&
      !/\b(insert|update|delete|alter|create|drop|truncate)\b/i.test(STRAIN_TYPE_ORDER_QUERY),
  )
  check(
    'the post-migration reconciliation through 0019 and every probe are untouched',
    runnerSource.includes('reconcileLedger({ migrations, rows: afterLedger, expectedTags: ALL_TAGS })') &&
      runnerSource.includes('evaluateApplied({ inventory, dropped, observedKeys: afterObserved.keys })') &&
      runnerSource.includes('await runProbes(pool)') &&
      REQUIRED_PROBES.length === 14 &&
      ALL_TAGS[ALL_TAGS.length - 1] === '0019_demonic_rockslide',
  )
  check(
    'no refusal in this section ever reports equivalence, whatever it was handed',
    [
      { driftPresent: [] },
      { driftPresent: null },
      { recordedTags: undefined },
      { pendingTags: undefined },
      { strainTypeRows: null },
      { source: undefined },
      { source: `${source0018}\nSELECT 1;` },
      { strainTypeRows: rowsOf('indica', 'sativa', 'hybrid', 'hybrid_s', 'hybrid_i', 'cbd') },
    ].every((over) => {
      const result = evaluate(over)
      return result.equivalent === false && result.problems.length > 0
    }),
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
