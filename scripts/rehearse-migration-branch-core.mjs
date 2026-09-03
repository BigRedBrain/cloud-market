/**
 * The decision core of the production-shaped migration rehearsal.
 *
 * PURE, AND THAT IS THE ENTIRE POINT. Nothing in this file reads the
 * environment, opens a socket, touches the filesystem, or talks to Neon or
 * Postgres. Every export is a function of its arguments — including
 * `confirmCleanupTarget`, whose branch listing and whose delay are both handed
 * in, so that the one function which retries is still testable against literals.
 * The runner
 * (`rehearse-migration-branch.mjs`) gathers facts; this module decides what they
 * mean; the verifier (`verify-rehearse-migration-branch.mjs`) proves the
 * decisions are right without a network, a database, or a credential.
 *
 * WHY THE SPLIT EXISTS. The rehearsal's whole value is its refusals — that it
 * will not clone the wrong parent, will not run a migration onto a database
 * whose ledger it cannot reconcile, will not read a pre-existing enum value as
 * evidence that a migration was applied, and will not report PASS on a probe
 * that never ran. A refusal that is only exercised when someone points the
 * script at production is a refusal nobody has ever seen work. Extracted here,
 * every one of them is testable in milliseconds against literals.
 *
 * THE INVARIANTS THIS FILE ENCODES
 *
 *   1. Evidence that is missing, ambiguous, or unrecognised is a FAILURE, never
 *      a pass and never a shrug. There is no code path that treats absence as
 *      permission.
 *   2. An object existing on the clone while the migration that declares it is
 *      unrecorded is DRIFT — always blocking, never evidence of application.
 *      `hybrid_i`/`hybrid_s` are the named case of this rule because
 *      `ADD VALUE IF NOT EXISTS` is exactly the statement that would otherwise
 *      succeed silently and leave a ledger that disagrees with the schema.
 *   3. The migration command is the repository's own `drizzle-kit migrate`, run
 *      once, with the journal and migration files exactly as committed. There is
 *      no per-file executor here, no statement splitter, and no ledger writer —
 *      by construction, not by convention.
 */
import { createHash } from 'node:crypto'

import { isProductionHostFingerprint } from './environment-fingerprints.mjs'

/* ============================================================ expectations = */

/** Every rehearsal branch this tooling may create or delete is named this way. */
export const REHEARSAL_BRANCH_PREFIX = 'rehearsal-'

/**
 * The migrations production is expected to have already recorded.
 *
 * Spelled out rather than derived from "everything before the pending stack",
 * so that a journal which quietly gained or lost an entry fails reconciliation
 * instead of silently redefining what production is supposed to look like.
 */
export const RECORDED_TAGS = Object.freeze([
  '0000_keen_raider',
  '0001_friendly_morlocks',
  '0002_quick_beyonder',
  '0003_lean_starbolt',
  '0004_true_amazoness',
  '0005_flimsy_shinko_yamashiro',
  '0006_normal_darwin',
  '0007_cloudy_kulan_gath',
  '0008_organic_proemial_gods',
  '0009_lucky_cloak',
  '0010_limit_boundary_guard',
  '0011_unknown_absorbing_man',
  '0012_scheduler_run_guard',
  '0013_cra_measurement_model',
  '0014_exact_cap_scale',
  '0015_catalog_compliance',
])

/** The stack this rehearsal exists to apply, in order. */
export const PENDING_TAGS = Object.freeze([
  '0016_yummy_tattoo',
  '0017_phase_5_private_storefront',
  '0018_strain_leaning_types',
  '0019_demonic_rockslide',
])

export const ALL_TAGS = Object.freeze([...RECORDED_TAGS, ...PENDING_TAGS])

/**
 * The two enum values whose mere existence has previously been mistaken for
 * proof that 0018 had been applied. Named here so the rule is testable by name.
 */
export const STRAIN_LEANING_VALUES = Object.freeze(['hybrid_i', 'hybrid_s'])

/**
 * The behavioural probes that MUST report PASS.
 *
 * Declared up front, so that a probe which never ran is detectable as a missing
 * result rather than invisible. Every probe is self-sufficient: it builds the
 * rows it needs inside a transaction that is rolled back, so none of them can
 * report SKIP because the clone happened not to carry a convenient row.
 */
export const REQUIRED_PROBES = Object.freeze([
  '0016.media_defaults',
  '0016.media_explicit_kind',
  '0016.media_kind_rejects_unknown',
  '0017.invite_code_hash_unique',
  '0017.invite_code_budget_check',
  '0017.admin_ceiling_trigger',
  '0018.strain_leaning_accepted',
  '0018.strain_leaning_ordering',
  '0019.invite_target_role_default',
  '0019.redemption_same_invite_rejected',
  '0019.redemption_other_invite_allowed',
  '0019.marketplace_access_user_unique',
  '0019.marketplace_access_user_cascade',
  'probe.isolation',
])

/** The only status that may contribute to a PASS. */
export const PROBE_PASS = 'PASS'

/* ============================================== repository migration facts = */

/**
 * The hash drizzle records for a migration: SHA-256 over the file's text.
 *
 * This must stay byte-for-byte what `drizzle-orm`'s `readMigrationFiles` does —
 * `sha256(readFileSync(file).toString())` — because the value it produces is
 * compared against rows that drizzle itself wrote. Normalising line endings or
 * trimming whitespace here would not "fix" a mismatch; it would hide one.
 */
export function migrationHash(sql) {
  if (typeof sql !== 'string') {
    throw new TypeError('migrationHash requires the migration file text as a string')
  }
  return createHash('sha256').update(sql).digest('hex')
}

const shortHash = (h) => (typeof h === 'string' ? `${h.slice(0, 12)}…` : String(h))

const normalizeHash = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null
}

/**
 * `created_at` is a bigint column, so the driver may hand back a number, a
 * string or a BigInt depending on version and settings. All three are accepted;
 * anything else is unrecognised evidence and therefore a failure.
 */
const normalizeMillis = (value) => {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim()
  return null
}

/**
 * The repository's migrations, as the ledger should describe them.
 *
 * @param {object} input
 * @param {object} input.journal  parsed drizzle/meta/_journal.json
 * @param {Record<string,string>} input.sources  tag -> exact file text
 */
export function buildRepositoryMigrations({ journal, sources }) {
  const problems = []
  const migrations = []

  if (!journal || typeof journal !== 'object' || !Array.isArray(journal.entries)) {
    return {
      problems: ['drizzle/meta/_journal.json is missing or has no entries array — no repository evidence.'],
      migrations,
    }
  }

  const entries = journal.entries
  if (entries.length !== ALL_TAGS.length) {
    problems.push(
      `The journal has ${entries.length} entries; this rehearsal is defined against exactly ` +
        `${ALL_TAGS.length} (${ALL_TAGS[0]} … ${ALL_TAGS[ALL_TAGS.length - 1]}). Regenerate the ` +
        'rehearsal expectations deliberately rather than letting them drift.',
    )
  }

  entries.forEach((entry, position) => {
    const expected = ALL_TAGS[position]
    if (expected === undefined) {
      problems.push(`Journal position ${position} ("${entry?.tag}") is beyond the expected stack.`)
      return
    }
    if (entry?.tag !== expected) {
      problems.push(`Journal position ${position} is "${entry?.tag}", expected "${expected}".`)
    }
    if (entry?.idx !== position) {
      problems.push(`Journal entry "${entry?.tag}" reports idx ${entry?.idx} at position ${position}.`)
    }
    if (!Number.isInteger(entry?.when) || entry.when <= 0) {
      problems.push(`Journal entry "${entry?.tag}" has no usable "when" timestamp (${entry?.when}).`)
      return
    }
    if (position > 0 && Number.isInteger(entries[position - 1]?.when) && entry.when <= entries[position - 1].when) {
      problems.push(
        `Journal entry "${entry.tag}" is not newer than its predecessor ` +
          `(${entry.when} <= ${entries[position - 1].when}).`,
      )
    }

    const sql = sources?.[entry.tag]
    if (typeof sql !== 'string' || sql.length === 0) {
      /*
       * MISSING EVIDENCE FAILS CLOSED. A migration file that cannot be read
       * cannot be hashed, so its ledger row cannot be reconciled — and an
       * unreconciled row is precisely the thing this rehearsal refuses to
       * proceed past.
       */
      problems.push(
        `drizzle/${entry.tag}.sql could not be read. Its hash cannot be computed, so the ` +
          'clone ledger cannot be reconciled against it.',
      )
      return
    }

    migrations.push({ idx: position, tag: entry.tag, when: entry.when, hash: migrationHash(sql), sql })
  })

  return { problems, migrations }
}

/* ============================================================ the ledger === */

/**
 * Exact reconciliation of the clone's `drizzle.__drizzle_migrations` against a
 * span of repository migrations: same rows, same order, same hashes, same
 * timestamps, nothing extra and nothing unexplained.
 *
 * A COUNT IS NOT A RECONCILIATION. The rehearsal this replaces asserted the
 * number of ledger rows and nothing else, which cannot distinguish "production
 * is at 0015" from "production is at sixteen migrations that are not these".
 *
 * @param {object} input
 * @param {Array} input.migrations   from buildRepositoryMigrations
 * @param {Array|null} input.rows    ledger rows: { id, hash, created_at }, ordered by id
 * @param {readonly string[]} input.expectedTags
 */
export function reconcileLedger({ migrations, rows, expectedTags }) {
  const problems = []

  if (!Array.isArray(rows)) {
    return {
      problems: [
        'The clone produced no ledger evidence at all (drizzle.__drizzle_migrations could not be ' +
          'read). Absence of evidence is a stop, not a baseline.',
      ],
      recordedTags: [],
    }
  }

  const byTag = new Map(migrations.map((m) => [m.tag, m]))
  const byHash = new Map(migrations.map((m) => [m.hash, m]))

  const expected = []
  for (const tag of expectedTags) {
    const migration = byTag.get(tag)
    if (!migration) {
      problems.push(`No repository evidence for "${tag}", so the ledger cannot be reconciled against it.`)
      continue
    }
    expected.push(migration)
  }

  if (rows.length !== expectedTags.length) {
    problems.push(
      `The clone ledger holds ${rows.length} row(s); exact reconciliation requires ` +
        `${expectedTags.length} (${expectedTags[0]} … ${expectedTags[expectedTags.length - 1]}).`,
    )
  }

  const span = Math.max(rows.length, expected.length)
  let previousId = null

  for (let position = 0; position < span; position += 1) {
    const row = rows[position]
    const want = expected[position]

    if (!row) {
      problems.push(`Ledger position ${position}: "${want.tag}" is not recorded on the clone.`)
      continue
    }
    if (!want) {
      const stray = byHash.get(normalizeHash(row.hash))
      problems.push(
        `Ledger position ${position}: the clone records an extra row ` +
          `(${stray ? stray.tag : `unknown hash ${shortHash(row.hash)}`}) beyond the expected span.`,
      )
      continue
    }

    const hash = normalizeHash(row.hash)
    if (hash === null) {
      problems.push(`Ledger position ${position} ("${want.tag}") has an unreadable hash (${row.hash}).`)
    } else if (hash !== want.hash) {
      const actual = byHash.get(hash)
      problems.push(
        `Ledger position ${position}: expected "${want.tag}" (${shortHash(want.hash)}) but the clone ` +
          `records ${actual ? `"${actual.tag}"` : `an unknown migration (${shortHash(hash)})`}.` +
          (actual ? '' : ' The file in this repository may differ from the one that was applied.'),
      )
    }

    const created = normalizeMillis(row.created_at)
    if (created === null) {
      problems.push(
        `Ledger position ${position} ("${want.tag}") has an unusable created_at (${row.created_at}).`,
      )
    } else if (created !== String(want.when)) {
      problems.push(
        `Ledger position ${position} ("${want.tag}"): recorded timestamp ${created} does not match the ` +
          `journal timestamp ${want.when}.`,
      )
    }

    const id = typeof row.id === 'string' && /^\d+$/.test(row.id) ? Number(row.id) : row.id
    if (!Number.isInteger(id)) {
      problems.push(`Ledger position ${position} ("${want.tag}") has no usable id (${row.id}).`)
    } else if (previousId !== null && id <= previousId) {
      problems.push(
        `Ledger ids are not strictly ascending at position ${position} (${previousId} -> ${id}), so ` +
          'the recorded order cannot be trusted.',
      )
    } else {
      previousId = id
    }
  }

  /*
   * Called out separately because it means something specific and alarming: a
   * migration this run is about to apply is ALREADY in the ledger, out of the
   * span being reconciled.
   */
  for (const row of rows.slice(expected.length)) {
    const stray = byHash.get(normalizeHash(row.hash))
    if (stray && PENDING_TAGS.includes(stray.tag)) {
      problems.push(
        `The clone already records "${stray.tag}", which this rehearsal is defined to apply. The ` +
          'clone is not the production shape this run assumes.',
      )
    }
  }

  return {
    problems,
    recordedTags: rows
      .map((row) => byHash.get(normalizeHash(row.hash))?.tag)
      .filter((tag) => typeof tag === 'string'),
  }
}

