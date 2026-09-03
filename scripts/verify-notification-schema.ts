/**
 * Customer notifications — schema shape and migration-chain checks.
 *
 * Run: npx tsx scripts/verify-notification-schema.ts
 *
 * HERMETIC. No database, no network, no environment. `lib/db/schema/*` imports
 * only `drizzle-orm`, never `lib/db` or `lib/env`, so the table definition can be
 * introspected as plain objects. `getTableConfig` reads the same metadata
 * drizzle-kit uses to emit DDL, which is what makes these assertions about the
 * real schema rather than about a copy of it.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HUMAN COMPLETION STEP — GENERATE 0020, NEVER WRITE IT                    │
 * │                                                                          │
 * │ Drizzle's migration SQL, its `drizzle/meta/0020_snapshot.json`, and the  │
 * │ `drizzle/meta/_journal.json` entry are GENERATED ARTIFACTS. A            │
 * │ hand-written snapshot or journal entry is not a cheaper version of a     │
 * │ generated one — it is a lie about what the schema was at that point in   │
 * │ history, and every later `db:generate` diffs against it. So they are not │
 * │ written here, and nothing in this repository fabricates them.            │
 * │                                                                          │
 * │ Generation does NOT need a reachable database — drizzle-kit only         │
 * │ requires `drizzle.config.ts` to resolve a connection string, which it    │
 * │ never opens for `generate`. Point it at a dead local address so it       │
 * │ cannot reach anything even by accident:                                  │
 * │                                                                          │
 * │   PowerShell:                                                            │
 * │     $env:DATABASE_URL='postgresql://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1'
 * │     $env:DATABASE_URL_UNPOOLED=$env:DATABASE_URL                         │
 * │     npm run db:generate -- --name notifications                          │
 * │                                                                          │
 * │   bash:                                                                  │
 * │     DATABASE_URL='postgresql://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1' \
 * │     DATABASE_URL_UNPOOLED='postgresql://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1' \
 * │     npm run db:generate -- --name notifications                          │
 * │                                                                          │
 * │ Use ONLY those values. A real DATABASE_URL here would let a mistyped     │
 * │ subcommand (`push`, `migrate`) reach a live database, and this step is   │
 * │ authorized to write files and nothing else.                              │
 * │                                                                          │
 * │ Then commit drizzle/0020_notifications.sql, drizzle/meta/0020_snapshot.json
 * │ and the updated drizzle/meta/_journal.json, and re-run this script. Do   │
 * │ NOT run `db:migrate`, `db:push`, or any production migration: applying   │
 * │ 0020 to production goes through scripts/migrate-production-safe.mjs and  │
 * │ an explicit human authorization, and nowhere else.                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * These check SHAPE, not behaviour. Whether the migration applies cleanly to a
 * populated database is a question for the Neon branch rehearsal
 * (`npm run rehearse:migration:branch`), which these assertions do not
 * substitute for.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getTableConfig } from 'drizzle-orm/pg-core'

import { notifications, withUpdatedAt } from '../lib/db/schema'

/**
 * The chain anchor. 0020's snapshot must declare this as its `prevId`, which is
 * what makes it a continuation of the committed history rather than a snapshot
 * generated against some other state of the schema.
 */
const SNAPSHOT_0019_ID = '73a59305-aa50-408f-b165-6e07405219a2'
const JOURNAL_ENTRIES_BEFORE = 20
const TAG_0019 = '0019_demonic_rockslide'
const TAG_0020 = '0020_notifications'

const ROOT = join(__dirname, '..')
const DRIZZLE = join(ROOT, 'drizzle')
const SQL_0020 = join(DRIZZLE, `${TAG_0020}.sql`)
const SNAPSHOT_0020 = join(DRIZZLE, 'meta', '0020_snapshot.json')

let failures = 0

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const pass = a === e
  if (!pass) failures += 1
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        expected ${e}\n        actual   ${a}`),
  )
}

function assert(name: string, condition: boolean, detail = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `\n        ${detail}`}`)
}

