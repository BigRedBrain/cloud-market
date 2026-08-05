/**
 * The single gate that decides whether checkout may be enabled.
 *
 *   npm run verify:checkout-readiness
 *   npm run verify:checkout-readiness -- --expect-migrations=15
 *
 * READ ONLY AND SAFE AGAINST PRODUCTION. Catalogue queries, `has_*_privilege()`
 * calls and SELECTs. It never writes, never begins a mutating transaction, and
 * never attempts the operations it tests for. It prints no secret and no
 * connection string — only a truncated fingerprint, which identifies a database
 * without naming it.
 *
 * EXITS NONZERO IF ANY REQUIRED GATE FAILS. That is the point: this is the
 * command a deploy pipeline or an operator runs immediately before flipping
 * `CHECKOUT_ENABLED`, and a partial pass has to be as loud as a total one.
 *
 * WHY ONE COMMAND RATHER THAN A CHECKLIST
 *
 * The individual checks already existed — privileges, catalog readiness, rule
 * coverage, the scheduler — spread across three scripts and two documents. A
 * human running four commands and reading three documents will eventually run
 * three and read two, and the one they skip will be the one that mattered.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

loadEnv({ path: '.env.local', quiet: true })

const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

/** The release this gate expects. Supplied per rollout so it never goes stale. */
/**
 * Journal ENTRIES, not the highest migration number. 0000 through 0015 is
 * sixteen of them — an off-by-one here reads as "schema is behind" on a
 * perfectly current database, which is the kind of false alarm that teaches an
 * operator to skip the gate.
 */
const EXPECTED_MIGRATIONS = Number(flag('expect-migrations') ?? 16)
const MAX_SWEEP_AGE_SECONDS = 900

const connectionString = process.env.DATABASE_URL

const SUPPORTED = [
  'flower',
  'concentrate',
  'infused_solid',
  'infused_liquid',
  'immature_plant',
  'non_cannabis',
]

const CLASS_MEASUREMENT = {
  flower: { basis: 'net_weight_grams', cannabis: true },
  concentrate: { basis: 'net_weight_grams', cannabis: true },
  infused_solid: { basis: 'finished_net_weight_grams', cannabis: true },
  infused_liquid: { basis: 'finished_volume_fluid_ounces', cannabis: true },
  immature_plant: { basis: 'unit_count', cannabis: true },
  non_cannabis: { basis: 'exempt', cannabis: false },
}

let passed = 0
let failed = 0
const failures = []