/**
 * What is left to apply, derived from the ledger rather than assumed.
 *
 * The derived stack is then required to be EXACTLY the four pending tags, in
 * order, as a contiguous tail. A pending set that is anything else means the
 * clone is not the database this rehearsal was designed against.
 */
export function derivePendingStack({ migrations, rows }) {
  const problems = []

  if (!Array.isArray(rows)) {
    return { problems: ['No ledger evidence, so the pending stack cannot be derived.'], pendingTags: [] }
  }

  const recordedHashes = new Set(rows.map((row) => normalizeHash(row.hash)).filter(Boolean))
  const pending = migrations.filter((m) => !recordedHashes.has(m.hash))
  const pendingTags = pending.map((m) => m.tag)

  const tail = migrations.slice(migrations.length - pending.length).map((m) => m.tag)
  if (pendingTags.join(',') !== tail.join(',')) {
    problems.push(
      `The unapplied migrations (${pendingTags.join(', ') || 'none'}) are not a contiguous tail of the ` +
        'journal. A gap in the middle means the ledger and the repository disagree about history.',
    )
  }

  if (pendingTags.join(',') !== PENDING_TAGS.join(',')) {
    problems.push(
      `Derived pending stack [${pendingTags.join(', ') || 'none'}] is not the expected ` +
        `[${PENDING_TAGS.join(', ')}].`,
    )
  }

  return { problems, pendingTags }
}

/* ================================================= declared-object inventory */

export const objectKey = Object.freeze({
  type: (name) => `type:${name}`,
  enumValue: (type, value) => `enumValue:${type}:${value}`,
  table: (name) => `table:${name}`,
  column: (table, column) => `column:${table}.${column}`,
  index: (name) => `index:${name}`,
  constraint: (name) => `constraint:${name}`,
  function: (name) => `function:${name}`,
  trigger: (name) => `trigger:${name}`,
})

/**
 * Line comments are stripped before matching.
 *
 * 0017 carries a long hand-written commentary and a plpgsql body, and matching
 * DDL keywords inside prose would invent objects that do not exist. Nothing in
 * this stack puts a `--` inside a string literal, which is the only case this
 * would get wrong.
 */
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '')

const collect = (sql, pattern, build) => {
  const found = []
  for (const match of sql.matchAll(pattern)) found.push(build(match))
  return found
}

/**
 * Every object a migration file DECLARES — the things that must not already
 * exist on a clone where that migration is unrecorded.
 *
 * `conflictKind` records how the statement would behave if the object were
 * already there:
 *
 *   'hard'   — the statement raises, so the migration would fail loudly.
 *   'silent' — IF NOT EXISTS / OR REPLACE / a preceding DROP IF EXISTS means the
 *              statement would succeed and leave the ledger claiming a migration
 *              that only half-happened.
 *
 * BOTH ARE BLOCKING. The distinction exists to tell an operator what they are
 * looking at, never to decide whether to proceed.
 */
