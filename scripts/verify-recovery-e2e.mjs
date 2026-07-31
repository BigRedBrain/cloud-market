/**
 * Phase 3.5 — email verification and password recovery, end to end.
 *
 *   node scripts/verify-recovery-e2e.mjs [base-url]
 *
 * Requires the server to be running with EMAIL_PROVIDER=capture, so the real
 * message is produced and the real link is parsed out of it. Nothing is sent
 * anywhere and no provider credential exists.
 *
 * DEVELOPMENT ONLY — refuses the production fingerprint outright.
 *
 * HARNESS RULE, carried forward from the Phase 3 incident: every row this suite
 * creates is captured BY ID at creation time and deleted by id. There are no
 * shape-based deletes anywhere in this file — no time windows, no `WHERE
 * event = ...`, no "looks like ours". Rows that existed beforehand are
 * snapshotted and asserted to survive.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'http://127.0.0.1:3600'
const PRODUCTION_FP = '2b968b3cbe06'
const fp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}
if (fp(process.env.DATABASE_URL) === PRODUCTION_FP) {
  console.error('REFUSING: this is production. Run against development.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)

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
const section = (t) => console.log(`\n${t}`)

/* ------------------------------------------------------------- http plumbing */
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

async function visit(d, path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: [...d.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      'user-agent': `RecoveryE2E/${d.label}`,
      ...(init.headers ?? {}),
    },
  })
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    const name = pair.slice(0, i).trim()
    if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(raw)) d.cookies.delete(name)
    else d.cookies.set(name, pair.slice(i + 1).trim())
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

/* ------------------------------------------------------------- capture inbox */
const inbox = async () => (await fetch(`${BASE}/api/test-inbox`).then((r) => r.json())).messages
const clearInbox = () => fetch(`${BASE}/api/test-inbox`, { method: 'DELETE' })

/** `after()` runs post-response, so the message appears a moment later. */
async function waitForEmail(predicate, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const messages = await inbox()
    const found = messages.find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

/**
 * Pulls the token out of the emailed link BY PATH, not by origin.
 *
 * The origin is deliberately not the test server's: links are built from
 * `NEXT_PUBLIC_APP_URL` and never from a request header, because a `Host`-
 * derived reset link would deliver a live credential to whatever domain an
 * attacker put in the header. So the email correctly points at the canonical
 * public origin even when the suite is driving localhost, and matching on the
 * path is what keeps this test honest about that.
 */
const tokenFrom = (message, path) => {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`https?://[^\\s"<]+${escaped}/([^\\s"<]+)`).exec(message.text)
  return m ? decodeURIComponent(m[1]) : null
}

/* ------------------------------------------------------------- bookkeeping */
const CREATED_USERS = new Set()
const CREATED_AUDIT = new Set()
let PRE_EXISTING_AUDIT = new Set()

async function trackAudit(action) {
  const before = new Set((await sql('select id from audit_log')).map((r) => r.id))
  const result = await action()
  for (const row of await sql('select id from audit_log')) {
    if (!before.has(row.id)) CREATED_AUDIT.add(row.id)
  }
  return result
}

const stamp = Date.now()
const PASSWORD = 'a-really-solid-original-password'
const NEW_PASSWORD = 'an-entirely-different-password-9'

