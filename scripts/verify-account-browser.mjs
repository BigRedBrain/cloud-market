/**
 * Browser verification for the authenticated account pages.
 *
 *   node scripts/verify-account-browser.mjs [base-url]
 *
 * This exists because the account bug was invisible to every HTTP assertion we
 * had. The server was returning a well-formed streaming response the whole
 * time; what failed was the browser assembling it. A suite that only reads
 * response bodies cannot see that, and ours confidently reported green while
 * the page was blank on screen.
 *
 * So this drives a real Chromium: it reads the DOM after hydration, listens for
 * console errors and page exceptions, and — the assertion that matters most —
 * loads both routes again with JavaScript disabled to prove the content does
 * not depend on the client at all.
 *
 * DEVELOPMENT ONLY. It signs up, which writes rows; it refuses the production
 * fingerprint and removes everything it created by id.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { chromium } from 'playwright'
import { Pool, neonConfig } from '@neondatabase/serverless'

/**
 * Captured BEFORE dotenv runs, so we can tell an explicit variable from a
 * fallback. `.env.local` holds development credentials; loading it is a
 * convenience for local runs and a trap for production ones, which is why the
 * production harnesses refuse to read it at all. Here the file is still loaded
 * for the local case, but `--allow-production` requires the variable to have
 * been set deliberately.
 */
const EXPLICIT_DATABASE_URL = process.env.DATABASE_URL

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'http://127.0.0.1:3412'
const PRODUCTION_FP = '2b968b3cbe06'
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

const fp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

requireConnectionString(process.env.DATABASE_URL)
/**
 * Production requires an explicit opt-in, because this suite SIGNS UP — it
 * writes a real user, session and audit rows. Everything it creates is removed
 * by exact id in the finally block, and the run reports whether that succeeded.
 */
const ALLOW_PRODUCTION = process.argv.includes('--allow-production')

/**
 * A production run must name its own database. Falling back to `.env.local`
 * here would mean pointing the suite at the live storefront while silently
 * connecting to development — which is exactly the shape of the mistake this
 * guard exists to prevent.
 */
if (ALLOW_PRODUCTION && !EXPLICIT_DATABASE_URL) {
  console.error('DATABASE_URL is not set.\n' +
    '  --allow-production will not fall back to .env.local.\n' +
    '  PowerShell:  $env:DATABASE_URL = "postgresql://…"')
  process.exit(1)
}

if (fp(process.env.DATABASE_URL) === PRODUCTION_FP && !ALLOW_PRODUCTION) {
  console.error('REFUSING: this is production. Pass --allow-production if that is intended.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)

let passed = 0
let failed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`    ok    ${name}`) }
  else { failed += 1; failures.push(name); console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const stamp = Date.now()
const email = `browser.${stamp}@example.invalid`
const PASSWORD = 'a-really-solid-original-password'

/** Console errors and uncaught exceptions, collected per page. */
function watch(page, sink) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') sink.push(`console.error: ${msg.text().slice(0, 160)}`)
  })
  page.on('pageerror', (err) => sink.push(`pageerror: ${String(err).slice(0, 160)}`))
}

/** Text a human would actually see inside <main>. */
/**
 * DOMContentLoaded is enough now — the content is server-rendered, so it is in
 * the document before any script runs. Waiting for networkidle was both slower
 * and flaky, and it would have masked exactly the regression this suite exists
 * to catch: if the text only appears after the network settles, it came from
 * the client.
 */
const mainText = (page) =>
  page.evaluate(() => {
    const main = document.querySelector('main')
    return main ? (main.innerText ?? '').replace(/\s+/g, ' ').trim() : '(no <main>)'
  })

/**
 * Refuses unless this script's database is the one the deployed app uses.
 *
 * RUNS BEFORE THE BROWSER LAUNCHES, and that ordering is the entire point.
 * `postgresql://ACTUAL_PRODUCTION_POOLED_STRING` is a syntactically valid URL,
 * so the shape check passes it; its hostname simply hashes to something that is
 * not production. The old flow read that as "not production", carried on, drove
 * a real sign-up against the live storefront, and only failed at the first
 * query — by which point a production account, session and audit rows existed
 * with no working connection to clean them up.
 *
 * A fingerprint that merely differs from a known constant is not evidence of
 * anything. The only useful question is whether this connection is the same
 * database the application at BASE is talking to, so that is what is asked.
 *
 * Prints two fingerprints and a verdict. Never a host, a user, or a password.
 */