export function extractDeclaredObjects(tag, rawSql) {
  if (typeof rawSql !== 'string') {
    throw new TypeError(`extractDeclaredObjects(${tag}) requires the migration file text`)
  }
  const sql = stripComments(rawSql)
  const declared = []

  const droppedTriggers = new Set(
    collect(sql, /DROP\s+TRIGGER\s+IF\s+EXISTS\s+"?([a-z0-9_]+)"?/gi, (m) => m[1].toLowerCase()),
  )

  declared.push(
    ...collect(sql, /CREATE\s+TYPE\s+"public"\."([a-z0-9_]+)"\s+AS\s+ENUM/gi, (m) => ({
      kind: 'type',
      key: objectKey.type(m[1]),
      label: `type "${m[1]}"`,
      conflictKind: 'hard',
    })),
  )

  declared.push(
    ...collect(
      sql,
      /ALTER\s+TYPE\s+"public"\."([a-z0-9_]+)"\s+ADD\s+VALUE\s+(IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi,
      (m) => ({
        kind: 'enumValue',
        key: objectKey.enumValue(m[1], m[3]),
        label: `enum value "${m[1]}.${m[3]}"`,
        conflictKind: m[2] ? 'silent' : 'hard',
        note: m[2]
          ? 'ADD VALUE IF NOT EXISTS would succeed against it, so its presence is drift and never ' +
            'evidence that the migration was applied.'
          : undefined,
      }),
    ),
  )

  declared.push(
    ...collect(sql, /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"([a-z0-9_]+)"/gi, (m) => ({
      kind: 'table',
      key: objectKey.table(m[2]),
      label: `table "${m[2]}"`,
      conflictKind: m[1] ? 'silent' : 'hard',
    })),
  )

  declared.push(
    ...collect(sql, /ALTER\s+TABLE\s+"([a-z0-9_]+)"\s+ADD\s+COLUMN\s+"([a-z0-9_]+)"/gi, (m) => ({
      kind: 'column',
      key: objectKey.column(m[1], m[2]),
      label: `column "${m[1]}.${m[2]}"`,
      conflictKind: 'hard',
    })),
  )

  declared.push(
    ...collect(sql, /ALTER\s+TABLE\s+"([a-z0-9_]+)"\s+ADD\s+CONSTRAINT\s+"([a-z0-9_]+)"/gi, (m) => ({
      kind: 'constraint',
      key: objectKey.constraint(m[2]),
      label: `constraint "${m[2]}" on "${m[1]}"`,
      conflictKind: 'hard',
    })),
  )

  declared.push(
    ...collect(sql, /CONSTRAINT\s+"([a-z0-9_]+)"\s+CHECK/gi, (m) => ({
      kind: 'constraint',
      key: objectKey.constraint(m[1]),
      label: `check constraint "${m[1]}"`,
      conflictKind: 'hard',
    })),
  )

  declared.push(
    ...collect(
      sql,
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?"([a-z0-9_]+)"\s+ON\s+"([a-z0-9_]+)"/gi,
      (m) => ({
        kind: 'index',
        key: objectKey.index(m[3]),
        label: `${m[1] ? 'unique ' : ''}index "${m[3]}" on "${m[4]}"`,
        conflictKind: m[2] ? 'silent' : 'hard',
      }),
    ),
  )

  declared.push(
    ...collect(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+"?([a-z0-9_]+)"?\s*\(/gi, (m) => ({
      kind: 'function',
      key: objectKey.function(m[2]),
      label: `function "${m[2]}"`,
      conflictKind: m[1] ? 'silent' : 'hard',
    })),
  )

  declared.push(
    ...collect(sql, /CREATE\s+TRIGGER\s+"?([a-z0-9_]+)"?/gi, (m) => ({
      kind: 'trigger',
      key: objectKey.trigger(m[1]),
      label: `trigger "${m[1]}"`,
      conflictKind: droppedTriggers.has(m[1].toLowerCase()) ? 'silent' : 'hard',
    })),
  )

  /* De-duplicated: a name declared twice in one file is still one object. */
  const seen = new Set()
  const unique = []
  for (const object of declared) {
    if (seen.has(object.key)) continue
    seen.add(object.key)
    unique.push({ tag, ...object })
  }
  return unique
}

/** Objects a migration REMOVES — expected present before it, absent after. */
export function extractDroppedObjects(tag, rawSql) {
  const sql = stripComments(rawSql)
  return collect(sql, /DROP\s+INDEX\s+(IF\s+EXISTS\s+)?"([a-z0-9_]+)"/gi, (m) => ({
    tag,
    kind: 'index',
    key: objectKey.index(m[2]),
    label: `index "${m[2]}"`,
  }))
}

/** The full declared inventory across a set of migrations, in journal order. */
export function buildPendingInventory({ migrations, tags = PENDING_TAGS }) {
  const inventory = []
  const dropped = []
  const problems = []

  for (const tag of tags) {
    const migration = migrations.find((m) => m.tag === tag)
    if (!migration) {
      problems.push(`No repository evidence for pending migration "${tag}" — its objects cannot be inventoried.`)
      continue
    }
    inventory.push(...extractDeclaredObjects(tag, migration.sql))
    dropped.push(...extractDroppedObjects(tag, migration.sql))
  }

  if (problems.length === 0 && inventory.length === 0) {
    problems.push('The pending stack declared no objects at all, which cannot be right.')
  }

  return { inventory, dropped, problems }
}

/* ================================================================== drift == */

const OBSERVATION_KINDS = Object.freeze([
  'types',
  'enumValues',
  'tables',
  'columns',
  'indexes',
  'constraints',
  'functions',
  'triggers',
])

/**
 * Turn what was read out of the clone's catalogs into a key set.
 *
 * A kind that was not collected at all is missing evidence, and missing
 * evidence is a failure: "we did not look" must never read the same as "it is
 * not there".
 */
export function buildObservedKeys(observation) {
  const problems = []
  const keys = new Set()

  for (const kind of OBSERVATION_KINDS) {
    const rows = observation?.[kind]
    if (!Array.isArray(rows)) {
      problems.push(`The clone's ${kind} were not collected, so drift in them cannot be ruled out.`)
      continue
    }
    for (const row of rows) {
      switch (kind) {
        case 'types':
          keys.add(objectKey.type(row))
          break
        case 'enumValues':
          keys.add(objectKey.enumValue(row.type, row.value))
          break
        case 'tables':
          keys.add(objectKey.table(row))
          break
        case 'columns':
          keys.add(objectKey.column(row.table, row.column))
          break
        case 'indexes':
          keys.add(objectKey.index(row))
          break
        case 'constraints':
          keys.add(objectKey.constraint(row))
          break
        case 'functions':
          keys.add(objectKey.function(row))
          break
        case 'triggers':
          keys.add(objectKey.trigger(row))
          break
        default:
          break
      }
    }
  }

  return { problems, keys }
}

/**
 * Blocking drift: anything the pending stack declares that already exists while
 * its migration is unrecorded.
 *
 * THERE IS NO "ALREADY APPLIED" BRANCH HERE, DELIBERATELY. The ledger is the
 * only thing that says a migration ran. A schema object is not a substitute for
 * a ledger row, because the two disagreeing is the exact condition that makes a
 * migration run dangerous — and `ADD VALUE IF NOT EXISTS` makes that
 * disagreement survivable enough to go unnoticed.
 */
export function evaluateDrift({ inventory, recordedTags, observedKeys }) {
  const problems = []
  const present = []

  if (!(observedKeys instanceof Set)) {
    return {
      problems: ['No catalog observation was supplied, so pre-existing objects cannot be ruled out.'],
      present,
      checked: 0,
    }
  }

  const recorded = new Set(recordedTags ?? [])
  let checked = 0

  for (const object of inventory) {
    if (recorded.has(object.tag)) continue
    checked += 1
    if (!observedKeys.has(object.key)) continue

    present.push(object)
    problems.push(
      `DRIFT: ${object.label} already exists on the clone although "${object.tag}" is NOT recorded in ` +
        `the ledger (${object.conflictKind === 'silent' ? 'the statement would succeed silently' : 'the migration would fail on it'}). ` +
        (object.note ?? 'It is blocking drift, never evidence that the migration was applied.'),
    )
  }

  return { problems, present, checked }
}

/** Post-migration: everything the stack declared must now exist, and its drops must be gone. */
export function evaluateApplied({ inventory, dropped, observedKeys }) {
  const problems = []

  if (!(observedKeys instanceof Set)) {
    return { problems: ['No catalog observation was supplied after the migration.'] }
  }

  /*
   * An object created by one migration in the stack and removed by a later one
   * is not expected to survive the stack. 0017 creates
   * `invite_code_redemptions_user_unique` and 0019 drops it; requiring both
   * would fail a correct run.
   */
  const removed = new Set((dropped ?? []).map((object) => object.key))

  for (const object of inventory) {
    if (removed.has(object.key)) continue
    if (!observedKeys.has(object.key)) {
      problems.push(`After migrating, ${object.label} declared by "${object.tag}" does not exist.`)
    }
  }
  for (const object of dropped) {
    if (observedKeys.has(object.key)) {
      problems.push(`After migrating, ${object.label} was supposed to be dropped by "${object.tag}" and is still present.`)
    }
  }

  return { problems }
}

/* ================== the one equivalence exception, for 0018 and nothing else */

/**
 * THE ONLY EXCEPTION TO "PRE-EXISTING MEANS BLOCKING", AND IT PROVES ITSELF.
 *
 * The general rule above is unchanged, and stays unchanged: an object that
 * exists on the clone while the migration declaring it is unrecorded is drift,
 * and `evaluateDrift` reports it as blocking no matter which migration it
 * belongs to. Nothing in this section edits that function, relaxes it, or is
 * consulted by it.
 *
 * ONE CONFIRMED STATE IS RECONCILABLE RATHER THAN DANGEROUS. A clone whose
 * ledger is exactly 0000 … 0015, whose pending stack is exactly 0016 … 0019,
 * whose ONLY pre-existing pending objects are `strain_type.hybrid_i` and
 * `strain_type.hybrid_s`, whose repository copy of 0018 still carries exactly
 * the two intended `ADD VALUE IF NOT EXISTS … BEFORE 'cbd'` operations and no
 * other executable statement, and whose live `public.strain_type` already reads
 * exactly indica, sativa, hybrid, hybrid_i, hybrid_s, cbd — that clone differs
 * from the repository in 0018's ledger row alone, and 0018's own statements are
 * idempotent no-ops against it that leave the enum in precisely the sequence the
 * repository declares. The whole pending stack may then go through the ONE gated
 * `drizzle-kit migrate` exactly as it always does.
 *
 * FIVE PROOFS, ALL REQUIRED, NONE INFERRED FROM ANOTHER
 *
 *   1. the recorded ledger is exactly RECORDED_TAGS, in order;
 *   2. the derived pending stack is exactly PENDING_TAGS, in order;
 *   3. the complete set of pre-existing pending objects is exactly the two
 *      leaning enum values — one is not enough, three is too many, and each must
 *      be declared by 0018 with idempotent (`silent`) semantics;
 *   4. the repository's 0018 source PARSES to exactly those two operations, in
 *      that order, with that type, those labels, that anchor, and no additional
 *      executable statement — proved by a tokenizer and a grammar, never by a
 *      substring test, and cross-checked against `extractDeclaredObjects`;
 *   5. a direct catalog reading of the clone reports the COMPLETE ordered value
 *      sequence of `public.strain_type`, and it is exactly the expected six.
 *
 * EVERY OTHER ANSWER REFUSES. Evidence that is missing, null, malformed,
 * ambiguous, partially observed, reordered, or additional is a refusal.
 * `equivalent` is true only when there are no problems AND all five proofs were
 * positively established, so a caller cannot reach the accepting branch by
 * supplying less evidence.
 *
 * WHAT THIS IS NOT. It is not a repair, not a ledger row, not a way to skip
 * 0018, not a per-file executor, and not a second migration path. It decides one
 * boolean; the run it belongs to still applies the whole stack once, through the
 * repository's own command, and still reconciles the ledger through 0019
 * afterwards.
 */

/** The migration this exception is scoped to. There is no second one. */
export const STRAIN_EQUIVALENCE_TAG = '0018_strain_leaning_types'

/** The complete, ordered value sequence `public.strain_type` must already hold. */
export const STRAIN_TYPE_EXPECTED_ORDER = Object.freeze([
  'indica',
  'sativa',
  'hybrid',
  'hybrid_i',
  'hybrid_s',
  'cbd',
])

/** The exact executable semantics 0018 is permitted to carry, in this order. */
export const STRAIN_EQUIVALENCE_OPERATIONS = Object.freeze([
  Object.freeze({
    schema: 'public',
    type: 'strain_type',
    ifNotExists: true,
    value: 'hybrid_i',
    position: 'before',
    anchor: 'cbd',
  }),
  Object.freeze({
    schema: 'public',
    type: 'strain_type',
    ifNotExists: true,
    value: 'hybrid_s',
    position: 'before',
    anchor: 'cbd',
  }),
])

/**
 * The direct catalog question, asked of the disposable clone.
 *
 * `enumsortorder` is the enum's own ordering, which is the thing that matters:
 * `hybrid_i` existing says nothing about WHERE it sits, and 0018's whole content
 * is a position. Read-only, and about one type only.
 */
export const STRAIN_TYPE_ORDER_QUERY = `select e.enumlabel as label
                 from pg_enum e
                 join pg_type t on t.oid = e.enumtypid
                 join pg_namespace n on n.oid = t.typnamespace
                where n.nspname = 'public' and t.typname = 'strain_type'
                order by e.enumsortorder asc`

/**
 * SQL, as tokens, with comments and whitespace removed only where they are
 * PROVEN not to be part of a value.
 *
 * WHY NOT A REGEX. `stripComments` above deletes `--…` wherever it appears,
 * which is right for inventorying declared objects and wrong for deciding
 * whether a file's executable meaning is unchanged: it would also delete a `--`
 * that a string literal contains, silently rewriting the label being added. And
 * a substring test — "does the file contain these two statements?" — is
 * satisfied by a file that contains them AND a `DROP TABLE` after them.
 *
 * So the text is scanned once, character by character, and every construct is
 * classified: a single-quoted literal (with `''` for an embedded quote), a
 * double-quoted identifier (with `""`), a `--` line comment, a nested `/* … *\/`
 * block comment, a word, a dot, or a statement-terminating semicolon. Comments
 * and whitespace are dropped only once they have been recognised as such —
 * OUTSIDE a literal — which is what makes "they do not alter execution" a
 * property of the scan rather than an assumption about the file.
 *
 * ANYTHING ELSE REFUSES. An unterminated literal, an unterminated block comment,
 * a dollar-quoted body, an `E''` escape string, a parenthesis, a comma, an
 * operator — any character this grammar does not model — ends the scan with a
 * problem and no statements, because a token this parser cannot name is a
 * meaning it cannot prove.
 */
export function tokenizeMigrationSql(sql) {
  if (typeof sql !== 'string') {
    return {
      problems: ['No SQL text was supplied, so nothing about its executable meaning can be proved.'],
      statements: null,
    }
  }

  const statements = []
  let tokens = []
  let at = 0

  const isSpace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v'
  const isWordStart = (c) => /[A-Za-z_]/.test(c)
  const isWordPart = (c) => /[A-Za-z0-9_]/.test(c)
  const refuse = (message) => ({ problems: [message], statements: null })

  /** A quoted run, `close`-delimited, where a doubled delimiter is the delimiter. */
  const readQuoted = (start, quote) => {
    let scan = start + 1
    let value = ''
    while (scan < sql.length) {
      if (sql[scan] === quote) {
        if (sql[scan + 1] === quote) {
          value += quote
          scan += 2
          continue
        }
        return { value, next: scan + 1 }
      }
      value += sql[scan]
      scan += 1
    }
    return null
  }

  while (at < sql.length) {
    const c = sql[at]

    if (isSpace(c)) {
      at += 1
      continue
    }

    if (c === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at)
      at = end === -1 ? sql.length : end + 1
      continue
    }

    if (c === '/' && sql[at + 1] === '*') {
      let depth = 1
      let scan = at + 2
      while (scan < sql.length && depth > 0) {
        if (sql[scan] === '/' && sql[scan + 1] === '*') {
          depth += 1
          scan += 2
          continue
        }
        if (sql[scan] === '*' && sql[scan + 1] === '/') {
          depth -= 1
          scan += 2
          continue
        }
        scan += 1
      }
      if (depth !== 0) {
        return refuse('A block comment is never closed, so where the executable text resumes is unknown.')
      }
      at = scan
      continue
    }

    if (c === "'") {
      const literal = readQuoted(at, "'")
      if (literal === null) return refuse('A string literal is never closed, so the file cannot be read.')
      tokens.push({ kind: 'string', value: literal.value })
      at = literal.next
      continue
    }

    if (c === '"') {
      const name = readQuoted(at, '"')
      if (name === null) return refuse('A quoted identifier is never closed, so the file cannot be read.')
      /* Quoted identifiers keep their case, exactly as PostgreSQL keeps it. */
      tokens.push({ kind: 'name', value: name.value })
      at = name.next
      continue
    }

    if (isWordStart(c)) {
      let scan = at
      while (scan < sql.length && isWordPart(sql[scan])) scan += 1
      /* Unquoted words fold to lower case, exactly as PostgreSQL folds them. */
      tokens.push({ kind: 'word', value: sql.slice(at, scan).toLowerCase() })
      at = scan
      continue
    }

    if (c === '.') {
      tokens.push({ kind: 'dot', value: '.' })
      at += 1
      continue
    }

    if (c === ';') {
      statements.push(tokens)
      tokens = []
      at += 1
      continue
    }

    return refuse(
      `The character ${JSON.stringify(c)} at offset ${at} is not something this parser models, so the ` +
        'statement it belongs to cannot be proved equivalent to anything.',
    )
  }

  if (tokens.length > 0) statements.push(tokens)
  return { problems: [], statements }
}

/**
 * One `ALTER TYPE … ADD VALUE …` statement, or nothing.
 *
 * The whole token list must be consumed: a statement with a tail is a statement
 * whose meaning has not been read, so it is not matched at all rather than
 * matched loosely. `BEFORE`/`AFTER` and `IF NOT EXISTS` are PARSED rather than
 * required, so that a changed anchor direction or a dropped idempotence guard
 * becomes a precise refusal from the comparison below instead of an unreadable
 * statement.
 */
function matchAlterTypeAddValue(tokens) {
  let at = 0

  const takeWord = (expected) => {
    const token = tokens[at]
    if (!token || token.kind !== 'word' || token.value !== expected) return false
    at += 1
    return true
  }
  const takeIdentifier = () => {
    const token = tokens[at]
    if (!token || (token.kind !== 'word' && token.kind !== 'name')) return null
    at += 1
    return token.value
  }
  const takeString = () => {
    const token = tokens[at]
    if (!token || token.kind !== 'string') return null
    at += 1
    return token.value
  }

  if (!takeWord('alter') || !takeWord('type')) return null

  const first = takeIdentifier()
  if (first === null) return null
  let schema = null
  let type = first
  if (tokens[at]?.kind === 'dot') {
    at += 1
    const qualified = takeIdentifier()
    if (qualified === null) return null
    schema = first
    type = qualified
  }

  if (!takeWord('add') || !takeWord('value')) return null

  let ifNotExists = false
  if (tokens[at]?.kind === 'word' && tokens[at].value === 'if') {
    if (!takeWord('if') || !takeWord('not') || !takeWord('exists')) return null
    ifNotExists = true
  }

  const value = takeString()
  if (value === null) return null

  let position = 'end'
  let anchor = null
  if (tokens[at]?.kind === 'word' && (tokens[at].value === 'before' || tokens[at].value === 'after')) {
    position = tokens[at].value
    at += 1
    anchor = takeString()
    if (anchor === null) return null
  }

  if (at !== tokens.length) return null

  return { schema, type, ifNotExists, value, position, anchor }
}

/** A statement, in words, for a refusal that has to say what it read. */
export function describeAddValueOperation(operation) {
  return (
    `ALTER TYPE ${operation.schema === null ? '' : `${operation.schema}.`}${operation.type} ` +
    `ADD VALUE${operation.ifNotExists ? ' IF NOT EXISTS' : ''} '${operation.value}'` +
    (operation.position === 'end' ? '' : ` ${operation.position.toUpperCase()} '${operation.anchor}'`)
  )
}

/**
 * The complete executable content of a migration file, as operations — or
 * nothing at all.
 *
 * A file that contains one statement this grammar cannot name yields NO
 * operations, not "the ones it understood". Partial comprehension is exactly
 * the failure mode a substring test has.
 */
export function parseAddValueScript(sql) {
  const { problems, statements } = tokenizeMigrationSql(sql)
  if (statements === null) return { problems, operations: null }

  const refusals = []
  const operations = []

  statements.forEach((tokens, index) => {
    /* `;;`, or a trailing `;`, is an empty statement: no tokens, no execution. */
    if (tokens.length === 0) return
    const operation = matchAlterTypeAddValue(tokens)
    if (operation === null) {
      refusals.push(
        `Statement ${index + 1} is not a provable "ALTER TYPE … ADD VALUE …" and this parser will not ` +
          'guess at it. Anything else in the file — another DDL statement, a longer form of this one, or ' +
          'a tail after it — is an additional migration semantic.',
      )
      return
    }
    operations.push(operation)
  })

  if (refusals.length > 0) return { problems: refusals, operations: null }
  if (operations.length === 0) {
    return { problems: ['The file carries no executable statement at all.'], operations: null }
  }
  return { problems: [], operations }
}

const sameAddValueOperation = (a, b) =>
  a.schema === b.schema &&
  a.type === b.type &&
  a.ifNotExists === b.ifNotExists &&
  a.value === b.value &&
  a.position === b.position &&
  a.anchor === b.anchor

/**
 * The ordered enum labels a catalog reading reports, or null.
 *
 * A reading that is not a list, is empty, or carries a row without a usable
 * label is NOT a partial answer to be worked with — it is an unanswered
 * question, and the exception refuses on it.
 */
export function normalizeCatalogEnumOrder(rows) {
  if (!Array.isArray(rows)) {
    return {
      problems: [
        'The clone was not asked, or did not answer, for the complete ordered values of ' +
          'public.strain_type. A missing catalog observation is a refusal, never a pass.',
      ],
      labels: null,
    }
  }
  if (rows.length === 0) {
    return {
      problems: ['The clone reported no public.strain_type values at all, which cannot be the truth about it.'],
      labels: null,
    }
  }

  const labels = []
  for (const row of rows) {
    const label = typeof row === 'string' ? row : row?.label
    if (typeof label !== 'string' || label.length === 0) {
      return {
        problems: [
          'A public.strain_type row carried no usable label, so the observed value sequence is ' +
            'malformed and nothing may be concluded from it.',
        ],
        labels: null,
      }
    }
    labels.push(label)
  }
  return { problems: [], labels }
}

/**
 * The exception itself: five independent proofs, or a refusal.
 *
 * @param {object} input
 * @param {string[]|null} input.recordedTags   tags reconciled out of the clone ledger
 * @param {string[]|null} input.pendingTags    the stack derived from that ledger
 * @param {Array|null} input.driftPresent      every pre-existing pending object, from evaluateDrift
 * @param {string|undefined} input.source      the repository text of 0018
 * @param {Array|null} input.strainTypeRows    STRAIN_TYPE_ORDER_QUERY's rows, unmodified
 */
export function evaluateStrainLeaningEquivalence({
  recordedTags,
  pendingTags,
  driftPresent,
  source,
  strainTypeRows,
}) {
  const problems = []
  const proofs = { ledger: false, pending: false, preExisting: false, source: false, catalog: false }

  /* ---- 1. the ledger is exactly 0000 … 0015 ------------------------------ */
  if (!Array.isArray(recordedTags)) {
    problems.push('No ledger evidence was supplied to the 0018 equivalence exception, so it refuses.')
  } else if (recordedTags.join(',') !== RECORDED_TAGS.join(',')) {
    problems.push(
      `The exception applies only to a ledger of exactly [${RECORDED_TAGS.join(', ')}]; this clone ` +
        `records [${recordedTags.join(', ') || 'nothing'}].`,
    )
  } else {
    proofs.ledger = true
  }

  /* ---- 2. the pending stack is exactly 0016 … 0019 ---------------------- */
  if (!Array.isArray(pendingTags)) {
    problems.push('No pending-stack evidence was supplied to the 0018 equivalence exception, so it refuses.')
  } else if (pendingTags.join(',') !== PENDING_TAGS.join(',')) {
    problems.push(
      `The exception applies only to a pending stack of exactly [${PENDING_TAGS.join(', ')}]; this run ` +
        `derived [${pendingTags.join(', ') || 'nothing'}].`,
    )
  } else {
    proofs.pending = true
  }

  /* ---- 3. the pre-existing set is exactly the two leaning values -------- */
  const expectedKeys = STRAIN_LEANING_VALUES.map((value) => objectKey.enumValue('strain_type', value))
  const expectedKeyList = [...expectedKeys].sort().join(' + ')

  if (!Array.isArray(driftPresent)) {
    problems.push('No inventory of pre-existing objects was supplied, so the exception cannot bound what drifted.')
  } else {
    const keys = driftPresent.map((object) => (typeof object?.key === 'string' ? object.key : null))
    if (keys.some((key) => key === null)) {
      problems.push('A pre-existing object was reported without a usable key, so the drifted set is unreadable.')
    } else if (keys.length !== expectedKeys.length || [...keys].sort().join(' + ') !== expectedKeyList) {
      problems.push(
        `The exception covers exactly ${expectedKeyList} and nothing else. The clone's complete ` +
          `pre-existing set is [${keys.join(', ') || 'empty'}], which is a different state and blocks.`,
      )
    } else if (
      !driftPresent.every(
        (object) => object.tag === STRAIN_EQUIVALENCE_TAG && object.conflictKind === 'silent',
      )
    ) {
      problems.push(
        `Both pre-existing values must be declared by "${STRAIN_EQUIVALENCE_TAG}" with idempotent ` +
          '(ADD VALUE IF NOT EXISTS) semantics; they are not, so re-running the stack is not a no-op.',
      )
    } else {
      proofs.preExisting = true
    }
  }

  /* ---- 4. the repository's 0018 is provably the two intended operations - */
  const parsed = parseAddValueScript(source)
  if (parsed.operations === null) {
    problems.push(
      `The repository copy of ${STRAIN_EQUIVALENCE_TAG}.sql cannot be proved equivalent: ` +
        parsed.problems.join(' '),
    )
  } else if (
    parsed.operations.length !== STRAIN_EQUIVALENCE_OPERATIONS.length ||
    !parsed.operations.every((operation, index) =>
      sameAddValueOperation(operation, STRAIN_EQUIVALENCE_OPERATIONS[index]),
    )
  ) {
    problems.push(
      `${STRAIN_EQUIVALENCE_TAG}.sql no longer carries exactly [` +
        `${STRAIN_EQUIVALENCE_OPERATIONS.map(describeAddValueOperation).join('; ')}]. It carries [` +
        `${parsed.operations.map(describeAddValueOperation).join('; ')}], which is a different migration.`,
    )
  } else {
    /*
     * Cross-checked against the declared-object extractor the drift rule itself
     * uses, so the exception cannot be satisfied by a source form that the
     * inventory would read differently from this parser.
     */
    let declaredKeys = null
    try {
      declaredKeys = extractDeclaredObjects(STRAIN_EQUIVALENCE_TAG, source)
        .map((object) => object.key)
        .sort()
        .join(' + ')
    } catch {
      declaredKeys = null
    }
    if (declaredKeys !== expectedKeyList) {
      problems.push(
        `${STRAIN_EQUIVALENCE_TAG}.sql declares [${declaredKeys ?? 'nothing readable'}] to the drift ` +
          `inventory, not ${expectedKeyList}. The two readings of the file must agree exactly.`,
      )
    } else {
      proofs.source = true
    }
  }

  /* ---- 5. the clone's own catalog, complete and in order ---------------- */
  const catalog = normalizeCatalogEnumOrder(strainTypeRows)
  if (catalog.labels === null) {
    problems.push(...catalog.problems)
  } else if (catalog.labels.join(',') !== STRAIN_TYPE_EXPECTED_ORDER.join(',')) {
    problems.push(
      `The clone's public.strain_type reads [${catalog.labels.join(', ')}]; the exception requires ` +
        `exactly [${STRAIN_TYPE_EXPECTED_ORDER.join(', ')}], in that order, with nothing missing and ` +
        'nothing extra.',
    )
  } else {
    proofs.catalog = true
  }

  /*
   * BOTH CONDITIONS, ALWAYS. "No problems" alone would accept an input shape
   * that reached no branch; "all proofs" alone would accept a state that also
   * produced a problem. Neither can happen, and it costs one `&&` to say so.
   */
  const equivalent = problems.length === 0 && Object.values(proofs).every((proved) => proved === true)

  return { problems, equivalent, proofs }
}

/**
 * What the exception proved, in the words of the evidence — and only when it
 * actually proved it. A description is not available for a state that refused.
 */
export function describeStrainLeaningEquivalence(equivalence) {
  if (equivalence?.equivalent !== true) return []
  return [
    `the ledger is exactly ${RECORDED_TAGS[0]} … ${RECORDED_TAGS[RECORDED_TAGS.length - 1]} and the ` +
      `pending stack is exactly ${PENDING_TAGS.join(', ')}`,
    `the complete pre-existing set is exactly ${STRAIN_LEANING_VALUES.map((value) => `strain_type.${value}`).join(' and ')}, ` +
      `both declared by "${STRAIN_EQUIVALENCE_TAG}" with ADD VALUE IF NOT EXISTS`,
    `${STRAIN_EQUIVALENCE_TAG}.sql parses to exactly ` +
      `[${STRAIN_EQUIVALENCE_OPERATIONS.map(describeAddValueOperation).join('; ')}] and nothing else executable`,
    `the clone's public.strain_type reads exactly ${STRAIN_TYPE_EXPECTED_ORDER.join(', ')}`,
    'so 0018 is a proven no-op against this clone: the whole pending stack goes through the one gated ' +
      'drizzle-kit migrate unchanged, and the ledger is reconciled through 0019 afterwards',
  ]
}

/* ========================================================== carried data === */

/**
 * The tables whose row COUNT must be identical either side of the migration.
 *
 * The pending stack adds columns and types; it is not permitted to add, remove,
 * or renumber a row anywhere in this list.
 */
export const CARRIED_TABLES = Object.freeze([
  'users',
  'media',
  'product_media',
  'products',
  'product_variants',
])

/**
 * The columns actually compared value-for-value, per table.
 *
 * SPELLED OUT BECAUSE THE CLAIM IS SPELLED OUT. What this rehearsal can honestly
 * report is exactly what it read: these columns, of these tables, of every row.
 * It is not a comparison of every column of every table, and the report says so
 * (see `describeCarriedEvidence`). A digest is only evidence about the bytes it
 * consumed.
 */
export const CARRIED_DIGEST_COLUMNS = Object.freeze({
  users: Object.freeze(['id', 'email', 'role', 'status']),
  media: Object.freeze(['id', 'url', 'alt_text']),
})

/** The disclaimer that keeps the carried-data report narrower than the data. */
export const CARRIED_EVIDENCE_DISCLAIMER =
  'columns outside those lists were not compared and are not claimed unchanged'

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * The NULL field, as SQL.
 *
 * A NULL ANYWHERE IN A CONCATENATION MAKES THE WHOLE ROW NULL, and `string_agg`
 * then drops that row silently. The first digest here was
 * `md5(string_agg(id||':'||email||':'||…))` over columns that are genuinely
 * nullable — `users.email` and `media.alt_text` — so every row with a NULL in
 * one of them fell out of the aggregate on BOTH sides and compared equal no
 * matter what the migration did to it.
 *
 * `N:` is a TAG, not a sentinel byte: a non-NULL field always encodes as
 * `S<length>:<text>`, so nothing a column can contain ever produces it.
 */
export const DIGEST_NULL_FIELD_SQL = "'N:'"

/**
 * One field, framed by its own length.
 *
 * WHY NOT A DELIMITER. The encoding this replaces separated columns with
 * `chr(2)` and rows with `chr(3)` and asserted, in a comment, that "no value can
 * forge either". That is not true of PostgreSQL `text`: a column may hold any
 * code point other than U+0000, control characters included, so a crafted value
 * could shift a column or a row boundary and make two different tables digest
 * identically. The same held for the NULL sentinel `chr(1)||'NULL'`, which a
 * string could simply contain.
 *
 * Length framing removes the assumption instead of restating it. A reader of
 * `S3:abcN:S0:` is driven by counts, never by scanning for a byte, so the
 * encoding is injective over ANY field contents: `N:` (NULL) and `S0:` (the
 * empty string) are different, and no field's text can end its own frame early
 * or start the next one.
 */
export function digestFieldSql(column) {
  if (typeof column !== 'string' || !SQL_IDENTIFIER.test(column)) {
    throw new Error(`Refusing to digest the column name ${JSON.stringify(column)}.`)
  }
  return (
    `case when "${column}" is null then ${DIGEST_NULL_FIELD_SQL} ` +
    `else 'S' || length("${column}"::text) || ':' || "${column}"::text end`
  )
}

/**
 * The same encoding, in JavaScript, so the property that matters can be proved
 * without a database.
 *
 * These model the SQL above structurally; they are what the hermetic verifier
 * round-trips control characters, delimiter-like text, NULL, the empty string
 * and ordinary values through. (JavaScript counts UTF-16 code units where
 * PostgreSQL `length()` counts characters — each encoding is self-consistent and
 * injective on its own side, which is all the comparison needs, since both
 * digests of a table are produced by the same expression.)
 */
export function encodeDigestField(value) {
  if (value === null || value === undefined) return 'N:'
  const text = String(value)
  return `S${text.length}:${text}`
}

export function encodeDigestRow(values) {
  const body = (values ?? []).map(encodeDigestField).join('')
  return `R${body.length}:${body}`
}

export function encodeDigestRows(rows) {
  return (rows ?? []).map(encodeDigestRow).join('')
}

const decodeDigestFields = (body) => {
  const values = []
  let at = 0
  while (at < body.length) {
    const tag = body[at]
    if (tag === 'N') {
      if (body[at + 1] !== ':') throw new Error('Malformed digest field: a NULL tag without its colon.')
      values.push(null)
      at += 2
      continue
    }
    if (tag !== 'S') throw new Error(`Malformed digest field: unknown tag ${JSON.stringify(tag)}.`)
    const colon = body.indexOf(':', at + 1)
    if (colon === -1) throw new Error('Malformed digest field: no length terminator.')
    const digits = body.slice(at + 1, colon)
    if (!/^\d+$/.test(digits)) throw new Error('Malformed digest field: length is not a count.')
    const length = Number(digits)
    const text = body.slice(colon + 1, colon + 1 + length)
    if (text.length !== length) throw new Error('Malformed digest field: the frame is short.')
    values.push(text)
    at = colon + 1 + length
  }
  return values
}

/**
 * The decoder exists so injectivity is demonstrated rather than asserted: an
 * encoding that round-trips every hostile value is an encoding no value can
 * forge a boundary in.
 */
export function decodeDigestRows(encoded) {
  if (typeof encoded !== 'string') throw new Error('Refusing to decode a digest input that is not a string.')
  const rows = []
  let at = 0
  while (at < encoded.length) {
    if (encoded[at] !== 'R') throw new Error('Malformed digest row: no row tag.')
    const colon = encoded.indexOf(':', at + 1)
    if (colon === -1) throw new Error('Malformed digest row: no length terminator.')
    const digits = encoded.slice(at + 1, colon)
    if (!/^\d+$/.test(digits)) throw new Error('Malformed digest row: length is not a count.')
    const length = Number(digits)
    const body = encoded.slice(colon + 1, colon + 1 + length)
    if (body.length !== length) throw new Error('Malformed digest row: the frame is short.')
    rows.push(decodeDigestFields(body))
    at = colon + 1 + length
  }
  return rows
}

/**
 * A deterministic, null-distinguishing digest of one table, plus the number of
 * rows it covered.
 *
 * The row count travels WITH the digest on purpose: a digest that silently
 * covered fewer rows than the table holds is the exact failure mode above, and
 * `evaluateCarriedData` refuses to conclude anything from a digest whose
 * coverage does not equal the table's own count.
 */
export function buildRowDigestQuery({ table, columns, orderBy = 'id' }) {
  if (typeof table !== 'string' || !SQL_IDENTIFIER.test(table)) {
    throw new Error(`Refusing to build a digest query for the table name ${JSON.stringify(table)}.`)
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`Refusing to build a digest query for "${table}" with no columns.`)
  }
  for (const column of columns) {
    if (typeof column !== 'string' || !SQL_IDENTIFIER.test(column)) {
      throw new Error(`Refusing to digest the column name ${JSON.stringify(column)} of "${table}".`)
    }
  }
  if (typeof orderBy !== 'string' || !SQL_IDENTIFIER.test(orderBy) || !columns.includes(orderBy)) {
    throw new Error(`Refusing to order the digest of "${table}" by ${JSON.stringify(orderBy)}.`)
  }

  /*
   * Every field is length-framed and every row is length-framed, so the
   * aggregate needs no delimiter at all: the boundaries are counts, and a count
   * is not something a value can contain.
   */
  const fields = columns.map((column) => digestFieldSql(column)).join(' || ')
  return (
    `select count(*)::int as n,\n` +
    `       coalesce(md5(string_agg('R' || length("row_body") || ':' || "row_body", '' order by "${orderBy}")), 'empty') as d\n` +
    `  from (select "${orderBy}", ${fields} as "row_body" from "${table}") as "digest_rows"`
  )
}

