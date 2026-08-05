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
 * The Michigan adult-use figures.
 *
 * THESE NEED LEGAL CONFIRMATION BEFORE PRODUCTION USE. 2.5 oz (70.87 g) of
 * usable marijuana per day, of which no more than 15 g may be concentrate, is
 * the commonly stated rule. The equivalence factors — particularly for edibles,
 * which are usually counted by THC content rather than mass — vary by
 * interpretation. An operator who disagrees with a number should change it
 * here, or in the table directly, and rerun with --supersede.
 *
 * These mirror FALLBACK_LIMIT_RULES in lib/orders/limits.ts, which applies only
 * while this table is empty. Once seeded the TABLE wins, so the two drifting
 * apart is visible rather than dangerous — but keep them in step anyway.
 */
const RULES = [
  {
    cannabisClass: 'flower',
    equivalentGramsPerGram: '1.0000',
    dailyEquivalentGramsCap: '70.870',
    dailyConcentrateGramsCap: '15.000',
    notes: 'Michigan adult-use: 2.5 oz usable marijuana per day. Confirm with counsel.',
  },
  {
    cannabisClass: 'concentrate',
    equivalentGramsPerGram: '5.0000',
    dailyEquivalentGramsCap: '70.870',
    dailyConcentrateGramsCap: '15.000',
    notes: 'Concentrate weighted 5:1 against the equivalent cap, plus its own 15 g cap.',
  },
  {
    cannabisClass: 'edible',
    equivalentGramsPerGram: '1.0000',
    dailyEquivalentGramsCap: '70.870',
    dailyConcentrateGramsCap: '15.000',
    notes: 'Edibles are commonly counted by THC content; this factor approximates by mass.',
  },
  {
    cannabisClass: 'other',
    equivalentGramsPerGram: '0.0000',
    dailyEquivalentGramsCap: '70.870',
    dailyConcentrateGramsCap: '15.000',
    notes: 'Accessories and non-cannabis goods contribute nothing to either cap.',
  },
]

const same = (a, b) => Number(a) === Number(b)

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
      `select cannabis_class, equivalent_grams_per_gram, daily_equivalent_grams_cap,
              daily_concentrate_grams_cap
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
        same(current.equivalent_grams_per_gram, rule.equivalentGramsPerGram) &&
        same(current.daily_equivalent_grams_cap, rule.dailyEquivalentGramsCap) &&
        same(current.daily_concentrate_grams_cap ?? 0, rule.dailyConcentrateGramsCap ?? 0)

      if (unchanged) {
        console.log(`  ${rule.cannabisClass.padEnd(12)} already correct → skip`)
      } else if (SUPERSEDE) {
        planned.push({ rule, action: 'supersede' })
        console.log(
          `  ${rule.cannabisClass.padEnd(12)} differs → supersede ` +
            `(${current.equivalent_grams_per_gram} × ${current.daily_equivalent_grams_cap}` +
            ` → ${rule.equivalentGramsPerGram} × ${rule.dailyEquivalentGramsCap})`,
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
             (cannabis_class, equivalent_grams_per_gram, daily_equivalent_grams_cap,
              daily_concentrate_grams_cap, notes)
           values ($1, $2, $3, $4, $5)`,
          [
            rule.cannabisClass,
            rule.equivalentGramsPerGram,
            rule.dailyEquivalentGramsCap,
            rule.dailyConcentrateGramsCap,
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
      `select cannabis_class, equivalent_grams_per_gram, daily_equivalent_grams_cap,
              daily_concentrate_grams_cap
         from purchase_limit_rules
        where effective_until is null
        order by cannabis_class`,
    )

    console.log(`\nApplied ${planned.length} change(s). Live rules now:\n`)
    for (const row of after) {
      console.log(
        `  ${row.cannabis_class.padEnd(12)} factor ${row.equivalent_grams_per_gram}` +
          `  cap ${row.daily_equivalent_grams_cap}g` +
          `  concentrate ${row.daily_concentrate_grams_cap ?? 'none'}g`,
      )
    }

    if (after.length !== RULES.length) {
      console.log(
        `\nWARNING: ${after.length} live rules for ${RULES.length} classes. ` +
          'A class with no live rule gets a factor of 0 and does not count toward any cap.',
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
