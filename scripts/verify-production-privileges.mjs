/**
 * Production database privilege audit — READ ONLY.
 *
 *   $env:DATABASE_URL = "<the string the DEPLOYED APP uses>"
 *   node scripts/verify-production-privileges.mjs
 *
 * SAFE TO RUN AGAINST PRODUCTION. Every check is a catalogue query or a
 * `has_*_privilege()` call. It never writes, never begins a transaction that
 * modifies anything, and never attempts the operations it is testing for.
 *
 * That last point is the design decision worth stating. The obvious way to
 * check "can this role delete a rule?" is to try deleting one inside a
 * transaction and roll back. Against production that is unacceptable: a rolled
 * back DELETE still fires triggers, still takes row locks, and one mistyped
 * COMMIT away from destroying a compliance record. Postgres will answer the
 * same question from its catalogues without touching a row, so it is asked that
 * way instead.
 *
 * WHAT IT IS FOR
 *
 * The application's protections against rewriting compliance history are
 * triggers, and a role that OWNS a table can disable its triggers with one
 * statement. So the triggers are only worth anything if the application role
 * does not own the tables they guard. This script proves that separation
 * exists, in production, from outside.
 *
 * Run it with the connection string the deployed application uses — not the
 * migration string, and not the owner's. Checking the wrong role passes for the
 * wrong reason. The fingerprint is printed so it can be compared against
 * /api/health.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

/**
 * `.env.local` is loaded LAST and does not override.
 *
 * An exported DATABASE_URL therefore wins, which is what an operator auditing
 * production intends. Without this ordering the development string would be
 * silently substituted and the report would describe the wrong database — the
 * exact failure that produced a false pass in Phase 3.
 */
loadEnv({ path: '.env.local', quiet: true })

const connectionString = process.env.DATABASE_URL

/** Tables whose contents are a regulatory record. */
const PROTECTED_TABLES = ['purchase_limit_rules', 'audit_log', 'order_events']

/** Columns on `purchase_limit_rules` the app must never be able to rewrite. */
const FROZEN_COLUMNS = [
  'cannabis_class',
  'version',
  'equivalent_grams_per_gram',
  'daily_equivalent_grams_cap',
  'daily_concentrate_grams_cap',
  'effective_from',
  'change_reason',
  'published_by',
  'published_at',
  'reauthenticated_at',
  'supersedes_rule_id',
]

/** Columns the publish path legitimately needs to write. */
const MUTABLE_COLUMNS = ['effective_until', 'superseded_by_rule_id', 'updated_at']

const GUARD_TRIGGERS = ['purchase_limit_rules_immutable', 'purchase_limit_rules_no_delete']

let pass = 0
let fail = 0
let warn = 0
const failures = []

