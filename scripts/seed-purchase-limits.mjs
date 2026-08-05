/**
 * Seeds `purchase_limit_rules` — the daily purchase caps.
 *
 *   node scripts/seed-purchase-limits.mjs            # report only, writes nothing
 *   node scripts/seed-purchase-limits.mjs --confirm  # insert missing rules
 *   node scripts/seed-purchase-limits.mjs --confirm --supersede
 *
 * THIS IS CONFIGURATION, NOT CATALOG DATA. The standing rule is "do not insert
 * fake products or stores into production"; limit rules are neither. They are
 * the legal caps the storefront enforces, and production needs them populated
 * before a single order can be placed correctly. They contain no invented
 * inventory and no invented business.
 *
 * WHY A SCRIPT AND NOT A MIGRATION
 *
 * A migration is the wrong home for a number that a lawyer may correct. Putting
 * 70.87 in `0008_*.sql` would make a legal revision into a schema change, and
 * would make the value invisible to the operator who has to defend it. It is a
 * row, it is meant to be edited, and editing it must not require a deploy.
 *
 * WHY IT REFUSES TO OVERWRITE
 *
 * `purchase_limit_rules` is versioned: `effective_from` / `effective_until`,
 * with a partial unique index allowing one live rule per class. An order that
 * was checked last month must still be re-checkable against the rule that
 * applied then. So this script only ever INSERTS. If a live rule already exists
 * with different numbers it stops and says so; `--supersede` closes the old row
 * (`effective_until = now()`) and opens a new one, which is a correction with a
 * paper trail rather than a silent edit.
 *
 * Running it twice with no changes does nothing and reports nothing to do.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

loadEnv({ path: '.env.local', quiet: true })
loadEnv({ path: '.env', quiet: true })

const CONFIRM = process.argv.includes('--confirm')
const SUPERSEDE = process.argv.includes('--supersede')

const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

/**
 * The Michigan CRA figures.
 *
 * PER TRANSACTION, not per day — adult-use limits attach to the transaction,
 * and the rolling 24-hour window this file used to describe was the
 * medical-caregiver model applied to the wrong scheme.
 *
 * Three independent caps, each of which a basket must pass:
 *
 *   usable-marijuana equivalent  ≤ 2.5 oz  (70.87380781250 g exactly)
 *   concentrate                  ≤ 15 g
 *   immature plants              ≤ 3
 *
 * There is NO runtime fallback any more. `lib/orders/limits.ts` exports
 * `CRA_DEFAULT_RULES` for tests and for this file, but checkout refuses a class
 * with no published rule rather than reaching for a compiled-in default —
 * selling against numbers nobody approved is worse than not selling.
 */
/**
 * 2.5 oz of usable marijuana, exactly. An ounce is 28.349523125 g by
 * definition, so the cap is 70.87380781250 g — written out in full rather than
 * rounded to 70.87, because a cap that has been quietly rounded down is a cap
 * nobody chose.
 */
const USABLE_CAP = '70.87380781250'
const CONCENTRATE_CAP = '15.00000000000'
const PLANT_CAP = 3

