/**
 * The limit seeder's production refusal.
 *
 *   node scripts/verify-seed-guard.mjs
 *
 * Publishing a purchase limit rule is irreversible, and the seeder bypasses
 * every control the production path imposes — the `compliance_admin` grant,
 * step-up re-authentication, the typed confirmation, the written reason and the
 * transactional audit row. So the refusal has to be a property of the code, and
 * this proves it two ways:
 *
 *   1. **Unit** — `classifyTarget` is exercised directly, including with a
 *      production fingerprint, which cannot be produced from a real connection
 *      string in a test because it would require forging a SHA-256 prefix.
 *   2. **End to end** — the real CLI, with real arguments, against a real
 *      database, asserting the exit code AND that no row moved.
 *
 * The end-to-end production case is genuine rather than simulated: setting
 * `PRODUCTION_POOLED_URL` to the development string puts development's own
 * fingerprints on the denylist for that run, so the CLI refuses the very
 * database it would otherwise happily seed. Same code path, same branch, no
 * forged hash.
 *
 * DEVELOPMENT ONLY.
 */
import { spawnSync } from 'node:child_process'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

import {
  classifyTarget,
  denyFingerprintsFor,
  hostFingerprint,
  KNOWN_PRODUCTION_FINGERPRINTS,
  PERMITTED_ENVIRONMENTS,
} from './seed-target-guard.mjs'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket
loadEnv({ path: '.env.local', quiet: true })

const PRODUCTION_FP = '2b968b3cbe06'
const fp = (u) => hostFingerprint(u)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}
if (fp(process.env.DATABASE_URL) === PRODUCTION_FP) {
  console.error('REFUSING: this is production.')
  process.exit(1)
}

let passed = 0
let failed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) passed += 1
  else {
    failed += 1
    failures.push(name)
  }
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)

/** Every ordinary argument combination the script accepts. */
const ARG_COMBINATIONS = [
  [],
  ['--confirm'],
  ['--supersede'],
  ['--confirm', '--supersede'],
  ['--supersede', '--confirm'],
  ['--confirm', '--confirm'],
  ['--confirm', '--supersede', '--verbose'],
  ['--force'],
  ['--allow-production'],
  ['--yes', '--confirm', '--supersede'],
]

/** Declarations that must never be accepted. */
const REFUSED_DECLARATIONS = [
  { label: 'unset', value: undefined },
  { label: 'empty', value: '' },
  { label: 'whitespace', value: '   ' },
  { label: 'production', value: 'production' },
  { label: 'prod', value: 'prod' },
  { label: 'PRODUCTION', value: 'PRODUCTION' },
  { label: 'Development (wrong case)', value: 'Development' },
  { label: 'dev (abbreviated)', value: 'dev' },
  { label: 'live', value: 'live' },
  { label: 'development,production', value: 'development,production' },
  { label: 'true', value: 'true' },
  { label: 'yes', value: 'yes' },
]

