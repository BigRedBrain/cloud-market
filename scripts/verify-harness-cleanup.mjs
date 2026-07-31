/**
 * Regression test for the verifier's own teardown.
 *
 *   node scripts/verify-harness-cleanup.mjs <base-url>
 *
 * DEVELOPMENT ONLY. It refuses to run against the production endpoint, because
 * proving that a cleanup routine does not destroy audit history is not something
 * to prove on the audit history that matters.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * verify-bag-production.mjs used to end with:
 *
 *     delete from audit_log
 *      where user_id is null and event='FAILED_LOGIN'
 *        and occurred_at > now() - interval '10 minutes'
 *
 * intended to remove the FAILED_LOGIN row its own unknown-account probe had
 * just created. But the predicate describes a SHAPE, not an identity, and every
 * genuine unattributed failed sign-in in the same ten minutes matches it
 * exactly. On production it destroyed two real audit rows — and the residue
 * check still passed, because the count it compared against had been brought
 * back into line by the very deletion that caused the loss.
 *
 * WHAT THIS TEST DOES
 *
 * Plants sentinel rows that a shape-matching cleanup would delete and an
 * identity-based cleanup cannot — including one that is byte-for-byte the shape
 * the old predicate targeted: user_id NULL, event FAILED_LOGIN, occurred_at
 * now. Then it runs the real verifier as a child process and asserts every
 * sentinel survived.
 *
 * It cleans up its own sentinels by exact id, which is the discipline it is
 * testing for.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'http://127.0.0.1:3404'
const PRODUCTION_ENDPOINT_FP = '2b968b3cbe06'

const hostFp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (development).')
  process.exit(1)
}
if (hostFp(process.env.DATABASE_URL) === PRODUCTION_ENDPOINT_FP) {
  console.error('REFUSING: this is the production database. Run it against development.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`  ok    ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Overridable so this test can be pointed at the PRE-FIX verifier to prove it
 * fails there. A regression test that has never failed is an assumption.
 */
const VERIFIER = process.env.VERIFIER_SCRIPT ?? 'scripts/verify-bag-production.mjs'

function runVerifier() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [VERIFIER, BASE, '--allow-production'],
      { env: { ...process.env }, shell: false },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

async function main() {
  console.log(`Harness cleanup regression test against ${BASE}`)
  console.log(`database fingerprint: ${hostFp(process.env.DATABASE_URL)} (not production)\n`)

  const marker = `SENTINEL-${Date.now()}`

  /**
   * Four sentinels. The first is the exact shape the old predicate matched and
   * is the one that actually got destroyed in production; the others confirm
   * the cleanup does not reach adjacent shapes either.
   */
  const planted = []
  const plant = async (label, text, params) => {
    const [row] = await sql(text, params)
    planted.push({ label, id: row.id })
    return row.id
  }

  await plant(
    'unattributed FAILED_LOGIN, right now (the destroyed shape)',
    `insert into audit_log (event, user_id, summary, occurred_at)
     values ('FAILED_LOGIN', null, $1, now()) returning id`,
    [`${marker} unattributed-failed-login`])

  await plant(
    'unattributed FAILED_LOGIN, one minute old',
    `insert into audit_log (event, user_id, summary, occurred_at)
     values ('FAILED_LOGIN', null, $1, now() - interval '1 minute') returning id`,
    [`${marker} unattributed-failed-login-older`])

  await plant(
    'unattributed LOGOUT',
    `insert into audit_log (event, user_id, summary, occurred_at)
     values ('LOGOUT', null, $1, now()) returning id`,
    [`${marker} unattributed-logout`])

  const [realUser] = await sql(`select id from users limit 1`)
  if (realUser) {
    await plant(
      'FAILED_LOGIN attributed to a pre-existing user',
      `insert into audit_log (event, user_id, summary, occurred_at)
       values ('FAILED_LOGIN', $1, $2, now()) returning id`,
      [realUser.id, `${marker} attributed-failed-login`])
  }

  console.log(`planted ${planted.length} sentinel audit rows:`)
  for (const p of planted) console.log(`  ${p.id}  ${p.label}`)

  const auditBefore = (await sql('select count(*)::int n from audit_log'))[0].n
  console.log(`audit_log before verifier: ${auditBefore}\n`)

  console.log('running verify-bag-production.mjs …')
  const { code, out } = await runVerifier()
  const resultLine = out.split('\n').find((l) => l.startsWith('RESULT:')) ?? '(no RESULT line)'
  console.log(`verifier exited ${code} — ${resultLine.trim()}\n`)

  console.log('assertions:')

  const survivingIds = new Set((await sql('select id from audit_log')).map((r) => r.id))
  for (const p of planted) {
    check(`survived: ${p.label}`, survivingIds.has(p.id), `id ${p.id} was deleted`)
  }

  const stillThere = (await sql(
    `select count(*)::int n from audit_log where summary like $1`, [`${marker}%`]))[0].n
  check(`all ${planted.length} sentinels present by marker`, stillThere === planted.length,
    `found ${stillThere}`)

  const auditAfter = (await sql('select count(*)::int n from audit_log'))[0].n
  check('verifier left audit_log at the count it found it',
    auditAfter === auditBefore, `${auditBefore} -> ${auditAfter}`)

  check('the verifier itself asserted audit preservation',
    out.includes('pre-existing audit rows survived'),
    'preservation assertion missing from output')

  check('the verifier no longer deletes by time window',
    !out.includes('interval') && !/delete .*occurred_at/i.test(out))

  /* ---- remove our own sentinels, by exact id ---- */
  const ids = planted.map((p) => p.id)
  await sql(`delete from audit_log where id = any($1::uuid[])`, [ids])
  const leftover = (await sql(
    `select count(*)::int n from audit_log where summary like $1`, [`${marker}%`]))[0].n
  check('sentinels removed by id', leftover === 0, `${leftover} left`)

  console.log('\n==========================================================')
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  console.log('==========================================================')

  await pool.end()
  process.exitCode = failed ? 1 : 0
}

main().catch(async (error) => {
  console.error(`\nABORTED: ${error.message}`)
  await pool.end().catch(() => {})
  process.exitCode = 1
})
