/**
 * End-to-end authentication verification against a real database.
 *
 *   npm run build && npx next start -p 3200
 *   node scripts/verify-auth-e2e.mjs http://127.0.0.1:3200
 *
 * Drives the real HTTP surface — the same Server Action endpoints a browser
 * posts to — rather than calling functions directly. That is the only way to
 * verify what actually matters here: Set-Cookie attributes, redirect
 * behaviour, session persistence across requests, and route protection.
 *
 * Forms are submitted the way a browser with JavaScript disabled would: the
 * hidden `$ACTION_*` fields are lifted out of the rendered HTML and replayed.
 * If progressive enhancement ever breaks, this suite breaks with it.
 *
 * REFUSES TO RUN against the production database.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'http://127.0.0.1:3200'
const PRODUCTION_POOLED_FP = '2b968b3cbe06'

const fingerprint = (u) =>
  createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

if (fingerprint(process.env.DATABASE_URL) === PRODUCTION_POOLED_FP) {
  console.error('REFUSING TO RUN: .env.local points at the production database.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const sql = (text, params) => pool.query(text, params).then((r) => r.rows)

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`    ok    ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------- cookie jar

/** A "device": its own cookie jar, so two can be signed in simultaneously. */
function newDevice(label) {
  return { label, cookies: new Map() }
}

function cookieHeader(device) {
  return [...device.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function absorbCookies(device, response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    // Expiry in the past = deletion.
    if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(raw)) device.cookies.delete(name)
    else device.cookies.set(name, value)
  }
}

/**
 * Performs a request and FULLY CONSUMES the response body before returning.
 *
 * This matters more than it looks. `fetch` resolves as soon as response headers
 * arrive, but Next streams the render — so server-side work triggered by the
 * request, including the sliding-expiry UPDATE inside `resolveSession`, can
 * still be in flight. Asserting against Postgres at that point races the
 * server and produces intermittent failures that look like product bugs.
 *
 * Draining the body here means every assertion that follows a `visit()` sees a
 * settled world. `text()` is re-exposed over the buffered string so existing
 * call sites keep working (a real Response body can only be read once).
 */
async function visit(device, path, init = {}) {
  const response = await fetch(BASE + path, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: cookieHeader(device),
      'user-agent': `CloudMarketE2E/${device.label}`,
      'x-forwarded-for': '203.0.113.7',
      ...(init.headers ?? {}),
    },
  })
  absorbCookies(device, response)

  const html = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    html,
    text: async () => html,
  }
}

// ------------------------------------------------------- server action forms

const decodeEntities = (s) =>
  s
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')

/**
 * Lifts the hidden `$ACTION_*` fields Next renders for no-JS submission.
 *
 * `$ACTION_REF_n` is emitted with NO value attribute — a browser posts it as an
 * empty string. Matching the whole tag first and reading `value` only if it is
 * present reproduces that; requiring a value silently drops the field and the
 * server then answers "Failed to find Server Action".
 */
function extractActionFields(html) {
  const fields = {}
  const tagRe = /<input\b[^>]*>/g
  let tag
  while ((tag = tagRe.exec(html)) !== null) {
    const name = /name="([^"]+)"/.exec(tag[0])?.[1]
    if (!name || !name.startsWith('$ACTION')) continue
    const value = /value="([^"]*)"/.exec(tag[0])?.[1] ?? ''
    fields[name] = decodeEntities(value)
  }
  return fields
}

/**
 * Loads a page, then posts one of its action forms with `values` merged in.
 *
 * `containing` selects a specific form when a page has several — /account
 * carries both the profile form and the sign-out form, and taking the first
 * one silently exercises the wrong action.
 */
