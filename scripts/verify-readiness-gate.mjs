/**
 * The readiness gate's own contract: does it actually fail when it should?
 *
 *   node scripts/verify-readiness-gate.mjs
 *
 * A preflight command is only worth running if a failure is loud. This runs
 * `verify:checkout-readiness` as a subprocess under conditions that must fail,
 * and asserts the EXIT CODE — because that is what a deploy pipeline reads, and
 * a gate that prints FAIL while exiting 0 is worse than no gate at all.
 *
 * Every condition here is produced by an environment variable or a command-line
 * flag. Nothing is written to the database: a test that corrupted the catalog to
 * prove the catalog check works would be a test that corrupted the catalog.
 *
 * DEVELOPMENT ONLY. Refuses the production fingerprint.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local', quiet: true })

const PRODUCTION_FP = '2b968b3cbe06'
const fp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

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

/** Runs the gate and returns { code, stdout }. */
function runGate(env = {}, args = []) {
  const result = spawnSync(
    process.execPath,
    ['scripts/verify-checkout-readiness.mjs', ...args],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      cwd: process.cwd(),
    },
  )
  return { code: result.status, stdout: result.stdout ?? '' }
}

console.log('Readiness gate contract')
console.log(`database ${fp(process.env.DATABASE_URL)} (not production)\n`)

/* ============================================== 1. IT FAILS LOUDLY ======= */
section('[1] Every individual failed gate exits nonzero')
{
  /**
   * Development genuinely fails several gates — it has one owner role and an
   * unclassified catalog — so the baseline is already NOT READY. Each case
   * below adds one more failure and asserts the exit code stays nonzero and
   * the specific line appears.
   */
  const baseline = runGate()
  check('the baseline development run exits nonzero', baseline.code !== 0,
    `exit ${baseline.code}`)
  check('and prints NOT READY', baseline.stdout.includes('NOT READY'))
  check('and prints a remediation section', baseline.stdout.includes('Remediation:'))

  const wrongSchema = runGate({}, ['--expect-migrations=999'])
  check('a schema behind the expected release fails', wrongSchema.code !== 0)
  check('and says so by name',
    wrongSchema.stdout.includes('FAIL  schema is at migration 999'),
    'missing the schema line')

  const noCron = runGate({ CRON_SECRET: '' })
  check('a missing CRON_SECRET fails', noCron.code !== 0)
  check('and says so by name',
    noCron.stdout.includes('FAIL  CRON_SECRET is configured'))

  /**
   * The preflight self-check: running the gate with checkout ALREADY enabled
   * must fail, because a preflight that passes after the fact is a post-mortem.
   */
  const alreadyOn = runGate({ CHECKOUT_ENABLED: 'true' })
  check('running the gate with checkout already enabled fails', alreadyOn.code !== 0)
  check('and says so by name',
    alreadyOn.stdout.includes('FAIL  checkout is still disabled during preflight'))

  /** Every check must print exactly one PASS or FAIL line. */
  const lines = baseline.stdout.split('\n').filter((l) => /^ {2}(PASS|FAIL) {2}/.test(l))
  check('every check prints a PASS/FAIL line', lines.length >= 30, `${lines.length} lines`)

  const failLines = lines.filter((l) => l.startsWith('  FAIL'))
  const remediations = baseline.stdout
    .split('Remediation:')[1]
    ?.split('\n')
    .filter((l) => l.trim().startsWith('•')) ?? []
  check('every failure has a remediation entry',
    remediations.length === failLines.length,
    `${failLines.length} failures, ${remediations.length} remediations`)
}

/* ============================================ 2. IT LEAKS NOTHING ======== */
section('[2] It prints no secret and no connection string')
{
  const output = runGate().stdout

  check('no connection string appears', !/postgres(ql)?:\/\//i.test(output))
  check('no password appears', !output.includes('@ep-') && !/:\/\/[^/\s]*:[^@\s]*@/.test(output))

  const cron = process.env.CRON_SECRET
  if (cron) {
    check('CRON_SECRET is never echoed', !output.includes(cron))
  } else {
    check('CRON_SECRET is never echoed', true, 'not set locally')
  }

  const host = new URL(process.env.DATABASE_URL).hostname
  check('the database hostname is never printed', !output.includes(host))
  check('only the truncated fingerprint appears',
    output.includes(fp(process.env.DATABASE_URL)))
}

/* ============================================= 3. IT IS READ ONLY ======== */
section('[3] It writes nothing')
{
  /**
   * Proved by counting rows in the tables it touches, either side of a run.
   * A gate with a side effect is a gate nobody can safely run against
   * production, which is the only place it matters.
   */
  const { Pool, neonConfig } = await import('@neondatabase/serverless')
  if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  const counts = async () => {
    const tables = [
      'purchase_limit_rules',
      'product_variants',
      'audit_log',
      'scheduler_runs',
      'orders',
      'user_permissions',
    ]
    const out = {}
    for (const t of tables) {
      const { rows } = await pool.query(`select count(*)::int n from ${t}`)
      out[t] = rows[0].n
    }
    return out
  }

  const before = await counts()
  runGate()
  const after = await counts()
  await pool.end()

  for (const table of Object.keys(before)) {
    check(`${table} row count is unchanged`, before[table] === after[table],
      `${before[table]} -> ${after[table]}`)
  }
}

console.log('\n==========================================================')
console.log(`RESULT: ${passed} passed, ${failed} failed`)
if (failures.length) for (const f of failures) console.log(`  • ${f}`)
console.log('==========================================================')
process.exit(failed === 0 ? 0 : 1)
