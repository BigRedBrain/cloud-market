/**
 * Route-level authorization for the purchase limit screen.
 *
 *   npm run build && npx next start -p 3520
 *   node scripts/verify-limit-admin-http.mjs http://127.0.0.1:3520
 *
 * The governance suite proves what the DATABASE will refuse. This proves what
 * the HTTP surface will refuse, which is a different question and not implied by
 * the first: a correct trigger behind a page that renders for anyone is still a
 * hole. It drives real requests with real cookie jars and submits the hidden
 * $ACTION fields exactly as a browser without JavaScript would, so a pass also
 * shows the form degrades.
 *
 * THE ASSERTION THAT MATTERS MOST is that the Server Action refuses an
 * unauthorised caller. The page being unreachable proves nothing — a Server
 * Action is a public POST endpoint, reachable by anyone who can read the action
 * id out of any page that embeds it.
 *
 * REFUSES TO RUN against production. Removes every row it creates, by id.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'http://127.0.0.1:3520'
const PROD_FP = '2b968b3cbe06'
const fp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}
if (fp(process.env.DATABASE_URL) === PROD_FP) {
  console.error('REFUSING TO RUN against production.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
pool.on('error', () => {})
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)

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

/* ----------------------------------------------------------- http plumbing */
const device = (label) => ({ label, cookies: new Map() })
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

