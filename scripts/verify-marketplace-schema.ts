/**
 * Marketplace access + invite target role — schema shape checks.
 *
 * Run: npm run test:marketplace-schema
 *
 * HERMETIC. No database, no network, no environment. `lib/db/schema/*` imports
 * only `drizzle-orm`, never `lib/db` or `lib/env`, so the table definitions can
 * be introspected as plain objects. `getTableConfig` reads the same metadata
 * drizzle-kit uses to emit DDL, which is what makes these assertions about the
 * real schema rather than about a copy of it.
 *
 * WHY THIS FILE EXISTS. Batch 3b contains one irreversible operation: dropping
 * `invite_code_redemptions_user_unique`. Once a single user holds two
 * redemptions it can never be recreated, so the surrounding decisions — the
 * composite replacement, its ordering in the migration, the permanent
 * `shopper` default that backfills legacy invites — are not things to re-derive
 * by reading. They are pinned here.
 *
 * These check SHAPE, not behaviour. Whether the migration applies cleanly to a
 * populated table is a question for a Neon branch rehearsal, which has not been
 * run and which these assertions do not substitute for.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { getTableConfig } from 'drizzle-orm/pg-core'

import {
  inviteCodeRedemptions,
  inviteCodes,
  inviteTargetRole,
  marketplaceAccess,
  marketplaceAccessStatus,
  marketplaceScope,
} from '../lib/db/schema'

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

/** Index descriptors as `name -> { columns, unique }`. */
function indexesOf(table: Parameters<typeof getTableConfig>[0]) {
  const config = getTableConfig(table)
  return Object.fromEntries(
    config.indexes.map((entry) => [
      entry.config.name,
      {
        columns: (entry.config.columns as { name?: string }[]).map((c) => c.name ?? '?'),
        unique: entry.config.unique === true,
      },
    ]),
  )
}