const RULES = [
  {
    cannabisClass: 'flower',
    equivalenceNumerator: '1',
    equivalenceDenominator: '1',
    expectedBasis: 'net_weight_grams',
    notes: 'CRA: flower counts 1:1 by actual gram weight.',
  },
  {
    cannabisClass: 'concentrate',
    equivalenceNumerator: '1',
    equivalenceDenominator: '1',
    expectedBasis: 'net_weight_grams',
    notes:
      'CRA: concentrate counts 1:1 by actual gram weight toward the usable cap, ' +
      'and is separately capped at 15 g per transaction. The former 5:1 weighting ' +
      'matched no rule in the guidance and has been removed.',
  },
  {
    cannabisClass: 'infused_solid',
    /** 16 oz of finished product = 1 oz usable. A mass ratio, so 1/16. */
    equivalenceNumerator: '1',
    equivalenceDenominator: '16',
    expectedBasis: 'finished_net_weight_grams',
    notes:
      'CRA: 16 ounces of solid infused product equals 1 ounce of usable marijuana, ' +
      'by FINISHED-PRODUCT mass. Not derived from THC content.',
  },
  {
    cannabisClass: 'infused_liquid',
    /**
     * 36 fl oz = 1 oz usable, so grams-usable per fluid ounce is
     * 45359237/1600000 ÷ 36 = 45359237/57600000. Non-terminating as a decimal,
     * which is exactly why the column pair is integers.
     */
    equivalenceNumerator: '45359237',
    equivalenceDenominator: '57600000',
    expectedBasis: 'finished_volume_fluid_ounces',
    notes:
      'CRA: 36 fluid ounces of liquid infused product equals 1 ounce of usable ' +
      'marijuana, by FINISHED-PRODUCT volume. Exact ratio; not representable as a decimal.',
  },
  {
    cannabisClass: 'immature_plant',
    /** Counted against the plant cap; contributes no usable weight. */
    equivalenceNumerator: '0',
    equivalenceDenominator: '1',
    expectedBasis: 'unit_count',
    notes: 'CRA: no more than 3 immature plants per transaction.',
  },
  {
    cannabisClass: 'non_cannabis',
    /**
     * The ONLY other class permitted to convert to zero, and it says so in its
     * name. This replaces the old `other` rule, whose zero factor meant any
     * unclassified product sold with no cap at all.
     */
    equivalenceNumerator: '0',
    equivalenceDenominator: '1',
    expectedBasis: 'exempt',
    notes:
      'Explicitly exempt retail merchandise — apparel, lighters. NOT a fallback ' +
      'for unclassified product, which fails closed.',
  },
]

const same = (a, b) => String(a) === String(b)

