/**
 * Production authentication smoke test.
 *
 *   DATABASE_URL=... node scripts/verify-auth-production.mjs <base-url> --allow-production
 *
 * Verifies the six things that prove auth is operational against the live
 * database: sign-up, login, logout, session creation, session revocation, and
 * audit log creation.
 *
 * Deliberately NOT the full 89-assertion suite. That one exercises suspension,
 * lockout and role changes and writes several hundred audit rows — acceptable
 * on a development branch, noise in a real compliance log. This does the
 * minimum that demonstrates the system works, then removes every trace of
 * itself.
 *
 * The production guard must be overridden explicitly with `--allow-production`,
 * so the safety rail in the main suite keeps its meaning.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'https://cloud-market-ten.vercel.app'
const ALLOW = process.argv.includes('--allow-production')

if (!ALLOW) {
  console.error('Refusing to run without --allow-production.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)
const fp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

let passed = 0
let failed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`    ok    ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ------------------------------------------------------------------ plumbing
const decode = (s) =>
  s.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&')

function actionFields(html) {
  const out = {}
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1]
    if (name?.startsWith('$ACTION')) out[name] = decode(/value="([^"]*)"/.exec(m[0])?.[1] ?? '')
  }
  return out
}

const device = (label) => ({ label, cookies: new Map() })

/** Always drains the body: fetch resolves on headers, but the server may still
 *  be streaming, and asserting against Postgres before then races it. */
async function visit(d, path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: [...d.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      'user-agent': `CloudMarketProdCheck/${d.label}`,
      ...(init.headers ?? {}),
    },
  })
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(raw)) d.cookies.delete(pair.slice(0, i).trim())
    else d.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
  const html = await res.text()
  return { status: res.status, headers: res.headers, html }
}

async function submit(d, path, values, containing) {
  const page = await visit(d, path)
  let scope = page.html
  if (containing) {
    const forms = [...page.html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0])
    scope = forms.find((f) => f.includes(containing)) ?? ''
    if (!scope) throw new Error(`no form containing ${containing} on ${path}`)
  }
  const fields = actionFields(scope)
  if (!Object.keys(fields).length) throw new Error(`no action fields on ${path}`)

  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.append(k, v)
  for (const [k, v] of Object.entries(values)) body.append(k, v)
  return visit(d, path, { method: 'POST', body })
}

const hasSession = (d) => [...d.cookies.keys()].some((k) => k.includes('cloudmarket_session'))
const sessionCount = async (id) =>
  Number((await sql('select count(*)::int n from sessions where user_id=$1', [id]))[0].n)
const events = async (id) =>
  (await sql('select event from audit_log where user_id=$1 order by occurred_at', [id])).map(
    (r) => r.event,
  )

const stamp = Date.now()
const EMAIL = `prodcheck.${stamp}@cloudmarket.invalid`
const PASSWORD = 'production-smoke-test-pw-1'

let userId = null

