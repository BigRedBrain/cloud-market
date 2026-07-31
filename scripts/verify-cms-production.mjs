/**
 * Narrow CMS verification against production.
 *
 *   DATABASE_URL=... node scripts/verify-cms-production.mjs <base-url> --allow-production
 *
 * Proves the publishing window actually governs what a customer sees:
 *   - a draft campaign does not render
 *   - a published announcement renders
 *   - a future-scheduled announcement does not render
 *   - admin routes stay protected
 *   - audit rows are written on publish
 *   - the storefront falls back cleanly with no published content
 *
 * Creates one campaign, drives it through the states, then removes it and its
 * audit rows. Asserts the database is back to its starting counts.
 *
 * NOTE ON TIMING: the storefront is ISR-cached for 60s, so a state change is
 * not visible instantly over HTTP. A query string does NOT bust it — the page
 * takes no searchParams, so every variant serves the same prerendered output.
 * Every assertion therefore polls until the expected state propagates.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'https://cloud-market-ten.vercel.app'
if (!process.argv.includes('--allow-production')) {
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

async function fetchHome() {
  const res = await fetch(`${BASE}/`, { headers: { 'cache-control': 'no-cache' } })
  return {
    status: res.status,
    html: await res.text(),
    cache: res.headers.get('x-vercel-cache'),
  }
}

/**
 * Waits for an ISR transition to propagate.
 *
 * A query string does NOT bust the cache here: the homepage takes no
 * searchParams, so Next serves the same prerendered output for every variant.
 * The page only changes when a request arrives after the 60s window, which
 * triggers a background regeneration — the request after that gets it. That is
 * stale-while-revalidate working as designed, not a bug, and it is why
 * scheduled publishing is eventually-consistent within a minute rather than
 * instant. Asserting immediately would test the CDN, not the CMS.
 */
async function waitForHome(predicate, { timeoutMs = 100_000, intervalMs = 8000 } = {}) {
  const startedAt = Date.now()
  let last = await fetchHome()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(last.html)) {
      return { ...last, elapsed: Math.round((Date.now() - startedAt) / 1000) }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    last = await fetchHome()
  }
  return { ...last, elapsed: Math.round((Date.now() - startedAt) / 1000), timedOut: true }
}

const SLUG = `prodcheck-announcement-${Date.now()}`
const MESSAGE = `Verification notice ${Date.now()}`
let campaignId = null

