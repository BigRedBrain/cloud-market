/**
 * Catalog readiness — which variants cannot legally enter checkout.
 *
 *   npm run verify:catalog                # every active variant
 *   npm run verify:catalog -- --all       # include inactive and deleted
 *   npm run verify:catalog -- --json      # machine-readable
 *
 * READ ONLY, AND SAFE AGAINST PRODUCTION. It runs SELECTs and nothing else. It
 * deliberately does not offer a `--fix`: rewriting a product's cannabis
 * classification or its compliance measurement is a decision about what a real
 * physical item is, and a script that guesses at that would be inventing legal
 * facts. Every finding here is for a person to resolve in the catalog.
 *
 * WHY THIS EXISTS
 *
 * Checkout fails closed on every one of these conditions, which is correct and
 * also invisible: the failure surfaces as a customer being refused at the last
 * step, one product at a time, with no way to tell how many others are waiting.
 * This turns that into a list that can be worked through before opening.
 *
 * CHECKOUT MUST STAY DISABLED UNTIL THIS REPORTS ZERO UNRESOLVED CANNABIS
 * VARIANTS.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

loadEnv({ path: '.env.local', quiet: true })

const INCLUDE_ALL = process.argv.includes('--all')
const AS_JSON = process.argv.includes('--json')

const connectionString = process.env.DATABASE_URL

/**
 * Mirrors `CLASS_MEASUREMENT` in lib/orders/limits.ts.
 *
 * Duplicated rather than imported because this is a plain `.mjs` operational
 * script that must run against production with no build step and no bundler.
 * The duplication is checked: `verify-compliance.ts` asserts the same matrix
 * from the TypeScript side, and any class added to one and not the other shows
 * up here as `unsupported_class`.
 */
const CLASS_MEASUREMENT = {
  flower: { basis: 'net_weight_grams', unit: 'g', cannabis: true },
  concentrate: { basis: 'net_weight_grams', unit: 'g', cannabis: true },
  infused_solid: { basis: 'finished_net_weight_grams', unit: 'g', cannabis: true },
  infused_liquid: { basis: 'finished_volume_fluid_ounces', unit: 'fl_oz', cannabis: true },
  immature_plant: { basis: 'unit_count', unit: 'unit', cannabis: true },
  non_cannabis: { basis: 'exempt', unit: 'exempt', cannabis: false },
}

