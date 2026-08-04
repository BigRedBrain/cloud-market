/**
 * Regression tests for the browser verifier's target guard.
 *
 *   node scripts/verify-browser-guard.mjs <local-base-url>
 *
 * The guard exists because a syntactically valid but meaningless connection
 * string — `postgresql://ACTUAL_PRODUCTION_POOLED_STRING` — passed the shape
 * check, hashed to something that was not production, and was therefore read as
 * "safe". The run then signed up against the live storefront and could not
 * clean up, because the database handle pointed at a host that does not exist.
 *
 * Each case below runs the real verifier as a child process and asserts three
 * things: it exits non-zero, it never prints the section header that follows
 * `chromium.launch()`, and — the assertion that actually matters — the user
 * table is unchanged afterwards.
 *
 * DEVELOPMENT ONLY. The refusal cases are aimed at production on purpose (a
 * `GET /api/health` and nothing more); the passing case runs against the local
 * server.
 */
import { spawnSync } from 'node:child_process'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const LOCAL = process.argv[2] ?? 'http://127.0.0.1:3417'
const PRODUCTION = 'https://cloudmarket.cc'

const DEV_URL = process.env.DATABASE_URL
if (!DEV_URL) {
  console.error('DATABASE_URL (development) is required to run these checks.')
  process.exit(1)
}

const pool = new Pool({ connectionString: DEV_URL })
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)

let passed = 0
let failed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`    ok    ${name}`) }
  else { failed += 1; failures.push(name); console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** The header the verifier prints immediately after launching Chromium. */
const LAUNCH_MARKER = '[1] Real browser'

function run(databaseUrl, base, extraArgs = []) {
  const env = { ...process.env }
  if (databaseUrl === undefined) delete env.DATABASE_URL
  else env.DATABASE_URL = databaseUrl

  const result = spawnSync(
    process.execPath,
    ['scripts/verify-account-browser.mjs', base, ...extraArgs],
    { env, encoding: 'utf8', timeout: 120_000 },
  )
  return {
    code: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

const userCount = async () => (await sql('select count(*)::int n from users'))[0].n

async function main() {
  console.log('Browser verifier target-guard regression\n')

  const before = await userCount()
  console.log(`  development users before: ${before}\n`)

  const cases = [
    {
      label: 'placeholder text',
      url: '<PRODUCTION POOLED CONNECTION STRING>',
      base: PRODUCTION,
      expect: /does not look like a connection string/i,
    },
    {
      label: 'syntactically valid placeholder (the actual incident)',
      url: 'postgresql://ACTUAL_PRODUCTION_POOLED_STRING',
      base: PRODUCTION,
      expect: /refused: DATABASE_URL is not the database behind/i,
    },
    {
      label: 'development credential aimed at production',
      url: DEV_URL,
      base: PRODUCTION,
      expect: /refused: DATABASE_URL is not the database behind/i,
    },
    {
      label: 'malformed URL',
      url: 'not-a-url-at-all',
      base: PRODUCTION,
      expect: /does not look like a connection string/i,
    },
    {
      label: 'missing URL',
      url: undefined,
      base: PRODUCTION,
      expect: /is not set/i,
    },
  ]

  for (const testCase of cases) {
    console.log(`  [${testCase.label}]`)
    const { code, out } = run(testCase.url, testCase.base, ['--allow-production'])

    check('exits non-zero', code !== 0, `exit ${code}`)
    check('prints the expected refusal', testCase.expect.test(out),
      out.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 80))
    check('never launched the browser', !out.includes(LAUNCH_MARKER))
    check('printed no connection string',
      !/postgres(ql)?:\/\/[^\s]*:[^\s]*@/.test(out))
    console.log('')
  }

  /**
   * The passing case. Same code path a correct production credential takes —
   * the guard compares against whatever /api/health reports, so a matching
   * local pair exercises it identically. It is stopped as soon as the verdict
   * is printed so the full suite does not run twice.
   */
  console.log('  [matching credential and app]')
  const ok = run(DEV_URL, LOCAL, [])
  check('target confirmed', /target confirmed/.test(ok.out),
    ok.out.split('\n').filter(Boolean)[1]?.slice(0, 80))
  check('the two fingerprints are printed',
    /deployed app fingerprint:/.test(ok.out) && /supplied database fingerprint:/.test(ok.out))
  check('it proceeds to launch the browser', ok.out.includes(LAUNCH_MARKER))
  check('printed no connection string',
    !/postgres(ql)?:\/\/[^\s]*:[^\s]*@/.test(ok.out))

  console.log('')
  const after = await userCount()
  check(`no user was created by any refused run (${before} -> ${after})`,
    after === before, `${before} -> ${after}`)

  console.log('\n==========================================================')
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  console.log('==========================================================')

  await pool.end()
  process.exitCode = failed ? 1 : 0
}

main().catch(async (error) => {
  console.error(`\nABORTED: ${error.message}`)
  await pool.end().catch(() => {})
  process.exitCode = 1
})