const report = (state, name, detail = '') => {
  if (state === 'PASS') pass += 1
  else if (state === 'WARN') warn += 1
  else {
    fail += 1
    failures.push(name)
  }
  console.log(`  ${state.padEnd(4)}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)

async function main() {
  if (!connectionString) {
    console.error('DATABASE_URL is required. Set it to the string the DEPLOYED APP uses.')
    process.exitCode = 1
    return
  }

  const fingerprint = createHash('sha256')
    .update(new URL(connectionString).hostname)
    .digest('hex')
    .slice(0, 12)

  const pool = new Pool({ connectionString })
  const q = async (text, params) => (await pool.query(text, params)).rows

  try {
    const [{ role, is_superuser, database }] = await q(
      `select current_user as role,
              (select usesuper from pg_user where usename = current_user) as is_superuser,
              current_database() as database`,
    )

    console.log('Production application role — privilege audit (read only)\n')
    console.log(`  database fingerprint: ${fingerprint}`)
    console.log(`  database:             ${database}`)
    console.log(`  connected as:         ${role}`)

    /* ================================================== superuser ======== */
    section('[1] The role is not a superuser')
    report(
      is_superuser ? 'FAIL' : 'PASS',
      'the application role is not a superuser',
      is_superuser ? 'a superuser bypasses every check below' : '',
    )

    /* ================================================== ownership ======== */
    section('[2] The role does not own the protected tables')
    for (const table of PROTECTED_TABLES) {
      const rows = await q(
        `select c.relname, pg_get_userbyid(c.relowner) as owner
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname='public' and c.relname=$1`,
        [table],
      )
      if (rows.length === 0) {
        report('FAIL', `${table} exists`, 'table not found — migrations may be behind')
        continue
      }
      const owner = rows[0].owner
      /**
       * Ownership is checked through role MEMBERSHIP, not string equality. A
       * role that is a member of the owning role can SET ROLE to it and inherit
       * everything, so `owner != current_user` on its own proves nothing.
       */
      const [{ inherits }] = await q(`select pg_has_role(current_user, $1, 'USAGE') as inherits`, [
        owner,
      ])
      report(
        inherits ? 'FAIL' : 'PASS',
        `does not own or inherit ownership of ${table}`,
        inherits ? `owner is "${owner}" and the app role has USAGE on it` : `owner is "${owner}"`,
      )
    }

    /* =============================================== trigger control ===== */
    section('[3] The role cannot disable or drop the guard triggers')
    for (const trigger of GUARD_TRIGGERS) {
      const rows = await q(
        `select t.tgname, t.tgenabled, pg_get_userbyid(c.relowner) as owner
           from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where t.tgname=$1 and not t.tgisinternal`,
        [trigger],
      )
      if (rows.length === 0) {
        report('FAIL', `${trigger} exists`, 'the guard is missing entirely')
        continue
      }
      report(
        rows[0].tgenabled === 'O' ? 'PASS' : 'FAIL',
        `${trigger} is enabled`,
        `tgenabled=${rows[0].tgenabled}`,
      )
      /**
       * ALTER TABLE ... DISABLE TRIGGER requires table ownership; there is no
       * grantable privilege for it. So the answer is exactly the ownership
       * answer, restated where an operator will look for it.
       */
      const [{ inherits }] = await q(`select pg_has_role(current_user, $1, 'USAGE') as inherits`, [
        rows[0].owner,
      ])
      report(
        inherits ? 'FAIL' : 'PASS',
        `cannot disable ${trigger}`,
        inherits ? 'ALTER TABLE ... DISABLE TRIGGER would succeed' : 'requires table ownership',
      )
    }

    /* ============================================== trigger function ===== */
    section('[4] The role cannot replace the trigger function')
    const fn = await q(
      `select p.proname, pg_get_userbyid(p.proowner) as owner
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='purchase_limit_rules_guard'`,
    )
    if (fn.length === 0) {
      report('FAIL', 'purchase_limit_rules_guard exists', 'the guard function is missing')
    } else {
      const [{ inherits }] = await q(`select pg_has_role(current_user, $1, 'USAGE') as inherits`, [
        fn[0].owner,
      ])
      report(
        inherits ? 'FAIL' : 'PASS',
        'cannot CREATE OR REPLACE purchase_limit_rules_guard',
        inherits ? `owner is "${fn[0].owner}" and the app role inherits it` : `owner is "${fn[0].owner}"`,
      )
    }

    /* ================================================= table rights ====== */
    section('[5] The role cannot delete or truncate compliance rows')
    for (const [table, privilege] of [
      ['purchase_limit_rules', 'DELETE'],
      ['purchase_limit_rules', 'TRUNCATE'],
      ['audit_log', 'DELETE'],
      ['audit_log', 'UPDATE'],
      ['audit_log', 'TRUNCATE'],
      ['order_events', 'DELETE'],
      ['order_events', 'UPDATE'],
    ]) {
      const [{ allowed }] = await q(
        `select has_table_privilege(current_user, $1, $2) as allowed`,
        [table, privilege],
      )
      report(allowed ? 'FAIL' : 'PASS', `cannot ${privilege} ${table}`)
    }

    /* ================================================ column rights ====== */
    section('[6] The role cannot rewrite frozen historical columns')
    for (const column of FROZEN_COLUMNS) {
      const [{ allowed }] = await q(
        `select has_column_privilege(current_user, 'purchase_limit_rules', $1, 'UPDATE') as allowed`,
        [column],
      )
      report(allowed ? 'FAIL' : 'PASS', `cannot UPDATE purchase_limit_rules.${column}`)
    }

    section('[7] The role CAN still do its job')
    for (const column of MUTABLE_COLUMNS) {
      const [{ allowed }] = await q(
        `select has_column_privilege(current_user, 'purchase_limit_rules', $1, 'UPDATE') as allowed`,
        [column],
      )
      report(allowed ? 'PASS' : 'FAIL', `can UPDATE purchase_limit_rules.${column}`)
    }
    for (const [table, privilege] of [
      ['purchase_limit_rules', 'SELECT'],
      ['purchase_limit_rules', 'INSERT'],
      ['audit_log', 'INSERT'],
      ['order_events', 'INSERT'],
      ['orders', 'UPDATE'],
      ['product_variants', 'UPDATE'],
      ['scheduler_runs', 'INSERT'],
    ]) {
      const [{ allowed }] = await q(
        `select has_table_privilege(current_user, $1, $2) as allowed`,
        [table, privilege],
      )
      report(allowed ? 'PASS' : 'FAIL', `can ${privilege} ${table}`)
    }

    /* =============================================== self-elevation ====== */
    section('[8] The role cannot grant itself compliance_admin')
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      const [{ allowed }] = await q(
        `select has_table_privilege(current_user, 'user_permissions', $1) as allowed`,
        [privilege],
      )
      report(allowed ? 'FAIL' : 'PASS', `cannot ${privilege} user_permissions`)
    }
    const [{ readable }] = await q(
      `select has_table_privilege(current_user, 'user_permissions', 'SELECT') as readable`,
    )
    report(readable ? 'PASS' : 'FAIL', 'can SELECT user_permissions (needed to check the grant)')

    const [{ can_create_role }] = await q(
      `select rolcreaterole as can_create_role from pg_roles where rolname = current_user`,
    )
    report(can_create_role ? 'FAIL' : 'PASS', 'cannot create or alter roles')

    /* ================================================ test bypass ======== */
    section('[9] No test-only bypass is reachable')
    /**
     * The verification suites disable the guard triggers during teardown. That
     * is only possible for a role that owns the table, so in a correctly
     * configured production the bypass fails closed by construction — there is
     * no flag to leave switched on. This restates that conclusion explicitly
     * because "the bypass is unreachable" is the claim an auditor will want
     * answered directly rather than inferred from section [2].
     */
    const [{ owner: rulesOwner }] = await q(
      `select pg_get_userbyid(c.relowner) as owner from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='purchase_limit_rules'`,
    )
    const [{ inherits: ownsRules }] = await q(
      `select pg_has_role(current_user, $1, 'USAGE') as inherits`,
      [rulesOwner],
    )
    report(
      ownsRules ? 'FAIL' : 'PASS',
      'the harness trigger-disable path is unavailable to this role',
      ownsRules ? 'this role could run the test teardown against production' : '',
    )

    const [{ exclusion }] = await q(
      `select count(*)::int > 0 as exclusion from pg_constraint
        where conrelid='purchase_limit_rules'::regclass and contype='x'`,
    )
    report(exclusion ? 'PASS' : 'FAIL', 'the overlap exclusion constraint is present')

    /* ==================================================== summary ======== */
    console.log('\n==========================================================')
    if (fail === 0) {
      console.log(`ALL REQUIRED PRIVILEGES CORRECT — ${pass} PASS, ${warn} WARN`)
    } else {
      console.log(`NOT SAFE — ${pass} PASS, ${fail} FAIL, ${warn} WARN`)
      for (const f of failures) console.log(`  • ${f}`)
      console.log('\nSee PURCHASE-LIMITS.md §"Production role hardening" for the SQL that')
      console.log('establishes the separation. It must be run by the OWNER, not the app role.')
      process.exitCode = 1
    }
    console.log('==========================================================')
  } catch (error) {
    console.error(`\nABORTED: ${error.message}`)
    process.exitCode = 1
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(`\nABORTED: ${error.message}`)
  process.exitCode = 1
})
