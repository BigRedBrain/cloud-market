/**
 * Cart & Bag end-to-end verification against a real database.
 *
 *   npm run build && npx next start -p 3500
 *   node scripts/verify-bag-e2e.mjs http://127.0.0.1:3500
 *
 * Drives the real HTTP surface with per-device cookie jars, submitting the
 * hidden $ACTION fields exactly as a browser with JavaScript disabled would —
 * so a pass here also proves the bag degrades without JS.
 *
 * REFUSES TO RUN against production.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'http://127.0.0.1:3500'
const PROD_FP = '2b968b3cbe06'
const fp = (u) => createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

if (fp(process.env.DATABASE_URL) === PROD_FP) {
  console.error('REFUSING TO RUN against production.')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
pool.on('error', () => {})
const sql = (t, p) => pool.query(t, p).then((r) => r.rows)

let passed = 0, failed = 0
const failures = []
const check = (name, ok, detail = '') => {
  ok ? passed++ : (failed++, failures.push(name))
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)

/* ----------------------------------------------------------- http plumbing */
const device = (label) => ({ label, cookies: new Map() })
const decode = (s) => s.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&amp;', '&')

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
      'user-agent': `BagE2E/${d.label}`,
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
  // Always drain: fetch resolves on headers while the server may still be
  // streaming, and asserting against Postgres before then races it.
  const html = await res.text()
  return { status: res.status, headers: res.headers, html }
}

/** Posts a specific form on a page, identified by a string it contains. */
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

/** Posts arbitrary fields to a page's action — used for tamper tests. */
async function rawPost(d, path, values, containing) {
  return submit(d, path, values, containing)
}

const bagCookieName = (d) => [...d.cookies.keys()].find((k) => k.includes('cloudmarket_bag'))
const hasBagCookie = (d) => Boolean(bagCookieName(d))

/* ------------------------------------------------------------- db helpers */
const cartFor = async (userId) =>
  (await sql(`select * from carts where user_id=$1 and status='active'`, [userId]))[0]
const linesOf = async (cartId) =>
  sql(`select cl.*, pv.sku from cart_lines cl join product_variants pv on pv.id=cl.variant_id
       where cl.cart_id=$1 order by cl.created_at`, [cartId])
const guestCartByToken = async (token) =>
  (await sql(`select * from carts where guest_token_hash=$1`, [
    createHash('sha256').update(token).digest('hex'),
  ]))[0]

const stamp = Date.now()

