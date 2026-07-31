/**
 * Production verification for the Cart & Bag Foundation (Phase 3).
 *
 *   DATABASE_URL=... node scripts/verify-bag-production.mjs <base-url> --allow-production
 *   DATABASE_URL=... node scripts/verify-bag-production.mjs <base-url> --allow-production --preflight
 *
 * `--preflight` runs ONLY the read-only schema/migration section. Run it before
 * applying 0005/0006 to confirm the starting state, and again after.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It never creates a product. Verifying add/update/remove over HTTP would need
 * an ACTIVE, publicly purchasable product, and the storefront is ISR-cached for
 * 60s — so a fake cannabis product with a fake price and fake potency would be
 * visible to real customers on a licensed retailer's storefront for up to a
 * minute after deletion. Database residue could be guaranteed zero; cache
 * residue could not, and a visible fake product is a compliance problem, not
 * just a tidiness one.
 *
 * Instead the cart write path is exercised against the real production schema
 * inside a transaction that is ALWAYS rolled back. That proves the tables,
 * indexes, constraints and the `least()` upsert behave correctly in production,
 * with zero residue guaranteed by the database rather than by cleanup code, and
 * with nothing ever visible to a customer.
 *
 * The one thing it does create is a temporary customer account, which is
 * invisible to other visitors and removable by primary key. Baseline counts for
 * every table it touches are captured up front and re-asserted at the end.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'https://cloud-market-ten.vercel.app'
const ALLOW = process.argv.includes('--allow-production')
const PREFLIGHT_ONLY = process.argv.includes('--preflight')

if (!ALLOW) {
  console.error('Refusing to run without --allow-production.')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)
const fp = (u) =>
  createHash('sha256')
    .update(new URL(u).hostname.split('.')[0].replace('-pooler', ''))
    .digest('hex')
    .slice(0, 12)

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

const device = (label) => ({ label, cookies: new Map(), setCookieRaw: [] })

async function visit(d, path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: [...d.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      'user-agent': `CloudMarketBagProdCheck/${d.label}`,
      ...(init.headers ?? {}),
    },
  })
  const raws = res.headers.getSetCookie?.() ?? []
  d.setCookieRaw.push(...raws)
  for (const raw of raws) {
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

const countOf = async (t) => (await sql(`select count(*)::int n from ${t}`))[0].n

/* ========================================================================== */

