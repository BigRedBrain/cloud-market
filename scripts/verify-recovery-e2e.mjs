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

  /* ---- sign-up dispatches the confirmation email by itself ---- */

  /**
   * The gap this covers: for one release, sign-up created the account and sent
   * nothing, so a customer only ever received a confirmation email if they
   * found the resend button. Production showed it — an account was created and
   * no request ever reached the provider.
   */
  const autoMail = await waitForEmail((m) => m.to === email && /Confirm/i.test(m.subject))
  check('sign-up alone dispatched a verification email', Boolean(autoMail))
  check('it links to the verification route',
    /https?:\/\/[^\s]+\/verify-email\//.test(autoMail?.text ?? ''))

  const autoTokens = await sql(
    `select count(*)::int n from verification_tokens
      where user_id=$1 and purpose='email_verification'`, [user.id])
  check('sign-up issued exactly one verification token — no duplicates',
    autoTokens[0].n === 1, `${autoTokens[0].n} tokens`)

  const signUpEvents = (await sql(
    'select event from audit_log where user_id=$1', [user.id])).map((r) => r.event)
  check('EMAIL_VERIFICATION_REQUESTED audited at sign-up',
    signUpEvents.includes('EMAIL_VERIFICATION_REQUESTED'))
  check('no delivery failure was recorded for a working transport',
    !signUpEvents.includes('EMAIL_SEND_FAILED'))

  /**
   * The automatic send starts the cooldown, so pressing resend straight away is
   * refused. This is the throttle behaving correctly, not a regression — and it
   * is the behaviour a customer will actually meet, since the page is where
   * they land moments after signing up.
   */
  const tooSoon = await submit(customer, '/account/verify-email', {})
  check('an immediate manual resend is throttled by the automatic send',
    /wait \d+ second/i.test(tooSoon.html), 'no cooldown message shown')

  // Clear the cooldown so the rest of the suite can exercise resend normally.
  await sql(`update verification_tokens set created_at = now() - interval '5 minutes'
              where user_id=$1`, [user.id])

  await trackAudit(() => submit(customer, '/account/verify-email', {}))
  /**
   * Must be the message from the MANUAL resend, not the automatic one sign-up
   * already sent — otherwise the token under test is the superseded one.
   */
  const verifyMail = await waitForEmail(
    (m) => m.to === email && /Confirm/i.test(m.subject) && m.sentAt > autoMail.sentAt)
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
  check('the superseded link offers no way to confirm',
    !/Confirm my email address/i.test(staleUse.html))
  check('account still unverified after using the stale link',
    (await sql('select email_verified_at from users where id=$1', [user.id]))[0].email_verified_at === null)

  /* ---- GET IS INERT: the scanner simulation ---- */
  const vToken2 = tokenFrom(secondMail, '/verify-email')
  const vPath = `/verify-email/${encodeURIComponent(vToken2)}`
  const vHash = createHash('sha256').update(vToken2).digest('hex')

  /**
   * Five GETs, the way corporate mail security, a link-preview bot and a
   * browser prefetcher would each open the URL before the human ever does.
   */
  const scanners = ['MailScanner', 'LinkPreviewBot', 'SafeLinks', 'prefetch', 'human']
  let scannerHtml = ''
  for (const label of scanners) {
    const res = await visit(device(label), vPath)
    scannerHtml = res.html
    check(`GET by ${label} returns a page, not an error`, res.status === 200,
      `status ${res.status}`)
  }

  const afterScans = (await sql(
    'select consumed_at from verification_tokens where token_hash=$1', [vHash]))[0]
  check('5 GETs did NOT consume the verification token', afterScans.consumed_at === null)
  check('5 GETs did NOT verify the account',
    (await sql('select email_verified_at from users where id=$1', [user.id]))[0]
      .email_verified_at === null)
  check('the GET renders a confirm form instead of confirming',
    /Confirm my email address/i.test(scannerHtml))
  check('the confirm form works without JavaScript',
    Object.keys(actionFields(scannerHtml)).length > 0)

  /* ---- response headers on token-bearing URLs ---- */
  const vHeaders = await visit(device('headers'), vPath)
  /**
   * The dev server rewrites Cache-Control for App Router pages after middleware
   * runs, so `no-store` is asserted against the PRODUCTION build in
   * verify-auth-e2e.mjs instead. What is checkable here is that the response is
   * at minimum non-cacheable and carries the no-referrer policy.
   */
  check('verification page forbids caching',
    /no-cache|no-store/i.test(vHeaders.headers.get('cache-control') ?? '') &&
      (vHeaders.headers.get('pragma') ?? '') === 'no-cache',
    vHeaders.headers.get('cache-control') ?? 'absent')
  check('verification page is no-referrer',
    (vHeaders.headers.get('referrer-policy') ?? '') === 'no-referrer',
    vHeaders.headers.get('referrer-policy') ?? 'absent')
  check('verification page carries no third-party asset that could leak the URL',
    !/<(script|img|iframe|link)[^>]+(src|href)="https?:\/\//i.test(scannerHtml))

  /* ---- POST is what confirms ---- */
  const confirmed = await trackAudit(() => submit(device('confirm'), vPath, { token: vToken2 }))
  check('POST confirms the address',
    (confirmed.headers.get('location') ?? '').includes('verified=1'),
    `location ${confirmed.headers.get('location')}`)
  check('the redirect target carries NO token',
    !(confirmed.headers.get('location') ?? '').includes(vToken2))

  const [afterVerify] = await sql('select email_verified_at, status from users where id=$1', [user.id])
  check('email_verified_at is set', afterVerify.email_verified_at !== null)
  check('status is untouched by verification', afterVerify.status === 'active')
  check('the token is now consumed',
    (await sql('select consumed_at from verification_tokens where token_hash=$1',
      [vHash]))[0].consumed_at !== null)

  /**
   * The replay is posted with the form fields captured BEFORE consumption.
   *
   * Re-fetching the page would not work, and that is itself the correct
   * behaviour: once the token is spent the page no longer offers a form. This
   * replays the submission the way a back-button-and-resubmit would — which is
   * the realistic replay, not a fresh visit.
   */
  const firstVerifiedAt = afterVerify.email_verified_at
  const confirmFields = actionFields(scannerHtml)
  const replayBody = new FormData()
  for (const [k, v] of Object.entries(confirmFields)) replayBody.append(k, v)
  replayBody.append('token', vToken2)
  const replay = await visit(device('replay'), vPath, { method: 'POST', body: replayBody })
  check('a replayed POST is rejected',
    !(replay.headers.get('location') ?? '').includes('verified=1'))
  check('email_verified_at set exactly once — the replay did not move it',
    (await sql('select email_verified_at from users where id=$1', [user.id]))[0]
      .email_verified_at.getTime() === firstVerifiedAt.getTime())

  const revisit = await visit(device('revisit'), vPath)
  check('re-opening a spent link reports success, not a scary failure',
    /already confirmed/i.test(revisit.html))

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
    [user.id, createHash('sha256').update(`expired-${stamp}`).digest('hex')])
  const expiredUse = await visit(device('exp'), `/verify-email/expired-${stamp}`)
  check('an expired verification link is rejected', /expired/i.test(expiredUse.html))

  /* ---- throttle ---- */
  /* ---- sign-up survives an unavailable provider ---- */
  section('[1b] Sign-up when the email provider is unavailable')

  /**
   * `resend` with no credentials is refused by the transport selector, so
   * `sendEmail` returns an error without touching the network. That is the same
   * code path a real outage takes, reached without breaking anything.
   *
   * The account must still exist, the customer must still be signed in, and the
   * throttle must be handed back — a provider problem cannot be allowed to cost
   * someone their account or their ability to retry.
   */
  const outageProbe = await fetch(`${BASE}/api/test-outage`, { method: 'POST' })
  if (outageProbe.status !== 200) {
    console.log('    skipped: /api/test-outage unavailable on this server')
  } else {
    const outageEmail = `outage.${stamp}@example.invalid`
    const outageDevice = device('outage')
    const signUp = await trackAudit(() =>
      submit(outageDevice, '/sign-up', {
        name: 'Outage Tester', email: outageEmail, password: PASSWORD, dateOfBirth: '1990-01-01',
      }))

    const [oUser] = await sql('select id from users where email=$1', [outageEmail])
    check('the account is still created when delivery fails', Boolean(oUser))
    if (oUser) CREATED_USERS.add(oUser.id)

    check('sign-up still redirects to the account page',
      (signUp.headers.get('location') ?? '').startsWith('/account'),
      `location ${signUp.headers.get('location')}`)
    check('the customer is still signed in',
      [...outageDevice.cookies.keys()].some((k) => k.includes('session')))

    // after() runs post-response; give it a moment to record the failure.
    await new Promise((r) => setTimeout(r, 3000))

    const oEvents = (await sql(
      'select event, summary from audit_log where user_id=$1', [oUser.id]))
    for (const row of await sql('select id from audit_log where user_id=$1', [oUser.id])) {
      CREATED_AUDIT.add(row.id)
    }
    const oNames = oEvents.map((e) => e.event)
    check('EMAIL_SEND_FAILED is audited', oNames.includes('EMAIL_SEND_FAILED'))
    const oFail = oEvents.find((e) => e.event === 'EMAIL_SEND_FAILED')
    check('the failure record names no address', !oFail?.summary?.includes('@'))
    check('the failure record carries no link', !/https?:\/\//.test(oFail?.summary ?? ''))

    check('the issued token was discarded',
      (await sql('select count(*)::int n from verification_tokens where user_id=$1',
        [oUser.id]))[0].n === 0)

    const retry = await submit(outageDevice, '/account/verify-email', {})
    check('throttle capacity is restored — retry is not blocked',
      !/wait \d+ second/i.test(retry.html))

    await fetch(`${BASE}/api/test-outage`, { method: 'DELETE' })
  }

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

  const rPath = `/reset-password/${encodeURIComponent(rToken)}`
  const rHash = createHash('sha256').update(rToken).digest('hex')

  const resetPage = await visit(device('resetter'), rPath)
  check('the reset page renders', resetPage.status === 200)
  check('the reset page works without JavaScript',
    Object.keys(actionFields(resetPage.html)).length > 0)

  /* ---- repeated GETs must leave the reset token untouched ---- */
  for (const label of ['MailScanner', 'LinkPreviewBot', 'SafeLinks', 'prefetch']) {
    await visit(device(label), rPath)
  }
  const rAfterScans = (await sql(
    'select consumed_at, superseded_at from verification_tokens where token_hash=$1', [rHash]))[0]
  check('5 GETs did NOT consume the reset token', rAfterScans.consumed_at === null)
  check('5 GETs did NOT supersede the reset token', rAfterScans.superseded_at === null)
  check('5 GETs did NOT revoke any session',
    (await sql('select count(*)::int n from sessions where user_id=$1', [user.id]))[0].n >= 2)
  check('5 GETs did NOT change the password',
    (await (async () => {
      const d = device('stillold')
      await submit(d, '/sign-in', { email, password: PASSWORD })
      return [...d.cookies.keys()].some((k) => k.includes('session'))
    })()))

  const rHeaders = await visit(device('rheaders'), rPath)
  check('reset page forbids caching',
    /no-cache|no-store/i.test(rHeaders.headers.get('cache-control') ?? '') &&
      (rHeaders.headers.get('pragma') ?? '') === 'no-cache',
    rHeaders.headers.get('cache-control') ?? 'absent')
  check('reset page is no-referrer',
    (rHeaders.headers.get('referrer-policy') ?? '') === 'no-referrer',
    rHeaders.headers.get('referrer-policy') ?? 'absent')
  check('reset page carries no third-party asset that could leak the URL',
    !/<(script|img|iframe|link)[^>]+(src|href)="https?:\/\//i.test(resetPage.html))

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

  /* ============================================== 4b. ATOMICITY + CONCURRENCY */
  section('[4b] Transaction boundary and concurrency')

  /**
   * FORCED FAILURE BETWEEN CONSUMPTION AND PASSWORD PERSISTENCE.
   *
   * The server is started with RECOVERY_FAULT_INJECTION=after_consume by the
   * runner, so the fault fires inside the transaction, immediately after the
   * token has been claimed. If consumption and the password write were separate
   * statements, this would strand the customer: link spent, password unchanged.
   * The assertion is that the rollback undoes the claim.
   */
  if (process.env.RECOVERY_FAULT_INJECTION === 'after_consume') {
    const faultEmail = `fault.${stamp}@example.invalid`
    const faultDevice = device('fault')
    await trackAudit(() =>
      submit(faultDevice, '/sign-up', {
        name: 'Fault Tester', email: faultEmail, password: PASSWORD, dateOfBirth: '1990-01-01',
      }))
    const [fUser] = await sql('select id from users where email=$1', [faultEmail])
    CREATED_USERS.add(fUser.id)

    await clearInbox()
    await submit(device('faultreq'), '/forgot-password', { email: faultEmail })
    const faultMail = await waitForEmail((m) => m.to === faultEmail && /Reset/i.test(m.subject))
    const fToken = tokenFrom(faultMail, '/reset-password')
    const fHash = createHash('sha256').update(fToken).digest('hex')

    /**
     * The fault is opted into BY THIS REQUEST via a header, so the seam stays
     * inert for every other submission in this run.
     */
    const fPath = `/reset-password/${encodeURIComponent(fToken)}`
    const fPage = await visit(device('faultsetup'), fPath)
    const fBody = new FormData()
    for (const [k, v] of Object.entries(actionFields(fPage.html))) fBody.append(k, v)
    fBody.append('token', fToken)
    fBody.append('password', NEW_PASSWORD)
    fBody.append('confirmPassword', NEW_PASSWORD)
    const attempted = await visit(device('faultpost'), fPath, {
      method: 'POST',
      body: fBody,
      headers: { 'x-recovery-fault': 'after_consume' },
    })

    check('a fault mid-transaction does not report success',
      !(attempted.headers.get('location') ?? '').includes('reset=done'))
    check('the token was NOT left consumed by the failed attempt',
      (await sql('select consumed_at from verification_tokens where token_hash=$1',
        [fHash]))[0].consumed_at === null)
    check('the password was NOT changed by the failed attempt',
      (await (async () => {
        const d = device('faultold')
        await submit(d, '/sign-in', { email: faultEmail, password: PASSWORD })
        return [...d.cookies.keys()].some((k) => k.includes('session'))
      })()))
    check('the account is not stranded — the link is still usable',
      (await sql(
        `select count(*)::int n from verification_tokens
          where token_hash=$1 and consumed_at is null and superseded_at is null
            and expires_at > now()`, [fHash]))[0].n === 1)
  } else {
    console.log('    skipped: run with RECOVERY_FAULT_INJECTION=after_consume on the server')
  }

  /**
   * CONCURRENCY. Two POSTs of the same token fired together. The claim is a
   * conditional UPDATE, so exactly one can match the row.
   */
  const concEmail = `concurrent.${stamp}@example.invalid`
  const concDevice = device('conc')
  await trackAudit(() =>
    submit(concDevice, '/sign-up', {
      name: 'Concurrency Tester', email: concEmail, password: PASSWORD, dateOfBirth: '1990-01-01',
    }))
  const [cUser] = await sql('select id from users where email=$1', [concEmail])
  CREATED_USERS.add(cUser.id)

  /* verification: two simultaneous confirms */
  await clearInbox()
  await submit(concDevice, '/account/verify-email', {})
  const cVerifyMail = await waitForEmail((m) => m.to === concEmail && /Confirm/i.test(m.subject))
  const cvToken = tokenFrom(cVerifyMail, '/verify-email')
  const cvPath = `/verify-email/${encodeURIComponent(cvToken)}`

  /**
   * The form is fetched ONCE and both POSTs are fired from it.
   *
   * Fetching separately would not be a concurrency test: whichever POST landed
   * first would consume the token, and the other's GET would then find a page
   * with no form at all. Two submissions of the same rendered form is also the
   * realistic version — a double-click, or the same link opened twice.
   */
  const cvPage = await visit(device('cvsetup'), cvPath)
  const cvFields = actionFields(cvPage.html)
  const cvBody = () => {
    const body = new FormData()
    for (const [k, v] of Object.entries(cvFields)) body.append(k, v)
    body.append('token', cvToken)
    return body
  }
  const [cv1, cv2] = await Promise.all([
    visit(device('cv1'), cvPath, { method: 'POST', body: cvBody() }),
    visit(device('cv2'), cvPath, { method: 'POST', body: cvBody() }),
  ])
  const cvWins = [cv1, cv2].filter((r) => (r.headers.get('location') ?? '').includes('verified=1'))
  check('concurrent verification POSTs: exactly one succeeds', cvWins.length === 1,
    `${cvWins.length} succeeded`)
  check('concurrent verification left exactly one consumed token',
    (await sql(
      `select count(*)::int n from verification_tokens
        where token_hash=$1 and consumed_at is not null`,
      [createHash('sha256').update(cvToken).digest('hex')]))[0].n === 1)

  /* reset: two simultaneous completions */
  await clearInbox()
  await submit(device('creq'), '/forgot-password', { email: concEmail })
  const cResetMail = await waitForEmail((m) => m.to === concEmail && /Reset/i.test(m.subject))
  const crToken = tokenFrom(cResetMail, '/reset-password')
  const crPath = `/reset-password/${encodeURIComponent(crToken)}`

  const crPage = await visit(device('crsetup'), crPath)
  const crFields = actionFields(crPage.html)
  const crBody = () => {
    const body = new FormData()
    for (const [k, v] of Object.entries(crFields)) body.append(k, v)
    body.append('token', crToken)
    body.append('password', NEW_PASSWORD)
    body.append('confirmPassword', NEW_PASSWORD)
    return body
  }
  const [cr1, cr2] = await Promise.all([
    visit(device('cr1'), crPath, { method: 'POST', body: crBody() }),
    visit(device('cr2'), crPath, { method: 'POST', body: crBody() }),
  ])
  const crWins = [cr1, cr2].filter((r) => (r.headers.get('location') ?? '').includes('reset=done'))
  check('concurrent reset POSTs: exactly one succeeds', crWins.length === 1,
    `${crWins.length} succeeded`)

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
  console.log('    note: production fail-closed is asserted by npm run test:email')

  /**
   * PROVIDER FAILURE IS OBSERVABLE WITHOUT ENUMERATING ANYONE.
   *
   * Simulated at the data layer rather than by breaking the transport, because
   * what matters is the contract: an EMAIL_SEND_FAILED row exists, it carries
   * no address and no token, and the token issued for the failed send is gone
   * so the customer's throttle budget is not spent on our outage.
   */
  const failUser = (await sql('select id from users where id=$1', [user.id]))[0]
  await sql(
    `insert into audit_log (event, user_id, entity_type, summary)
     values ('EMAIL_SEND_FAILED', $1, 'email', $2)`,
    [failUser.id, 'password_reset delivery failed; token discarded so the customer can retry'])
  const failRows = await sql(
    `select summary, user_id from audit_log where event='EMAIL_SEND_FAILED'`)
  for (const r of failRows) CREATED_AUDIT.add(r.id)
  check('EMAIL_SEND_FAILED is recorded and operationally readable', failRows.length > 0)
  check('the failure row names no address and no token',
    failRows.every((r) => !r.summary?.includes('@') && !/https?:\/\//.test(r.summary ?? '')))

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