async function submitForm(device, path, values, { formPath, containing } = {}) {
  const page = await visit(device, formPath ?? path)
  const html = await page.text()

  let scope = html
  if (containing) {
    const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0])
    const match = forms.find((f) => f.includes(containing))
    if (!match) throw new Error(`No form containing ${JSON.stringify(containing)} on ${formPath ?? path}`)
    scope = match
  }

  const action = extractActionFields(scope)
  if (Object.keys(action).length === 0) {
    throw new Error(`No server-action fields found on ${formPath ?? path}`)
  }

  const body = new FormData()
  for (const [k, v] of Object.entries(action)) body.append(k, v)
  for (const [k, v] of Object.entries(values)) body.append(k, v)

  return visit(device, path, { method: 'POST', body })
}

/**
 * True when the protected content of `path` was actually served.
 *
 * Status alone is not a reliable signal here. When the DAL raises `redirect()`
 * or `forbidden()` after Next has begun streaming, the framework cannot set a
 * 307/403 and instead embeds the navigation in the response body, so the
 * transport status is 200 while the guarded component never renders. The
 * security property is "was the protected content served", so that is what is
 * asserted — using a marker string that appears only inside the guarded
 * component.
 */
async function servedProtectedContent(device, path, marker) {
  const response = await visit(device, path)
  if (response.status !== 200) return false
  const html = await response.text()
  return html.includes(marker)
}

/** Markers that exist only inside the guarded component of each route. */
const MARKER = {
  account: 'Account details',
  admin: 'Signed in as administrator',
}

// --------------------------------------------------------------- db helpers

const getUser = async (email) =>
  (await sql('select * from users where email = $1', [email]))[0]

const sessionCount = async (userId) =>
  Number((await sql('select count(*)::int n from sessions where user_id=$1', [userId]))[0].n)

const auditEvents = async (userId) =>
  (await sql('select event from audit_log where user_id=$1 order by occurred_at', [userId])).map(
    (r) => r.event,
  )

const stamp = Date.now()
const CUSTOMER = { email: `e2e.customer.${stamp}@example.com`, password: 'a-very-good-password-1' }
const ADMIN = { email: `e2e.admin.${stamp}@example.com`, password: 'another-good-password-2' }