async function main() {
  console.log(`Production auth verification`)
  console.log(`  target   ${BASE}`)
  console.log(`  database ${fp(process.env.DATABASE_URL)} (production)`)
  console.log(`  account  ${EMAIL}\n`)

  const base = {
    users: Number((await sql('select count(*)::int n from users'))[0].n),
    sessions: Number((await sql('select count(*)::int n from sessions'))[0].n),
    audit: Number((await sql('select count(*)::int n from audit_log'))[0].n),
  }
  console.log(
    `  baseline: users=${base.users} sessions=${base.sessions} audit=${base.audit}\n`,
  )

  // ------------------------------------------------------------- 1. sign-up
  console.log('[1] Sign-up')
  const devA = device('A')
  const signUp = await submit(devA, '/sign-up', {
    name: 'Production Check',
    email: EMAIL,
    password: PASSWORD,
    dateOfBirth: '1990-01-01',
  })

  check('sign-up redirects', [302, 303, 307].includes(signUp.status), `got ${signUp.status}`)
  check('session cookie issued', hasSession(devA))

  const [user] = await sql('select * from users where email=$1', [EMAIL])
  userId = user?.id ?? null
  check('user row created', Boolean(user))
  check('role defaults to customer', user?.role === 'customer')
  check('password stored as scrypt hash, not clear', /^scrypt\$/.test(user?.password_hash ?? ''))

  // ---------------------------------------------------- 2. session creation
  console.log('\n[2] Session creation')
  check('session row created', (await sessionCount(userId)) === 1)
  const [s1] = await sql('select * from sessions where user_id=$1', [userId])
  check('token stored hashed (64 hex)', /^[0-9a-f]{64}$/.test(s1.token_hash))
  const cookieValue = devA.cookies.get(
    [...devA.cookies.keys()].find((k) => k.includes('cloudmarket_session')),
  )
  check(
    'stored hash matches SHA-256 of cookie',
    s1.token_hash === createHash('sha256').update(cookieValue).digest('hex'),
  )

  const setCookie = (signUp.headers.getSetCookie?.() ?? []).find((c) =>
    c.includes('cloudmarket_session'),
  )
  check('cookie is __Host- prefixed', (setCookie ?? '').startsWith('__Host-'))
  check('cookie HttpOnly + Secure + SameSite=Lax', /HttpOnly/i.test(setCookie ?? '') && /Secure/i.test(setCookie ?? '') && /SameSite=Lax/i.test(setCookie ?? ''))

  const acct = await visit(devA, '/account')
  check('authenticated request reaches /account', acct.html.includes('Account details'))

  // ----------------------------------------------------------- 3. audit log
  console.log('\n[3] Audit log')
  const afterSignUp = await events(userId)
  check('ACCOUNT_CREATED recorded', afterSignUp.includes('ACCOUNT_CREATED'))
  check('LOGIN recorded', afterSignUp.includes('LOGIN'))
  const [row] = await sql("select * from audit_log where user_id=$1 limit 1", [userId])
  check('IP stored hashed, not in clear', /^[0-9a-f]{64}$/.test(row.ip_hash ?? ''))
  check('user-agent stored hashed', /^[0-9a-f]{64}$/.test(row.user_agent_hash ?? ''))

  // --------------------------------------------------------------- 4. login
  console.log('\n[4] Login')
  const devB = device('B')
  const login = await submit(devB, '/sign-in', { email: EMAIL, password: PASSWORD })
  check('correct password redirects', [302, 303, 307].includes(login.status), `got ${login.status}`)
  check('second session created', (await sessionCount(userId)) === 2)
  check('device B authenticated', (await visit(devB, '/account')).html.includes('Account details'))
  check('LOGIN audited twice', (await events(userId)).filter((e) => e === 'LOGIN').length === 2)

  const badDevice = device('bad')
  const bad = await submit(badDevice, '/sign-in', { email: EMAIL, password: 'wrong-password-xxxx' })
  check('wrong password issues no session', !hasSession(badDevice))
  check('generic failure message', bad.html.includes('Email or password is incorrect'))
  check('FAILED_LOGIN audited', (await events(userId)).includes('FAILED_LOGIN'))
  // Clear the failed-attempt counter this check just incremented.
  await sql('update users set failed_login_attempts=0, locked_until=null where id=$1', [userId])

  // -------------------------------------------------- 5. session revocation
  console.log('\n[5] Session revocation')
  const [bRow] = await sql(
    "select id from sessions where user_id=$1 and user_agent like '%ProdCheck/B%'",
    [userId],
  )
  const aRow = (await sql('select id from sessions where user_id=$1', [userId])).find(
    (r) => r.id !== bRow.id,
  )

  await submit(devB, '/account/security', { sessionId: aRow.id }, 'sessionId')
  check('one session remains after revoke', (await sessionCount(userId)) === 1)
  check(
    'revoked device A is signed out',
    !(await visit(devA, '/account')).html.includes('Account details'),
  )
  check(
    'device B still signed in',
    (await visit(devB, '/account')).html.includes('Account details'),
  )
  check('SESSION_REVOKED audited', (await events(userId)).includes('SESSION_REVOKED'))

  // -------------------------------------------------------------- 6. logout
  console.log('\n[6] Logout')
  await submit(devB, '/account', {}, 'Sign out')
  check('all sessions destroyed', (await sessionCount(userId)) === 0)
  check('LOGOUT audited', (await events(userId)).includes('LOGOUT'))
  check(
    'protected route denied after logout',
    !(await visit(devB, '/account')).html.includes('Account details'),
  )

  console.log(`\n  audit events for this account: ${(await events(userId)).join(', ')}`)

  // ------------------------------------------------------------- 7. cleanup
  console.log('\n[7] Cleanup')
  const auditRows = Number(
    (await sql('select count(*)::int n from audit_log where user_id=$1', [userId]))[0].n,
  )
  // Audit rows are ON DELETE SET NULL, so they must be removed explicitly —
  // otherwise this test leaves orphaned rows in a real compliance log.
  await sql('delete from audit_log where user_id=$1', [userId])
  await sql('delete from users where id=$1', [userId])
  console.log(`    removed ${auditRows} synthetic audit rows and the test account`)

  const after = {
    users: Number((await sql('select count(*)::int n from users'))[0].n),
    sessions: Number((await sql('select count(*)::int n from sessions'))[0].n),
    audit: Number((await sql('select count(*)::int n from audit_log'))[0].n),
  }
  check('users back to baseline', after.users === base.users, `${base.users} -> ${after.users}`)
  check('sessions back to baseline', after.sessions === base.sessions, `${base.sessions} -> ${after.sessions}`)
  check('audit log back to baseline', after.audit === base.audit, `${base.audit} -> ${after.audit}`)

  console.log(`\n${'='.repeat(56)}`)
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  console.log('='.repeat(56))

  await pool.end()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error('\nABORTED:', error.message)
  // Best-effort cleanup so a mid-run failure does not leave test data behind.
  if (userId) {
    await sql('delete from audit_log where user_id=$1', [userId]).catch(() => {})
    await sql('delete from users where id=$1', [userId]).catch(() => {})
    console.error('cleaned up test account')
  }
  await pool.end().catch(() => {})
  process.exit(1)
})
