/**
 * Upload authorization, over real HTTP.
 *
 *   npm run build && npx next start -p 3530
 *   node scripts/verify-product-media-http.mjs http://127.0.0.1:3530
 *
 * The main suite proves what the DATABASE and the byte sniffer refuse. This
 * proves what the NETWORK refuses, which is a different question: the upload
 * token endpoint is a public POST route, reachable by anyone who can type its
 * path. The admin UI being invisible to a customer protects nothing.
 *
 * WHAT A FAILURE HERE WOULD MEAN. Any signed-in customer could mint a token and
 * write objects into the store's bucket — a storage bill and a hosting service
 * for whatever they liked, on our domain.
 *
 * REFUSES TO RUN against production. Removes every row it creates, by id.
 */
import { createHash } from 'node:crypto'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

loadEnv({ path: '.env.local', quiet: true })
if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

const BASE = process.argv[2] ?? 'http://127.0.0.1:3530'
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
      'user-agent': `ProductMediaHTTP/${d.label}`,
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

async function submit(d, path, values) {
  const page = await visit(d, path)
  const fields = actionFields(page.html)
  if (!Object.keys(fields).length) throw new Error(`no action fields on ${path}`)
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.append(k, v)
  for (const [k, v] of Object.entries(values)) body.append(k, v)
  return visit(d, path, { method: 'POST', body })
}

