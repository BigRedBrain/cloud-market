/**
 * Production verification for Phase 3.5, in four modes matching the rollout.
 *
 *   $env:DATABASE_URL = "<production POOLED string>"
 *   node scripts/verify-recovery-production.mjs <base-url> --allow-production <mode>
 *
 *   schema       steps 2 + 3 — post-migration schema, and old code unaffected
 *   failclosed   step 4      — production refuses ConsoleTransport
 *   flow         step 8      — both flows, driven from a link you were emailed
 *   cleanup      removes rows recorded by a previous run, by exact id
 *
 * WHY `flow` NEEDS YOU. Once Resend is live the suite cannot read the inbox, and
 * the token is stored only as a SHA-256 — it cannot be recovered from the
 * database. So you perform the human half (request, open your mail) and pass the
 * link in; the script does everything that can be checked mechanically. Any
 * script claiming to verify production email end-to-end without a real mailbox
 * is verifying something else.
 *
 * IDENTITY-BASED CLEANUP ONLY. Every row this creates is recorded to a local
 * ledger file at creation time and deleted by id. No shape-based deletes — no
 * time windows, no `WHERE event = …`. That rule exists because a shape-based
 * delete destroyed two production audit rows during Phase 3.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'https://cloud-market-ten.vercel.app'
const ALLOW = process.argv.includes('--allow-production')
const MODE = ['schema', 'failclosed', 'flow', 'cleanup'].find((m) => process.argv.includes(m))
const LEDGER = '.recovery-prod-ledger.json'

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

if (!ALLOW || !MODE) {
  console.error('Usage: node scripts/verify-recovery-production.mjs <url> --allow-production <schema|failclosed|flow|cleanup>')
  process.exit(1)
}
requireConnectionString(process.env.DATABASE_URL)

/**
 * Validate the SHAPE before fingerprinting it. `new URL()` on a placeholder
 * throws ERR_INVALID_URL from deep inside Node, which reads like a bug in this
 * script rather than an unset variable. This is the third time a configuration
 * mistake has surfaced as a stack trace; it should surface as a sentence.
 */
function requireConnectionString(value, name = 'DATABASE_URL') {
  if (!value) {
    console.error(`${name} is not set.\n` +
      `  PowerShell:  $env:${name} = "postgresql://…"\n` +
      `  bash:        export ${name}="postgresql://…"`)
    process.exit(1)
  }
  if (!/^postgres(ql)?:\/\//.test(value)) {
    console.error(`${name} does not look like a connection string.\n` +
      `  It currently starts with: ${value.slice(0, 24)}…\n` +
      `  Expected something beginning postgresql:// — if you copied the command\n` +
      `  from the docs, replace the placeholder with the real value.`)
    process.exit(1)
  }
  return value
}

const hostFp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

let pool = null
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)