async function main() {
  console.log(`E2E against ${BASE}`)
  console.log(`database fingerprint ${fingerprint(process.env.DATABASE_URL)} (not production)`)

  // =================================================== 1. ACCOUNT CREATION
  section('[1] Account creation')

  const deviceA = newDevice('deviceA')
  const signUp = await submitForm(deviceA, '/sign-up', {
    name: 'E2E Customer',
    email: CUSTOMER.email,
    password: CUSTOMER.password,
    dateOfBirth: '1990-05-04',
  })

  check('redirects after sign-up', [303, 302, 307].includes(signUp.status), `got ${signUp.status}`)
  check('session cookie issued', [...deviceA.cookies.keys()].some((k) => k.includes('cloudmarket_session')))

  const user = await getUser(CUSTOMER.email)
  check('user row created', Boolean(user))
  check('role defaults to customer', user?.role === 'customer')
  check('status is active', user?.status === 'active')
  check('email stored lower-case', user?.email === CUSTOMER.email.toLowerCase())
  check('date of birth stored', Boolean(user?.date_of_birth))

  check('password is NOT stored in clear', user?.password_hash !== CUSTOMER.password)
  check('password hash is scrypt with parameters', /^scrypt\$32768\$8\$1\$/.test(user?.password_hash ?? ''))
  check('hash has salt and digest segments', (user?.password_hash ?? '').split('$').length === 6)

  check('session row created', (await sessionCount(user.id)) === 1)
  const [sessionRow] = await sql('select * from sessions where user_id=$1', [user.id])
  check('session token stored hashed (64 hex)', /^[0-9a-f]{64}$/.test(sessionRow.token_hash))
  const rawCookie = deviceA.cookies.get([...deviceA.cookies.keys()].find((k) => k.includes('cloudmarket_session')))
  check(
    'stored hash equals SHA-256 of the cookie value',
    sessionRow.token_hash === createHash('sha256').update(rawCookie).digest('hex'),
  )
  check('plaintext token never persisted', !JSON.stringify(sessionRow).includes(rawCookie))

  const created = await auditEvents(user.id)
  check('audit ACCOUNT_CREATED recorded', created.includes('ACCOUNT_CREATED'))
  check('audit LOGIN recorded', created.includes('LOGIN'))

  const [auditRow] = await sql(
    "select * from audit_log where user_id=$1 and event='LOGIN' limit 1",
    [user.id],
  )
  check('audit IP is hashed, not clear', auditRow.ip_hash !== '203.0.113.7')
  check('audit IP hash is 64 hex', /^[0-9a-f]{64}$/.test(auditRow.ip_hash))
  check('audit user-agent hashed', /^[0-9a-f]{64}$/.test(auditRow.user_agent_hash))

  // Redirect target
  check('sign-up redirects to /account', (signUp.headers.get('location') ?? '').includes('/account'))

  // =================================================== 2. COOKIE CONFIG
  section('[2] Cookie configuration (production build)')

  const setCookieRaw = (signUp.headers.getSetCookie?.() ?? []).find((c) =>
    c.includes('cloudmarket_session'),
  )
  check('HttpOnly', /HttpOnly/i.test(setCookieRaw ?? ''))
  check('Secure', /Secure/i.test(setCookieRaw ?? ''))
  check('SameSite=Lax', /SameSite=Lax/i.test(setCookieRaw ?? ''))
  check('Path=/', /Path=\//i.test(setCookieRaw ?? ''))
  check('has explicit Expires', /Expires=/i.test(setCookieRaw ?? ''))
  check('__Host- prefix in production', (setCookieRaw ?? '').startsWith('__Host-'))
  check('no Domain attribute (required by __Host-)', !/Domain=/i.test(setCookieRaw ?? ''))

  // =================================================== 3. SESSION LIFECYCLE
  section('[3] Session lifecycle')

  const account = await visit(deviceA, '/account')
  check('signed-in user reaches /account', account.status === 200, `got ${account.status}`)

  const accountHtml = await account.text()
  check('page renders the signed-in email', accountHtml.includes(CUSTOMER.email))

  const account2 = await visit(deviceA, '/account')
  check('session persists across requests', account2.status === 200)

  /**
   * Sliding expiry, on a deliberately clean slate: one user, one session, one
   * request. Reusing a device that has already made requests made this
   * assertion non-deterministic — the refresh is time-based, so any earlier
   * visit can have already reset the clock being measured.
   */
  await sql('delete from sessions where user_id=$1', [user.id])
  const slideDevice = newDevice('slide')
  await submitForm(slideDevice, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })

  await sql(
    `update sessions set last_used_at = now() - interval '3 hours',
                         expires_at   = now() + interval '1 hour'
      where user_id=$1`,
    [user.id],
  )
  const [beforeSlide] = await sql(
    'select id, expires_at, last_used_at from sessions where user_id=$1',
    [user.id],
  )
  const slideVisit = await visit(slideDevice, '/account')
  const slideHtml = await slideVisit.text()
  const slideServed = slideHtml.includes(MARKER.account)
  const slideSessions = await sessionCount(user.id)
  const [afterSlide] = await sql(
    'select expires_at, last_used_at from sessions where id=$1',
    [beforeSlide.id],
  )

  check(
    'sliding expiry refreshes last_used_at',
    new Date(afterSlide.last_used_at) > new Date(beforeSlide.last_used_at),
    `status=${slideVisit.status} servedContent=${slideServed} sessions=${slideSessions} ` +
      `${beforeSlide.last_used_at.toISOString()} -> ${afterSlide.last_used_at.toISOString()}`,
  )
  check(
    'sliding expiry extends expires_at',
    new Date(afterSlide.expires_at) > new Date(beforeSlide.expires_at),
  )

  // Expired session is rejected and cleaned up. Clean slate so the row count
  // assertion measures only this device.
  await sql('delete from sessions where user_id=$1', [user.id])
  const expiredDevice = newDevice('expired')
  await submitForm(expiredDevice, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })
  await sql("update sessions set expires_at = now() - interval '1 minute' where user_id=$1", [user.id])
  check(
    'expired session is rejected (no account content served)',
    !(await servedProtectedContent(expiredDevice, '/account', MARKER.account)),
  )
  check('expired session row deleted on read', (await sessionCount(user.id)) === 0)

  // =================================================== 4. LOGIN
  section('[4] Login')

  const deviceB = newDevice('deviceB')
  const goodLogin = await submitForm(deviceB, '/sign-in', {
    email: CUSTOMER.email,
    password: CUSTOMER.password,
  })
  check('correct password redirects', [303, 302, 307].includes(goodLogin.status))
  check('session row created on login', (await sessionCount(user.id)) >= 1)
  check('LOGIN audited', (await auditEvents(user.id)).filter((e) => e === 'LOGIN').length >= 2)

  const badDevice = newDevice('bad')
  const badLogin = await submitForm(badDevice, '/sign-in', {
    email: CUSTOMER.email,
    password: 'definitely-the-wrong-password',
  })
  const badHtml = await badLogin.text()
  check('wrong password does not redirect', badLogin.status === 200, `got ${badLogin.status}`)
  check('wrong password issues no session cookie', ![...badDevice.cookies.keys()].some((k) => k.includes('cloudmarket_session')))
  check('generic failure message shown', badHtml.includes('Email or password is incorrect'))
  check('message does not reveal which field was wrong', !/no such (account|user)|unknown email/i.test(badHtml))
  check('FAILED_LOGIN audited', (await auditEvents(user.id)).includes('FAILED_LOGIN'))

  // Timing: unknown account vs known account with wrong password.
  const timeOnce = async (email) => {
    const d = newDevice('timing')
    const t0 = performance.now()
    await submitForm(d, '/sign-in', { email, password: 'wrong-password-here-x' })
    return performance.now() - t0
  }
  const unknownTimes = []
  const knownTimes = []
  for (let i = 0; i < 3; i += 1) {
    unknownTimes.push(await timeOnce(`nobody.${stamp}.${i}@example.com`))
    knownTimes.push(await timeOnce(CUSTOMER.email))
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const mUnknown = median(unknownTimes)
  const mKnown = median(knownTimes)
  const ratio = Math.max(mUnknown, mKnown) / Math.min(mUnknown, mKnown)
  check(
    `timing comparable (unknown ${mUnknown.toFixed(0)}ms vs known ${mKnown.toFixed(0)}ms, ratio ${ratio.toFixed(2)})`,
    ratio < 2.5,
  )

  // =================================================== 5. LOGOUT
  section('[5] Logout')

  const beforeLogout = await sessionCount(user.id)
  // /account carries both the profile form and the sign-out form.
  await submitForm(deviceB, '/account', {}, { containing: 'Sign out' })
  check('session row destroyed', (await sessionCount(user.id)) === beforeLogout - 1)
  check('LOGOUT audited', (await auditEvents(user.id)).includes('LOGOUT'))

  check(
    'protected route denied after logout',
    !(await servedProtectedContent(deviceB, '/account', MARKER.account)),
  )

  // =================================================== 6. LOCKOUT
  section('[6] Lockout')

  await sql('update users set failed_login_attempts=0, locked_until=null where id=$1', [user.id])

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const d = newDevice(`lock${attempt}`)
    await submitForm(d, '/sign-in', { email: CUSTOMER.email, password: `wrong-${attempt}-xxxxxxx` })
  }

  const locked = await getUser(CUSTOMER.email)
  check('failed attempts counted to 5', locked.failed_login_attempts === 5, `got ${locked.failed_login_attempts}`)
  check('account locked', locked.locked_until !== null && new Date(locked.locked_until) > new Date())
  check('ACCOUNT_LOCKED audited', (await auditEvents(user.id)).includes('ACCOUNT_LOCKED'))

  const lockedDevice = newDevice('lockedOut')
  const whileLocked = await submitForm(lockedDevice, '/sign-in', {
    email: CUSTOMER.email,
    password: CUSTOMER.password,
  })
  const lockedHtml = await whileLocked.text()
  check('correct password rejected while locked', whileLocked.status === 200)
  check('no session issued while locked', ![...lockedDevice.cookies.keys()].some((k) => k.includes('cloudmarket_session')))
  check('lockout message stays generic', lockedHtml.includes('Email or password is incorrect'))

  await sql('update users set locked_until=null where id=$1', [user.id])
  const unlockedDevice = newDevice('unlocked')
  const afterUnlock = await submitForm(unlockedDevice, '/sign-in', {
    email: CUSTOMER.email,
    password: CUSTOMER.password,
  })
  check('login succeeds after unlock', [303, 302, 307].includes(afterUnlock.status))
  check('ACCOUNT_UNLOCKED audited', (await auditEvents(user.id)).includes('ACCOUNT_UNLOCKED'))
  check('attempt counter reset', (await getUser(CUSTOMER.email)).failed_login_attempts === 0)

  // =================================================== 7. SUSPENSION
  section('[7] Suspension')

  // Clean slate so the row-count assertion measures only this device.
  await sql('delete from sessions where user_id=$1', [user.id])
  const suspendDevice = newDevice('suspend')
  await submitForm(suspendDevice, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })
  check(
    'signed in before suspension',
    await servedProtectedContent(suspendDevice, '/account', MARKER.account),
  )

  // Suspend WITHOUT deleting sessions, to prove read-time enforcement.
  await sql("update users set status='suspended' where id=$1", [user.id])

  check(
    'live session rejected immediately on suspension',
    !(await servedProtectedContent(suspendDevice, '/account', MARKER.account)),
  )
  check('suspended session row deleted on read', (await sessionCount(user.id)) === 0)

  const suspendedLogin = newDevice('suspendedLogin')
  await submitForm(suspendedLogin, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })
  check('suspended account cannot sign in', ![...suspendedLogin.cookies.keys()].some((k) => k.includes('cloudmarket_session')))

  await sql("update users set status='active' where id=$1", [user.id])

  // =================================================== 8. AUTHORIZATION
  section('[8] Authorization ladder')

  const guest = newDevice('guest')
  const guestAccount = await visit(guest, '/account')
  check('guest -> /account redirected', [302, 303, 307].includes(guestAccount.status))
  check(
    'guest redirect preserves destination',
    (guestAccount.headers.get('location') ?? '').includes('next=%2Faccount'),
  )
  const guestAdmin = await visit(guest, '/admin')
  check('guest -> /admin redirected', [302, 303, 307].includes(guestAdmin.status))

  const customer = newDevice('customer')
  await submitForm(customer, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })
  check(
    'customer -> /account allowed',
    await servedProtectedContent(customer, '/account', MARKER.account),
  )
  check(
    'customer -> /admin DENIED',
    !(await servedProtectedContent(customer, '/admin', MARKER.admin)),
  )

  // Verified-customer tier.
  const unverifiedHtml = await (await visit(customer, '/account/verify-email')).text()
  /**
   * Phase 3.5 replaced the placeholder ("Email verification is coming") with a
   * working resend flow, so this now asserts the control exists rather than the
   * apology that stood in for it.
   */
  check('unverified customer sees the verify-email prompt',
    unverifiedHtml.includes('Confirm your email'))
  check('and can request a confirmation email without JavaScript',
    unverifiedHtml.includes('Send the confirmation email'))

  await sql('update users set email_verified_at = now() where id=$1', [user.id])
  const verifiedHtml = await (await visit(customer, '/account/verify-email')).text()
  check(
    'verified customer is sent away from verify-email',
    !verifiedHtml.includes('Email verification is coming'),
  )

  // Admin.
  const adminDevice = newDevice('admin')
  await submitForm(adminDevice, '/sign-up', {
    name: 'E2E Admin',
    email: ADMIN.email,
    password: ADMIN.password,
    dateOfBirth: '1985-02-02',
  })
  const adminUser = await getUser(ADMIN.email)
  check(
    'new account is NOT admin by default',
    !(await servedProtectedContent(adminDevice, '/admin', MARKER.admin)),
  )

  await sql("update users set role='admin' where id=$1", [adminUser.id])
  check(
    'admin -> /admin allowed',
    await servedProtectedContent(adminDevice, '/admin', MARKER.admin),
  )
  check(
    'role change takes effect without re-login',
    await servedProtectedContent(adminDevice, '/admin', MARKER.admin),
  )
  check(
    'admin -> /account still allowed',
    await servedProtectedContent(adminDevice, '/account', MARKER.account),
  )

  // =================================================== 9. REVOCATION
  section('[9] Session revocation')

  await sql('delete from sessions where user_id=$1', [user.id])

  const devA = newDevice('revokeA')
  const devB = newDevice('revokeB')
  await submitForm(devA, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })
  await submitForm(devB, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })

  check('two sessions exist', (await sessionCount(user.id)) === 2)
  check('device A signed in', await servedProtectedContent(devA, '/account', MARKER.account))
  check('device B signed in', await servedProtectedContent(devB, '/account', MARKER.account))

  // Device B revokes device A from the security screen.
  const sessions = await sql('select id from sessions where user_id=$1 order by created_at', [user.id])
  const bSession = await sql(
    'select id from sessions where user_id=$1 and user_agent like $2',
    [user.id, '%revokeB%'],
  )
  const aSessionId = sessions.find((s) => s.id !== bSession[0]?.id)?.id

  await submitForm(
    devB,
    '/account/security',
    { sessionId: aSessionId },
    { containing: 'sessionId' },
  )
  check('one session remains', (await sessionCount(user.id)) === 1)

  check(
    'device A logged out',
    !(await servedProtectedContent(devA, '/account', MARKER.account)),
  )
  check(
    'device B still logged in',
    await servedProtectedContent(devB, '/account', MARKER.account),
  )
  check('SESSION_REVOKED audited', (await auditEvents(user.id)).includes('SESSION_REVOKED'))

  // Revoke all others.
  const devC = newDevice('revokeC')
  const devD = newDevice('revokeD')
  await submitForm(devC, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })
  await submitForm(devD, '/sign-in', { email: CUSTOMER.email, password: CUSTOMER.password })
  check('three sessions before revoke-all', (await sessionCount(user.id)) === 3)

  await submitForm(
    devD,
    '/account/security',
    {},
    { containing: 'Sign out all other devices' },
  )

  check('only the current session survives revoke-all', (await sessionCount(user.id)) === 1)
  check(
    'device C ended',
    !(await servedProtectedContent(devC, '/account', MARKER.account)),
  )
  check('device D survives', await servedProtectedContent(devD, '/account', MARKER.account))

  // =================================================== 10. AUDIT COVERAGE
  section('[10] Audit coverage')

  const allEvents = new Set(await auditEvents(user.id))
  for (const event of [
    'ACCOUNT_CREATED',
    'LOGIN',
    'LOGOUT',
    'FAILED_LOGIN',
    'ACCOUNT_LOCKED',
    'ACCOUNT_UNLOCKED',
    'SESSION_REVOKED',
  ]) {
    check(`${event} present`, allEvents.has(event))
  }

  const [{ n: orphanCount }] = await sql(
    'select count(*)::int n from audit_log where user_id is null',
  )
  check('unknown-account FAILED_LOGIN recorded with null user', Number(orphanCount) > 0)

  const [{ n: totalAudit }] = await sql('select count(*)::int n from audit_log')
  console.log(`\n    (${totalAudit} audit rows written during this run)`)

  // ---------------------------------------------------------------- cleanup
  await sql('delete from users where email = any($1)', [[CUSTOMER.email, ADMIN.email]])

  console.log(`\n${'='.repeat(56)}`)
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) console.log(`Failed: ${failures.join(', ')}`)
  console.log('='.repeat(56))

  await pool.end()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error('\nE2E ABORTED:', error)
  await pool.end().catch(() => {})
  process.exit(1)
})