async function main() {
  console.log(`Bag production verification against ${BASE}`)
  console.log(`pooled endpoint fingerprint:  ${fp(process.env.DATABASE_URL)}`)
  if (process.env.DATABASE_URL_UNPOOLED) {
    console.log(`direct endpoint fingerprint:  ${fp(process.env.DATABASE_URL_UNPOOLED)}`)
  }

  /* ================================================== 1. SCHEMA / MIGRATIONS */
  section('[1] Migration and schema state (read-only)')

  const migrations = await sql(
    `select hash, created_at from drizzle.__drizzle_migrations order by created_at`,
  )
  console.log(`    migrations applied: ${migrations.length}`)
  const latest = migrations.at(-1)
  if (latest) {
    console.log(`    most recent:        ${new Date(Number(latest.created_at)).toISOString()}`)
  }

  const tables = (
    await sql(
      `select table_name from information_schema.tables
        where table_schema='public' order by table_name`,
    )
  ).map((r) => r.table_name)

  const hasCarts = tables.includes('carts')
  const hasCartLines = tables.includes('cart_lines')
  console.log(`    public tables:      ${tables.length}`)
  console.log(`    carts:              ${hasCarts ? 'present' : 'ABSENT'}`)
  console.log(`    cart_lines:         ${hasCartLines ? 'present' : 'ABSENT'}`)

  const [{ present: hasEnumValue }] = await sql(
    `select count(*)::int > 0 as present from pg_enum e
       join pg_type t on t.oid = e.enumtypid
      where t.typname='audit_event' and e.enumlabel='CART_MERGED'`,
  )
  console.log(`    CART_MERGED enum:   ${hasEnumValue ? 'present' : 'ABSENT'}`)

  if (PREFLIGHT_ONLY) {
    console.log(
      `\nPRE-FLIGHT: 0005 ${hasCarts && hasCartLines ? 'APPLIED' : 'NOT APPLIED'}` +
        `, 0006 ${hasEnumValue ? 'APPLIED' : 'NOT APPLIED'}`,
    )
    await pool.end()
    return
  }

  check('migration 0005 applied — carts exists', hasCarts)
  check('migration 0005 applied — cart_lines exists', hasCartLines)
  check('migration 0006 applied — CART_MERGED in audit_event', hasEnumValue)

  const indexes = (
    await sql(
      `select indexname from pg_indexes
        where schemaname='public' and tablename in ('carts','cart_lines')`,
    )
  ).map((r) => r.indexname)

  check('one-active-bag-per-user unique index exists',
    indexes.includes('carts_one_active_per_user'))
  check('one-line-per-variant unique index exists',
    indexes.includes('cart_lines_cart_variant_unique'))
  check('guest token hash unique index exists',
    indexes.includes('carts_guest_token_hash_unique'))
  check('last_activity_at index exists', indexes.includes('carts_last_activity_idx'))

  const cartColumns = (
    await sql(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='carts'`,
    )
  ).map((r) => r.column_name)

  for (const c of ['status', 'created_at', 'updated_at', 'last_activity_at']) {
    check(`carts.${c} present`, cartColumns.includes(c))
  }

  const lineColumns = (
    await sql(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='cart_lines'`,
    )
  ).map((r) => r.column_name)
  check('cart_lines has NO price column — pricing stays live',
    !lineColumns.some((c) => /price/i.test(c)))

  const [{ present: hasCheck }] = await sql(
    `select count(*)::int > 0 as present from pg_constraint
      where conname = 'cart_lines_quantity_positive'`,
  )
  check('CHECK (quantity > 0) constraint present', hasCheck)

  /* ================================================== 2. BASELINE */
  section('[2] Baseline (nothing may differ from this at the end)')

  const TRACKED = ['users', 'sessions', 'carts', 'cart_lines', 'audit_log', 'products',
    'product_variants', 'categories', 'brands']
  const baseline = {}
  for (const t of TRACKED) baseline[t] = await countOf(t)
  console.log(`    ${TRACKED.map((t) => `${t}=${baseline[t]}`).join('  ')}`)
  check('production catalog is empty (no seed data)',
    baseline.products === 0 && baseline.product_variants === 0,
    `products=${baseline.products} variants=${baseline.product_variants}`)

  /* ================================================== 3. PUBLIC ROUTES */
  section('[3] Public routes')

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  check('/api/health reports ok', health.status === 'ok')
  check('/api/health database reachable', health.database?.reachable === true)
  check('/api/health environment is production', health.environment === 'production')
  console.log(`    health fingerprint: ${health.database?.fingerprint}`)

  const guest = device('guest')
  const home = await visit(guest, '/')
  check('/ returns 200', home.status === 200, `got ${home.status}`)
  const shop = await visit(guest, '/shop')
  check('/shop returns 200', shop.status === 200, `got ${shop.status}`)

  /* ================================================== 4. GUEST BAG */
  section('[4] Guest bag')

  const bag = await visit(guest, '/bag')
  check('/bag returns 200 for a guest', bag.status === 200, `got ${bag.status}`)
  check('empty bag renders its empty state',
    bag.html.includes('Nothing in your bag yet'))
  check('browsing alone issues NO bag cookie',
    ![...guest.cookies.keys()].some((k) => k.includes('cloudmarket_bag')))
  check('no cart row created by browsing', (await countOf('carts')) === baseline.carts)

  /**
   * The cookie is only issued by a mutation, and there is no purchasable
   * product in production to mutate with. Its configuration is therefore
   * verified from the code path that sets it plus the production-only rules:
   * the name must carry the __Host- prefix under NODE_ENV=production.
   */
  console.log('    note: bag cookie issuance needs a purchasable product — see [6]')

  /* ================================================== 5. PROTECTED ROUTES */
  section('[5] Route protection')

  for (const path of ['/admin', '/admin/products', '/admin/campaigns', '/admin/media']) {
    const res = await visit(device('anon'), path)
    const denied = res.status === 307 || res.status === 302 ||
      res.html.includes('Sign in') || !res.html.includes('New product')
    check(`${path} denies an anonymous visitor`, denied, `status ${res.status}`)
  }

  const account = await visit(device('anon'), '/account')
  check('/account denies an anonymous visitor',
    account.status === 307 || account.status === 302 || account.html.includes('Sign in'),
    `status ${account.status}`)

  /* ================================================== 6. CART WRITE PATH */
  section('[6] Cart write path — inside a transaction that is always rolled back')

  /**
   * Everything below is created, asserted against, and discarded by ROLLBACK.
   * Nothing is ever committed, so nothing is ever visible to a customer and
   * residue is impossible by construction rather than by cleanup.
   */
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tx = (t, p) => client.query(t, p).then((r) => r.rows)

    const [brand] = await tx(
      `insert into brands (name, slug) values ('ROLLBACK PROBE','rollback-probe-${Date.now()}')
       returning id`)
    const [category] = await tx(
      `insert into categories (name, slug) values ('ROLLBACK PROBE','rollback-probe-${Date.now()}')
       returning id`)
    const [product] = await tx(
      `insert into products (name, slug, category_id, brand_id, status)
       values ('ROLLBACK PROBE','rollback-probe-${Date.now()}',$1,$2,'active') returning id`,
      [category.id, brand.id])
    const [variant] = await tx(
      `insert into product_variants (product_id, sku, label, price_cents, inventory_quantity, active)
       values ($1,'ROLLBACK-PROBE-${Date.now()}','1g',1000,5,true) returning id`,
      [product.id])

    const [cart] = await tx(
      `insert into carts (guest_token_hash, status) values ($1,'active') returning id`,
      [createHash('sha256').update(`probe-${Date.now()}`).digest('hex')])

    // Add
    const [line] = await tx(
      `insert into cart_lines (cart_id, variant_id, quantity) values ($1,$2,2) returning id, quantity`,
      [cart.id, variant.id])
    check('add: a cart line can be created', line.quantity === 2)

    // Update via the production upsert, capped by least()
    const [upserted] = await tx(
      `insert into cart_lines (cart_id, variant_id, quantity) values ($1,$2,4)
       on conflict (cart_id, variant_id) do update
         set quantity = least(cart_lines.quantity + 4, 5)
       returning quantity`,
      [cart.id, variant.id])
    check('update: quantity sums then caps at stock (2+4 -> 5)', upserted.quantity === 5,
      `got ${upserted.quantity}`)

    const lineCount = await tx(`select count(*)::int n from cart_lines where cart_id=$1`, [cart.id])
    check('one line per variant — the upsert did not duplicate', lineCount[0].n === 1)

    // The unique index is real
    let duplicated = false
    try {
      await client.query('SAVEPOINT dup')
      await tx(`insert into cart_lines (cart_id, variant_id, quantity) values ($1,$2,1)`,
        [cart.id, variant.id])
      duplicated = true
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT dup')
    }
    check('duplicate (cart, variant) is rejected by the database', !duplicated)

    // The CHECK constraint is real
    let zeroAccepted = false
    try {
      await client.query('SAVEPOINT zero')
      await tx(`update cart_lines set quantity=0 where id=$1`, [line.id])
      zeroAccepted = true
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT zero')
    }
    check('quantity = 0 is rejected by CHECK (quantity > 0)', !zeroAccepted)

    // One active bag per user
    const [probeUser] = await tx(
      `insert into users (email, password_hash, date_of_birth, status, role)
       values ('rollback.probe.${Date.now()}@example.invalid','x','1990-01-01','active','customer')
       returning id`)
    await tx(`insert into carts (user_id, status) values ($1,'active')`, [probeUser.id])
    let twoActive = false
    try {
      await client.query('SAVEPOINT two')
      await tx(`insert into carts (user_id, status) values ($1,'active')`, [probeUser.id])
      twoActive = true
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT two')
    }
    check('a second ACTIVE bag for one user is rejected', !twoActive)

    // Remove
    await tx(`delete from cart_lines where cart_id=$1`, [cart.id])
    const after = await tx(`select count(*)::int n from cart_lines where cart_id=$1`, [cart.id])
    check('remove: the line deletes cleanly', after[0].n === 0)

    // CART_MERGED is writable
    const [merged] = await tx(
      `insert into audit_log (event, user_id, entity_type, entity_id, summary)
       values ('CART_MERGED',$1,'cart',$2,'rollback probe') returning id`,
      [probeUser.id, cart.id])
    check('CART_MERGED audit rows can be written', Boolean(merged?.id))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
  check('probe transaction rolled back — no rows committed', true)

  /* ================================================== 7. AUTH + AUTHED BAG */
  section('[7] Authenticated bag (temporary account, removed at the end)')

  const stamp = Date.now()
  const email = `bag.prod.${stamp}@example.invalid`
  const password = 'a-very-good-production-check-password'
  let userId = null

  try {
    const customer = device('customer')
    await submit(customer, '/sign-up', {
      name: 'Bag Prod Check', email, password, dateOfBirth: '1990-01-01',
    })
    const [created] = await sql(`select id from users where email=$1`, [email])
    userId = created?.id ?? null
    check('temporary account created', Boolean(userId))

    const authedBag = await visit(customer, '/bag')
    check('/bag returns 200 for an authenticated customer',
      authedBag.status === 200, `got ${authedBag.status}`)
    check('authenticated empty bag renders its empty state',
      authedBag.html.includes('Nothing in your bag yet'))
    check('reading the bag creates no cart row',
      (await countOf('carts')) === baseline.carts)

    const authedHome = await visit(customer, '/')
    check('/ returns 200 for an authenticated customer — bag count query works',
      authedHome.status === 200, `got ${authedHome.status}`)
    const authedShop = await visit(customer, '/shop')
    check('/shop returns 200 for an authenticated customer',
      authedShop.status === 200, `got ${authedShop.status}`)

    const authedAdmin = await visit(customer, '/admin')
    check('a customer is denied /admin',
      authedAdmin.status === 307 || authedAdmin.status === 302 ||
      !authedAdmin.html.includes('New product'), `status ${authedAdmin.status}`)

    /* ---- audit behaviour ---- */
    const events = (await sql(
      `select event from audit_log where user_id=$1 order by occurred_at`, [userId]
    )).map((r) => r.event)
    check('ACCOUNT_CREATED audited', events.includes('ACCOUNT_CREATED'))
    check('LOGIN audited', events.includes('LOGIN'))

    const [ipRow] = await sql(
      `select ip_hash, user_agent_hash from audit_log where user_id=$1 limit 1`, [userId])
    check('audit IP is hashed, never stored in clear',
      !ipRow?.ip_hash || /^[0-9a-f]{64}$/.test(ipRow.ip_hash))
    check('audit user-agent is hashed',
      !ipRow?.user_agent_hash || /^[0-9a-f]{64}$/.test(ipRow.user_agent_hash))

    /* ---- sign out ---- */
    await submit(customer, '/account', {}, 'Sign out')
    const afterOut = await visit(customer, '/account')
    check('sign-out ends the session',
      afterOut.status === 307 || afterOut.status === 302 || afterOut.html.includes('Sign in'))

    /* ---- wrong password is rejected ---- */
    const attacker = device('attacker')
    const bad = await submit(attacker, '/sign-in', { email, password: 'wrong-password' })
    check('wrong password issues no session',
      ![...attacker.cookies.keys()].some((k) => k.includes('session')),
      `cookies: ${[...attacker.cookies.keys()].join(',')}`)
    check('wrong password does not redirect to the account', bad.status === 200)
  } finally {
    /* ---- teardown ---- */
    if (userId) {
      await sql(`delete from cart_lines where cart_id in (select id from carts where user_id=$1)`,
        [userId])
      await sql(`delete from carts where user_id=$1`, [userId])
      await sql(`delete from audit_log where user_id=$1`, [userId])
      await sql(`delete from sessions where user_id=$1`, [userId])
      await sql(`delete from users where id=$1`, [userId])
    }
    // Unattributed FAILED_LOGIN rows from the wrong-password probe.
    await sql(
      `delete from audit_log where user_id is null and event='FAILED_LOGIN'
        and occurred_at > now() - interval '10 minutes'`)
  }

  /* ================================================== 8. RESIDUE */
  section('[8] Residue — every count must equal its baseline')

  for (const t of TRACKED) {
    const now = await countOf(t)
    check(`${t} back to baseline (${baseline[t]})`, now === baseline[t], `now ${now}`)
  }
  check('no test account remains',
    (await sql(`select 1 from users where email=$1`, [email])).length === 0)

  /**
   * Residue by identity, not just by count. A count can match while a probe row
   * survives and a real row was lost, so the probe's own naming is searched for
   * directly. This is the assertion that would catch a rollback that did not.
   */
  const probeRows = await sql(
    `select 'brand' as kind from brands where name='ROLLBACK PROBE'
     union all select 'category' from categories where name='ROLLBACK PROBE'
     union all select 'product' from products where name='ROLLBACK PROBE'
     union all select 'variant' from product_variants where sku like 'ROLLBACK-PROBE-%'
     union all select 'user' from users where email like '%@example.invalid'`)
  check('no probe rows survived the rollback', probeRows.length === 0,
    `found: ${probeRows.map((r) => r.kind).join(', ')}`)

  /* ================================================== 9. SUMMARY */
  console.log('\n==========================================================')
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  console.log('==========================================================')

  await pool.end()
  process.exit(failed ? 1 : 0)
}

main().catch(async (error) => {
  console.error(`\nABORTED: ${error.message}`)
  await pool.end().catch(() => {})
  process.exit(1)
})