let passed = 0
let failed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`    ok    ${name}`) }
  else { failed += 1; failures.push(name); console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

/* ------------------------------------------------------------------ ledger */

const readLedger = () =>
  existsSync(LEDGER)
    ? JSON.parse(readFileSync(LEDGER, 'utf8'))
    : { users: [], audit: [], preExistingAudit: [], baseline: null }
const writeLedger = (l) => writeFileSync(LEDGER, JSON.stringify(l, null, 2))

/* -------------------------------------------------------------- http utils */

const device = (label) => ({ label, cookies: new Map() })

async function visit(d, path, init = {}) {
  const url = path.startsWith('http') ? path : BASE + path
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: [...d.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      'user-agent': `CloudMarketRecoveryProd/${d.label}`,
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
  return { status: res.status, headers: res.headers, html: await res.text() }
}

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

async function submit(d, path, values) {
  const page = await visit(d, path)
  const fields = actionFields(page.html)
  if (!Object.keys(fields).length) throw new Error(`no action fields on ${path}`)
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.append(k, v)
  for (const [k, v] of Object.entries(values)) body.append(k, v)
  return visit(d, path, { method: 'POST', body })
}

/** Refuses to read anything until the target is the deployed app's database. */
async function assertTarget() {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  const mine = hostFp(process.env.DATABASE_URL)
  console.log(`deployed app database:  ${health.database?.fingerprint} (${health.environment})`)
  console.log(`this script's database: ${mine}`)
  if (health.database?.fingerprint !== mine) {
    console.error('\nREFUSING TO RUN: different database than the deployed application.')
    process.exitCode = 1
    return null
  }
  console.log('target confirmed\n')
  pool = new Pool({ connectionString: process.env.DATABASE_URL })
  return health
}

const TRACKED = ['users', 'sessions', 'verification_tokens', 'audit_log',
  'products', 'product_variants']

const snapshot = async () => {
  const out = {}
  for (const t of TRACKED) out[t] = (await sql(`select count(*)::int n from ${t}`))[0].n
  return out
}

/* ========================================================== MODE: schema === */

async function modeSchema() {
  section('[2] Migration 0007 landed')

  const migrations = await sql('select count(*)::int n from drizzle.__drizzle_migrations')
  console.log(`    journal entries: ${migrations[0].n}`)
  check('journal is at 8 entries (0000-0007)', migrations[0].n === 8, `${migrations[0].n}`)

  const expected = ['EMAIL_VERIFICATION_REQUESTED', 'EMAIL_VERIFIED', 'EMAIL_VERIFICATION_FAILED',
    'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'PASSWORD_RESET_FAILED',
    'SESSIONS_REVOKED', 'EMAIL_SEND_FAILED']
  const labels = (await sql(
    `select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
      where t.typname='audit_event'`)).map((r) => r.enumlabel)
  for (const label of expected) check(`enum value ${label} exists`, labels.includes(label))

  const [{ present: hasColumn }] = await sql(
    `select count(*)::int > 0 as present from information_schema.columns
      where table_schema='public' and table_name='verification_tokens'
        and column_name='superseded_at'`)
  check('verification_tokens.superseded_at exists', hasColumn)

  const indexes = (await sql(
    `select indexname from pg_indexes where schemaname='public'
      and tablename='verification_tokens'`)).map((r) => r.indexname)
  check('throttle index exists',
    indexes.includes('verification_tokens_user_purpose_created_idx'),
    indexes.join(', '))

  /**
   * The migration is additive, so nothing that already existed may have moved.
   * Counted rather than assumed: an additive migration that quietly dropped
   * rows would still "apply successfully".
   */
  const counts = await snapshot()
  console.log(`    ${TRACKED.map((t) => `${t}=${counts[t]}`).join('  ')}`)
  check('no verification token was altered by the migration',
    (await sql('select count(*)::int n from verification_tokens where superseded_at is not null'))[0].n === 0)
  check('production catalog is still empty',
    counts.products === 0 && counts.product_variants === 0)

  section('[3] Schema ahead of code is safe')

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  check('/api/health ok', health.status === 'ok')
  check('database reachable', health.database?.reachable === true)

  for (const [path, label] of [['/', 'home'], ['/shop', 'shop'], ['/sign-in', 'sign-in'],
    ['/sign-up', 'sign-up']]) {
    const res = await visit(device('anon'), path)
    check(`${label} still 200`, res.status === 200, `status ${res.status}`)
  }

  const signIn = await visit(device('anon'), '/sign-in')
  check('sign-in still renders a usable form',
    Object.keys(actionFields(signIn.html)).length > 0)

  /**
   * The pre-Phase-3.5 build has no recovery routes. If these answer, the code
   * has already been deployed and the ordering was not what it should be.
   */
  section('[3b] Old code exposes no recovery behaviour')
  for (const path of ['/forgot-password', '/verify-email/probe', '/reset-password/probe']) {
    const res = await visit(device('anon'), path)
    check(`${path} is not served by the old build`, res.status === 404,
      `status ${res.status} — Phase 3.5 code may already be deployed`)
  }
}

/* ====================================================== MODE: failclosed === */

async function modeFailClosed() {
  section('[4] Production refuses a non-sending transport')

  const ledger = readLedger()
  ledger.preExistingAudit = (await sql('select id from audit_log')).map((r) => r.id)
  ledger.baseline = await snapshot()
  writeLedger(ledger)
  console.log(`    recorded ${ledger.preExistingAudit.length} pre-existing audit ids for protection`)

  const stamp = Date.now()
  const email = `failclosed.${stamp}@example.invalid`
  const password = 'a-controlled-production-check-password'

  const customer = device('customer')
  await submit(customer, '/sign-up', {
    name: 'Fail Closed Check', email, password, dateOfBirth: '1990-01-01',
  })
  const [user] = await sql('select id from users where email=$1', [email])
  check('controlled account created', Boolean(user))
  if (!user) return
  ledger.users.push(user.id)
  writeLedger(ledger)

  const tokensBefore = (await sql(
    'select count(*)::int n from verification_tokens where user_id=$1', [user.id]))[0].n

  /** The minimum request that forces a send attempt. */
  await submit(customer, '/account/verify-email', {})
  await new Promise((r) => setTimeout(r, 4000)) // after() runs post-response

  const events = await sql(
    'select id, event, summary from audit_log where user_id=$1 order by occurred_at', [user.id])
  for (const row of events) ledger.audit.push(row.id)
  writeLedger(ledger)

  const names = events.map((e) => e.event)
  check('EMAIL_VERIFICATION_REQUESTED recorded', names.includes('EMAIL_VERIFICATION_REQUESTED'))
  check('EMAIL_SEND_FAILED recorded — the failure is operationally visible',
    names.includes('EMAIL_SEND_FAILED'))

  const failure = events.find((e) => e.event === 'EMAIL_SEND_FAILED')
  check('the failure row contains no address', !failure?.summary?.includes('@'))
  check('the failure row contains no link', !/https?:\/\//.test(failure?.summary ?? ''))

  const tokensAfter = (await sql(
    'select count(*)::int n from verification_tokens where user_id=$1', [user.id]))[0].n
  check('the issued token was discarded on delivery failure',
    tokensAfter === tokensBefore, `${tokensBefore} -> ${tokensAfter}`)

  /**
   * Throttle capacity is computed from token rows, so discarding the token is
   * what gives the budget back. Without it a provider outage would lock a
   * customer out of recovery for a day.
   */
  check('throttle capacity is restored (no token consumed the budget)', tokensAfter === 0)

  const retry = await submit(customer, '/account/verify-email', {})
  check('the customer can retry immediately', !/wait \d+ second/i.test(retry.html))

  check('no raw token exists anywhere in the token table',
    (await sql(
      `select count(*)::int n from verification_tokens where length(token_hash) <> 64`))[0].n === 0)

  await runCleanup()
}

/* ============================================================ MODE: flow === */

async function modeFlow() {
  const link = arg('link')
  const email = arg('email')
  const oldPassword = arg('old-password')
  const newPassword = arg('new-password')
  const kind = arg('kind') // 'verify' | 'reset'

  if (!link || !kind) {
    console.error('Usage: ... flow --kind=verify|reset --link="<the URL from the email>" [--email=] [--old-password=] [--new-password=]')
    process.exitCode = 1
    return
  }

  const path = new URL(link).pathname
  const token = decodeURIComponent(path.split('/').pop())
  const tokenHash = createHash('sha256').update(token).digest('hex')

  section(`[8] ${kind} flow, driven from the emailed link`)

  const [row] = await sql(
    'select id, user_id, purpose, consumed_at, expires_at from verification_tokens where token_hash=$1',
    [tokenHash])
  check('the emailed token exists in the database', Boolean(row))
  if (!row) return

  check('it is stored only as a 64-char hash', /^[0-9a-f]{64}$/.test(tokenHash))
  check('the RAW token is not stored anywhere',
    (await sql('select count(*)::int n from verification_tokens where token_hash=$1', [token]))[0].n === 0)
  check('purpose matches the flow',
    row.purpose === (kind === 'verify' ? 'email_verification' : 'password_reset'), row.purpose)
  check('it is unconsumed before we start', row.consumed_at === null)

  const ttlMinutes = (new Date(row.expires_at) - Date.now()) / 60000
  check(kind === 'verify' ? 'TTL is about 24 hours' : 'TTL is about 1 hour',
    kind === 'verify' ? ttlMinutes > 1000 : ttlMinutes > 0 && ttlMinutes <= 60,
    `${Math.round(ttlMinutes)} minutes`)

  /* ---- headers ---- */
  const head = await visit(device('headers'), path)
  check('response is no-store', /no-store/i.test(head.headers.get('cache-control') ?? ''),
    head.headers.get('cache-control') ?? 'absent')
  check('response is no-referrer',
    (head.headers.get('referrer-policy') ?? '') === 'no-referrer',
    head.headers.get('referrer-policy') ?? 'absent')
  check('response is noindex',
    /noindex/i.test(head.headers.get('x-robots-tag') ?? ''),
    head.headers.get('x-robots-tag') ?? 'absent')
  check('the page loads no third-party asset that could leak the URL',
    !/<(script|img|iframe|link)[^>]+(src|href)="https?:\/\//i.test(head.html))

  /* ---- scanner GETs ---- */
  for (const label of ['MailScanner', 'LinkPreviewBot', 'SafeLinks', 'prefetch']) {
    await visit(device(label), path)
  }
  const afterScans = (await sql(
    'select consumed_at from verification_tokens where token_hash=$1', [tokenHash]))[0]
  check('repeated scanner-style GETs did NOT consume the token',
    afterScans.consumed_at === null)

  if (kind === 'verify') {
    const before = (await sql('select email_verified_at from users where id=$1', [row.user_id]))[0]
    check('GETs did not verify the account', before.email_verified_at === null)

    const page = await visit(device('confirm'), path)
    const result = await submit(device('confirm2'), path, { token })
    void page
    check('POST verified the account',
      (result.headers.get('location') ?? '').includes('verified=1'),
      `location ${result.headers.get('location')}`)
    check('the redirect carries no token',
      !(result.headers.get('location') ?? '').includes(token))

    const after = (await sql('select email_verified_at from users where id=$1', [row.user_id]))[0]
    check('email_verified_at is set', after.email_verified_at !== null)
    check('the token is consumed',
      (await sql('select consumed_at from verification_tokens where token_hash=$1',
        [tokenHash]))[0].consumed_at !== null)

    const replay = await visit(device('replay'), path)
    check('re-opening the link reports already confirmed',
      /already confirmed/i.test(replay.html))
    check('email_verified_at was not moved by the replay',
      (await sql('select email_verified_at from users where id=$1',
        [row.user_id]))[0].email_verified_at.getTime() === after.email_verified_at.getTime())
  } else {
    if (!email || !oldPassword || !newPassword) {
      console.error('reset flow needs --email, --old-password and --new-password')
      process.exitCode = 1
      return
    }

    const a = device('sessionA')
    const b = device('sessionB')
    await submit(a, '/sign-in', { email, password: oldPassword })
    await submit(b, '/sign-in', { email, password: oldPassword })
    const live = (await sql('select count(*)::int n from sessions where user_id=$1',
      [row.user_id]))[0].n
    check('two sessions exist before the reset', live >= 2, `${live}`)

    const result = await submit(device('resetter'), path,
      { token, password: newPassword, confirmPassword: newPassword })
    check('POST completed the reset',
      (result.headers.get('location') ?? '').includes('reset=done'),
      `location ${result.headers.get('location')}`)
    check('the redirect carries no token',
      !(result.headers.get('location') ?? '').includes(token))
    check('no session was created — no automatic sign-in',
      ![...device('resetter').cookies.keys()].some((k) => k.includes('session')))
    check('every prior session was revoked',
      (await sql('select count(*)::int n from sessions where user_id=$1', [row.user_id]))[0].n === 0)

    const oldTry = device('oldpass')
    await submit(oldTry, '/sign-in', { email, password: oldPassword })
    check('the old password no longer works',
      ![...oldTry.cookies.keys()].some((k) => k.includes('session')))

    const newTry = device('newpass')
    await submit(newTry, '/sign-in', { email, password: newPassword })
    check('the new password works',
      [...newTry.cookies.keys()].some((k) => k.includes('session')))

    const replay = await submit(device('replay'), path,
      { token, password: newPassword, confirmPassword: newPassword })
    check('the consumed token is rejected on replay',
      !(replay.headers.get('location') ?? '').includes('reset=done'))
  }

  /* ---- secret hygiene across the whole log ---- */
  section('[8b] Secret hygiene')
  const rows = await sql('select summary, ip_hash, user_agent_hash from audit_log')
  check('no audit summary contains a raw token',
    !rows.some((r) => r.summary?.includes(token)))
  check('no audit summary contains a URL', !rows.some((r) => /https?:\/\//.test(r.summary ?? '')))
  check('no audit summary contains an address', !rows.some((r) => r.summary?.includes('@')))
  check('every ip_hash is a 64-char digest',
    rows.every((r) => !r.ip_hash || /^[0-9a-f]{64}$/.test(r.ip_hash)))

  const ledger = readLedger()
  const created = await sql('select id from audit_log where user_id=$1', [row.user_id])
  for (const r of created) if (!ledger.audit.includes(r.id)) ledger.audit.push(r.id)
  if (!ledger.users.includes(row.user_id)) ledger.users.push(row.user_id)
  writeLedger(ledger)
  console.log(`\n    ledger now holds ${ledger.users.length} user(s) and ${ledger.audit.length} audit row(s)`)
  console.log('    run `cleanup` when both flows are finished')
}

/* ========================================================= MODE: cleanup === */

async function runCleanup() {
  section('[9] Cleanup — by exact id only')

  const ledger = readLedger()
  const protectedIds = new Set(ledger.preExistingAudit)

  for (const userId of ledger.users) {
    await sql('delete from verification_tokens where user_id=$1', [userId])
    await sql('delete from sessions where user_id=$1', [userId])
  }

  const own = await sql('select id from audit_log where user_id = any($1::uuid[])',
    [ledger.users.length ? ledger.users : ['00000000-0000-0000-0000-000000000000']])
  const candidates = [...new Set([...ledger.audit, ...own.map((r) => r.id)])]
  const deletable = candidates.filter((id) => !protectedIds.has(id))
  const refused = candidates.filter((id) => protectedIds.has(id))
  if (refused.length) console.log(`    REFUSED to delete ${refused.length} pre-existing audit row(s)`)
  if (deletable.length) {
    await sql('delete from audit_log where id = any($1::uuid[])', [deletable])
    console.log(`    removed ${deletable.length} audit row(s) created by this run`)
  }
  for (const userId of ledger.users) await sql('delete from users where id=$1', [userId])

  const surviving = new Set((await sql('select id from audit_log')).map((r) => r.id))
  const lost = ledger.preExistingAudit.filter((id) => !surviving.has(id))
  check(`all ${ledger.preExistingAudit.length} pre-existing audit rows survived`, lost.length === 0,
    `lost ${lost.length}`)

  if (ledger.baseline) {
    const now = await snapshot()
    for (const t of TRACKED) {
      check(`${t} back to baseline (${ledger.baseline[t]})`, now[t] === ledger.baseline[t],
        `now ${now[t]}`)
    }
  }

  writeLedger({ users: [], audit: [], preExistingAudit: ledger.preExistingAudit, baseline: ledger.baseline })
}

/* ============================================================== dispatch === */

async function main() {
  console.log(`Phase 3.5 production verification — mode: ${MODE}`)
  if (!(await assertTarget())) return

  if (MODE === 'schema') await modeSchema()
  else if (MODE === 'failclosed') await modeFailClosed()
  else if (MODE === 'flow') await modeFlow()
  else if (MODE === 'cleanup') await runCleanup()

  console.log('\n==========================================================')
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  console.log('==========================================================')
  await pool?.end().catch(() => {})
  process.exitCode = failed ? 1 : 0
}

main().catch(async (error) => {
  console.error(`\nABORTED: ${error.message}`)
  await pool?.end().catch(() => {})
  process.exitCode = 1
})