async function assertTargetMatchesDeployedApp() {
  let health
  try {
    health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  } catch (error) {
    console.error(`refused: could not reach ${BASE}/api/health — ${error.message}`)
    return false
  }

  const deployed = health.database?.fingerprint ?? null
  const supplied = fp(process.env.DATABASE_URL)

  console.log(`deployed app fingerprint:      ${deployed ?? '(none reported)'}`)
  console.log(`supplied database fingerprint: ${supplied}`)

  if (!deployed || deployed !== supplied) {
    console.error('refused: DATABASE_URL is not the database behind ' + BASE)
    return false
  }

  console.log('target confirmed\n')
  return true
}

async function main() {
  console.log(`Account browser verification against ${BASE}`)

  /**
   * Nothing below this line may run on a mismatch — no browser, no sign-up, no
   * user, session, token or audit row.
   */
  if (!(await assertTargetMatchesDeployedApp())) {
    process.exitCode = 1
    await pool.end().catch(() => {})
    return
  }

  const browser = await chromium.launch()
  let userId = null

  try {
    /* ============================================== 1. WITH JAVASCRIPT */
    section('[1] Real browser, JavaScript enabled')

    const errors = []
    const context = await browser.newContext()
    const page = await context.newPage()
    watch(page, errors)

    await page.goto(`${BASE}/sign-up`, { waitUntil: 'domcontentloaded' })
    await page.fill('input[name="name"]', 'Browser Tester')
    await page.fill('input[name="email"]', email)
    await page.fill('input[name="password"]', PASSWORD)
    await page.fill('input[name="dateOfBirth"]', '1990-01-01')
    await Promise.all([
      page.waitForURL(/\/account/, { timeout: 20000 }),
      page.click('button[type="submit"]'),
    ])
    check('sign-up lands on /account', page.url().includes('/account'))

    const [user] = await sql('select id from users where email=$1', [email])
    userId = user?.id ?? null
    check('the account exists', Boolean(userId))

    /* ---- /account ---- */
    await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' })
    const accountText = await mainText(page)
    check('/account <main> has visible text', accountText.length > 40,
      `${accountText.length} chars`)
    /** innerText reflects CSS text-transform, and the heading is uppercased. */
    check('/account shows the profile heading', /profile/i.test(accountText))
    check('/account shows the account details card', /account details/i.test(accountText))
    check('/account shows no loading skeleton', !/loading your account/i.test(accountText))
    /**
     * The forms are client components that React streams in, so they appear a
     * beat after the server-rendered content. Waiting for them is correct; the
     * point of the restructure was that the CONTENT no longer waits.
     */
    await page.waitForSelector('input[name="name"]', { state: 'visible', timeout: 15000 })
    check('the profile form becomes interactive', true)

    /* ---- /account/security ---- */
    await page.goto(`${BASE}/account/security`, { waitUntil: 'domcontentloaded' })
    const securityText = await mainText(page)
    check('/account/security <main> has visible text', securityText.length > 40,
      `${securityText.length} chars`)
    check('/account/security shows its heading', /Security/i.test(securityText))
    await page.waitForSelector('input[name="currentPassword"]', { state: 'visible', timeout: 15000 })
    check('/account/security password form becomes interactive', true)

    /* ---- refresh both ---- */
    for (const path of ['/account', '/account/security']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
      await page.reload({ waitUntil: 'domcontentloaded' })
      const text = await mainText(page)
      check(`${path} still renders after a refresh`, text.length > 40, `${text.length} chars`)
    }

    /* ---- client-side navigation between the tabs ---- */
    await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' })
    await page.click('a[href="/account/security"]')
    await page.waitForURL(/\/account\/security/, { timeout: 20000 })
    const navText = await mainText(page)
    check('tab navigation renders the security page', /Security/i.test(navText),
      navText.slice(0, 80))
    await page.click('a[href="/account"]')
    await page.waitForURL(/\/account$/, { timeout: 20000 })
    const backText = await mainText(page)
    check('tab navigation back renders the profile page',
      /account details/i.test(backText), backText.slice(0, 80))

    check('no console errors or page exceptions', errors.length === 0,
      errors.slice(0, 2).join(' | '))

    await context.close()

    /* ============================================== 2. WITHOUT JAVASCRIPT */
    section('[2] JavaScript disabled — the content must not need the client')

    /**
     * The decisive test. With JS off, React cannot run the inline `$RC(…)`
     * relocation, so anything that depends on it is simply absent. If these
     * pass, the primary content is genuinely server-rendered.
     */
    const noJsErrors = []
    const noJs = await browser.newContext({ javaScriptEnabled: false })
    const noJsPage = await noJs.newPage()
    watch(noJsPage, noJsErrors)

    // Sign in the no-JS way: a plain form post.
    await noJsPage.goto(`${BASE}/sign-in`)
    await noJsPage.fill('input[name="email"]', email)
    await noJsPage.fill('input[name="password"]', PASSWORD)
    await noJsPage.click('button[type="submit"]')
    await noJsPage.waitForLoadState('load')
    check('sign-in works without JavaScript', noJsPage.url().includes('/account'),
      noJsPage.url())

    await noJsPage.goto(`${BASE}/account`)
    const noJsAccount = await mainText(noJsPage)
    check('/account renders without JavaScript', noJsAccount.length > 40,
      `${noJsAccount.length} chars`)
    check('/account shows real content, not a skeleton',
      /account details/i.test(noJsAccount) && !/loading your account/i.test(noJsAccount),
      noJsAccount.slice(0, 90))

    await noJsPage.goto(`${BASE}/account/security`)
    const noJsSecurity = await mainText(noJsPage)
    check('/account/security renders without JavaScript', noJsSecurity.length > 40,
      `${noJsSecurity.length} chars`)
    check('/account/security shows real content',
      /Security/i.test(noJsSecurity) && !noJsSecurity.includes('Loading your account'),
      noJsSecurity.slice(0, 90))

    /**
     * KNOWN LIMITATION, asserted rather than glossed over. The forms are client
     * components React streams into a hidden div and reveals with an inline
     * script, so without JavaScript they are present in the DOM but not visible.
     * The pages are still useful — details, verification state and sessions all
     * read fine — but profile edits and password changes need JavaScript.
     */
    const noJsFormInDom = await noJsPage.locator('input[name="currentPassword"]').count()
    const noJsFormVisible = noJsFormInDom
      ? await noJsPage.locator('input[name="currentPassword"]').first().isVisible()
      : false
    check('without JS the forms are present in the DOM', noJsFormInDom > 0)
    check('without JS the forms are NOT yet visible (documented limitation)',
      !noJsFormVisible)

    await noJs.close()

    /* ============================================== 3. ROUTE PROTECTION */
    section('[3] Route protection in the browser')

    const anon = await browser.newContext()
    const anonPage = await anon.newPage()
    await anonPage.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' })
    check('an anonymous visitor is bounced from /account',
      anonPage.url().includes('/sign-in'), anonPage.url())
    await anonPage.goto(`${BASE}/account/security`, { waitUntil: 'domcontentloaded' })
    check('an anonymous visitor is bounced from /account/security',
      anonPage.url().includes('/sign-in'), anonPage.url())
    await anon.close()
  } finally {
    await browser.close()

    /* ---- cleanup by exact id ---- */
    if (userId) {
      for (const table of ['verification_tokens', 'sessions', 'audit_log']) {
        await sql(`delete from ${table} where user_id=$1`, [userId])
      }
      await sql('delete from users where id=$1', [userId])
    }
    const leftover = await sql('select count(*)::int n from users where email=$1', [email])
    check('the temporary account was removed by id', leftover[0].n === 0)
    if (userId) {
      const residue = await sql(
        `select (select count(*)::int from sessions where user_id = $1) s,
                (select count(*)::int from audit_log where user_id = $1) a,
                (select count(*)::int from verification_tokens where user_id = $1) t`,
        [userId])
      check('no sessions, audit rows or tokens remain for it',
        residue[0].s === 0 && residue[0].a === 0 && residue[0].t === 0,
        JSON.stringify(residue[0]))
    }
  }

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