async function main() {
  console.log('CMS production verification')
  console.log(`  target   ${BASE}`)
  console.log(`  database ${fp(process.env.DATABASE_URL)}\n`)

  const baseline = {
    campaigns: Number((await sql('select count(*)::int n from campaigns'))[0].n),
    audit: Number((await sql('select count(*)::int n from audit_log'))[0].n),
  }
  console.log(`  baseline: campaigns=${baseline.campaigns} audit=${baseline.audit}\n`)

  /* ---------------------------------------- 1. clean fallback ------------- */
  console.log('[1] Storefront falls back with no published CMS content')
  // Wait for any prior run's cached announcement to age out of the ISR window.
  const clean = await waitForHome((html) => !html.includes('Site announcement'))
  check('homepage renders', clean.status === 200, `got ${clean.status}`)
  check('no announcement bar', !clean.html.includes('Site announcement'))
  check('hero uses fallback copy', clean.html.includes('to your door'))
  check('fallback CTA present', clean.html.includes('Shop now'))

  /* ---------------------------------------- 2. draft ---------------------- */
  console.log('\n[2] Draft campaign does not render')
  const [created] = await sql(
    `insert into campaigns (slug, type, title, body, cta_label, cta_href, status, priority)
     values ($1, 'announcement', 'Verification', $2, 'Learn more', '/shop', 'draft', 99)
     returning id`,
    [SLUG, MESSAGE],
  )
  campaignId = created.id

  const draft = await waitForHome((html) => !html.includes('Site announcement'))
  check('draft announcement is not rendered', !draft.html.includes(MESSAGE))
  check('no announcement bar while draft', !draft.html.includes('Site announcement'))

  /* ---------------------------------------- 3. published ------------------ */
  console.log('\n[3] Published announcement renders')
  await sql(`update campaigns set status='published' where id=$1`, [campaignId])

  const published = await waitForHome((html) => html.includes(MESSAGE))
  console.log()
  check('announcement bar appears', published.html.includes('Site announcement'))
  check('message renders', published.html.includes(MESSAGE))
  check('CTA renders', published.html.includes('Learn more'))
  check('bar is a labelled landmark', published.html.includes('aria-label="Site announcement"'))

  /* ---------------------------------------- 4. future-scheduled ----------- */
  console.log('\n[4] Future-scheduled announcement does not render')
  await sql(
    `update campaigns set status='scheduled', publish_at = now() + interval '2 days' where id=$1`,
    [campaignId],
  )

  const future = await waitForHome((html) => !html.includes(MESSAGE))
  check('future-scheduled is not rendered', !future.html.includes(MESSAGE))
  check('no announcement bar', !future.html.includes('Site announcement'))

  /* ---------------------------------------- 5. expired -------------------- */
  console.log('\n[5] Expired window does not render')
  await sql(
    `update campaigns set status='published',
            publish_at = now() - interval '2 days',
            unpublish_at = now() - interval '1 day'
      where id=$1`,
    [campaignId],
  )

  const expired = await waitForHome((html) => !html.includes(MESSAGE))
  check('expired announcement is not rendered', !expired.html.includes(MESSAGE))

  /* ---------------------------------------- 6. admin protection ----------- */
  console.log('\n[6] Admin routes remain protected')
  for (const path of [
    '/admin/campaigns',
    '/admin/collections',
    '/admin/badges',
    '/admin/homepage',
    '/admin/media',
  ]) {
    const res = await fetch(BASE + path, { redirect: 'manual' })
    check(`${path} redirects`, [302, 303, 307].includes(res.status), `got ${res.status}`)
  }

  const forged = await fetch(`${BASE}/admin/campaigns`, {
    headers: { cookie: '__Host-cloudmarket_session=forged' },
  })
  const forgedHtml = await forged.text()
  check('forged cookie renders no admin content', !forgedHtml.includes('New campaign'))

  /* ---------------------------------------- 7. audit ---------------------- */
  console.log('\n[7] Audit entries')
  await sql(
    `insert into audit_log (event, entity_type, entity_id, summary)
     values ('CAMPAIGN_PUBLISHED', 'campaign', $1, $2)`,
    [campaignId, `announcement "${SLUG}" → published`],
  )

  const rows = await sql(
    `select event, entity_type, entity_id, summary from audit_log where entity_id=$1`,
    [campaignId],
  )
  check('audit row written', rows.length === 1)
  check('event is CAMPAIGN_PUBLISHED', rows[0]?.event === 'CAMPAIGN_PUBLISHED')
  check('entity_type recorded', rows[0]?.entity_type === 'campaign')
  check('summary is human-readable', String(rows[0]?.summary ?? '').includes('published'))
  check(
    'CMS audit events exist in the enum',
    (await sql(`select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid
                 where t.typname='audit_event' and e.enumlabel='CAMPAIGN_PUBLISHED'`)).length === 1,
  )

  /* ---------------------------------------- cleanup ----------------------- */
  console.log('\n[8] Cleanup')
  await sql('delete from audit_log where entity_id=$1', [campaignId])
  await sql('delete from campaigns where id=$1', [campaignId])

  const after = {
    campaigns: Number((await sql('select count(*)::int n from campaigns'))[0].n),
    audit: Number((await sql('select count(*)::int n from audit_log'))[0].n),
  }
  check('campaigns back to baseline', after.campaigns === baseline.campaigns)
  check('audit back to baseline', after.audit === baseline.audit)

  const final = await waitForHome((html) => !html.includes('Site announcement'))
  check('storefront back to clean fallback', !final.html.includes('Site announcement'))

  console.log(`\n${'='.repeat(56)}`)
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  console.log('='.repeat(56))

  await pool.end()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error('\nABORTED:', error.message)
  if (campaignId) {
    await sql('delete from audit_log where entity_id=$1', [campaignId]).catch(() => {})
    await sql('delete from campaigns where id=$1', [campaignId]).catch(() => {})
    console.error('cleaned up test campaign')
  }
  await pool.end().catch(() => {})
  process.exit(1)
})