const usableDigest = (side) =>
  side !== null &&
  typeof side === 'object' &&
  typeof side.digest === 'string' &&
  side.digest.length > 0 &&
  Number.isInteger(side.rows)

/**
 * What the carried data proves, and nothing beyond it.
 *
 * Every comparison here fails closed on missing evidence: a count that was not
 * observed on both sides, a digest that is absent, and a digest that did not
 * cover every row of its table are all failures, because each of them is a
 * question that was not answered rather than an answer of "unchanged".
 */
export function evaluateCarriedData({ before, after }) {
  const problems = []

  for (const table of CARRIED_TABLES) {
    const b = before?.counts?.[table]
    const a = after?.counts?.[table]
    if (!Number.isInteger(b) || !Number.isInteger(a)) {
      problems.push(
        `The row count of "${table}" was not observed on both sides, so nothing may be concluded about it.`,
      )
      continue
    }
    if (a !== b) problems.push(`${table} row count changed: ${b} -> ${a}`)
  }

  for (const [table, columns] of Object.entries(CARRIED_DIGEST_COLUMNS)) {
    const b = before?.digests?.[table]
    const a = after?.digests?.[table]
    if (!usableDigest(b) || !usableDigest(a)) {
      problems.push(
        `No usable digest of "${table}" (${columns.join(', ')}) was observed on both sides, so its rows ` +
          'are unverified.',
      )
      continue
    }

    for (const [label, side, counts] of [
      ['before', b, before?.counts],
      ['after', a, after?.counts],
    ]) {
      const count = counts?.[table]
      if (Number.isInteger(count) && side.rows !== count) {
        problems.push(
          `The ${label} digest of "${table}" covered ${side.rows} of ${count} row(s). A digest that does ` +
            'not cover every row is not evidence about the rows it missed.',
        )
      }
    }

    if (a.digest !== b.digest) {
      problems.push(`The digest of "${table}" over (${columns.join(', ')}) changed.`)
    }
  }

  return { problems }
}