const report = (ok, name, detail = '', remedy = '') => {
  if (ok) passed += 1
  else {
    failed += 1
    failures.push({ name, remedy })
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)

async function main() {
  if (!connectionString) {
    console.error('DATABASE_URL is required.')
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
    console.log('Checkout readiness gate (read only)\n')
    console.log(`  database fingerprint: ${fingerprint}`)
    console.log(`  expected migrations:  ${EXPECTED_MIGRATIONS}`)

    /* ================================================== 1. SCHEMA ======== */
    section('[1] Schema')
    {
      const [{ n }] = await q('select count(*)::int n from drizzle.__drizzle_migrations')
      report(
        n === EXPECTED_MIGRATIONS,
        `schema is at migration ${EXPECTED_MIGRATIONS}`,
        `found ${n}`,
        'Run the gated migration sequence in ORDERS.md §14.',
      )

      for (const [table, label] of [
        ['purchase_limit_rules', 'purchase limit rules'],
        ['user_permissions', 'permissions'],
        ['scheduler_runs', 'scheduler runs'],
        ['orders', 'orders'],
      ]) {
        const [{ present }] = await q(
          `select count(*)::int > 0 as present from information_schema.tables
            where table_schema='public' and table_name=$1`,
          [table],
        )
        report(present, `${label} table exists`, '', 'Migrations are behind.')
      }

      const [{ triggers }] = await q(
        `select count(*)::int triggers from pg_trigger
          where tgrelid='purchase_limit_rules'::regclass and not tgisinternal
            and tgenabled='O'`,
      )
      report(
        triggers === 2,
        'both purchase-limit guard triggers are enabled',
        `${triggers} enabled`,
        'Re-run migration 0013; a test harness may have left them disabled.',
      )

      const [{ exclusion }] = await q(
        `select count(*)::int exclusion from pg_constraint
          where conrelid='purchase_limit_rules'::regclass and contype='x'`,
      )
      report(exclusion === 1, 'the rule-overlap exclusion constraint exists', '',
        'Re-run migration 0011.')

      const [{ matrix }] = await q(
        `select count(*)::int matrix from pg_constraint
          where conrelid='product_variants'::regclass
            and conname='product_variants_compliance_matrix'`,
      )
      report(matrix === 1, 'the catalog compliance matrix constraint exists', '',
        'Re-run migration 0015.')
    }

    /* ============================================== 2. PRIVILEGES ======== */
    section('[2] Production role privileges')
    {
      const [{ role, is_superuser }] = await q(
        `select current_user as role,
                (select usesuper from pg_user where usename = current_user) as is_superuser`,
      )
      report(!is_superuser, 'the application role is not a superuser', `role ${role}`,
        'See PURCHASE-LIMITS.md §8 — create a limited application role.')

      for (const table of ['purchase_limit_rules', 'audit_log', 'order_events']) {
        const [owner] = await q(
          `select pg_get_userbyid(c.relowner) as owner from pg_class c
             join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relname=$1`,
          [table],
        )
        const [{ inherits }] = await q(
          `select pg_has_role(current_user, $1, 'USAGE') as inherits`,
          [owner.owner],
        )
        report(!inherits, `does not own ${table}`, `owner ${owner.owner}`,
          'See PURCHASE-LIMITS.md §8 — the app role must not own protected tables.')
      }

      for (const [table, privilege] of [
        ['purchase_limit_rules', 'DELETE'],
        ['purchase_limit_rules', 'TRUNCATE'],
        ['audit_log', 'UPDATE'],
        ['audit_log', 'DELETE'],
        ['order_events', 'DELETE'],
        ['user_permissions', 'INSERT'],
        ['user_permissions', 'UPDATE'],
      ]) {
        const [{ allowed }] = await q(
          `select has_table_privilege(current_user, $1, $2) as allowed`,
          [table, privilege],
        )
        report(!allowed, `cannot ${privilege} ${table}`, '',
          'See PURCHASE-LIMITS.md §8 — REVOKE this privilege.')
      }
    }

    /* ================================================ 3. RULES =========== */
    section('[3] Purchase limit rules')
    {
      const live = await q(
        `select cannabis_class, count(*)::int n
           from purchase_limit_rules
          where effective_from <= now()
            and (effective_until is null or effective_until > now())
            and equivalence_numerator is not null
            and equivalence_denominator is not null
            and expected_basis is not null
            and usable_equivalent_cap_grams is not null
            and concentrate_cap_grams is not null
            and immature_plant_cap_units is not null
          group by cannabis_class`,
      )
      const byClass = new Map(live.map((r) => [r.cannabis_class, r.n]))

      for (const cls of SUPPORTED) {
        const n = byClass.get(cls) ?? 0
        report(
          n === 1,
          `exactly one rule in force for ${cls}`,
          n === 0 ? 'none' : `${n} rules`,
          n === 0
            ? `Publish a rule for ${cls} — products in it cannot be sold.`
            : `More than one rule covers ${cls}; the overlap constraint should have prevented this.`,
        )
      }

      const [{ zero }] = await q(
        `select count(*)::int zero from purchase_limit_rules
          where effective_from <= now()
            and (effective_until is null or effective_until > now())
            and equivalence_numerator = 0
            and cannabis_class not in ('immature_plant','non_cannabis')`,
      )
      report(zero === 0, 'no cannabis class has a zero conversion', `${zero} found`,
        'A zero conversion means unlimited sales. Publish a correction.')

      /**
       * Overlap is checked directly rather than trusted to the constraint,
       * because a database restored without it would look identical from here.
       */
      const [{ overlapCount }] = await q(
        `select count(*)::int as "overlapCount"
           from purchase_limit_rules a join purchase_limit_rules b
             on a.cannabis_class = b.cannabis_class and a.id < b.id
          where tstzrange(a.effective_from, a.effective_until)
             && tstzrange(b.effective_from, b.effective_until)`,
      )
      report(overlapCount === 0, 'no rule windows overlap', `${overlapCount} overlapping pairs`,
        'Two rules claim the same instant. Do not enable checkout.')
    }

    /* ============================================== 4. CATALOG =========== */
    section('[4] Catalog')
    {
      const variants = await q(
        `select v.id, v.sku, v.cannabis_class, v.measurement_basis, v.measurement_value
           from product_variants v join products p on p.id = v.product_id
          where v.active = true and v.deleted_at is null
            and p.status = 'active' and p.deleted_at is null`,
      )

      report(variants.length > 0, 'there are active variants to sell', `${variants.length}`,
        'Load real catalog data.')

      const unsupported = variants.filter(
        (v) => !v.cannabis_class || !SUPPORTED.includes(v.cannabis_class),
      )
      report(
        unsupported.length === 0,
        'no active variant is unclassified, other, edible or unsupported',
        `${unsupported.length} of ${variants.length}`,
        'Classify them at /admin/catalog/compliance. Run `npm run verify:catalog` for the list.',
      )

      const badMeasurement = variants.filter((v) => {
        const spec = CLASS_MEASUREMENT[v.cannabis_class]
        if (!spec) return false
        if (!spec.cannabis) return v.measurement_value !== null || v.measurement_basis !== 'exempt'
        return (
          v.measurement_basis !== spec.basis ||
          v.measurement_value === null ||
          Number(v.measurement_value) <= 0
        )
      })
      report(
        badMeasurement.length === 0,
        'every active cannabis variant has a compatible positive measurement',
        `${badMeasurement.length} incompatible`,
        'Fix at /admin/catalog/compliance.',
      )

      const zeroEquivalent = variants.filter(
        (v) =>
          CLASS_MEASUREMENT[v.cannabis_class]?.cannabis &&
          v.measurement_value !== null &&
          Number(v.measurement_value) === 0,
      )
      report(zeroEquivalent.length === 0, 'no cannabis variant converts to zero',
        `${zeroEquivalent.length}`, 'A zero measurement sells with no cap.')

      const [{ stores }] = await q(
        `select count(*)::int stores from stores
          where status='active' and pickup_enabled = true
            and license_number is not null and license_number <> ''`,
      )
      report(stores > 0, 'at least one licensed pickup store exists', `${stores}`,
        'Create the real store record with its licence number.')

      const [{ badInventory }] = await q(
        `select count(*)::int as "badInventory" from product_variants v
           join products p on p.id = v.product_id
          where v.active = true and v.deleted_at is null
            and p.status='active' and p.deleted_at is null
            and (v.inventory_quantity < 0 or v.reserved_quantity < 0
                 or v.reserved_quantity > v.inventory_quantity)`,
      )
      report(badInventory === 0, 'sellable variants have coherent inventory records',
        `${badInventory} incoherent`,
        'A negative or over-reserved count means stock arithmetic has gone wrong.')
    }

    /* ============================================ 5. SCHEDULER =========== */
    section('[5] Scheduler and configuration')
    {
      const [last] = await q(
        `select started_at, extract(epoch from (now() - started_at))::int as age
           from scheduler_runs
          where job='sweep-expired-drafts' and outcome='completed'
          order by started_at desc limit 1`,
      )
      if (!last) {
        report(false, 'the expiry sweeper has completed recently', 'never run',
          'Install the cron (ORDERS.md §13) and confirm the Vercel plan supports the interval.')
      } else {
        report(
          last.age <= MAX_SWEEP_AGE_SECONDS,
          `the expiry sweeper completed within ${MAX_SWEEP_AGE_SECONDS}s`,
          `${last.age}s ago`,
          'The sweeper is stale; expired holds are not being released.',
        )
      }

      report(
        Boolean(process.env.CRON_SECRET),
        'CRON_SECRET is configured',
        process.env.CRON_SECRET ? 'set' : 'missing',
        'Set CRON_SECRET in the deployment environment; the cron route 503s without it.',
      )

      /**
       * The flag must still be OFF while this runs. A preflight that passes
       * with checkout already live is not a preflight — it is a post-mortem.
       */
      report(
        process.env.CHECKOUT_ENABLED !== 'true',
        'checkout is still disabled during preflight',
        process.env.CHECKOUT_ENABLED ?? 'unset',
        'Run this gate BEFORE enabling checkout.',
      )
    }

    /* ================================================== SUMMARY ========== */
    console.log('\n==========================================================')
    if (failed === 0) {
      console.log(`READY — ${passed} checks passed`)
      console.log('\nCheckout may be enabled. Set CHECKOUT_ENABLED=true and redeploy.')
    } else {
      console.log(`NOT READY — ${passed} passed, ${failed} failed`)
      console.log('\nRemediation:')
      for (const f of failures) console.log(`  • ${f.name}\n      ${f.remedy}`)
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