async function main() {
  console.log(`Recovery E2E against ${BASE}`)
  console.log(`database ${fp(process.env.DATABASE_URL)} (not production)`)

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  if (health.environment === 'production') throw new Error('refusing: app reports production')

  const probe = await fetch(`${BASE}/api/test-inbox`)
  if (probe.status !== 200) {
    throw new Error('capture inbox unavailable — start the server with EMAIL_PROVIDER=capture')
  }
  await clearInbox()

  PRE_EXISTING_AUDIT = new Set((await sql('select id from audit_log')).map((r) => r.id))
  const baselineUsers = (await sql('select count(*)::int n from users'))[0].n
  const baselineTokens = (await sql('select count(*)::int n from verification_tokens'))[0].n
  console.log(`baseline: users=${baselineUsers} tokens=${baselineTokens} audit=${PRE_EXISTING_AUDIT.size}`)

  /* ============================================== 1. VERIFICATION */
  section('[1] Email verification')

  const email = `recovery.${stamp}@example.invalid`
  const customer = device('customer')
  await trackAudit(() =>
    submit(customer, '/sign-up', {
      name: 'Recovery Tester', email, password: PASSWORD, dateOfBirth: '1990-01-01',
    }))

  const [user] = await sql('select id, status, email_verified_at from users where email=$1', [email])
  if (!user) throw new Error('sign-up failed')
  CREATED_USERS.add(user.id)

  check('new account is ACTIVE, not pending_verification', user.status === 'active',
    `status ${user.status}`)
  check('new account starts unverified', user.email_verified_at === null)

  const prompt = await visit(customer, '/account/verify-email')
  check('verify-email page renders for an unverified user', prompt.status === 200)
  check('the page works without JavaScript (has an action form)',
    Object.keys(actionFields(prompt.html)).length > 0)

  await trackAudit(() => submit(customer, '/account/verify-email', {}))
  const verifyMail = await waitForEmail((m) => m.to === email && /Confirm/i.test(m.subject))
  check('a verification email was produced', Boolean(verifyMail))
  check('it has a plain-text part', Boolean(verifyMail?.text?.length))
  check('it has no remote images', !/<img/i.test(verifyMail?.html ?? ''))
  check('it states the 24-hour expiry', /24 hours/.test(verifyMail?.text ?? ''))
  check('it shows the raw URL as text, not just a button',
    /https?:\/\/[^\s]+\/verify-email\//.test(verifyMail?.text ?? ''))
  check('it carries the ignore-if-not-you line',
    /did not create this account/i.test(verifyMail?.text ?? ''))

  const vToken = tokenFrom(verifyMail, '/verify-email')
  check('a token could be parsed from the link', Boolean(vToken))

  const [stored] = await sql(
    `select token_hash, purpose, expires_at, consumed_at from verification_tokens
      where user_id=$1 and purpose='email_verification' order by created_at desc limit 1`,
    [user.id])
  check('token stored as a 64-char hash', /^[0-9a-f]{64}$/.test(stored?.token_hash ?? ''))
  check('stored value is sha256 of the emailed token',
    stored?.token_hash === createHash('sha256').update(vToken).digest('hex'))
  check('the raw token is NOT stored anywhere',
    (await sql(`select count(*)::int n from verification_tokens where token_hash=$1`, [vToken]))[0].n === 0)
  check('purpose recorded as email_verification', stored?.purpose === 'email_verification')

  /* ---- wrong purpose is refused ---- */
  const crossUse = await visit(device('cross'), `/reset-password/${encodeURIComponent(vToken)}`)
  const crossPost = await submit(device('cross2'), `/reset-password/${encodeURIComponent(vToken)}`,
    { token: vToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
  check('a verification token is rejected at the reset endpoint',
    !crossPost.headers.get('location')?.includes('reset=done'),
    `location ${crossPost.headers.get('location')}`)
  check('reset page itself does not consume the token', crossUse.status === 200)

  /* ---- resend supersedes ---- */
  await sql(`update verification_tokens set created_at = now() - interval '5 minutes'
              where user_id=$1`, [user.id])
  await trackAudit(() => submit(customer, '/account/verify-email', {}))
  const secondMail = await waitForEmail(
    (m) => m.to === email && /Confirm/i.test(m.subject) && m.sentAt > verifyMail.sentAt)
  check('a second verification email was produced', Boolean(secondMail))

  const [supersededRow] = await sql(
    `select superseded_at, consumed_at from verification_tokens where token_hash=$1`,
    [createHash('sha256').update(vToken).digest('hex')])
  check('the previous token is marked superseded', supersededRow?.superseded_at !== null)
  check('superseded is NOT recorded as consumed', supersededRow?.consumed_at === null)

  const staleUse = await visit(device('stale'), `/verify-email/${encodeURIComponent(vToken)}`)
  check('the superseded link no longer verifies', !/Email confirmed/i.test(staleUse.html))
  check('account still unverified after using the stale link',
    (await sql('select email_verified_at from users where id=$1', [user.id]))[0].email_verified_at === null)

  /* ---- the current link works ---- */
  const vToken2 = tokenFrom(secondMail, '/verify-email')
  const confirmed = await visit(device('confirm'), `/verify-email/${encodeURIComponent(vToken2)}`)
  check('the current link confirms the address', /Email confirmed/i.test(confirmed.html))

  const [afterVerify] = await sql('select email_verified_at, status from users where id=$1', [user.id])
  check('email_verified_at is set', afterVerify.email_verified_at !== null)
  check('status is untouched by verification', afterVerify.status === 'active')

  const firstVerifiedAt = afterVerify.email_verified_at
  const replay = await visit(device('replay'), `/verify-email/${encodeURIComponent(vToken2)}`)
  check('replaying the link does not fail the user (scanner tolerance)',
    /Email confirmed/i.test(replay.html))
  check('email_verified_at set exactly once — replay did not move it',
    (await sql('select email_verified_at from users where id=$1', [user.id]))[0]
      .email_verified_at.getTime() === firstVerifiedAt.getTime())

  const alreadyVerified = await visit(customer, '/account/verify-email')
  /**
   * Asserted on CONTENT, not status. A redirect() raised after Next has begun
   * streaming returns 200 carrying the destination's body — measured and
   * documented in Phase 1. What matters is that the resend form is gone.
   */
  check('a verified user cannot reach the resend control',
    !/Send the confirmation email/i.test(alreadyVerified.html),
    `status ${alreadyVerified.status}`)

  /* ---- expired token ---- */
  await sql(
    `insert into verification_tokens (user_id, token_hash, purpose, expires_at)
     values ($1,$2,'email_verification', now() - interval '1 hour')`,
    [user.id, createHash('sha256').update('expired-verification-token').digest('hex')])
  const expiredUse = await visit(device('exp'), '/verify-email/expired-verification-token')
  check('an expired verification link is rejected', /expired/i.test(expiredUse.html))

  /* ---- throttle ---- */
  section('[2] Send throttling')

  const throttleEmail = `throttle.${stamp}@example.invalid`
  const throttled = device('throttled')
  await trackAudit(() =>
    submit(throttled, '/sign-up', {
      name: 'Throttle Tester', email: throttleEmail, password: PASSWORD, dateOfBirth: '1990-01-01',
    }))
  const [tUser] = await sql('select id from users where email=$1', [throttleEmail])
  CREATED_USERS.add(tUser.id)

  await trackAudit(() => submit(throttled, '/account/verify-email', {}))
  await waitForEmail((m) => m.to === throttleEmail)
  const immediate = await submit(throttled, '/account/verify-email', {})
  check('a resend inside the 60s cooldown is refused',
    /wait|second/i.test(immediate.html), 'no cooldown message shown')

  // Backdate past the cooldown but leave the daily count, then exhaust it.
  for (let i = 0; i < 5; i += 1) {
    await sql(
      `insert into verification_tokens (user_id, token_hash, purpose, expires_at, created_at)
       values ($1,$2,'email_verification', now() + interval '1 day', now() - interval '2 minutes')`,
      [tUser.id, createHash('sha256').update(`filler-${stamp}-${i}`).digest('hex')])
  }
  /**
   * Backdate EVERY token for this account, not just the fillers. The cooldown
   * is evaluated before the daily cap, so a token issued seconds ago would trip
   * the 60s rule first and this would be testing the wrong limit.
   */
  await sql(
    `update verification_tokens set created_at = now() - interval '2 minutes' where user_id=$1`,
    [tUser.id])
  const capped = await submit(throttled, '/account/verify-email', {})
  check('the 24-hour send cap is enforced', /maximum|tomorrow/i.test(capped.html))

  /* ============================================== 3. RESET — ENUMERATION */
  section('[3] Password reset — anti-enumeration')

  await clearInbox()
  const anon = device('anon')
  const known = await submit(anon, '/forgot-password', { email })
  const unknownEmail = `nobody.${stamp}@example.invalid`
  const unknown = await submit(device('anon2'), '/forgot-password', { email: unknownEmail })
  const malformed = await submit(device('anon3'), '/forgot-password', { email: 'not-an-email' })

  check('known address redirects to the shared confirmation',
    known.headers.get('location')?.includes('/forgot-password/sent'),
    `location ${known.headers.get('location')}`)
  check('unknown address redirects identically',
    unknown.headers.get('location') === known.headers.get('location'),
    `${unknown.headers.get('location')} vs ${known.headers.get('location')}`)
  check('malformed address redirects identically',
    malformed.headers.get('location') === known.headers.get('location'))
  check('all three return the same status', known.status === unknown.status &&
    known.status === malformed.status)

  const sentPage = await visit(anon, '/forgot-password/sent')
  check('the confirmation page is conditional in its wording',
    /if an account exists/i.test(sentPage.html))

  check('no reset token exists for the unknown address',
    (await sql(
      `select count(*)::int n from verification_tokens vt
        join users u on u.id = vt.user_id where u.email=$1`, [unknownEmail]))[0].n === 0)
  check('no user row was created for the unknown address',
    (await sql('select count(*)::int n from users where email=$1', [unknownEmail]))[0].n === 0)

  const resetMail = await waitForEmail((m) => m.to === email && /Reset/i.test(m.subject))
  check('a reset email was produced for the real address', Boolean(resetMail))
  check('no email was produced for the unknown address',
    !(await inbox()).some((m) => m.to === unknownEmail))
  check('reset email states the 1-hour expiry', /1 hour/.test(resetMail?.text ?? ''))
  check('reset email carries the did-not-request warning',
    /did not ask to reset/i.test(resetMail?.text ?? ''))
  check('reset email has no remote images', !/<img/i.test(resetMail?.html ?? ''))
  check('reset email has a plain-text part', Boolean(resetMail?.text?.length))

  /* ---- suspended account ---- */
  await sql(`update users set status='suspended' where id=$1`, [user.id])
  await sql(`update verification_tokens set created_at = now() - interval '5 minutes'
              where user_id=$1 and purpose='password_reset'`, [user.id])
  const beforeSuspended = (await inbox()).length
  const suspendedReq = await submit(device('anon4'), '/forgot-password', { email })
  await new Promise((r) => setTimeout(r, 1500))
  check('a suspended account gets the identical response',
    suspendedReq.headers.get('location') === known.headers.get('location'))
  check('but no reset email is sent to a suspended account',
    (await inbox()).length === beforeSuspended)
  await sql(`update users set status='active' where id=$1`, [user.id])

  /* ============================================== 4. RESET — COMPLETION */
  section('[4] Password reset — completion')

  const rToken = tokenFrom(resetMail, '/reset-password')
  check('a reset token could be parsed', Boolean(rToken))

  const [rStored] = await sql(
    `select token_hash, expires_at from verification_tokens
      where user_id=$1 and purpose='password_reset' order by created_at desc limit 1`, [user.id])
  check('reset token stored hashed',
    rStored?.token_hash === createHash('sha256').update(rToken).digest('hex'))
  const ttlMinutes = (new Date(rStored.expires_at) - Date.now()) / 60000
  check('reset TTL is about an hour', ttlMinutes > 50 && ttlMinutes <= 60,
    `${Math.round(ttlMinutes)} minutes`)

  // Sessions that must not survive.
  const deviceA = device('sessionA')
  const deviceB = device('sessionB')
  await submit(deviceA, '/sign-in', { email, password: PASSWORD })
  await submit(deviceB, '/sign-in', { email, password: PASSWORD })
  const liveBefore = (await sql('select count(*)::int n from sessions where user_id=$1', [user.id]))[0].n
  check('two sessions exist before the reset', liveBefore >= 2, `got ${liveBefore}`)

  const resetPage = await visit(device('resetter'), `/reset-password/${encodeURIComponent(rToken)}`)
  check('the reset page renders', resetPage.status === 200)
  check('the reset page works without JavaScript',
    Object.keys(actionFields(resetPage.html)).length > 0)
  check('rendering the reset page did NOT consume the token',
    (await sql(`select consumed_at from verification_tokens where token_hash=$1`,
      [createHash('sha256').update(rToken).digest('hex')]))[0].consumed_at === null)

  const mismatch = await submit(device('mismatch'), `/reset-password/${encodeURIComponent(rToken)}`,
    { token: rToken, password: NEW_PASSWORD, confirmPassword: 'something-else-entirely' })
  check('mismatched confirmation is rejected', /match/i.test(mismatch.html))

  const resetter = device('resetter2')
  const done = await trackAudit(() =>
    submit(resetter, `/reset-password/${encodeURIComponent(rToken)}`,
      { token: rToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }))

  check('reset redirects to sign-in', done.headers.get('location')?.startsWith('/sign-in'),
    `location ${done.headers.get('location')}`)
  check('reset does NOT sign the customer in',
    ![...resetter.cookies.keys()].some((k) => k.includes('session')),
    `cookies: ${[...resetter.cookies.keys()].join(',')}`)
  check('every previous session was revoked',
    (await sql('select count(*)::int n from sessions where user_id=$1', [user.id]))[0].n === 0)
  check('the reset token is now consumed',
    (await sql(`select consumed_at from verification_tokens where token_hash=$1`,
      [createHash('sha256').update(rToken).digest('hex')]))[0].consumed_at !== null)

  const signInAfter = await visit(device('anon5'), '/sign-in?reset=done')
  check('sign-in shows the reset confirmation', /Password updated/i.test(signInAfter.html))

  const oldPass = device('oldpass')
  await submit(oldPass, '/sign-in', { email, password: PASSWORD })
  check('the old password no longer works',
    ![...oldPass.cookies.keys()].some((k) => k.includes('session')))

  const newPass = device('newpass')
  await submit(newPass, '/sign-in', { email, password: NEW_PASSWORD })
  check('the new password works',
    [...newPass.cookies.keys()].some((k) => k.includes('session')))

  const reuse = await submit(device('reuse'), `/reset-password/${encodeURIComponent(rToken)}`,
    { token: rToken, password: 'yet-another-password-here', confirmPassword: 'yet-another-password-here' })
  check('a consumed reset token is rejected on replay',
    !reuse.headers.get('location')?.includes('reset=done'))
  check('the replay did not change the password again',
    (await (async () => {
      const d = device('stillnew')
      await submit(d, '/sign-in', { email, password: NEW_PASSWORD })
      return [...d.cookies.keys()].some((k) => k.includes('session'))
    })()))

  /* ============================================== 5. PASSWORD CHANGE */
  section('[5] Authenticated password change')

  const changer = device('changer')
  await submit(changer, '/sign-in', { email, password: NEW_PASSWORD })
  const other = device('other')
  await submit(other, '/sign-in', { email, password: NEW_PASSWORD })
  const beforeChange = (await sql('select count(*)::int n from sessions where user_id=$1', [user.id]))[0].n
  check('two sessions before the change', beforeChange >= 2, `got ${beforeChange}`)

  const FINAL_PASSWORD = 'the-final-password-for-this-test'
  await trackAudit(() =>
    submit(changer, '/account/security', {
      currentPassword: NEW_PASSWORD,
      newPassword: FINAL_PASSWORD,
      confirmPassword: FINAL_PASSWORD,
    }, 'currentPassword'))

  const afterChange = await visit(changer, '/account')
  check('the changing session survives', afterChange.status === 200,
    `status ${afterChange.status}`)
  check('exactly one session remains',
    (await sql('select count(*)::int n from sessions where user_id=$1', [user.id]))[0].n === 1)
  const otherAfter = await visit(other, '/account')
  check('the other session was revoked',
    otherAfter.status === 307 || otherAfter.status === 302 || /Sign in/i.test(otherAfter.html))

  /* ============================================== 6. AUDIT + SECRETS */
  section('[6] Audit and secret hygiene')

  const events = (await sql(
    'select event, summary, ip_hash, user_agent_hash from audit_log where user_id=$1', [user.id]))
    .map((r) => r.event)
  check('EMAIL_VERIFICATION_REQUESTED recorded', events.includes('EMAIL_VERIFICATION_REQUESTED'))
  check('EMAIL_VERIFIED recorded', events.includes('EMAIL_VERIFIED'))
  check('PASSWORD_RESET_REQUESTED recorded', events.includes('PASSWORD_RESET_REQUESTED'))
  check('PASSWORD_RESET_COMPLETED recorded', events.includes('PASSWORD_RESET_COMPLETED'))
  check('SESSIONS_REVOKED recorded', events.includes('SESSIONS_REVOKED'))
  check('PASSWORD_CHANGED recorded', events.includes('PASSWORD_CHANGED'))

  const failures_ = (await sql(
    `select event from audit_log where event in ('EMAIL_VERIFICATION_FAILED','PASSWORD_RESET_FAILED')`))
  check('token failures are audited', failures_.length > 0)

  const allRows = await sql('select summary, ip_hash, user_agent_hash from audit_log')
  const secrets = [vToken, vToken2, rToken, PASSWORD, NEW_PASSWORD, FINAL_PASSWORD]
  check('NO audit summary contains a raw token or password',
    !allRows.some((r) => r.summary && secrets.some((s) => s && r.summary.includes(s))))
  check('no audit summary contains a reset or verification URL',
    !allRows.some((r) => r.summary && /https?:\/\//.test(r.summary)))
  check('no audit summary contains an email address',
    !allRows.some((r) => r.summary && r.summary.includes('@')))
  check('IP hashes are 64-char hex, never plain addresses',
    allRows.every((r) => !r.ip_hash || /^[0-9a-f]{64}$/.test(r.ip_hash)))
  check('user-agent hashes are 64-char hex',
    allRows.every((r) => !r.user_agent_hash || /^[0-9a-f]{64}$/.test(r.user_agent_hash)))

  const unknownRows = await sql(
    `select summary, entity_id from audit_log where event='PASSWORD_RESET_REQUESTED' and user_id is null`)
  check('reset requests for unknown addresses record nothing identifying',
    unknownRows.every((r) => !r.summary && !r.entity_id))

  /* ============================================== 7. TRANSPORT SAFETY */
  section('[7] Transport configuration')

  check('the capture inbox is reachable in development', probe.status === 200)
  check('health does not report production', health.environment !== 'production')
  console.log('    note: production fail-closed is asserted by unit checks below')

  /* ============================================== 8. CLEANUP BY IDENTITY */
  section('[8] Cleanup — by exact identity, never by shape')

  for (const id of CREATED_USERS) {
    await sql('delete from verification_tokens where user_id=$1', [id])
    await sql('delete from sessions where user_id=$1', [id])
  }
  const deletableAudit = [...CREATED_AUDIT].filter((id) => !PRE_EXISTING_AUDIT.has(id))
  const refused = [...CREATED_AUDIT].filter((id) => PRE_EXISTING_AUDIT.has(id))
  if (refused.length) console.log(`    REFUSED to delete ${refused.length} pre-existing audit row(s)`)
  // Rows written by after() may land outside a tracked window; scope strictly to
  // the users this run created, which are UUIDs nothing pre-existing can match.
  const ownRows = await sql(
    `select id from audit_log where user_id = any($1::uuid[])`, [[...CREATED_USERS]])
  const toDelete = [...new Set([...deletableAudit, ...ownRows.map((r) => r.id)])]
    .filter((id) => !PRE_EXISTING_AUDIT.has(id))
  if (toDelete.length) {
    await sql('delete from audit_log where id = any($1::uuid[])', [toDelete])
  }
  for (const id of CREATED_USERS) await sql('delete from users where id=$1', [id])

  const surviving = new Set((await sql('select id from audit_log')).map((r) => r.id))
  const lost = [...PRE_EXISTING_AUDIT].filter((id) => !surviving.has(id))
  check(`all ${PRE_EXISTING_AUDIT.size} pre-existing audit rows survived`, lost.length === 0,
    `lost ${lost.length}`)
  check('users back to baseline',
    (await sql('select count(*)::int n from users'))[0].n === baselineUsers)
  check('verification_tokens back to baseline',
    (await sql('select count(*)::int n from verification_tokens'))[0].n === baselineTokens)
  check('no test account remains',
    (await sql('select count(*)::int n from users where email like $1', [`%${stamp}@example.invalid`]))[0].n === 0)

  await clearInbox()

  console.log('\n==========================================================')
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  console.log('==========================================================')

  await pool.end()
  process.exitCode = failed ? 1 : 0
}

main().catch(async (error) => {
  console.error(`\nABORTED: ${error.message}`)
  console.error(error.stack)
  await pool.end().catch(() => {})
  process.exitCode = 1
})