/* ========================================================= media backfill == */

/** The only value `media.kind` may hold once 0016 has been applied and backfilled. */
export const MEDIA_IMAGE_KIND = 'image'

/**
 * The exhaustive post-migration check, NULL-SAFE.
 *
 * `kind <> 'image'` is not this predicate. In PostgreSQL a comparison against
 * NULL is NULL, never true, so `where kind <> 'image'` counts zero rows whether
 * the backfill worked or left every row's `kind` NULL — the one outcome the
 * check exists to catch. `IS DISTINCT FROM` is the null-safe form: it is true
 * for NULL and for any non-'image' value alike.
 */
export const MEDIA_NON_IMAGE_PREDICATE_SQL = `"kind" is distinct from '${MEDIA_IMAGE_KIND}'`

export const MEDIA_BACKFILL_QUERY =
  `select count(*)::int as n from media where ${MEDIA_NON_IMAGE_PREDICATE_SQL}`

/**
 * The same predicate in JavaScript, so the contract is testable hermetically.
 * A missing/NULL kind counts, exactly as `IS DISTINCT FROM` counts it.
 */
export function isNonImageKind(kind) {
  return kind !== MEDIA_IMAGE_KIND
}

/** The `media.kind` backfill, which IS proved exhaustively and may be said so. */
export function evaluateMediaBackfill(nonImageRows) {
  if (!Number.isInteger(nonImageRows)) {
    return { problems: ["The media backfill was not observed, so 'image' cannot be claimed for any row."] }
  }
  if (nonImageRows !== 0) {
    return {
      problems: [
        `${nonImageRows} pre-existing media row(s) hold a kind that is NULL or some other value — they ` +
          "did not backfill to 'image'.",
      ],
    }
  }
  return { problems: [] }
}

/**
 * The carried-data report, in words the evidence actually supports.
 *
 * THE WORDING IS PART OF THE CONTRACT. The previous version printed "every
 * carried row is byte-identical" on the strength of five row counts and two
 * partial-column digests that dropped every row containing a NULL. A rehearsal
 * is believed; a rehearsal that overstates what it checked is worse than one
 * that checks less and says so, because the overstatement is what gets quoted in
 * the decision to migrate production.
 */
export function describeCarriedEvidence(signature) {
  const counts = CARRIED_TABLES.map((table) => `${table} ${signature?.counts?.[table] ?? '?'}`).join(', ')
  const digested = Object.entries(CARRIED_DIGEST_COLUMNS)
    .map(([table, columns]) => `${table}(${columns.join(', ')})`)
    .join(' and ')
  return (
    `row counts held across all ${CARRIED_TABLES.length} carried tables (${counts}); ` +
    `a null-safe, length-framed digest of ${digested} covering every row of those tables is unchanged ` +
    '(NULL and the empty string encode differently, and no field or row content can move a boundary, ' +
    'because the boundaries are lengths rather than delimiter bytes); ' +
    CARRIED_EVIDENCE_DISCLAIMER
  )
}

/* =============================================================== identity == */

/**
 * THE HEALTH ORIGIN IS A CONSTANT, NOT AN ARGUMENT.
 *
 * Every refusal downstream is anchored to what ONE specific deployment says
 * about itself: the parent branch is cloned only because the live application at
 * this origin published the fingerprint that branch resolves to. An origin that
 * can be supplied on the command line is an origin that can be pointed at a
 * preview deployment, a local server, a look-alike host, or a plaintext proxy —
 * and the fingerprint comparison would then be comparing production's Neon
 * branch against somebody else's idea of production.
 *
 * There is no override. `resolveHealthOrigin` returns this constant in every
 * branch, so a caller that ignored its `problems` entirely still cannot obtain a
 * different origin from it. The problems exist so that an operator who tried
 * gets an explanation instead of a silently different run.
 */
export const PRODUCTION_HEALTH_ORIGIN = 'https://cloudmarket.cc'
export const PRODUCTION_HEALTH_URL = `${PRODUCTION_HEALTH_ORIGIN}/api/health`

/**
 * The fetch redirect policy, as a value, so the runner cannot quietly stop
 * refusing redirects without this constant changing.
 *
 * `'error'` makes a 3xx a transport failure instead of a hop. Following one
 * would move the identity check to whatever the response's `Location` named —
 * an attacker-influenced DNS answer, an HTTP downgrade, a look-alike host — and
 * every refusal downstream is anchored to what THAT deployment published.
 */
export const HEALTH_REDIRECT_POLICY = 'error'

/**
 * Anything shaped like an attempt to supply an origin: a scheme-qualified URL in
 * any scheme, or a flag whose name means "where to look".
 *
 * The flag name is captured so the refusal can say WHICH kind of argument it
 * refused without repeating the argument.
 */
const ORIGIN_ARGUMENT =
  /^(?:[a-z][a-z0-9+.-]*:\/\/|--(base|base-url|url|origin|host|hostname|endpoint|health|target)(?:=|$))/i

/** The flag names above as a closed set: a refusal may echo one of these and nothing else. */
const ORIGIN_FLAGS = Object.freeze([
  'base',
  'base-url',
  'url',
  'origin',
  'host',
  'hostname',
  'endpoint',
  'health',
  'target',
])

/**
 * The production health origin, and a refusal for anyone who tried to change it.
 *
 * THE REFUSAL NEVER REPEATS THE ARGUMENT. It used to print `Refusing "${arg}"`,
 * which meant the one input this tooling is guaranteed to reject was also the
 * one input it echoed verbatim — into a terminal and into whatever CI log was
 * watching. A rejected argument is a URL-shaped string a human just typed or
 * pasted: `https://user:password@…`, `…?token=…`, a DSN. Worse, this refusal
 * happens at startup, BEFORE the runner's redaction has any secrets registered,
 * so there is nothing downstream that would catch it.
 *
 * What is reported is the argument's position and its shape, both of which come
 * from this module rather than from the value: the position is an index, and the
 * shape is either "a scheme-qualified URL" or one of the nine flag names above.
 *
 * @param {readonly unknown[]} argv  the user-supplied arguments only
 */
export function resolveHealthOrigin(argv) {
  const problems = []

  const args = Array.isArray(argv) ? argv : []
  args.forEach((arg, index) => {
    if (typeof arg !== 'string') return
    const match = ORIGIN_ARGUMENT.exec(arg.trim())
    if (match === null) return
    const flag =
      typeof match[1] === 'string' && ORIGIN_FLAGS.includes(match[1].toLowerCase())
        ? `--${match[1].toLowerCase()}`
        : null
    problems.push(
      `Refusing argument #${index + 1} (${flag ? `the ${flag} flag` : 'a scheme-qualified URL'}): the health ` +
        `origin of this production rehearsal is fixed at ${PRODUCTION_HEALTH_ORIGIN}. It cannot be ` +
        'redirected to another scheme, host, port, or credentialed URL, and this tooling reads it from no ' +
        'argument and no variable. The supplied value is deliberately not repeated here: a rejected ' +
        'argument may carry userinfo, a password, a token, or a query secret, and this refusal happens ' +
        'before any redaction exists to catch it.',
    )
  })

  return { problems, origin: PRODUCTION_HEALTH_ORIGIN, url: PRODUCTION_HEALTH_URL }
}