function main() {
  console.log('\n-- enum values (Postgres cannot remove one) ---------------')

  check(
    'invite_target_role',
    [...inviteTargetRole.enumValues],
    ['shopper', 'vendor'],
  )
  check('marketplace_scope', [...marketplaceScope.enumValues], ['shopper', 'vendor'])
  check(
    'marketplace_access_status',
    [...marketplaceAccessStatus.enumValues],
    ['active', 'suspended', 'revoked'],
  )
  assert(
    'invite_target_role and marketplace_scope are SEPARATE pg types',
    inviteTargetRole.enumName !== marketplaceScope.enumName,
    'sharing one type would make any future value legal for both purposes',
  )

  console.log('\n-- invite_codes.target_role ------------------------------')

  const inviteColumns = getTableConfig(inviteCodes).columns
  const targetRole = inviteColumns.find((c) => c.name === 'target_role')

  assert('column exists', targetRole !== undefined)
  check('is not null', targetRole?.notNull, true)
  /*
   * The load-bearing one. Without a default, drizzle-kit emits a bare
   * ADD COLUMN ... NOT NULL, which FAILS against a non-empty invite_codes
   * table — and production is not assumed empty. The default is also what
   * backfills every legacy Phase-5 invite to its original shopper semantics.
   */
  check('defaults to shopper', targetRole?.default, 'shopper')
  check('uses the invite_target_role type', targetRole?.enumValues, ['shopper', 'vendor'])

  console.log('\n-- marketplace_access columns ----------------------------')

  const accessConfig = getTableConfig(marketplaceAccess)
  check(
    'exactly the six agreed columns',
    accessConfig.columns.map((c) => c.name).sort(),
    ['created_at', 'id', 'scope', 'status', 'updated_at', 'user_id'],
  )

  const byName = Object.fromEntries(accessConfig.columns.map((c) => [c.name, c]))
  check('user_id is not null', byName.user_id?.notNull, true)
  check('scope is not null', byName.scope?.notNull, true)
  check('scope has NO default — every grant states its intent', byName.scope?.hasDefault, false)
  check('status is not null', byName.status?.notNull, true)
  check('status defaults to active', byName.status?.default, 'active')

  for (const banned of ['granted_via', 'granted_by', 'invite_code_id', 'status_reason']) {
    assert(`deferred column absent: ${banned}`, byName[banned] === undefined)
  }

  console.log('\n-- marketplace_access relationships ----------------------')

  const referenced = accessConfig.foreignKeys.map(
    (fk) => getTableConfig(fk.reference().foreignTable).name,
  )
  check('references exactly one table', referenced.sort(), ['users'])

  const referencedColumns = accessConfig.foreignKeys.flatMap((fk) =>
    fk.reference().foreignColumns.map((c) => c.name),
  )
  check('and only users.id', referencedColumns.sort(), ['id'])

  /*
   * No vendor or application FK yet, by decision. Asserted against the FK list
   * rather than the source so that adding one later trips here rather than
   * being noticed in review.
   */
  for (const banned of ['vendors', 'vendor_memberships', 'shopper_applications', 'vendor_applications']) {
    assert(`no FK to ${banned}`, !referenced.includes(banned))
  }

  const marketplaceSource = readFileSync(
    join(__dirname, '..', 'lib', 'db', 'schema', 'marketplace.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n')
  const marketplaceCode = marketplaceSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  assert(
    'never couples to users.role or users.status',
    !/\buserRole\b/.test(marketplaceCode) && !/\buserStatus\b/.test(marketplaceCode),
    'marketplace membership is a separate fact from account role/status',
  )

  console.log('\n-- redemption uniqueness --------------------------------')

  const redemptionIndexes = indexesOf(inviteCodeRedemptions)

  check(
    'exactly one index, the composite unique',
    Object.keys(redemptionIndexes).sort(),
    ['invite_code_redemptions_invite_user_unique'],
  )
  check(
    'on (invite_code_id, user_id), in that order',
    redemptionIndexes.invite_code_redemptions_invite_user_unique?.columns,
    ['invite_code_id', 'user_id'],
  )
  check(
    'and it is UNIQUE',
    redemptionIndexes.invite_code_redemptions_invite_user_unique?.unique,
    true,
  )
  assert(
    'the old user-only uniqueness is GONE',
    redemptionIndexes.invite_code_redemptions_user_unique === undefined,
    'a unique(user_id) rule makes shopper-then-vendor redemption impossible',
  )
  assert(
    'the now-redundant invite-id index is GONE',
    redemptionIndexes.invite_code_redemptions_invite_idx === undefined,
    'the composite index serves leading-column lookups on invite_code_id',
  )

  console.log('\n-- marketplace_access indexes ---------------------------')

  const accessIndexes = indexesOf(marketplaceAccess)
  check(
    'exactly one index — no status index yet',
    Object.keys(accessIndexes).sort(),
    ['marketplace_access_user_unique'],
  )
  check(
    'unique on user_id — one membership per account',
    accessIndexes.marketplace_access_user_unique,
    { columns: ['user_id'], unique: true },
  )

  console.log('\n-- barrel export ----------------------------------------')

  const barrel = readFileSync(
    join(__dirname, '..', 'lib', 'db', 'schema', 'index.ts'),
    'utf8',
  )
  assert(
    "index.ts re-exports './marketplace'",
    /export \* from '\.\/marketplace'/.test(barrel),
    'without this, db.query.* cannot see the table',
  )

  console.log('\n-- migration 0019 statement order -----------------------')

  const drizzleDir = join(__dirname, '..', 'drizzle')
  const migrations = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()
  const zero19 = migrations.filter((f) => f.startsWith('0019'))

  check('exactly one 0019 migration', zero19.length, 1)
  check('migration history stops at 0019', migrations.length, 20)

  const raw = readFileSync(join(drizzleDir, zero19[0]), 'utf8')

  /*
   * Comment lines are stripped first, and this is not optional: the hand-written
   * header of 0019 explains the reordering and therefore NAMES both dropped
   * indexes. Searching the raw text would find those mentions and report a pass
   * no matter how the real statements were ordered.
   */
  const sql = raw
    .split('\n')
    .filter((line) => !/^\s*--(?!>)/.test(line))
    .join('\n')

  const createComposite = sql.indexOf(
    'CREATE UNIQUE INDEX "invite_code_redemptions_invite_user_unique"',
  )
  const dropUserUnique = sql.indexOf('DROP INDEX "invite_code_redemptions_user_unique"')
  const dropInviteIdx = sql.indexOf('DROP INDEX "invite_code_redemptions_invite_idx"')

  assert('all three statements present', createComposite >= 0 && dropUserUnique >= 0 && dropInviteIdx >= 0,
    `create=${createComposite} dropUnique=${dropUserUnique} dropIdx=${dropInviteIdx}`)
  assert(
    'composite CREATE comes BEFORE dropping user_unique',
    createComposite >= 0 && dropUserUnique >= 0 && createComposite < dropUserUnique,
    'dropping first leaves a window with no uniqueness, and the row that slips in is unrecoverable',
  )
  assert(
    'composite CREATE comes BEFORE dropping invite_idx',
    createComposite >= 0 && dropInviteIdx >= 0 && createComposite < dropInviteIdx,
  )

  const addColumn = sql.indexOf('ADD COLUMN "target_role"')
  assert('target_role is added', addColumn >= 0)
  assert(
    'with DEFAULT shopper AND NOT NULL, in one statement',
    /ADD COLUMN "target_role" "invite_target_role" DEFAULT 'shopper' NOT NULL/.test(sql),
    'a bare NOT NULL without a default fails against a non-empty table',
  )
  assert(
    'no backfill UPDATE is needed or present',
    !/UPDATE\s+"?invite_codes"?/i.test(sql),
    'the constant default backfills existing rows as a catalog change',
  )

  assert(
    'no audit_event values were added (deferred to the wiring batch)',
    !/ALTER TYPE "public"\."audit_event"/.test(sql),
  )

  console.log(
    `\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failing assertion(s)\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main()