async function main() {
  console.log(`Bag E2E against ${BASE}`)
  console.log(`database ${fp(process.env.DATABASE_URL)} (not production)`)

  // Fixtures from the seeded catalog.
  const [inStock] = await sql(
    `select pv.id, pv.sku, pv.price_cents, pv.inventory_quantity, p.slug
       from product_variants pv join products p on p.id=pv.product_id
      where p.status='active' and pv.active and pv.inventory_quantity >= 5
      order by pv.inventory_quantity desc limit 1`)
  const [lowStock] = await sql(
    `select pv.id, pv.sku, pv.inventory_quantity, p.slug
       from product_variants pv join products p on p.id=pv.product_id
      where p.status='active' and pv.active and pv.inventory_quantity between 1 and 3 limit 1`)
  const [soldOut] = await sql(
    `select pv.id, pv.sku, p.slug from product_variants pv join products p on p.id=pv.product_id
      where p.status='active' and pv.inventory_quantity = 0 limit 1`)
  const [draftVariant] = await sql(
    `select pv.id, pv.sku from product_variants pv join products p on p.id=pv.product_id
      where p.status='draft' limit 1`)

  console.log(`fixtures: inStock=${inStock.sku}(${inStock.inventory_quantity}) low=${lowStock.sku}(${lowStock.inventory_quantity}) soldOut=${soldOut?.sku} draft=${draftVariant?.sku}`)

  /**
   * COMPLIANCE FIXTURE, added in Phase 4.4.
   *
   * The bag now refuses a variant that is not compliance-ready, which is the
   * required behaviour — an unclassified product must not be addable. The
   * development catalog was seeded long before classifications existed, so
   * every variant defaults to `other` and the whole suite would otherwise fail
   * at the first add.
   *
   * These four are classified HERE, explicitly, as a test fixture, and their
   * original values are captured and restored in teardown. This is not the
   * automatic catalog rewrite the phase forbids: it is four rows, named by the
   * test that needs them, put back afterwards.
   */
  const complianceFixtures = [inStock, lowStock, soldOut, draftVariant].filter(Boolean)
  const originalCompliance = await sql(
    `select id, cannabis_class, measurement_basis, measurement_value
       from product_variants where id = any($1::uuid[])`,
    [complianceFixtures.map((v) => v.id)],
  )
  await sql(
    `update product_variants
        set cannabis_class = 'flower',
            measurement_basis = 'net_weight_grams',
            measurement_value = 3.5000
      where id = any($1::uuid[])`,
    [complianceFixtures.map((v) => v.id)],
  )
  const restoreCompliance = async () => {
    for (const row of originalCompliance) {
      await sql(
        `update product_variants
            set cannabis_class = $2, measurement_basis = $3, measurement_value = $4
          where id = $1`,
        [row.id, row.cannabis_class, row.measurement_basis, row.measurement_value],
      )
    }
  }
  /** Reachable from the abort handler, which runs outside this scope. */
  globalThis.__restoreCompliance = restoreCompliance

  /* ============================================== 1. GUEST BAG BASICS */
  section('[1] Guest bag — add, persist, increment')
  const guest = device('guest')

  const empty = await visit(guest, '/bag')
  check('empty bag renders its empty state', empty.html.includes('Nothing in your bag yet'))
  check('no bag cookie issued by browsing alone', !hasBagCookie(guest))

  await submit(guest, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '1' }, inStock.id)
  check('bag cookie issued on first add', hasBagCookie(guest))

  const token = guest.cookies.get(bagCookieName(guest))
  const gCart = await guestCartByToken(token)
  check('guest cart row created', Boolean(gCart))
  check('cart is anonymous (no user)', gCart?.user_id === null)
  check('token stored hashed, not in clear', gCart?.guest_token_hash !== token)
  check('stored hash is sha256 of the cookie',
    gCart?.guest_token_hash === createHash('sha256').update(token).digest('hex'))

  let lines = await linesOf(gCart.id)
  check('one line created', lines.length === 1)
  check('line references the VARIANT', lines[0]?.variant_id === inStock.id)
  check('quantity is 1', lines[0]?.quantity === 1)
  check('no price column exists on the line', !('price_cents' in (lines[0] ?? {})))

  const bagPage = await visit(guest, '/bag')
  check('bag persists across requests for the guest', bagPage.html.includes(inStock.sku))

  // Same variant again -> increments, does not duplicate.
  await submit(guest, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '1' }, inStock.id)
  lines = await linesOf(gCart.id)
  check('adding the same variant twice does NOT duplicate the line', lines.length === 1)
  check('quantity incremented to 2', lines[0]?.quantity === 2)

  /* ============================================== 2. QUANTITY + REMOVE */
  section('[2] Quantity and removal')
  const bagHtml = (await visit(guest, '/bag')).html
  const lineId = lines[0].id

  await rawPost(guest, '/bag', { lineId, quantity: '4' }, 'Increase quantity')
  check('quantity increased', (await linesOf(gCart.id))[0]?.quantity === 4)

  await rawPost(guest, '/bag', { lineId, quantity: '2' }, 'Decrease quantity')
  check('quantity decreased', (await linesOf(gCart.id))[0]?.quantity === 2)

  const subtotalShown = bagHtml.includes('Subtotal')
  check('subtotal is rendered', subtotalShown)

  await rawPost(guest, '/bag', { lineId }, 'Remove')
  check('line removed', (await linesOf(gCart.id)).length === 0)
  check('bag shows empty state again', (await visit(guest, '/bag')).html.includes('Nothing in your bag yet'))

  /* ============================================== 3. VALIDATION */
  section('[3] Server-side validation')

  const before = (await linesOf(gCart.id)).length
  await submit(guest, `/product/${inStock.slug}`, { variantId: '00000000-0000-4000-8000-000000000000', quantity: '1' }, inStock.id)
  check('unknown variant is rejected', (await linesOf(gCart.id)).length === before)

  await submit(guest, `/product/${inStock.slug}`, { variantId: 'not-a-uuid', quantity: '1' }, inStock.id)
  check('malformed variant id is rejected', (await linesOf(gCart.id)).length === before)

  if (draftVariant) {
    await submit(guest, `/product/${inStock.slug}`, { variantId: draftVariant.id, quantity: '1' }, inStock.id)
    const has = (await linesOf(gCart.id)).some((l) => l.variant_id === draftVariant.id)
    check('variant of a DRAFT product cannot be added', !has)
  }

  if (soldOut) {
    await submit(guest, `/product/${inStock.slug}`, { variantId: soldOut.id, quantity: '1' }, inStock.id)
    const has = (await linesOf(gCart.id)).some((l) => l.variant_id === soldOut.id)
    check('sold-out variant cannot be added', !has)
  }

  // Inactive variant
  await sql(`update product_variants set active=false where id=$1`, [lowStock.id])
  await submit(guest, `/product/${inStock.slug}`, { variantId: lowStock.id, quantity: '1' }, inStock.id)
  check('inactive variant cannot be added',
    !(await linesOf(gCart.id)).some((l) => l.variant_id === lowStock.id))
  await sql(`update product_variants set active=true where id=$1`, [lowStock.id])

  /**
   * Over-request is capped at STOCK, and stock is the only cap.
   *
   * 5000 is deliberately far above the 99 that used to be hard-coded: if any
   * arbitrary per-line limit came back, this line would land on it instead of
   * on inventory and the assertion would fail.
   */
  await submit(guest, `/product/${lowStock.slug}`, { variantId: lowStock.id, quantity: '5000' }, lowStock.id)
  const capped = (await linesOf(gCart.id)).find((l) => l.variant_id === lowStock.id)
  check('over-requested quantity is capped at available stock, not at an arbitrary limit',
    capped?.quantity === lowStock.inventory_quantity,
    `got ${capped?.quantity}, stock ${lowStock.inventory_quantity}`)

  // A quantity above int4 is a validation failure, not a database error.
  await submit(guest, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '2147483648' }, inStock.id)
  check('quantity beyond int4 is rejected cleanly',
    !(await linesOf(gCart.id)).some((l) => l.variant_id === inStock.id))

  // Deep stock accepts a large request without any policy cap intervening.
  await sql(`update product_variants set inventory_quantity=1000 where id=$1`, [inStock.id])
  await submit(guest, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '500' }, inStock.id)
  const deep = (await linesOf(gCart.id)).find((l) => l.variant_id === inStock.id)
  check('a 500-unit request against 1000 stock is granted in full',
    deep?.quantity === 500, `got ${deep?.quantity}`)
  await sql(`update product_variants set inventory_quantity=$1 where id=$2`,
    [inStock.inventory_quantity, inStock.id])

  await sql(`delete from cart_lines where cart_id=$1`, [gCart.id])

  /* ============================================== 4. PRICE AUTHORITY */
  section('[4] Price authority')

  await submit(guest, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '2' }, inStock.id)
  const original = inStock.price_cents
  const html1 = (await visit(guest, '/bag')).html
  const shows = (cents) => html1.includes(`$${(cents / 100).toFixed(2)}`)
  check('bag shows the catalog price', shows(original * 2) || shows(original))

  // Change the price in the catalog; the bag must follow with no reconciliation.
  const bumped = original + 1500
  await sql(`update product_variants set price_cents=$1 where id=$2`, [bumped, inStock.id])
  const html2 = (await visit(guest, '/bag')).html
  check('price change is reflected live (no snapshot)',
    html2.includes(`$${((bumped * 2) / 100).toFixed(2)}`))
  check('old price no longer shown',
    !html2.includes(`$${((original * 2) / 100).toFixed(2)}`))
  await sql(`update product_variants set price_cents=$1 where id=$2`, [original, inStock.id])

  // Tamper: submit a price field. It must be ignored entirely.
  await rawPost(guest, '/bag', { lineId: (await linesOf(gCart.id))[0].id, quantity: '3', priceCents: '1', price: '1', unitPriceCents: '1' }, 'Increase quantity')
  const html3 = (await visit(guest, '/bag')).html
  check('client-supplied price fields are ignored', !html3.includes('$0.01') && !html3.includes('$0.03'))
  check('total still derives from the catalog',
    html3.includes(`$${((original * 3) / 100).toFixed(2)}`))

  /* ============================================== 5. FORGED IDENTITY */
  section('[5] Forged / tampered guest identity')

  const forged = device('forged')
  forged.cookies.set(bagCookieName(guest), 'totally-made-up-token-value')
  const forgedBag = await visit(forged, '/bag')
  check('forged guest token yields an EMPTY bag, not someone else\'s',
    forgedBag.html.includes('Nothing in your bag yet'))
  check('forged token does not leak the real bag contents', !forgedBag.html.includes(inStock.sku))

  const guessed = device('guessed')
  guessed.cookies.set(bagCookieName(guest), gCart.id) // the actual cart UUID
  const guessedBag = await visit(guessed, '/bag')
  check('cart UUID used as a token does not resolve', guessedBag.html.includes('Nothing in your bag yet'))

  /* ============================================== 6. MERGE */
  section('[6] Guest → customer merge')

  const email = `bag.e2e.${stamp}@example.com`
  const password = 'a-very-good-bag-password'

  // Customer signs up in a SEPARATE device and builds a bag.
  const customer = device('customer')
  await submit(customer, '/sign-up', {
    name: 'Bag Tester', email, password, dateOfBirth: '1990-01-01',
  })
  const [user] = await sql(`select id from users where email=$1`, [email])
  check('customer account created', Boolean(user))

  await submit(customer, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '2' }, inStock.id)
  const custCart = await cartFor(user.id)
  check('authenticated bag is bound to the user', custCart?.user_id === user.id)
  check('authenticated bag has no guest token', custCart?.guest_token_hash === null)
  check('authenticated bag persists', (await linesOf(custCart.id)).length === 1)

  // Sign out, then build a guest bag with the SAME variant plus another.
  await submit(customer, '/account', {}, 'Sign out')
  const guest2 = device('guest2')
  await submit(guest2, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '2' }, inStock.id)
  await submit(guest2, `/product/${lowStock.slug}`, { variantId: lowStock.id, quantity: '1' }, lowStock.id)
  const g2Token = guest2.cookies.get(bagCookieName(guest2))
  const g2Cart = await guestCartByToken(g2Token)
  check('guest bag built with 2 lines', (await linesOf(g2Cart.id)).length === 2)

  // Sign in on the guest device -> merge.
  await submit(guest2, '/sign-in', { email, password })

  const mergedCart = await cartFor(user.id)
  const mergedLines = await linesOf(mergedCart.id)
  check('customer keeps their original cart (not replaced)', mergedCart.id === custCart.id)
  check('merged bag contains both variants', mergedLines.length === 2)

  const sameVariantLine = mergedLines.find((l) => l.variant_id === inStock.id)
  check('same variant in both bags SUMS (2 + 2 = 4)', sameVariantLine?.quantity === 4,
    `got ${sameVariantLine?.quantity}`)

  const g2After = (await sql(`select * from carts where id=$1`, [g2Cart.id]))[0]
  check('guest cart marked merged', g2After?.status === 'merged')
  check('guest cart points at its destination', g2After?.merged_into_cart_id === mergedCart.id)
  check('guest cookie destroyed after merge', !hasBagCookie(guest2))

  /* ---- idempotency: replay the merge ---- */
  const beforeReplay = (await linesOf(mergedCart.id)).map((l) => `${l.variant_id}:${l.quantity}`).sort().join(',')
  // Sign out first: while a session exists, /sign-in redirects and has no form.
  await submit(guest2, '/account', {}, 'Sign out')
  // Re-plant the CONSUMED guest token, then sign in again — the replay attack.
  guest2.cookies.set('__Host-cloudmarket_bag', g2Token)
  guest2.cookies.set('cloudmarket_bag', g2Token)
  await submit(guest2, '/sign-in', { email, password })
  const afterReplay = (await linesOf(mergedCart.id)).map((l) => `${l.variant_id}:${l.quantity}`).sort().join(',')
  check('replayed merge is idempotent — quantities did not double', beforeReplay === afterReplay,
    `${beforeReplay} -> ${afterReplay}`)

  /* ---- merge capped at stock ---- */
  await sql(`delete from cart_lines where cart_id=$1`, [mergedCart.id])
  await sql(`update product_variants set inventory_quantity=5 where id=$1`, [inStock.id])
  await sql(`insert into cart_lines (cart_id, variant_id, quantity) values ($1,$2,4)`, [mergedCart.id, inStock.id])

  const guest3 = device('guest3')
  await submit(guest3, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '4' }, inStock.id)
  await submit(guest3, '/sign-in', { email, password })
  const cappedLine = (await linesOf(mergedCart.id)).find((l) => l.variant_id === inStock.id)
  check('merge caps combined quantity at available stock (4+4 -> 5)',
    cappedLine?.quantity === 5, `got ${cappedLine?.quantity}`)

  /* ---- unpurchasable guest lines are omitted, but NOT silently ---- */
  await sql(`delete from cart_lines where cart_id=$1`, [mergedCart.id])
  await sql(`delete from audit_log where user_id=$1 and event='CART_MERGED'`, [user.id])

  const guest4 = device('guest4')
  await submit(guest4, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '1' }, inStock.id)
  await submit(guest4, `/product/${lowStock.slug}`, { variantId: lowStock.id, quantity: '1' }, lowStock.id)
  const g4Token = guest4.cookies.get(bagCookieName(guest4))
  const g4Cart = await guestCartByToken(g4Token)
  check('guest bag has both lines before the item sells out',
    (await linesOf(g4Cart.id)).length === 2)

  // It sells out between the guest adding it and the guest signing in.
  await sql(`update product_variants set inventory_quantity=0 where id=$1`, [lowStock.id])

  const signedIn = await submit(guest4, '/sign-in', { email, password })
  const afterMerge = await linesOf(mergedCart.id)

  check('in-stock guest line still merges',
    afterMerge.some((l) => l.variant_id === inStock.id))
  check('sold-out guest line is NOT carried into the active bag',
    !afterMerge.some((l) => l.variant_id === lowStock.id))

  // The three ways the fact survives: the retained guest cart, the audit row,
  // and the notice the customer actually sees.
  const g4After = (await sql(`select * from carts where id=$1`, [g4Cart.id]))[0]
  check('guest cart is retained, not deleted', Boolean(g4After))
  check('retained guest cart still holds the dropped line',
    (await linesOf(g4Cart.id)).some((l) => l.variant_id === lowStock.id))

  const [mergeAudit] = await sql(
    `select * from audit_log where user_id=$1 and event='CART_MERGED' order by occurred_at desc limit 1`,
    [user.id])
  check('merge writes a CART_MERGED audit row', Boolean(mergeAudit))
  check('audit summary records the omitted line',
    /unavailable and omitted/.test(mergeAudit?.summary ?? ''),
    `summary: ${mergeAudit?.summary}`)
  check('audit row points at the destination cart', mergeAudit?.entity_id === mergedCart.id)

  /**
   * The sign-in response is the 303 itself — `visit` does not follow redirects,
   * which is also the only place the flag is observable in transit.
   */
  const signInTarget = signedIn.headers.get('location') ?? ''
  check('sign-in redirect carries the bag-changed flag',
    signInTarget.includes('bag=updated'), `location: ${signInTarget || '(none)'}`)

  check('the destination page surfaces the notice',
    (await visit(guest4, '/account?bag=updated')).html.includes('Your bag was updated'))
  check('the bag page surfaces the notice too',
    (await visit(guest4, '/bag?bag=updated')).html.includes('Your bag was updated'))
  check('the notice is not shown without the flag',
    !(await visit(guest4, '/bag')).html.includes('Your bag was updated'))

  await sql(`update product_variants set inventory_quantity=$1 where id=$2`,
    [lowStock.inventory_quantity, lowStock.id])

  /* ---- a clean merge does not raise the notice ---- */
  await submit(guest4, '/account', {}, 'Sign out')
  const guest5 = device('guest5')
  await submit(guest5, `/product/${inStock.slug}`, { variantId: inStock.id, quantity: '1' }, inStock.id)
  const g5Token = guest5.cookies.get(bagCookieName(guest5))
  const cleanSignIn = await submit(guest5, '/sign-in', { email, password })
  check('a merge with nothing dropped raises no flag',
    !(cleanSignIn.headers.get('location') ?? '').includes('bag=updated'),
    `location: ${cleanSignIn.headers.get('location')}`)

  /* ============================================== 7. SUSPENDED ACCOUNT */
  section('[7] Suspended account')
  await sql(`update users set status='suspended' where id=$1`, [user.id])
  const suspended = await visit(guest3, '/bag')
  check('suspended user is signed out of the bag',
    suspended.html.includes('Nothing in your bag yet') || suspended.status !== 200)
  await sql(`update users set status='active' where id=$1`, [user.id])

  /* ============================================== 8. CLEANUP */
  section('[8] Cleanup')
  await sql(`update product_variants set inventory_quantity=$1 where id=$2`,
    [inStock.inventory_quantity, inStock.id])

  /** The four compliance fixtures, back to exactly how they were found. */
  await restoreCompliance()
  const restored = await sql(
    `select id, cannabis_class, measurement_basis, measurement_value
       from product_variants where id = any($1::uuid[]) order by id`,
    [complianceFixtures.map((v) => v.id)],
  )
  const expected = [...originalCompliance].sort((a, b) => a.id.localeCompare(b.id))
  check(
    'compliance fixtures restored to their original values',
    restored
      .sort((a, b) => a.id.localeCompare(b.id))
      .every(
        (row, i) =>
          row.cannabis_class === expected[i].cannabis_class &&
          row.measurement_basis === expected[i].measurement_basis &&
          String(row.measurement_value) === String(expected[i].measurement_value),
      ),
  )

  await sql(`delete from carts where user_id=$1`, [user.id])
  await sql(`delete from carts where guest_token_hash = any($1)`,
    [[token, g2Token, g4Token, g5Token].filter(Boolean)
      .map((t) => createHash('sha256').update(t).digest('hex'))])
  await sql(`delete from audit_log where user_id=$1`, [user.id])
  await sql(`delete from users where id=$1`, [user.id])
  const leftover = await sql(`select count(*)::int n from carts where user_id is null and status='active'`)
  console.log(`    residual anonymous carts: ${leftover[0].n}`)
  check('test user removed', (await sql(`select 1 from users where id=$1`, [user.id])).length === 0)

  console.log(`\n${'='.repeat(58)}`)
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed) console.log(`Failed: ${failures.join(', ')}`)
  console.log('='.repeat(58))
  await pool.end()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nABORTED:', e.message)
  /**
   * The compliance fixtures are restored even on an abort. A crashed run that
   * left four catalog rows reclassified would be a test suite quietly editing
   * the catalog — the exact thing this phase forbids.
   */
  try {
    if (typeof globalThis.__restoreCompliance === 'function') {
      await globalThis.__restoreCompliance()
      console.error('compliance fixtures restored after the abort')
    }
  } catch (restoreError) {
    console.error('WARNING: could not restore compliance fixtures —', restoreError.message)
  }
  await pool.end().catch(() => {})
  process.exit(1)
})