/**
 * A URL described by its origin alone — scheme, host, port — and nothing else.
 *
 * Used where an unexpected URL must be reported to an operator: `origin` cannot
 * carry userinfo, a path, a query, or a fragment, so it names the destination
 * without reproducing whatever secret was travelling in it.
 */
export function describeOriginSafely(value) {
  try {
    return new URL(value).origin
  } catch {
    return '(an unparseable URL)'
  }
}

/**
 * THE RESPONSE MUST HAVE COME FROM THE EXACT URL, NOT FROM WHEREVER IT LED.
 *
 * `evaluateHealthIdentity` judges what the body says. This judges where the body
 * came from, which is the question a redirect answers differently from the
 * request: `fetch` is configured with `redirect: 'error'`, so a 3xx never
 * becomes a hop, and the response's own URL is then required to be
 * `PRODUCTION_HEALTH_URL` character for character. A trailing slash, an explicit
 * `:443`, an added query, userinfo, a subdomain, or plain HTTP are all "not that
 * URL" and therefore cannot establish production identity.
 */
export function evaluateHealthEndpointIdentity({ url, redirected }) {
  const problems = []

  if (redirected === true) {
    problems.push(
      `The health request was redirected. Production identity may only be established by ` +
        `${PRODUCTION_HEALTH_URL} answering it directly, so a redirect is refused rather than followed.`,
    )
  }
  if (typeof url !== 'string' || url.length === 0) {
    problems.push(
      `The health response reported no URL of its own, so it cannot be shown to have come from ` +
        `${PRODUCTION_HEALTH_URL}.`,
    )
    return { problems }
  }
  if (url !== PRODUCTION_HEALTH_URL) {
    problems.push(
      `The health response did not come from ${PRODUCTION_HEALTH_URL} exactly (its origin is ` +
        `${describeOriginSafely(url)}). A different scheme, host, port, path, query, or a followed ` +
        'redirect cannot anchor this rehearsal. Only the origin is reported here: the rest of a URL may ' +
        'carry userinfo, a token, or a query secret.',
    )
  }

  return { problems }
}

/**
 * The deployed application must say, in its own words, that it is production
 * and that it is talking to the database this repository expects.
 *
 * Both halves are required. "Production" alone would accept a production
 * deployment pointed at a database nobody wrote down; the fingerprint alone
 * would accept a preview deployment that happens to share production's
 * connection string.
 */
export function evaluateHealthIdentity({ reachable, httpStatus, body, expectedFingerprint }) {
  const problems = []

  if (!reachable) {
    problems.push('The deployed health endpoint could not be reached, so production identity is unverifiable.')
    return { problems, fingerprint: null }
  }
  if (httpStatus !== 200) {
    problems.push(`The health endpoint returned HTTP ${httpStatus}; production identity is unverifiable.`)
  }
  if (!body || typeof body !== 'object') {
    problems.push('The health endpoint did not return a JSON object.')
    return { problems, fingerprint: null }
  }
  if (body.environment !== 'production') {
    problems.push(
      `The deployment reports environment "${body.environment ?? '(none)'}", not "production". Only the ` +
        'production deployment may anchor the parent this rehearsal clones.',
    )
  }
  if (body.status !== 'ok') {
    problems.push(`The deployment reports status "${body.status ?? '(none)'}", not "ok".`)
  }
  if (body.database?.configured !== true || body.database?.reachable !== true) {
    problems.push('The deployment does not report a configured, reachable database.')
  }

  const fingerprint =
    typeof body.database?.fingerprint === 'string' && body.database.fingerprint.trim().length > 0
      ? body.database.fingerprint.trim()
      : null

  if (fingerprint === null) {
    problems.push('The health endpoint published no database fingerprint.')
  } else if (typeof expectedFingerprint !== 'string' || expectedFingerprint.length === 0) {
    problems.push('No expected production fingerprint was supplied to compare against.')
  } else if (fingerprint !== expectedFingerprint) {
    problems.push(
      `The live database fingerprint is ${fingerprint}, but this repository expects ` +
        `${expectedFingerprint}. Either production moved or the recorded constant is stale — a person ` +
        'must decide which, and nothing may be cloned until they have.',
    )
  }

  return { problems, fingerprint }
}

/**
 * Which branch is production, and is the control plane unambiguous about it?
 *
 * `findDefaultBranch` in `neon-api.mjs` falls back from `default` to `primary`,
 * which is right for a helper that only needs a branch to read. It is wrong
 * here: a project where those two flags disagree is a project where nobody can
 * say what production is, and that is a stop.
 */
export function evaluateBranchTopology(branches) {
  const problems = []

  if (!Array.isArray(branches) || branches.length === 0) {
    return { problems: ['Neon returned no branches for this project.'], parent: null, flagEvidence: null }
  }

  for (const branch of branches) {
    if (typeof branch?.id !== 'string' || branch.id.length === 0) {
      problems.push('A branch in this project has no id, so its metadata cannot be trusted.')
    }
    if (typeof branch?.name !== 'string' || branch.name.length === 0) {
      problems.push(`Branch ${branch?.id ?? '(no id)'} has no name.`)
    }
    for (const flag of ['default', 'primary']) {
      const value = branch?.[flag]
      if (value !== undefined && value !== null && typeof value !== 'boolean') {
        problems.push(`Branch "${branch?.name}" reports a non-boolean "${flag}" (${String(value)}).`)
      }
    }
  }

  const defaults = branches.filter((b) => b.default === true)
  const primaries = branches.filter((b) => b.primary === true)

  if (defaults.length === 0 && primaries.length === 0) {
    problems.push(
      'No branch in this project is marked default or primary, so production cannot be identified.',
    )
  }
  if (defaults.length > 1) {
    problems.push(`${defaults.length} branches are marked default; production is ambiguous.`)
  }
  if (primaries.length > 1) {
    problems.push(`${primaries.length} branches are marked primary; production is ambiguous.`)
  }
  if (defaults.length === 1 && primaries.length === 1 && defaults[0].id !== primaries[0].id) {
    problems.push(
      `The default branch ("${defaults[0].name}") and the primary branch ("${primaries[0].name}") are ` +
        'different branches. Nothing may be cloned while the control plane disagrees with itself.',
    )
  }

  return {
    problems,
    /*
     * Either flag may identify production, but they may never identify
     * different branches and neither may identify two. A control plane that
     * reports only one of the pair is answerable; one that contradicts itself
     * is not.
     */
    parent: problems.length === 0 ? (defaults[0] ?? primaries[0]) : null,
    /*
     * Whether the API populates each flag AT ALL in this project. Used to decide
     * whether an absent flag on the clone means "false" or means "unknown".
     */
    flagEvidence: {
      default: defaults.length === 1,
      primary: primaries.length === 1,
    },
  }
}

/**
 * A safety-critical clone flag is accepted only when the control plane
 * explicitly reports `false`. Omission, null, or any non-boolean value is
 * ambiguous and therefore blocks the rehearsal.
 */
export function interpretBranchFlag(value) {
  if (value === true) return 'set'
  if (value === false) return 'clear'
  return 'ambiguous'
}

/** The clone must be demonstrably a child, and demonstrably not production. */
export function evaluateCloneMetadata({ clone, parent }) {
  const problems = []

  if (!clone || typeof clone.id !== 'string' || clone.id.length === 0) {
    return { problems: ['Branch creation returned no usable branch metadata.'] }
  }
  if (clone.id === parent?.id) {
    problems.push('The created branch reports the same id as the production parent.')
  }
  if (typeof clone.name !== 'string' || !clone.name.startsWith(REHEARSAL_BRANCH_PREFIX)) {
    problems.push(`The created branch is named "${clone.name}", which is not a ${REHEARSAL_BRANCH_PREFIX}* name.`)
  }
  if (clone.parent_id !== parent?.id) {
    problems.push(
      `The created branch reports parent_id ${clone.parent_id ?? '(none)'}, not the verified production ` +
        `parent ${parent?.id}.`,
    )
  }

  for (const flag of ['default', 'primary']) {
    const state = interpretBranchFlag(clone[flag])
    if (state === 'set') {
      problems.push(`The created branch is marked ${flag}. Nothing further may run against it.`)
    } else if (state === 'ambiguous') {
      problems.push(
        `The created branch must explicitly report "${flag}: false"; received ${String(clone[flag])}. ` +
          'This rehearsal will not proceed on an inferred or unproven negative.',
      )
    }
  }

  return { problems }
}

/**
 * The connection targets must be the clone's own, and must not be production —
 * current or retired — under either the live fingerprint or the recorded ones.
 */
export function evaluateCloneTargets({
  pooledHost,
  directHost,
  pooledEndpoint,
  directEndpoint,
  parentPooledHost,
  parentEndpoint,
  liveFingerprint,
}) {
  const problems = []

  for (const [label, fp] of [
    ['pooled', pooledHost],
    ['direct', directHost],
  ]) {
    if (typeof fp !== 'string' || fp.length === 0) {
      problems.push(`The clone's ${label} target produced no fingerprint.`)
      continue
    }
    if (isProductionHostFingerprint(fp)) {
      problems.push(`The clone's ${label} target matches a current or retired production fingerprint (${fp}).`)
    }
    if (typeof liveFingerprint === 'string' && fp === liveFingerprint) {
      problems.push(`The clone's ${label} target IS the database the live application is using.`)
    }
    if (typeof parentPooledHost === 'string' && fp === parentPooledHost) {
      problems.push(`The clone's ${label} target is the production parent's own host.`)
    }
  }

  if (typeof parentEndpoint === 'string' && parentEndpoint.length > 0) {
    for (const [label, fp] of [
      ['pooled', pooledEndpoint],
      ['direct', directEndpoint],
    ]) {
      if (fp === parentEndpoint) {
        problems.push(`The clone's ${label} target is on production's compute endpoint (${fp}).`)
      }
    }
  }

  if (
    typeof pooledEndpoint === 'string' &&
    typeof directEndpoint === 'string' &&
    pooledEndpoint !== directEndpoint
  ) {
    problems.push('The clone\'s pooled and direct strings are on different endpoints, so they are not one branch.')
  }

  return { problems }
}

/* ============================================================= redaction === */

/** What every suppressed value is replaced by, so a redaction is visible. */
export const REDACTED = '[redacted]'

/**
 * A URI in a scheme Postgres is reached over, credentials or not.
 *
 * Matched structurally rather than by literal, because the value that must never
 * be printed is not always a value this process is holding: `drizzle-kit`
 * rewrites, quotes, and truncates the string it was handed, and a driver error
 * can carry a URI assembled somewhere else entirely.
 */
const POSTGRES_URI = /\bpostgres(?:ql)?:\/\/[^\s'"`<>]*/gi

/** Any URI carrying userinfo, in any scheme — `scheme://user:secret@host/…`. */
const CREDENTIALED_URI = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]*@[^\s'"`<>]*/gi

/** `DATABASE_URL=…`, `DATABASE_URL: …`, and the rest of the named carriers. */
const SECRET_ASSIGNMENT =
  /\b(DATABASE_URL_UNPOOLED|DATABASE_URL|POSTGRES_URL|PGPASSWORD|NEON_API_KEY)\b(\s*[=:]\s*)("?)([^\s'"`,;]+)\3/g

/** `password=…` and `password: …` in a query string, DSN, or log line. */
const PASSWORD_ASSIGNMENT = /\b(password|pgpassword|pwd)\b(\s*[=:]\s*)("?)([^\s&'"`,;]+)\3/gi

/**
 * Everything a connection string discloses, decomposed.
 *
 * The whole URI is only the easiest form to spot. Tools print the userinfo alone,
 * the password alone, and the URI with the scheme stripped, and any one of those
 * is the credential. Returned longest-first so a shorter component cannot chop a
 * longer one into unrecognisable pieces before it is matched.
 */