async function visit(d, path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: [...d.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      'user-agent': `LimitAdminHTTP/${d.label}`,
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

const stamp = Date.now()
const PASSWORD = 'Governance!Http7'
const created = { users: [], rules: [] }

async function makeUser(label, role) {
  const email = `limithttp.${label}.${stamp}@example.invalid`
  const device0 = device(label)
  await submit(device0, '/sign-up', {
    email,
    password: PASSWORD,
    name: `Limit ${label}`,
    dateOfBirth: '1990-01-01',
  })
  const [user] = await sql('select id from users where email=$1', [email])
  if (!user) throw new Error(`sign-up failed for ${email}`)
  created.users.push(user.id)
  await sql(`update users set role=$2, email_verified_at=now(), status='active' where id=$1`, [
    user.id,
    role,
  ])
  return { id: user.id, email, device: device0 }
}

/**
 * No separate sign-in step.
 *
 * `signUpAction` establishes a session on the device that created the account,
 * so the jar returned by `makeUser` is already authenticated — and posting to
 * /sign-in while a session exists redirects instead of rendering a form, which
 * is what makes the naive version of this helper fail. The role and
 * verification changes made afterwards take effect immediately because the DAL
 * resolves the user from the database on every request rather than trusting
 * anything stamped into the cookie.
 */
const ruleCount = async () =>
  Number((await sql('select count(*)::int n from purchase_limit_rules'))[0].n)

async function main() {
  console.log(`Purchase limit admin — HTTP authorization, against ${BASE}`)
  console.log(`database ${fp(process.env.DATABASE_URL)} (not production)`)

  const before = await ruleCount()

  /* --------------------------------------------------------- fixtures --- */
  const customer = await makeUser('customer', 'customer')
  const admin = await makeUser('admin', 'admin')
  const officer = await makeUser('officer', 'admin')

  /* ================================================ 1. PAGE ACCESS ===== */
  section('[1] Who can open the page')
  {
    const anon = device('anon')
    const anonView = await visit(anon, '/admin/purchase-limits')
    check(
      'signed out is refused',
      anonView.status === 307 || anonView.status === 403 ||
        !anonView.html.includes('Publish a change'),
      `status ${anonView.status}`,
    )

    const custView = await visit(customer.device, '/admin/purchase-limits')
    check(
      'a customer is refused',
      !custView.html.includes('Publish a change'),
      `status ${custView.status}`,
    )

    /**
     * The one that would be easy to get wrong. `admin` is the most privileged
     * ROLE in the application, and it is still not enough — the permission is a
     * separate grant on purpose.
     */
    const adminView = await visit(admin.device, '/admin/purchase-limits')
    check(
      'an ADMIN without the grant is refused',
      !adminView.html.includes('Publish a change'),
      `status ${adminView.status}`,
    )

    const adminNav = await visit(admin.device, '/admin')
    check(
      'the nav tab is hidden from an admin without the grant',
      !adminNav.html.includes('/admin/purchase-limits'),
    )

    await sql(
      `insert into user_permissions (user_id, permission, reason)
       values ($1, 'compliance_admin', 'http verification')`,
      [officer.id],
    )
    const officerView = await visit(officer.device, '/admin/purchase-limits')
    check(
      'the grant holder can open the page',
      officerView.status === 200 && officerView.html.includes('Publish a change'),
      `status ${officerView.status}`,
    )
    check('the page shows the rules in force', officerView.html.includes('In force now'))
    check('the page shows the full history', officerView.html.includes('Full history'))

    const officerNav = await visit(officer.device, '/admin')
    check(
      'the nav tab is shown to the grant holder',
      officerNav.html.includes('/admin/purchase-limits'),
    )
  }

  /* ============================================= 2. THE ACTION ITSELF === */
  section('[2] The Server Action refuses what the page refuses')
  {
    const countBefore = await ruleCount()

    /**
     * The admin has no grant, but they can read the action id from any page
     * that embeds it — so the action is posted with the grant holder's form
     * fields and the ungranted admin's cookies. This is the attack the page
     * check does not cover.
     */
    const stolen = await visit(officer.device, '/admin/purchase-limits')
    const forms = [...stolen.html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0])
    const publishForm = forms.find((f) => f.includes('confirmClass'))
    check('the publish form was found to copy', Boolean(publishForm))

    if (publishForm) {
      const fields = actionFields(publishForm)
      const body = new FormData()
      for (const [k, v] of Object.entries(fields)) body.append(k, v)
      body.append('cannabisClass', 'edible')
      body.append('equivalentGramsPerGram', '1')
      body.append('dailyEquivalentGramsCap', '999')
      body.append('dailyConcentrateGramsCap', '999')
      body.append('timing', 'now')
      body.append('changeReason', 'Unauthorised attempt from the HTTP verification suite.')
      body.append('confirmClass', 'edible')
      body.append('acknowledgeImmutable', 'on')
      body.append('password', PASSWORD)

      const attempt = await visit(admin.device, '/admin/purchase-limits', {
        method: 'POST',
        body,
      })
      check(
        'an ungranted admin posting the action directly is refused',
        attempt.status === 403 || attempt.status === 307 ||
          !attempt.html.includes('Published'),
        `status ${attempt.status}`,
      )
      check(
        'no rule was created by the unauthorised post',
        (await ruleCount()) === countBefore,
      )
    }
  }

  /* =========================================== 3. STEP-UP AND INPUT ===== */
  section('[3] Re-authentication and validation, over HTTP')
  {
    const countBefore = await ruleCount()

    const wrongPassword = await submit(
      officer.device,
      '/admin/purchase-limits',
      {
        cannabisClass: 'edible',
        equivalentGramsPerGram: '1',
        dailyEquivalentGramsCap: '65',
        dailyConcentrateGramsCap: '14',
        timing: 'now',
        changeReason: 'HTTP suite: a publish attempt with the wrong password.',
        confirmClass: 'edible',
        acknowledgeImmutable: 'on',
        password: 'definitely-not-the-password',
      },
      'confirmClass',
    )
    check(
      'a wrong password does not publish',
      (await ruleCount()) === countBefore,
      `${countBefore} -> ${await ruleCount()}`,
    )
    check(
      'the wrong password is reported to the user',
      wrongPassword.html.includes('not correct'),
    )

    const wrongConfirm = await submit(
      officer.device,
      '/admin/purchase-limits',
      {
        cannabisClass: 'edible',
        equivalentGramsPerGram: '1',
        dailyEquivalentGramsCap: '64',
        dailyConcentrateGramsCap: '14',
        timing: 'now',
        changeReason: 'HTTP suite: a publish attempt with a mistyped confirmation.',
        confirmClass: 'flower',
        acknowledgeImmutable: 'on',
        password: PASSWORD,
      },
      'confirmClass',
    )
    check('a mistyped confirmation does not publish', (await ruleCount()) === countBefore)
    check(
      'the mistyped confirmation is explained',
      wrongConfirm.html.includes('Type the class name'),
    )

    const noAcknowledge = await submit(
      officer.device,
      '/admin/purchase-limits',
      {
        cannabisClass: 'edible',
        equivalentGramsPerGram: '1',
        dailyEquivalentGramsCap: '63',
        dailyConcentrateGramsCap: '14',
        timing: 'now',
        changeReason: 'HTTP suite: a publish attempt without the acknowledgement.',
        confirmClass: 'edible',
        password: PASSWORD,
      },
      'confirmClass',
    )
    check('an unacknowledged publish is refused', (await ruleCount()) === countBefore)
    check(
      'the acknowledgement requirement is explained',
      noAcknowledge.html.includes('cannot be edited or deleted'),
    )

    const shortReason = await submit(
      officer.device,
      '/admin/purchase-limits',
      {
        cannabisClass: 'edible',
        equivalentGramsPerGram: '1',
        dailyEquivalentGramsCap: '62',
        dailyConcentrateGramsCap: '14',
        timing: 'now',
        changeReason: 'because',
        confirmClass: 'edible',
        acknowledgeImmutable: 'on',
        password: PASSWORD,
      },
      'confirmClass',
    )
    check('a token reason is refused', (await ruleCount()) === countBefore)
    check('the reason requirement is explained', shortReason.html.includes('20 characters'))

    const concentrateTooHigh = await submit(
      officer.device,
      '/admin/purchase-limits',
      {
        cannabisClass: 'edible',
        equivalentGramsPerGram: '1',
        dailyEquivalentGramsCap: '10',
        dailyConcentrateGramsCap: '50',
        timing: 'now',
        changeReason: 'HTTP suite: concentrate cap exceeding the overall cap.',
        confirmClass: 'edible',
        acknowledgeImmutable: 'on',
        password: PASSWORD,
      },
      'confirmClass',
    )
    check('an incoherent pair of caps is refused', (await ruleCount()) === countBefore)
    check(
      'the cap relationship is explained',
      concentrateTooHigh.html.includes('cannot exceed'),
    )
  }

  /* ============================================ 4. THE HAPPY PATH ======= */
  section('[4] A real publish, end to end')
  {
    check('nothing was published by any refused attempt', (await ruleCount()) === before,
      `${before} -> ${await ruleCount()}`)

    const [baseline] = await sql(
      `select id, version, effective_until, superseded_by_rule_id
         from purchase_limit_rules
        where cannabis_class='edible' and effective_until is null`,
    )
    check('there is a rule to supersede', Boolean(baseline))

    const result = await submit(
      officer.device,
      '/admin/purchase-limits',
      {
        cannabisClass: 'edible',
        equivalentGramsPerGram: '1.2',
        dailyEquivalentGramsCap: '61',
        dailyConcentrateGramsCap: '13',
        timing: 'now',
        changeReason: 'HTTP suite: a genuine publish, exercising the whole path.',
        confirmClass: 'edible',
        acknowledgeImmutable: 'on',
        password: PASSWORD,
      },
      'confirmClass',
    )

    const [published] = await sql(
      `select * from purchase_limit_rules
        where cannabis_class='edible' and effective_until is null`,
    )
    created.rules.push(published?.id)

    check('a new version is in force', published?.id !== baseline?.id, `status ${result.status}`)
    check('the version incremented', published?.version === baseline?.version + 1,
      `${baseline?.version} -> ${published?.version}`)
    check('the new cap was stored', Number(published?.daily_equivalent_grams_cap) === 61)
    check('the publisher was recorded', published?.published_by === officer.id)
    check('the reason was recorded',
      (published?.change_reason ?? '').includes('a genuine publish'))
    check('the re-authentication instant was recorded',
      published?.reauthenticated_at !== null)
    check('it points back at what it replaced', published?.supersedes_rule_id === baseline?.id)

    const [superseded] = await sql('select * from purchase_limit_rules where id=$1', [
      baseline?.id,
    ])
    check('the previous version was closed, not changed',
      superseded?.effective_until !== null &&
        Number(superseded?.daily_equivalent_grams_cap) ===
          Number(baseline?.daily_equivalent_grams_cap ?? superseded?.daily_equivalent_grams_cap))
    check('the previous version points at its successor',
      superseded?.superseded_by_rule_id === published?.id)

    const events = await sql(
      `select event from audit_log where user_id=$1 order by occurred_at`,
      [officer.id],
    )
    const names = events.map((e) => e.event)
    check('the publish was audited', names.includes('PURCHASE_LIMIT_RULE_PUBLISHED'))
    check('the supersession was audited', names.includes('PURCHASE_LIMIT_RULE_SUPERSEDED'))
    check('the successful step-up was audited', names.includes('COMPLIANCE_REAUTH_SUCCEEDED'))
    check('the failed step-up was audited', names.includes('COMPLIANCE_REAUTH_FAILED'))
    check('the refused attempts were audited',
      names.includes('PURCHASE_LIMIT_RULE_REJECTED'))

    const page = await visit(officer.device, '/admin/purchase-limits')
    check('the page shows the new version in force', page.html.includes('61'))
    check('the page shows the superseded version in the history',
      page.html.includes('Superseded'))

    /**
     * Teardown for the rules, which cannot be deleted while the guards are on.
     * Same shape as the governance suite: guards off, delete by captured id,
     * restore the baseline verbatim, guards back on, then assert all of it.
     */
    await sql('alter table purchase_limit_rules disable trigger purchase_limit_rules_no_delete')
    await sql('alter table purchase_limit_rules disable trigger purchase_limit_rules_immutable')
    try {
      await sql(
        `update purchase_limit_rules set superseded_by_rule_id=null, supersedes_rule_id=null
          where id = any($1::uuid[])`,
        [created.rules],
      )
      await sql(`update purchase_limit_rules set superseded_by_rule_id=null where id=$1`, [
        baseline?.id,
      ])
      await sql(`delete from purchase_limit_rules where id = any($1::uuid[])`, [created.rules])
      await sql(
        `update purchase_limit_rules set effective_until=$2, superseded_by_rule_id=$3 where id=$1`,
        [baseline?.id, baseline?.effective_until, baseline?.superseded_by_rule_id],
      )
    } finally {
      await sql('alter table purchase_limit_rules enable trigger purchase_limit_rules_immutable')
      await sql('alter table purchase_limit_rules enable trigger purchase_limit_rules_no_delete')
    }

    const [restored] = await sql('select * from purchase_limit_rules where id=$1', [
      baseline?.id,
    ])
    check('the pre-existing rule is open again', restored?.effective_until === null)
    check('the pre-existing rule has no dangling successor',
      restored?.superseded_by_rule_id === null)

    const triggers = await sql(
      `select tgenabled from pg_trigger
        where tgrelid='purchase_limit_rules'::regclass and not tgisinternal`,
    )
    check('both guard triggers are enabled again',
      triggers.length === 2 && triggers.every((t) => t.tgenabled === 'O'),
      triggers.map((t) => t.tgenabled).join(','))
  }

  /* =================================================== 5. CLEANUP ======= */
  section('[5] Nothing was left behind')
  {

    const auditRows = await sql(
      `select id from audit_log where user_id = any($1::uuid[])`,
      [created.users],
    )
    if (auditRows.length) {
      await sql(`delete from audit_log where id = any($1::uuid[])`, [
        auditRows.map((r) => r.id),
      ])
    }
    await sql(`delete from user_permissions where user_id = any($1::uuid[])`, [created.users])
    await sql(`delete from sessions where user_id = any($1::uuid[])`, [created.users])
    await sql(`delete from verification_tokens where user_id = any($1::uuid[])`, [created.users])
    await sql(`delete from carts where user_id = any($1::uuid[])`, [created.users])
    await sql(`delete from users where id = any($1::uuid[])`, [created.users])

    const leftover = await sql('select id from users where id = any($1::uuid[])', [
      created.users,
    ])
    check('every fixture user was removed by id', leftover.length === 0)
    check('the rule table is exactly as it was found', (await ruleCount()) === before)
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