/** Every distinct reason a variant cannot be sold, reported separately. */
const CATEGORIES = {
  missing_class: 'cannabis_class is null',
  fallback_other: 'classified `other` — the unsafe legacy fallback',
  legacy_edible: 'classified `edible` — ambiguous between solid and liquid',
  unsupported_class: 'classification is not one the calculation supports',
  missing_measurement_value: 'no compliance measurement recorded',
  missing_measurement_basis: 'no measurement basis recorded',
  incompatible_basis: 'measurement basis does not match the classification',
  zero_measurement: 'cannabis variant measures zero — would sell uncapped',
  negative_measurement: 'measurement is negative',
  no_rule_in_force: 'no published purchase-limit rule covers this class',
  active_despite_failure: 'marked active despite failing a compliance check',
}

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
    /** Which classes actually have a rule in force right now. */
    const ruled = new Set(
      (
        await q(
          `select cannabis_class from purchase_limit_rules
            where effective_from <= now()
              and (effective_until is null or effective_until > now())
              and equivalence_numerator is not null
              and expected_basis is not null
              and usable_equivalent_cap_grams is not null`,
        )
      ).map((r) => r.cannabis_class),
    )

    const variants = await q(
      `select v.id, v.sku, v.active, v.deleted_at,
              v.cannabis_class, v.measurement_basis, v.measurement_value,
              v.weight_grams, v.thc_mg,
              p.name as product_name, p.status as product_status, p.deleted_at as product_deleted_at
         from product_variants v
         join products p on p.id = v.product_id
        ${INCLUDE_ALL ? '' : "where v.active = true and v.deleted_at is null and p.status = 'active' and p.deleted_at is null"}
        order by p.name, v.sku`,
    )

    const findings = []

    for (const v of variants) {
      const problems = []
      const cls = v.cannabis_class
      const spec = CLASS_MEASUREMENT[cls]

      if (cls === null) problems.push('missing_class')
      else if (cls === 'other') problems.push('fallback_other')
      else if (cls === 'edible') problems.push('legacy_edible')
      else if (!spec) problems.push('unsupported_class')

      if (spec) {
        if (!ruled.has(cls)) problems.push('no_rule_in_force')

        if (spec.cannabis) {
          if (v.measurement_value === null) problems.push('missing_measurement_value')
          if (v.measurement_basis === null) problems.push('missing_measurement_basis')
          if (v.measurement_basis !== null && v.measurement_basis !== spec.basis) {
            problems.push('incompatible_basis')
          }
          if (v.measurement_value !== null) {
            const value = Number(v.measurement_value)
            if (value < 0) problems.push('negative_measurement')
            else if (value === 0) problems.push('zero_measurement')
          }
        } else if (v.measurement_basis !== null && v.measurement_basis !== 'exempt') {
          /**
           * A non-cannabis item carrying a cannabis basis. Harmless to a
           * calculation that refuses it, but it means someone classified the
           * item twice and disagreed with themselves — worth resolving before
           * it becomes the other way round.
           */
          problems.push('incompatible_basis')
        }
      }

      /**
       * Reported as its own finding, not just as part of the others.
       *
       * A variant that fails a compliance check while `active = true` is
       * customer-visible right now: it can be browsed and added to a bag, and
       * only fails at checkout. That is a different — and more urgent —
       * situation than a draft product with an incomplete record.
       */
      if (problems.length > 0 && v.active && v.deleted_at === null) {
        problems.push('active_despite_failure')
      }

      if (problems.length > 0) {
        findings.push({
          id: v.id,
          sku: v.sku,
          product: v.product_name,
          cannabisClass: cls,
          measurementBasis: v.measurement_basis,
          measurementValue: v.measurement_value,
          active: v.active,
          problems,
        })
      }
    }

    if (AS_JSON) {
      console.log(
        JSON.stringify(
          { fingerprint, scanned: variants.length, findings },
          null,
          2,
        ),
      )
      process.exitCode = findings.length > 0 ? 1 : 0
      return
    }

    console.log('Catalog readiness for checkout\n')
    console.log(`  database fingerprint: ${fingerprint}`)
    console.log(`  scope:                ${INCLUDE_ALL ? 'all variants' : 'active variants only'}`)
    console.log(`  variants scanned:     ${variants.length}`)
    console.log(`  classes with a rule:  ${[...ruled].sort().join(', ') || 'NONE'}\n`)

    if (variants.length === 0) {
      console.log('  No variants to check. Production has no catalog yet — expected.')
    }

    /** Grouped by reason, because they are resolved reason by reason. */
    for (const [key, description] of Object.entries(CATEGORIES)) {
      const hits = findings.filter((f) => f.problems.includes(key))
      if (hits.length === 0) continue

      console.log(`  ${key}  (${hits.length})`)
      console.log(`    ${description}`)
      for (const hit of hits.slice(0, 25)) {
        console.log(
          `      ${hit.sku.padEnd(20)} ${String(hit.cannabisClass).padEnd(16)} ` +
            `${String(hit.measurementValue ?? '—').padEnd(12)} ${hit.product}`,
        )
      }
      if (hits.length > 25) console.log(`      … and ${hits.length - 25} more`)
      console.log()
    }

    const blockedVariants = findings.length
    const activeBlocked = findings.filter((f) => f.active).length

    console.log('==========================================================')
    if (blockedVariants === 0) {
      console.log(`READY — all ${variants.length} variant(s) can enter checkout`)
    } else {
      console.log(`NOT READY — ${blockedVariants} variant(s) cannot enter checkout`)
      console.log(`            ${activeBlocked} of them are ACTIVE and customer-visible`)
      console.log('\nCheckout must remain disabled until this reports zero.')
      console.log('Resolve in the catalog; this script deliberately does not rewrite records.')
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