function runCli(env, args) {
  const merged = { ...process.env, ...env }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k]

  const result = spawnSync(
    process.execPath,
    ['scripts/seed-purchase-limits-dev.mjs', ...args],
    { env: merged, encoding: 'utf8', cwd: process.cwd() },
  )
  return {
    code: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const ruleSignature = async () => {
  const { rows } = await pool.query(
    `select count(*)::int n,
            coalesce(max(version), 0) as max_version,
            coalesce(max(created_at)::text, '') as newest
       from purchase_limit_rules`,
  )
  return `${rows[0].n}:${rows[0].max_version}:${rows[0].newest}`
}

async function main() {
  console.log('Seed guard — the limit seeder refuses production')
  console.log(`database ${fp(process.env.DATABASE_URL)} (not production)`)

  /* ================================ 1. THE UNCONDITIONAL REFUSAL ======== */
  section('[1] A production fingerprint is refused, whatever else is true')
  {
    /**
     * The compiled-in production value, crossed with every declaration and both
     * fingerprint positions. Nothing may reach `allowed: true`.
     */
    let accepted = 0
    let tested = 0
    for (const declared of [
      undefined,
      '',
      'development',
      'staging',
      'production',
      'DEVELOPMENT',
      ' development ',
    ]) {
      for (const position of ['host', 'endpoint']) {
        for (const vercelEnv of [undefined, 'preview', 'development']) {
          tested += 1
          const verdict = classifyTarget({
            hostFp: position === 'host' ? PRODUCTION_FP : 'aaaaaaaaaaaa',
            endpointFp: position === 'endpoint' ? PRODUCTION_FP : 'bbbbbbbbbbbb',
            declaredEnvironment: declared,
            vercelEnv,
            nodeEnv: 'development',
          })
          if (verdict.allowed) accepted += 1
        }
      }
    }
    check(
      `no declaration or environment accepts a production fingerprint (${tested} combinations)`,
      accepted === 0,
      `${accepted} accepted`,
    )

    const verdict = classifyTarget({
      hostFp: PRODUCTION_FP,
      endpointFp: 'bbbbbbbbbbbb',
      declaredEnvironment: 'development',
      nodeEnv: 'development',
    })
    check('the refusal is reported as a production fingerprint',
      verdict.reason === 'production_fingerprint', verdict.reason)
    check('the detail names the fingerprint, not a hostname',
      verdict.detail.includes(PRODUCTION_FP) && !verdict.detail.includes('://'))

    check('the compiled-in denylist is not empty', KNOWN_PRODUCTION_FINGERPRINTS.length > 0)
    check('PRODUCTION_POOLED_URL extends the denylist',
      denyFingerprintsFor(process.env.DATABASE_URL).length >
        KNOWN_PRODUCTION_FINGERPRINTS.length)
    check('an unparseable PRODUCTION_POOLED_URL cannot shrink it',
      denyFingerprintsFor('not-a-url').length === KNOWN_PRODUCTION_FINGERPRINTS.length)
  }

  /* ============================ 2. AMBIGUITY REFUSES ==================== */
  section('[2] An unknown or ambiguous environment is refused')
  {
    for (const { label, value } of REFUSED_DECLARATIONS) {
      const verdict = classifyTarget({
        hostFp: 'aaaaaaaaaaaa',
        endpointFp: 'bbbbbbbbbbbb',
        declaredEnvironment: value,
        nodeEnv: 'development',
      })
      check(`"${label}" is refused`, !verdict.allowed, verdict.allowed ? 'ACCEPTED' : '')
    }

    check('a production platform overrides a development declaration',
      !classifyTarget({
        hostFp: 'aaaaaaaaaaaa',
        endpointFp: 'bbbbbbbbbbbb',
        declaredEnvironment: 'development',
        vercelEnv: 'production',
      }).allowed)
    check('NODE_ENV=production overrides a development declaration',
      !classifyTarget({
        hostFp: 'aaaaaaaaaaaa',
        endpointFp: 'bbbbbbbbbbbb',
        declaredEnvironment: 'development',
        nodeEnv: 'production',
      }).allowed)
    check('an unreadable target is refused',
      !classifyTarget({
        hostFp: null,
        endpointFp: null,
        declaredEnvironment: 'development',
      }).allowed)

    /** The only accepting paths, stated explicitly. */
    for (const env of PERMITTED_ENVIRONMENTS) {
      check(`"${env}" on a clean target is accepted`,
        classifyTarget({
          hostFp: 'aaaaaaaaaaaa',
          endpointFp: 'bbbbbbbbbbbb',
          declaredEnvironment: env,
          nodeEnv: 'development',
        }).allowed === true)
    }
    check('there are exactly two permitted environments',
      PERMITTED_ENVIRONMENTS.length === 2, PERMITTED_ENVIRONMENTS.join(','))
  }

  /* ======================= 3. THE CLI CANNOT BE ARGUED PAST ============= */
  section('[3] No argument combination bypasses the refusal')
  {
    const before = await ruleSignature()

    /**
     * The genuine end-to-end production case. `PRODUCTION_POOLED_URL` is the
     * development string, so development's own fingerprints are on the denylist
     * and the CLI must refuse the database it would otherwise seed — the same
     * branch a real production target takes.
     */
    let refused = 0
    for (const args of ARG_COMBINATIONS) {
      const { code, out } = runCli(
        {
          SEED_TARGET_ENVIRONMENT: 'development',
          PRODUCTION_POOLED_URL: process.env.DATABASE_URL,
        },
        args,
      )
      const ok =
        code !== 0 &&
        out.includes('REFUSING TO WRITE') &&
        out.includes('known production database') &&
        !out.includes('target accepted as')
      if (ok) refused += 1
      else check(`args [${args.join(' ')}] refused against a denylisted target`, false,
        `exit ${code}`)
    }
    check(
      `all ${ARG_COMBINATIONS.length} argument combinations refused a denylisted target`,
      refused === ARG_COMBINATIONS.length,
      `${refused}/${ARG_COMBINATIONS.length}`,
    )

    const after = await ruleSignature()
    check('not one rule row moved', before === after, `${before} -> ${after}`)

    check('the refusal names the admin route as the only production path',
      runCli(
        { SEED_TARGET_ENVIRONMENT: 'development', PRODUCTION_POOLED_URL: process.env.DATABASE_URL },
        ['--confirm', '--supersede'],
      ).out.includes('/admin/purchase-limits'))
    check('and states that no flag overrides it',
      runCli(
        { SEED_TARGET_ENVIRONMENT: 'development', PRODUCTION_POOLED_URL: process.env.DATABASE_URL },
        ['--confirm'],
      ).out.includes('no flag that overrides'))
  }

  /* ============ 4. AMBIGUITY REFUSES BEFORE ANY TRANSACTION ============= */
  section('[4] An ambiguous environment refuses before a write transaction opens')
  {
    const before = await ruleSignature()

    for (const { label, value } of REFUSED_DECLARATIONS) {
      const { code, out } = runCli(
        { SEED_TARGET_ENVIRONMENT: value, PRODUCTION_POOLED_URL: undefined },
        ['--confirm', '--supersede'],
      )

      /**
       * `target accepted as` is printed immediately after the gate and
       * immediately BEFORE the pool is constructed. Its absence is the proof
       * that no connection — and therefore no transaction — was ever opened.
       */
      check(
        `"${label}" refuses before opening a connection`,
        code !== 0 && out.includes('REFUSING TO WRITE') && !out.includes('target accepted as'),
        `exit ${code}`,
      )
    }

    const nodeProd = runCli(
      {
        SEED_TARGET_ENVIRONMENT: 'development',
        NODE_ENV: 'production',
        PRODUCTION_POOLED_URL: undefined,
      },
      ['--confirm', '--supersede'],
    )
    check('NODE_ENV=production refuses before opening a connection',
      nodeProd.code !== 0 && !nodeProd.out.includes('target accepted as'),
      `exit ${nodeProd.code}`)

    const vercelProd = runCli(
      {
        SEED_TARGET_ENVIRONMENT: 'development',
        VERCEL_ENV: 'production',
        PRODUCTION_POOLED_URL: undefined,
      },
      ['--confirm', '--supersede'],
    )
    check('VERCEL_ENV=production refuses before opening a connection',
      vercelProd.code !== 0 && !vercelProd.out.includes('target accepted as'),
      `exit ${vercelProd.code}`)

    const after = await ruleSignature()
    check('not one rule row moved', before === after, `${before} -> ${after}`)
  }

  /* ================== 5. DEVELOPMENT STILL WORKS, IDEMPOTENTLY ========== */
  section('[5] Development behaviour is unchanged')
  {
    const before = await ruleSignature()

    const report = runCli({ SEED_TARGET_ENVIRONMENT: 'development' }, [])
    check('a declared development target is accepted',
      report.out.includes('target accepted as:   development'), `exit ${report.code}`)
    check('report-only exits zero', report.code === 0, `exit ${report.code}`)
    check('report-only writes nothing', (await ruleSignature()) === before)

    const write = runCli({ SEED_TARGET_ENVIRONMENT: 'development' }, ['--confirm', '--supersede'])
    check('--confirm --supersede exits zero on development', write.code === 0,
      `exit ${write.code}`)
    check('and is idempotent — nothing to do', write.out.includes('Nothing to do'),
      write.out.slice(-120))
    check('no rule row moved, because the values already match',
      (await ruleSignature()) === before)

    const staging = classifyTarget({
      hostFp: 'aaaaaaaaaaaa',
      endpointFp: 'bbbbbbbbbbbb',
      declaredEnvironment: 'staging',
      nodeEnv: 'development',
    })
    check('staging is accepted for the same behaviour', staging.allowed === true)
  }

  /* ============================ 6. NO LEAKS ============================= */
  section('[6] The refusal prints no credential')
  {
    const { out } = runCli(
      { SEED_TARGET_ENVIRONMENT: 'production', PRODUCTION_POOLED_URL: process.env.DATABASE_URL },
      ['--confirm', '--supersede'],
    )
    check('no connection string appears', !/postgres(ql)?:\/\//i.test(out))
    check('no hostname appears', !out.includes(new URL(process.env.DATABASE_URL).hostname))
    check('no password appears', !/:\/\/[^/\s]*:[^@\s]*@/.test(out))

    const accepted = runCli({ SEED_TARGET_ENVIRONMENT: 'development' }, []).out
    check('the accepted run prints fingerprints, not hostnames',
      accepted.includes('target endpoint id') &&
        !accepted.includes(new URL(process.env.DATABASE_URL).hostname))
  }
}

main()
  .catch((error) => {
    failed += 1
    failures.push('suite threw')
    console.error(`\nSUITE ERROR: ${error.stack ?? error}`)
  })
  .finally(async () => {
    await pool.end().catch(() => {})
    console.log('\n==========================================================')
    console.log(`RESULT: ${passed} passed, ${failed} failed`)
    if (failures.length) for (const f of failures) console.log(`  • ${f}`)
    console.log('==========================================================')
    process.exit(failed === 0 ? 0 : 1)
  })