/** Index descriptors as `name -> { columns, unique, partial }`. */
function indexesOf(table: Parameters<typeof getTableConfig>[0]) {
  const config = getTableConfig(table)
  return Object.fromEntries(
    config.indexes.map((entry) => [
      entry.config.name,
      {
        columns: (entry.config.columns as { name?: string }[]).map((c) => c.name ?? '?'),
        unique: entry.config.unique === true,
        partial: entry.config.where !== undefined,
      },
    ]),
  )
}

const readText = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

function main() {
  console.log('\n-- notifications columns ---------------------------------')

  const config = getTableConfig(notifications)
  const byName = Object.fromEntries(config.columns.map((c) => [c.name, c]))

  check('exactly the seven agreed columns', config.columns.map((c) => c.name).sort(), [
    'body',
    'created_at',
    'id',
    'read_at',
    'title',
    'updated_at',
    'user_id',
  ])

  check('id is the uuid primary key', byName.id?.primary, true)
  check('and it is a uuid with a database default', byName.id?.getSQLType(), 'uuid')
  check('the primary key defaults rather than requiring the caller to invent one', byName.id?.hasDefault, true)

  check('user_id is a uuid', byName.user_id?.getSQLType(), 'uuid')
  /*
   * The load-bearing one. `user_id` is the ONLY thing that says who may read a
   * notification, so a nullable owner column would be a row that every
   * owner-scoped query has to decide what to do with — and the wrong decision
   * shows one customer another customer's message.
   */
  check('user_id is NOT NULL — a notification with no owner has no reader', byName.user_id?.notNull, true)

  check('title is varchar(200)', byName.title?.getSQLType(), 'varchar(200)')
  check('title is not null', byName.title?.notNull, true)

  check('body is text', byName.body?.getSQLType(), 'text')
  check('body is NULLABLE — the title may be the whole message', byName.body?.notNull, false)
  check('body has no default, so NULL and "" stay distinguishable', byName.body?.hasDefault, false)

  check('read_at is timestamptz', byName.read_at?.getSQLType(), 'timestamp with time zone')
  check('read_at is nullable — NULL is what "unread" means', byName.read_at?.notNull, false)
  /*
   * A default of now() would mark every notification read at the instant it was
   * created, which is the exact opposite of what an insert means. Pinned here so
   * a later "tidy up" of the column trips this file.
   */
  check('read_at has NO default', byName.read_at?.hasDefault, false)

  check('created_at is a defaulted timestamptz', byName.created_at?.getSQLType(), 'timestamp with time zone')
  check('created_at is not null', byName.created_at?.notNull, true)
  check('created_at defaults', byName.created_at?.hasDefault, true)
  check('updated_at is a defaulted timestamptz', byName.updated_at?.getSQLType(), 'timestamp with time zone')
  check('updated_at is not null', byName.updated_at?.notNull, true)
  check('updated_at defaults', byName.updated_at?.hasDefault, true)

  for (const banned of ['deleted_at', 'kind', 'type', 'category', 'channel', 'read', 'is_read']) {
    assert(`deferred or rejected column absent: ${banned}`, byName[banned] === undefined)
  }

  console.log('\n-- ownership --------------------------------------------')

  const referenced = config.foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name)
  check('references exactly one table', referenced.sort(), ['users'])

  const referencedColumns = config.foreignKeys.flatMap((fk) =>
    fk.reference().foreignColumns.map((c) => c.name),
  )
  check('and only users.id', referencedColumns.sort(), ['id'])
  check(
    'the owner FK cascades — an erased account keeps no notifications',
    config.foreignKeys.map((fk) => fk.onDelete),
    ['cascade'],
  )

  console.log('\n-- indexes ----------------------------------------------')

  const indexes = indexesOf(notifications)
  check('exactly the two agreed indexes', Object.keys(indexes).sort(), [
    'notifications_user_created_idx',
    'notifications_user_unread_idx',
  ])
  check(
    'the list index is (user_id, created_at), in that order, and not unique',
    indexes.notifications_user_created_idx,
    { columns: ['user_id', 'created_at'], unique: false, partial: false },
  )
  /*
   * PARTIAL IS THE POINT, AND A NAME CANNOT CARRY IT. A full btree on `user_id`
   * would answer the unread count too, and would be maintained for every read
   * row forever. The predicate is what keeps the index proportional to what is
   * actually unread, so it is asserted rather than assumed from the name.
   */
  check(
    'the unread index is (user_id) and PARTIAL on read_at is null',
    indexes.notifications_user_unread_idx,
    { columns: ['user_id'], unique: false, partial: true },
  )

  console.log('\n-- schema module conventions ----------------------------')

  const schemaSource = readText(join(ROOT, 'lib', 'db', 'schema', 'notifications.ts'))
  const schemaCode = schemaSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  assert(
    'uses the project primary-key helper rather than an ad-hoc uuid column',
    /\bprimaryKeyColumn\b/.test(schemaCode) && /from '\.\/_shared'/.test(schemaCode),
    'a locally-declared id column drifts from every other table the first time the helper changes',
  )
  assert(
    'uses the project timestamp columns rather than declaring its own',
    /\.\.\.timestampColumns\b/.test(schemaCode),
  )
  assert(
    'no soft delete — a notification is not a regulated record',
    !/softDeleteColumns|deletedAt/.test(schemaCode),
    'a soft-deleted row is one every query has to remember to exclude',
  )
  assert(
    'no pg enum — a value that cannot be removed is not added before something reads it',
    !/pgEnum/.test(schemaCode),
  )
  assert(
    'never couples to users.role or users.status',
    !/\buserRole\b/.test(schemaCode) && !/\buserStatus\b/.test(schemaCode),
    'who may read a notification is user_id, and nothing else',
  )

  const barrel = readText(join(ROOT, 'lib', 'db', 'schema', 'index.ts'))
  assert(
    "index.ts re-exports './notifications'",
    /export \* from '\.\/notifications'/.test(barrel),
    'without this, db.query.* cannot see the table',
  )

  /*
   * The mutation contract the actions layer depends on: `updated_at` is
   * maintained by the application, not by a trigger, so a mark-read update that
   * forgets `withUpdatedAt` leaves a stale timestamp behind.
   */
  const updated = withUpdatedAt({ readAt: null })
  assert(
    'withUpdatedAt is exported from the schema barrel and sets updatedAt',
    typeof withUpdatedAt === 'function' && updated.updatedAt instanceof Date,
  )

  console.log('\n-- migration 0020 chain ---------------------------------')

  const journal = JSON.parse(readText(join(DRIZZLE, 'meta', '_journal.json'))) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
  }

  if (!existsSync(SQL_0020) || !existsSync(SNAPSHOT_0020) || journal.entries.length !== 21) {
    failures += 1
    console.log('FAIL  0020 has not been generated yet')
    console.log(
      '\n  HUMAN COMPLETION REQUIRED. The schema above is committed and correct, but its migration is\n' +
        '  a GENERATED artifact and this repository does not fabricate Drizzle metadata. Run the\n' +
        '  generation step documented at the top of this file:\n\n' +
        '    DATABASE_URL and DATABASE_URL_UNPOOLED set ONLY to\n' +
        '      postgresql://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1\n' +
        '    npm run db:generate -- --name notifications\n\n' +
        '  Then commit drizzle/0020_notifications.sql, drizzle/meta/0020_snapshot.json and the updated\n' +
        '  drizzle/meta/_journal.json, and run this script again. Never run a migration to complete this.',
    )
    console.log(`\nFAILED — ${failures} failing assertion(s)\n`)
    process.exit(1)
  }

  check('the journal now holds 21 entries', journal.entries.length, 21)

  const before = journal.entries[JOURNAL_ENTRIES_BEFORE - 1]
  const added = journal.entries[JOURNAL_ENTRIES_BEFORE]

  check('entry 19 is still 0019_demonic_rockslide, untouched', { idx: before?.idx, tag: before?.tag }, { idx: 19, tag: TAG_0019 })
  check('entry 20 is 0020_notifications', { idx: added?.idx, tag: added?.tag }, { idx: 20, tag: TAG_0020 })
  check('the new entry carries the journal format version', added?.version, '7')
  check('and statement breakpoints, like every other entry', added?.breakpoints, true)
  assert(
    'the new entry is newer than 0019 — a journal timestamp that goes backwards fails the rehearsal',
    Number.isInteger(added?.when) && Number.isInteger(before?.when) && added.when > before.when,
    `${added?.when} <= ${before?.when}`,
  )

  const snapshot0019 = JSON.parse(readText(join(DRIZZLE, 'meta', '0019_snapshot.json'))) as {
    id: string
  }
  const snapshot0020 = JSON.parse(readText(SNAPSHOT_0020)) as {
    id: string
    prevId: string
    version: string
    dialect: string
    tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>
  }

  check('the 0019 snapshot id is the committed anchor, unmoved', snapshot0019.id, SNAPSHOT_0019_ID)
  /*
   * THIS IS THE CHAIN. A snapshot whose prevId is anything else was generated
   * against a different history, and every migration generated after it would
   * diff from the wrong baseline.
   */
  check('the 0020 snapshot chains directly from it', snapshot0020.prevId, SNAPSHOT_0019_ID)
  assert(
    'the 0020 snapshot has its own generated id',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(snapshot0020.id ?? '') &&
      snapshot0020.id !== snapshot0020.prevId,
    String(snapshot0020.id),
  )
  check('the snapshot is the drizzle v7 postgres format', [snapshot0020.version, snapshot0020.dialect], ['7', 'postgresql'])

  const table = snapshot0020.tables?.['public.notifications']
  assert('the snapshot describes public.notifications', table !== undefined)
  check(
    'with exactly the seven columns',
    Object.keys(table?.columns ?? {}).sort(),
    ['body', 'created_at', 'id', 'read_at', 'title', 'updated_at', 'user_id'],
  )
  check(
    'and exactly the two indexes',
    Object.keys(table?.indexes ?? {}).sort(),
    ['notifications_user_created_idx', 'notifications_user_unread_idx'],
  )

  console.log('\n-- migration 0020 SQL -----------------------------------')

  const raw = readText(SQL_0020)
  /* Comments are stripped so prose can never satisfy a statement assertion. */
  const sql = raw
    .split('\n')
    .filter((line) => !/^\s*--(?!>)/.test(line))
    .join('\n')

  assert('creates the notifications table', /CREATE TABLE "notifications"/.test(sql))
  assert(
    'and creates nothing else',
    [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([a-z0-9_]+)"/gi)].map((m) => m[1]).join(',') ===
      'notifications',
    'this migration is scoped to one table',
  )
  assert(
    'user_id is NOT NULL in the emitted DDL',
    /"user_id" uuid NOT NULL/.test(sql),
  )
  assert('title is varchar(200) NOT NULL', /"title" varchar\(200\) NOT NULL/.test(sql))
  assert('body is nullable text', /"body" text(?!\s+NOT NULL)/.test(sql))
  assert(
    'read_at is a nullable timestamptz with no default',
    /"read_at" timestamp with time zone(?!\s+(?:DEFAULT|NOT NULL))/.test(sql),
  )
  assert(
    'the owner foreign key cascades on delete',
    /ADD CONSTRAINT "notifications_user_id_users_id_fk"[\s\S]*?REFERENCES "public"\."users"\("id"\) ON DELETE cascade/.test(
      sql,
    ),
  )
  assert(
    'the list index is created on (user_id, created_at)',
    /CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree \("user_id","created_at"\)/.test(sql),
  )
  assert(
    'the unread index is created PARTIAL on read_at is null',
    /CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree \("user_id"\)\s+WHERE[^;]*"read_at" is null/i.test(
      sql,
    ),
    'a full index here would be a different migration with different write costs',
  )
  assert(
    'nothing is dropped, altered away, or backfilled',
    !/\bDROP\b/i.test(sql) && !/\bUPDATE\s+"/i.test(sql) && !/\bDELETE\s+FROM\b/i.test(sql),
    '0020 is additive; anything else in it was not reviewed',
  )
  assert(
    'no enum type is introduced',
    !/CREATE TYPE/i.test(sql) && !/ALTER TYPE/i.test(sql),
  )
  assert(
    'no table other than notifications is altered',
    [...sql.matchAll(/ALTER TABLE "([a-z0-9_]+)"/gi)].every((m) => m[1] === 'notifications'),
  )

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failing assertion(s)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