async function main() {
  if (!connectionString) {
    console.error('No connection string resolved. Set DATABASE_URL_UNPOOLED or DATABASE_URL.')
    process.exitCode = 1
    return
  }

  /**
   * Identity, not trust. The same fingerprint the migration gate prints, so an
   * operator can compare the two by eye before allowing a write. No credential
   * is ever printed.
   */
  const endpoint = createHash('sha256')
    .update(new URL(connectionString).hostname.split('.')[0].replace('-pooler', ''))
    .digest('hex')
    .slice(0, 12)

  console.log('Purchase limit rules\n')
  console.log(`  target endpoint id: ${endpoint}`)
  console.log(`  mode:               ${CONFIRM ? (SUPERSEDE ? 'write, superseding' : 'write') : 'report only'}\n`)

  const pool = new Pool({ connectionString })
  const planned = []
  const blocked = []

  try {
    const { rows: live } = await pool.query(
      `select cannabis_class, version, equivalence_numerator, equivalence_denominator,
              expected_basis, usable_equivalent_cap_grams, concentrate_cap_grams,
              immature_plant_cap_units
         from purchase_limit_rules
        where effective_until is null`,
    )
    const byClass = new Map(live.map((r) => [r.cannabis_class, r]))

    for (const rule of RULES) {
      const current = byClass.get(rule.cannabisClass)

      if (!current) {
        planned.push({ rule, action: 'insert' })
        console.log(`  ${rule.cannabisClass.padEnd(12)} missing → insert`)
        continue
      }

      const unchanged =
        same(current.equivalence_numerator, rule.equivalenceNumerator) &&
        same(current.equivalence_denominator, rule.equivalenceDenominator) &&
        same(current.expected_basis, rule.expectedBasis) &&
        same(current.usable_equivalent_cap_grams, USABLE_CAP) &&
        same(current.concentrate_cap_grams, CONCENTRATE_CAP) &&
        current.immature_plant_cap_units === PLANT_CAP

      if (unchanged) {
        console.log(`  ${rule.cannabisClass.padEnd(12)} already correct → skip`)
      } else if (SUPERSEDE) {
        planned.push({ rule, action: 'supersede' })
        console.log(
          `  ${rule.cannabisClass.padEnd(12)} differs → supersede ` +
            `(${current.equivalence_numerator ?? '—'}/${current.equivalence_denominator ?? '—'}` +
            ` → ${rule.equivalenceNumerator}/${rule.equivalenceDenominator})`,
        )
      } else {
        blocked.push(rule.cannabisClass)
        console.log(`  ${rule.cannabisClass.padEnd(12)} DIFFERS from the live rule → blocked`)
      }
    }

    if (blocked.length) {
      console.log(
        `\nA live rule already exists with different numbers for: ${blocked.join(', ')}.\n` +
          'Nothing was changed. Rerun with --supersede to close the existing rule and\n' +
          'open a new one — the old row is kept, so historical orders stay re-checkable.',
      )
      process.exitCode = 1
      return
    }

    if (planned.length === 0) {
      console.log('\nNothing to do. Every class already has the intended live rule.')
      return
    }

    if (!CONFIRM) {
      console.log(`\n${planned.length} change(s) pending. Nothing was written.`)
      console.log('Rerun with --confirm to apply.')
      return
    }

    /**
     * One transaction. Superseding and inserting must not be separable: the
     * partial unique index permits exactly one live rule per class, so a crash
     * between the two halves would leave a class with no cap at all — which
     * fails open, and is the one failure mode this table exists to prevent.
     */
    const client = await pool.connect()
    try {
      await client.query('begin')
      for (const { rule, action } of planned) {
        if (action === 'supersede') {
          await client.query(
            `update purchase_limit_rules
                set effective_until = now(), updated_at = now()
              where cannabis_class = $1 and effective_until is null`,
            [rule.cannabisClass],
          )
        }
        await client.query(
          `insert into purchase_limit_rules
             (cannabis_class, version, equivalence_numerator, equivalence_denominator,
              expected_basis, usable_equivalent_cap_grams, concentrate_cap_grams,
              immature_plant_cap_units, calculation_version, change_reason, notes)
           values ($1,
                   coalesce((select max(version) + 1 from purchase_limit_rules
                              where cannabis_class = $1), 1),
                   $2, $3, $4, $5, $6, $7, 2, $8, $8)`,
          [
            rule.cannabisClass,
            rule.equivalenceNumerator,
            rule.equivalenceDenominator,
            rule.expectedBasis,
            USABLE_CAP,
            CONCENTRATE_CAP,
            PLANT_CAP,
            rule.notes,
          ],
        )
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    const { rows: after } = await pool.query(
      `select cannabis_class, version, equivalence_numerator, equivalence_denominator,
              expected_basis, usable_equivalent_cap_grams, concentrate_cap_grams,
              immature_plant_cap_units
         from purchase_limit_rules
        where effective_until is null
        order by cannabis_class`,
    )

    console.log(`\nApplied ${planned.length} change(s). Live rules now:\n`)
    for (const row of after) {
      console.log(
        `  ${row.cannabis_class.padEnd(15)} v${String(row.version).padEnd(3)} ` +
          `${row.equivalence_numerator}/${row.equivalence_denominator}`.padEnd(22) +
          `${row.expected_basis}`.padEnd(30) +
          `caps ${row.usable_equivalent_cap_grams}g / ${row.concentrate_cap_grams}g / ${row.immature_plant_cap_units}`,
      )
    }

    /**
     * Only the SUPPORTED classes are counted.
     *
     * `edible` and `other` may still have open rows: Postgres cannot remove an
     * enum value, and the rows cannot be deleted. They carry no conversion and
     * checkout refuses those classes outright, so their presence is expected
     * rather than a failure — reporting it as one would train an operator to
     * ignore this script's output.
     */
    const supported = new Set(RULES.map((r) => r.cannabisClass))
    const covered = after.filter((row) => supported.has(row.cannabis_class))
    const legacy = after.filter((row) => !supported.has(row.cannabis_class))

    if (legacy.length > 0) {
      console.log(
        `\nNote: ${legacy.map((r) => r.cannabis_class).join(', ')} are legacy classes ` +
          'with no conversion. Checkout refuses them; they cannot be deleted and do ' +
          'not need superseding.',
      )
    }

    if (covered.length !== RULES.length) {
      const absent = RULES.map((r) => r.cannabisClass).filter(
        (cls) => !covered.some((row) => row.cannabis_class === cls),
      )
      console.log(
        `\nWARNING: no live rule for ${absent.join(', ')}. Checkout REFUSES these ` +
          'classes — products in them cannot be sold until a rule is published.',
      )
      process.exitCode = 1
    }
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