export function collectSecretLiterals(secrets) {
  const literals = new Set()
  /* Four characters is the floor: shorter fragments match unrelated prose. */
  const add = (value) => {
    if (typeof value === 'string' && value.trim().length >= 4) literals.add(value.trim())
  }

  for (const secret of secrets ?? []) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    add(secret)

    const scheme = secret.indexOf('://')
    if (scheme === -1) continue
    const rest = secret.slice(scheme + 3)
    add(rest)

    const at = rest.lastIndexOf('@')
    if (at === -1) continue

    /*
     * The host too. It is not a credential, but it is half of a connection
     * target that this tooling prints only as a 12-character fingerprint, and a
     * child process writing `host=… user=… password=…` should not be the thing
     * that discloses it.
     */
    const authority = rest.slice(at + 1)
    const slash = authority.indexOf('/')
    add(slash === -1 ? authority : authority.slice(0, slash))

    const userinfo = rest.slice(0, at)
    add(userinfo)
    const colon = userinfo.indexOf(':')
    if (colon !== -1) {
      add(userinfo.slice(0, colon))
      add(userinfo.slice(colon + 1))
      try {
        add(decodeURIComponent(userinfo.slice(colon + 1)))
      } catch {
        /* A password that is not valid percent-encoding is already covered above. */
      }
    }
  }

  return [...literals].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

/**
 * Credentials out of anything about to be printed.
 *
 * WHY THIS IS NOT OPTIONAL. The clone is a byte-for-byte copy of production and
 * its connection string is handed to a child process as `DATABASE_URL` and
 * `DATABASE_URL_UNPOOLED`. When `drizzle-kit migrate` fails, it prints the
 * configuration it was given; when the driver fails, the URI is frequently in
 * `error.message`. The previous runner echoed the last three kilobytes of that
 * output verbatim, into a terminal and into whatever CI log was watching. A
 * credential in a build log is a credential that has been disclosed.
 *
 * Redaction is applied to child stdout, child stderr, and every Error-derived
 * string, ALWAYS — including on the success path, because "it only prints on
 * failure" is a property of today's code, not of the value.
 */
export function redactSecrets(value, secrets = []) {
  let text
  if (typeof value === 'string') text = value
  else if (value === null || value === undefined) text = ''
  else if (value instanceof Error) text = value.message
  else text = String(value)

  for (const literal of collectSecretLiterals(secrets)) {
    text = text.split(literal).join(REDACTED)
  }

  text = text.replace(POSTGRES_URI, REDACTED)
  text = text.replace(CREDENTIALED_URI, REDACTED)
  text = text.replace(SECRET_ASSIGNMENT, `$1$2${REDACTED}`)
  text = text.replace(PASSWORD_ASSIGNMENT, `$1$2${REDACTED}`)

  return text
}

/* ========================================================= the one command = */

/** The only command this tooling is permitted to run against the clone. */
export const MIGRATION_ARGV = Object.freeze(['drizzle-kit', 'migrate'])

/**
 * The repository's real migrate path, and nothing adjacent to it.
 *
 * `--step`, `--to`, a bare `push`, or anything else that would apply a subset,
 * regenerate, or repair is refused here rather than merely not used, so that a
 * future edit to the runner cannot quietly acquire the ability.
 */
export function assertMigrationCommand(file, args) {
  const problems = []
  const normalizedFile = String(file ?? '').toLowerCase()
  if (normalizedFile !== 'npx' && normalizedFile !== 'npx.cmd') {
    problems.push(`Refusing to run "${file}": the rehearsal may only invoke npx drizzle-kit migrate.`)
  }
  if (!Array.isArray(args) || args.length !== MIGRATION_ARGV.length) {
    problems.push(`Refusing an argument list of ${Array.isArray(args) ? args.length : 'unknown'} item(s).`)
  } else {
    args.forEach((arg, i) => {
      if (arg !== MIGRATION_ARGV[i]) {
        problems.push(`Refusing argument ${i} "${arg}": expected "${MIGRATION_ARGV[i]}".`)
      }
    })
  }
  if (problems.length > 0) throw new Error(problems.join(' '))
  return true
}

/**
 * One invocation, and only after the preflight has explicitly cleared it.
 *
 * The gate is a value rather than a flag on the runner because "did the
 * preflight pass?" and "has this already run?" are the two questions whose wrong
 * answer would put a second, unreviewed migration onto a database.
 */
export function createMigrationGate(invoke) {
  let cleared = false
  let invocations = 0

  return {
    clear() {
      cleared = true
    },
    get invocations() {
      return invocations
    },
    run(file, args, options) {
      if (!cleared) {
        throw new Error('REFUSING: the migration command was reached without a drift-free preflight.')
      }
      if (invocations > 0) {
        throw new Error('REFUSING: the migration command has already run once. Exactly one invocation is permitted.')
      }
      assertMigrationCommand(file, args)
      invocations += 1
      return invoke(file, args, options)
    },
  }
}

/* ==================================================== probes and cleanup === */

/**
 * The probe transaction's whole lifecycle: begin, body, rollback, release — in
 * that order, on every path there is.
 *
 * WHY THIS IS A FUNCTION AND NOT FOUR LINES IN THE RUNNER. "Nothing persists" is
 * the entire basis on which the probes are safe to run against a copy of
 * production, and it rests on a `rollback` that the previous version placed as
 * the last statement of the `try` block. Any unexpected exception above it — a
 * driver error, a null dereference in a `settle` expression, a socket dropping —
 * skipped the rollback and went straight to `client.release()`, returning a
 * connection to the pool with an open write transaction on it, whose fate is
 * then whatever the pool decides. Extracted here, the ordering is a property of
 * a function that can be tested with counters instead of a database.
 *
 * THE ROLLBACK'S FAILURE IS NEVER SWALLOWED. It is the one error that means the
 * probe rows may still be there, so it propagates even when it displaces the
 * error that caused the rollback, and it propagates even from the success path.
 * `release` still runs, because a leaked connection helps nobody.
 *
 * NOR IS IT SWALLOWED BY THE RELEASE. The rollback used to run in a `try` whose
 * `finally` awaited `release()`, so when BOTH failed the release's error
 * replaced the rollback's on the way out — and "the connection could not be
 * returned to the pool" would have been printed where "the probe rows may still
 * be in this database" belonged. Both failures are collected now: the thrown
 * error is an AggregateError whose `errors` are the cleanup failures in
 * precedence order (rollback first, release second) and whose message names
 * every one of them, so nothing disappears.
 *
 * A RELEASE FAILURE ALONE STILL FAILS THE REHEARSAL. A connection whose fate is
 * unknown is not a detail to log past.
 *
 * THE ORIGINAL FAILURE IS KEPT WHERE IT DOES NOT COMPETE. When the body (or the
 * begin) failed too, its error travels as `cause` rather than in the message, so
 * an operator still has it without the rollback failure being pushed down the
 * page. When cleanup succeeded, that error is simply rethrown as it was.
 *
 * `rollback` is attempted only if `begin` reported success: rolling back a
 * transaction that was never opened would replace a real connection error with a
 * meaningless one.
 */
const asError = (error) => (error instanceof Error ? error : new Error(String(error)))

export async function withProbeTransaction({ begin, body, rollback, release }) {
  for (const [name, fn] of [
    ['begin', begin],
    ['body', body],
    ['rollback', rollback],
    ['release', release],
  ]) {
    if (typeof fn !== 'function') {
      throw new TypeError(`withProbeTransaction requires a ${name} function; the probes will not run without one.`)
    }
  }

  let began = false
  let result
  let bodyError = null
  let rollbackError = null
  let releaseError = null

  try {
    await begin()
    began = true
    result = await body()
  } catch (error) {
    bodyError = asError(error)
  } finally {
    try {
      if (began) await rollback()
    } catch (error) {
      rollbackError = asError(error)
    } finally {
      try {
        await release()
      } catch (error) {
        releaseError = asError(error)
      }
    }
  }

  const cleanupFailures = []
  if (rollbackError !== null) cleanupFailures.push(rollbackError)
  if (releaseError !== null) cleanupFailures.push(releaseError)

  if (cleanupFailures.length > 0) {
    const failure = new AggregateError(
      cleanupFailures,
      cleanupFailures.map((error) => error.message).join('; additionally, '),
    )
    if (bodyError !== null) failure.cause = bodyError
    throw failure
  }
  if (bodyError !== null) throw bodyError
  return result
}

/**
 * Probe results, judged strictly.
 *
 * A probe that was skipped, never reached, or never reported is indistinguishable
 * from a probe that would have failed, so all three are treated as failure. The
 * previous rehearsal printed "SKIPPED — needs at least one redemption" and went
 * on to report PASS, which is the specific behaviour this replaces.
 */
export function evaluateProbeOutcomes(results, required = REQUIRED_PROBES) {
  const problems = []
  const byId = new Map()

  for (const result of results ?? []) {
    if (!result || typeof result.id !== 'string') {
      problems.push('A probe reported no id, so it cannot be accounted for.')
      continue
    }
    if (byId.has(result.id)) {
      problems.push(`Probe "${result.id}" reported more than once.`)
    }
    byId.set(result.id, result)
  }

  for (const id of required) {
    const result = byId.get(id)
    if (!result) {
      problems.push(`Probe "${id}" is MISSING — it produced no result at all.`)
      continue
    }
    if (result.status !== PROBE_PASS) {
      problems.push(`Probe "${id}" reported ${result.status}${result.detail ? ` — ${result.detail}` : ''}.`)
    }
  }

  for (const id of byId.keys()) {
    if (!required.includes(id)) problems.push(`Probe "${id}" is not a declared probe of this rehearsal.`)
  }

  return { problems, passed: [...byId.values()].filter((r) => r.status === PROBE_PASS).length }
}

/**
 * Deletion guard.
 *
 * Repeated in full at the moment of deletion rather than inherited from the
 * create path, because this is also the manual recovery entry point and a
 * mistyped id there is not recoverable.
 *
 * THE FLAGS MUST BE PROVED FALSE, NOT MERELY OBSERVED NOT-TRUE. This used to ask
 * only whether either flag was strictly equal to `true`, which is a test for
 * "the control plane said yes" and therefore treats every other answer —
 * omitted, `null`, `"false"`, `0`, an object, a listing that carried no flags at
 * all — as permission to delete. That is exactly backwards for a call that
 * destroys a database: the branch this tooling is allowed to delete is one whose
 * metadata positively states it is neither the default nor the primary branch.
 *
 * `interpretBranchFlag` is the strict reading already used to admit the clone in
 * the first place (`evaluateCloneMetadata`), so the same three-way answer —
 * set / clear / ambiguous — decides both ends of the branch's life rather than a
 * second, weaker rule being invented here.
 */
export function evaluateDeletionGuard({ target, parentId, expectedName }) {
  const problems = []

  if (!target || typeof target.id !== 'string') {
    return { problems: ['Refusing to delete: no branch metadata was found for the id given.'] }
  }
  if (typeof parentId === 'string' && target.id === parentId) {
    problems.push('REFUSING to delete the production parent branch.')
  }
  for (const flag of ['default', 'primary']) {
    const state = interpretBranchFlag(target[flag])
    if (state === 'set') {
      problems.push(`REFUSING: branch ${target.id} is marked default/primary ("${flag}": true).`)
    } else if (state === 'ambiguous') {
      problems.push(
        `REFUSING: branch ${target.id} does not explicitly report "${flag}": false — it reports ` +
          `${String(target[flag])}. Deletion is permitted only on metadata that proves the branch is ` +
          'neither default nor primary; an omitted, null, or non-boolean flag is unproven, and this ' +
          'tooling does not delete a database on an inferred negative.',
      )
    }
  }
  if (typeof target.name !== 'string' || !target.name.startsWith(REHEARSAL_BRANCH_PREFIX)) {
    problems.push(
      `REFUSING: branch "${target.name}" is not a ${REHEARSAL_BRANCH_PREFIX}* branch created by this tooling.`,
    )
  }
  if (typeof expectedName === 'string' && target.name !== expectedName) {
    problems.push(`REFUSING: branch ${target.id} is named "${target.name}", not the expected "${expectedName}".`)
  }

  return { problems }
}

/* ============================================== resolving what to clean up = */

/**
 * The four answers cleanup is allowed to reach.
 *
 * `UNCONFIRMED` and `AMBIGUOUS` are deliberately different: the first is "no
 * branch by that name exists, so there may be nothing to clean up and this run
 * cannot prove it either way", and the second is "several things match, so
 * choosing one of them would be a guess". Both refuse to delete; only one of
 * them describes a possible orphan.
 *
 * `ABSENT` IS A PROPERTY OF ONE LISTING, NOT A CONCLUSION. It means only that
 * the snapshot in hand did not contain the known id. `resolveCleanupTarget`
 * reports it about a single response; `confirmCleanupTarget` is what a caller
 * uses, and it never returns `ABSENT` — because a control plane that omitted a
 * branch from one list has not said the branch is gone.
 */