/** The body shape `handleUpload` expects when minting a client token. */
async function requestToken(d, pathname = 'product-media/test.gif') {
  const res = await fetch(`${BASE}/api/admin/media/upload`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      cookie: [...d.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: JSON.stringify({
      type: 'blob.generate-client-token',
      payload: {
        pathname,
        callbackUrl: `${BASE}/api/admin/media/upload`,
        clientPayload: null,
        multipart: false,
      },
    }),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body; status is what matters */
  }
  return { status: res.status, body }
}

const stamp = Date.now()
const PASSWORD = 'ProductMedia!Http9'
const created = { users: [] }

async function makeUser(label, role) {
  const email = `pmhttp.${label}.${stamp}@example.invalid`
  const jar = device(label)
  await submit(jar, '/sign-up', {
    email,
    password: PASSWORD,
    name: `PM ${label}`,
    dateOfBirth: '1990-01-01',
  })
  const [user] = await sql('select id from users where email=$1', [email])
  if (!user) throw new Error(`sign-up failed for ${email}`)
  created.users.push(user.id)
  await sql(`update users set role=$2, email_verified_at=now(), status='active' where id=$1`, [
    user.id,
    role,
  ])
  return { id: user.id, email, device: jar }
}

async function main() {
  console.log(`Product media — HTTP upload authorization, against ${BASE}`)
  console.log(`database ${fp(process.env.DATABASE_URL)} (not production)`)

  const customer = await makeUser('customer', 'customer')
  const staff = await makeUser('staff', 'staff')
  const admin = await makeUser('admin', 'admin')

  /* ============================================ 1. TOKEN ISSUANCE ====== */
  section('[1] Who can mint an upload token')
  {
    const anon = await requestToken(device('anon'))
    check('signed out is refused 401', anon.status === 401, `status ${anon.status}`)

    const cust = await requestToken(customer.device)
    check('a customer is refused 403', cust.status === 403, `status ${cust.status}`)

    /**
     * Staff run fulfilment. They are not administrators, and the catalogue —
     * including its imagery — is not theirs to change.
     */
    const staffAttempt = await requestToken(staff.device)
    check('STAFF is refused 403', staffAttempt.status === 403, `status ${staffAttempt.status}`)

    const adminAttempt = await requestToken(admin.device)
    check(
      'an admin gets past authorization',
      adminAttempt.status !== 401 && adminAttempt.status !== 403,
      `status ${adminAttempt.status}`,
    )
    if (adminAttempt.status === 200) {
      check('an admin receives a client token', typeof adminAttempt.body?.clientToken === 'string')
    } else {
      console.log(
        '      note: no BLOB_READ_WRITE_TOKEN in this environment, so issuance ' +
          'itself could not complete. Authorization was still exercised.',
      )
    }
  }

  /* ============================================ 2. PATH SCOPING ======== */
  section('[2] The token is scoped to our own prefix')
  {
    const escape = await requestToken(admin.device, '../../etc/passwd')
    check('a path outside the prefix is refused', escape.status === 400, `status ${escape.status}`)

    const otherPrefix = await requestToken(admin.device, 'invoices/secret.pdf')
    check(
      'an unrelated prefix is refused',
      otherPrefix.status === 400,
      `status ${otherPrefix.status}`,
    )
  }

  /* ============================================ 3. PAGE ACCESS ========= */
  section('[3] Who can open the product editor')
  {
    const [product] = await sql(
      `select id from products where deleted_at is null order by created_at limit 1`,
    )

    if (!product) {
      console.log('      skipped: no product exists in this database')
    } else {
      const anonView = await visit(device('anon'), `/admin/products/${product.id}`)
      check(
        'signed out cannot open it',
        anonView.status === 307 || !anonView.html.includes('Upload media'),
        `status ${anonView.status}`,
      )

      const custView = await visit(customer.device, `/admin/products/${product.id}`)
      check(
        'a customer cannot open it',
        !custView.html.includes('Upload media'),
        `status ${custView.status}`,
      )

      const adminView = await visit(admin.device, `/admin/products/${product.id}`)
      check(
        'an admin sees the media section',
        adminView.html.includes('Upload media'),
        `status ${adminView.status}`,
      )
      check(
        'the admin is told GIF animation is preserved',
        adminView.html.includes('Animated GIFs keep their animation') ||
          adminView.html.includes('keep their animation'),
      )
    }
  }

  /* ======================================== 4. MEDIA IS PRIVATE ======== */
  section('[4] Who can fetch an asset')
  {
    /**
     * THE MEDIA-PRIVACY FINDING, ASSERTED OVER THE WIRE.
     *
     * Before this release every asset had a permanent public URL on a CDN host,
     * and no amount of session checking in this application touched it. Now the
     * only address a browser is ever given is `/api/media/<id>` on this origin,
     * and that address is worth nothing without a live session — which is
     * exactly what these checks prove, including the part that matters most:
     * that it stops working the moment the session does.
     */
    const [asset] = await sql(
      `select m.id from media m
        where m.archived_at is null
        order by m.created_at desc
        limit 1`,
    )

    if (!asset) {
      console.log('      skipped: no media rows in this database')
    } else {
      const path = `/api/media/${asset.id}`

      const anon = await visit(device('anon'), path)
      check('signed out is refused 401', anon.status === 401, `status ${anon.status}`)
      check('the refusal is not an HTML page pretending to be an image', anon.html.trim() === '')

      const cust = await visit(customer.device, path)
      check(
        'a signed-in customer may fetch it',
        cust.status !== 401 && cust.status !== 403,
        `status ${cust.status}`,
      )

      /**
       * A signed-in customer must never be handed a storage address. For an
       * asset this application uploaded the response is the bytes; for one an
       * administrator added by pasting somebody else's URL it is a redirect to
       * that third-party host, which was public before we referenced it.
       */
      const location = cust.headers.get('location') ?? ''
      check(
        'no response points a customer at our storage',
        !location.includes('blob.vercel-storage.com'),
        location,
      )
      if (cust.status === 200) {
        check(
          'the response may not be cached by a shared cache',
          (cust.headers.get('cache-control') ?? '').includes('private'),
          cust.headers.get('cache-control') ?? '(none)',
        )
        check('sniffing is forbidden', cust.headers.get('x-content-type-options') === 'nosniff')
      }

      const unknown = await visit(customer.device, '/api/media/11111111-1111-1111-1111-111111111111')
      check('an unknown id is 404, not 500', unknown.status === 404, `status ${unknown.status}`)

      const malformed = await visit(customer.device, '/api/media/not-a-uuid')
      check('a malformed id is 404', malformed.status === 404, `status ${malformed.status}`)

      /**
       * REVOCATION. This is the property a signed CDN URL cannot have: the same
       * address, from the same browser, stops working the instant the session
       * ends rather than when a signature happens to expire.
       */
      const revoked = device('revoked')
      revoked.cookies = new Map(customer.device.cookies)
      await sql('delete from sessions where user_id = $1', [customer.id])
      const afterRevocation = await visit(revoked, path)
      check(
        'the same URL stops working when the session ends',
        afterRevocation.status === 401,
        `status ${afterRevocation.status}`,
      )
    }
  }

  /* ==================================== 5. NO STORAGE URL IN A PAGE ==== */
  section('[5] No page hands a browser a storage address')
  {
    const [product] = await sql(
      `select p.slug from products p
         join product_media pm on pm.product_id = p.id
        where p.deleted_at is null and p.status = 'active'
        limit 1`,
    )

    if (!product) {
      console.log('      skipped: no active product with media')
    } else {
      /** A fresh session, because §4 deliberately destroyed the customer's. */
      const shopper = await makeUser('shopper', 'customer')
      const page = await visit(shopper.device, `/product/${product.slug}`)

      check('the product page renders', page.status === 200, `status ${page.status}`)
      check(
        'it contains no storage address anywhere in its markup',
        !page.html.includes('blob.vercel-storage.com'),
      )
      check('its media is addressed through the authenticated route', page.html.includes('/api/media/'))
    }
  }

  console.log(`\n${'='.repeat(58)}`)
  console.log(failed === 0 ? `ALL ${passed} CHECKS PASSED` : `${passed} passed, ${failed} FAILED`)
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'))
  console.log('='.repeat(58))
}

main()
  .catch((error) => {
    console.error('\nABORTED:', error.message)
    failed += 1
  })
  .finally(async () => {
    try {
      if (created.users.length) {
        await sql('delete from sessions where user_id = any($1)', [created.users])
        await sql('delete from users where id = any($1)', [created.users])
      }
    } catch (error) {
      console.error('TEARDOWN FAILED — rows may remain:', error.message)
    }
    await pool.end().catch(() => {})
    process.exit(failed === 0 ? 0 : 1)
  })