export const CLEANUP_RESOLUTION = Object.freeze({
  IDENTIFIED: 'identified',
  ABSENT: 'absent',
  UNCONFIRMED: 'unconfirmed',
  AMBIGUOUS: 'ambiguous',
})

/**
 * WHICH BRANCH, IF ANY, THIS RUN MAY DELETE.
 *
 * THE ORPHAN THIS CLOSES. Neon's create-branch call can succeed server-side and
 * still fail the caller: the connection drops after the branch is committed, the
 * response is not JSON, or the JSON carries no `branch.id`. The previous runner
 * read `clone.id` from that response and only THEN entered the try/finally that
 * deletes it, so every one of those cases left a full copy of production data in
 * a branch nobody was watching, with the run reporting an error about something
 * else entirely.
 *
 * So the name is generated first, cleanup is armed before the request is made,
 * and when no trustworthy id came back this function re-lists the project and
 * looks for the name it generated — EXACTLY, not by prefix and not by
 * similarity. One match is the branch this run created, because the name embeds
 * a timestamp and was proved absent from the project moments earlier. Zero
 * matches is unconfirmed. More than one is a refusal, not a choice.
 *
 * This function never decides that deletion is SAFE. Whatever it identifies is
 * still put through `evaluateDeletionGuard`, which is what refuses the
 * production parent, a default or primary branch, a non-`rehearsal-*` branch,
 * and a branch whose name is not the expected one.
 */
export function resolveCleanupTarget({ cloneId, branchName, branches }) {
  if (!Array.isArray(branches)) {
    return {
      status: CLEANUP_RESOLUTION.AMBIGUOUS,
      target: null,
      matchedBy: null,
      problems: ['Neon returned no branch list, so no branch may be deleted on the strength of it.'],
    }
  }

  const trustworthyId = typeof cloneId === 'string' && cloneId.trim().length > 0 ? cloneId.trim() : null

  if (trustworthyId !== null) {
    const byId = branches.filter((b) => b?.id === trustworthyId)
    if (byId.length === 1) {
      return { status: CLEANUP_RESOLUTION.IDENTIFIED, target: byId[0], matchedBy: 'id', problems: [] }
    }
    if (byId.length > 1) {
      return {
        status: CLEANUP_RESOLUTION.AMBIGUOUS,
        target: null,
        matchedBy: null,
        problems: [`REFUSING: ${byId.length} branches report the id "${trustworthyId}".`],
      }
    }
    /*
     * NOT "IT IS GONE". This listing does not contain the id; that is all. The
     * caller (`confirmCleanupTarget`) re-lists, and falls back to the exact
     * generated name, before anyone is allowed to conclude anything from it.
     */
    return { status: CLEANUP_RESOLUTION.ABSENT, target: null, matchedBy: null, problems: [] }
  }

  /*
   * No id. The generated name is the only handle left, and it is usable only
   * because this tooling generated it: a name it did not generate could match
   * anything.
   */
  if (typeof branchName !== 'string' || !branchName.startsWith(REHEARSAL_BRANCH_PREFIX)) {
    return {
      status: CLEANUP_RESOLUTION.AMBIGUOUS,
      target: null,
      matchedBy: null,
      problems: [
        'REFUSING: no clone id and no generated ' +
          `${REHEARSAL_BRANCH_PREFIX}* name are available, so there is nothing this run may safely delete.`,
      ],
    }
  }

  const exact = branches.filter((b) => typeof b?.name === 'string' && b.name === branchName)

  if (exact.length === 1) {
    return { status: CLEANUP_RESOLUTION.IDENTIFIED, target: exact[0], matchedBy: 'name', problems: [] }
  }
  if (exact.length === 0) {
    return {
      status: CLEANUP_RESOLUTION.UNCONFIRMED,
      target: null,
      matchedBy: null,
      problems: [
        `Cleanup could not confirm a branch: no branch in this project is named exactly "${branchName}". ` +
          'Either the branch was never created or it is not visible here. Nothing was deleted; check the ' +
          'project by hand before assuming there is no orphan.',
      ],
    }
  }
  return {
    status: CLEANUP_RESOLUTION.AMBIGUOUS,
    target: null,
    matchedBy: null,
    problems: [
      `REFUSING: ${exact.length} branches are named exactly "${branchName}". Deleting one of them would ` +
        'be a guess, and a wrong guess here deletes a database. Resolve it by hand.',
    ],
  }
}

/** How many branch listings cleanup may ask for before it gives up and says so. */
export const CLEANUP_LIST_ATTEMPTS = 3

/** How long to wait before each re-listing. The first attempt never waits. */
export const CLEANUP_RELIST_DELAY_MS = Object.freeze([0, 750, 2000])

const defaultCleanupWait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * WHAT CLEANUP MAY DELETE, AFTER LOOKING MORE THAN ONCE.
 *
 * THE FALSE NEGATIVE THIS CLOSES. A single branch listing that does not mention
 * the id this run created was previously read as `ABSENT` and reported as
 * "branch … no longer exists", with the run exiting zero. Neon's control plane
 * is a distributed system: a listing taken moments after a create can lag, and a
 * listing is in any case a statement about what the API returned, never a proof
 * that a branch does not exist. That path could therefore announce a clean-up
 * that never happened and leave a byte-for-byte copy of production behind, with
 * nothing in the output suggesting anyone should look.
 *
 * So absence is now something this function tries hard to disprove and never
 * asserts:
 *
 *   1. The known id is looked up in each listing.
 *   2. When a listing does not carry it, the EXACT generated name is tried on
 *      that same listing — exactly, never by prefix or similarity.
 *   3. A name candidate is refused if its id contradicts the id this run was
 *      given, because two different branches cannot both be this run's clone.
 *   4. A name candidate must additionally pass `evaluateDeletionGuard` with the
 *      production parent id and the expected name before it is even nominated.
 *      The caller runs that guard again; this one exists so a recovered
 *      candidate is never returned unguarded in the first place.
 *   5. Listings are re-requested up to `attempts` times with a delay between,
 *      for the eventual-consistency case.
 *   6. If nothing is confirmed, the answer is `UNCONFIRMED` — never `ABSENT` —
 *      and the caller is expected to fail the run and send a human to look.
 *
 * Ambiguity short-circuits: two branches with one id, two branches with one
 * name, or a list that is not a list are refusals, and retrying a refusal is
 * just asking a different listing for a more convenient answer.
 *
 * @param {object} input
 * @param {string|null} input.cloneId       the id the create call returned, if any
 * @param {string|null} input.branchName    the name this run generated before creating
 * @param {string|null} input.parentId      the verified production parent
 * @param {() => Promise<unknown[]>} input.listBranches  supplied, so this stays testable
 */
export async function confirmCleanupTarget({
  cloneId,
  branchName,
  parentId,
  listBranches,
  attempts = CLEANUP_LIST_ATTEMPTS,
  delaysMs = CLEANUP_RELIST_DELAY_MS,
  wait = defaultCleanupWait,
}) {
  const refuse = (problems, attemptsMade) => ({
    status: CLEANUP_RESOLUTION.AMBIGUOUS,
    target: null,
    matchedBy: null,
    attemptsMade,
    problems,
  })

  if (typeof listBranches !== 'function') {
    return {
      status: CLEANUP_RESOLUTION.UNCONFIRMED,
      target: null,
      matchedBy: null,
      attemptsMade: 0,
      problems: [
        'Cleanup was given no way to list branches, so it cannot confirm anything — and it will not ' +
          'assume there is nothing to clean up. Inspect the project by hand.',
      ],
    }
  }

  const bound = Number.isInteger(attempts) && attempts > 0 ? attempts : CLEANUP_LIST_ATTEMPTS
  const delays = Array.isArray(delaysMs) && delaysMs.length > 0 ? delaysMs : CLEANUP_RELIST_DELAY_MS
  const knownId = typeof cloneId === 'string' && cloneId.trim().length > 0 ? cloneId.trim() : null
  /* Only a name THIS tooling generated may be used to find anything. */
  const recoverableName =
    typeof branchName === 'string' && branchName.startsWith(REHEARSAL_BRANCH_PREFIX) ? branchName : null
  const namedFor = recoverableName === null ? '(no generated name)' : `"${recoverableName}"`
  const problems = []
  let attemptsMade = 0

  /* Nothing is ever returned as deletable without the guard having seen it. */
  const nominate = (candidate, matchedBy, attemptsSoFar) => {
    const guard = evaluateDeletionGuard({ target: candidate, parentId, expectedName: branchName })
    if (guard.problems.length > 0) return refuse([...problems, ...guard.problems], attemptsSoFar)
    return { status: CLEANUP_RESOLUTION.IDENTIFIED, target: candidate, matchedBy, attemptsMade: attemptsSoFar, problems }
  }

  for (let attempt = 0; attempt < bound; attempt += 1) {
    if (attempt > 0) await wait(delays[attempt] ?? delays[delays.length - 1])
    attemptsMade += 1

    let branches
    try {
      branches = await listBranches(attempt)
    } catch (error) {
      problems.push(
        `Attempt ${attemptsMade} of ${bound}: the branch list could not be read (${error?.message ?? String(error)}).`,
      )
      continue
    }

    const snapshot = resolveCleanupTarget({ cloneId: knownId, branchName, branches })

    if (snapshot.status === CLEANUP_RESOLUTION.IDENTIFIED) {
      return nominate(snapshot.target, snapshot.matchedBy, attemptsMade)
    }
    if (snapshot.status === CLEANUP_RESOLUTION.AMBIGUOUS) {
      return refuse([...problems, ...snapshot.problems], attemptsMade)
    }
    if (snapshot.status === CLEANUP_RESOLUTION.UNCONFIRMED) {
      /* No trustworthy id at all, and this listing has no branch by the exact name. */
      problems.push(`Attempt ${attemptsMade} of ${bound}: no branch in this listing is named exactly ${namedFor}.`)
      continue
    }

    /* ABSENT: the id was not in this listing — which is not the same as gone. */
    if (recoverableName === null) {
      problems.push(
        `Attempt ${attemptsMade} of ${bound}: this listing carries no branch with id "${knownId}", and ` +
          'there is no generated name to recover by.',
      )
      continue
    }

    /* Try the exact generated name on the same listing. */
    const recovered = resolveCleanupTarget({ cloneId: null, branchName: recoverableName, branches })

    if (recovered.status === CLEANUP_RESOLUTION.IDENTIFIED) {
      const candidate = recovered.target
      if (candidate.id !== knownId) {
        /*
         * The name matched, but the branch wearing it is not the branch this run
         * was told it created. One of the two facts is wrong, and deleting on
         * either reading would be a guess about which.
         */
        return refuse(
          [
            ...problems,
            `REFUSING: a branch named exactly ${namedFor} reports id "${candidate.id}", but this run was ` +
              `given id "${knownId}" for its clone. Two branches cannot both be it, and deleting either ` +
              'would be a guess. Resolve it by hand.',
          ],
          attemptsMade,
        )
      }
      return nominate(candidate, 'name', attemptsMade)
    }
    if (recovered.status === CLEANUP_RESOLUTION.AMBIGUOUS) {
      return refuse([...problems, ...recovered.problems], attemptsMade)
    }

    problems.push(
      `Attempt ${attemptsMade} of ${bound}: this listing carries no branch with id "${knownId}", and none ` +
        `named exactly ${namedFor} either.`,
    )
  }

  return {
    status: CLEANUP_RESOLUTION.UNCONFIRMED,
    target: null,
    matchedBy: null,
    attemptsMade,
    problems: [
      ...problems,
      `Cleanup could not confirm ${knownId ? `branch "${knownId}"` : 'the branch this run may have created'} ` +
        `after ${attemptsMade} branch listing(s). A listing that omits a branch is NOT proof that the branch ` +
        'is gone, so nothing here may be read as "there was nothing to clean up". Nothing was deleted. ' +
        `Inspect the project by hand and remove any branch named exactly ${namedFor} if one exists.`,
    ],
  }
}

/** A rehearsal branch name that cannot collide and cannot be mistaken for anything else. */
export function rehearsalBranchName(nowMs, suffix) {
  return `${REHEARSAL_BRANCH_PREFIX}${PENDING_TAGS[0].slice(0, 4)}-${PENDING_TAGS[PENDING_TAGS.length - 1].slice(0, 4)}-${nowMs}${
    suffix ? `-${suffix}` : ''
  }`
}
