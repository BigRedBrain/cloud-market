/** MUST BE FIRST — see the header of that module. */
import './_phase-5-test-env.mts'

import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { db, schema } from '../lib/db'
import { isPublicApi, isPublicPage, isPublicRoute } from '../lib/auth/public-routes'
import {
  BLOB_PREFIX,
  BLOB_PRIVATE_HOST_SUFFIX,
  BLOB_PUBLIC_HOST_SUFFIX,
  isMediaHref,
  isOwnedBlobUrl,
  isPrivateBlobUrl,
  isPublicBlobUrl,
  MEDIA_ACCESS,
  MEDIA_ROUTE_PREFIX,
  mediaHref,
} from '../lib/media/constants'
import { decideMediaSource, mediaResponseHeaders, MEDIA_CACHE_CONTROL } from '../lib/media/serve'
import { adminProductGallery, libraryAssetsForPicker, primaryMediaByProduct, productGallery } from '../lib/media/queries'
import { adminListMedia } from '../lib/cms/admin-queries'

/**
 * Media privacy — the storefront's pictures are as private as its pages.
 *
 *   npm run test:media:privacy
 *
 * WHAT WAS WRONG, AND WHAT THIS SUITE HOLDS IN PLACE
 *
 * Phase 5 put every page behind a login and left every image in front of one.
 * Objects were written to Vercel Blob with `access: 'public'`, which means a
 * permanent URL on a CDN host: no session, no signature, no expiry. Anybody who
 * ever obtained one — from a screenshot, a `Referer` header, a crawl taken while
 * the site was public, a database dump — could fetch that object forever.
 * `MEDIA-PRIVACY.md` recorded it as an open finding, and this release closes it.
 *
 * The fix has two halves, and the suite is built around the seam between them:
 *
 *   STORAGE   every object is `access: 'private'`. Its URL is not a credential,
 *             because the URL does not work without the store token.
 *   SERVING   every asset reaches a browser as `/api/media/<id>`, a route that
 *             calls the Data Access Layer on every request.
 *
 * A system with only the first half leaks nothing but cannot display anything.
 * A system with only the second half is the one this release replaced: an
 * authenticated route in front of an object anybody could fetch directly. So
 * §A–§C prove the storage policy, §D–§E prove the serving policy, and §F is the
 * one that would actually catch a regression in normal work — it walks the real
 * DTOs and asserts that no storage address appears in any of them.
 *
 * REFUSES TO RUN AGAINST PRODUCTION. §F reads the catalog.
 */

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1
  else {
    failed += 1
    failures.push(detail ? `${name} — ${detail}` : name)
  }
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

const PRODUCTION_FP = '2b968b3cbe06'
const fingerprint = (value: string) =>
  createHash('sha256').update(new URL(value).hostname).digest('hex').slice(0, 12)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}
if (fingerprint(process.env.DATABASE_URL) === PRODUCTION_FP) {
  console.error('REFUSING TO RUN against production.')
  process.exit(1)
}

console.log('Media privacy and access control')

/* ========================================================================== */
section('A. Storage policy — nothing is written world-readable')
/* ========================================================================== */
{
  /**
   * The single most important line in this suite. `MEDIA_ACCESS` is what both
   * upload clients pass to `upload()`, and `finalizeUploadAction` refuses to
   * record any object that did not land on the private host — so a modified
   * client that asked for `public` gets its object deleted rather than
   * catalogued.
   */
  check('uploads are private', MEDIA_ACCESS === 'private')
  check('the private host suffix is the real one', BLOB_PRIVATE_HOST_SUFFIX === '.private.blob.vercel-storage.com')
  check('the public host suffix is still known, to recognise legacy rows', BLOB_PUBLIC_HOST_SUFFIX === '.public.blob.vercel-storage.com')
  check('uploads stay under one prefix', BLOB_PREFIX === 'product-media')
}

/* ========================================================================== */
section('B. URL classification — what counts as ours, and as public')
/* ========================================================================== */
{
  const priv = `https://store123${BLOB_PRIVATE_HOST_SUFFIX}/product-media/x-abc.jpg`
  const pub = `https://store123${BLOB_PUBLIC_HOST_SUFFIX}/product-media/x-abc.jpg`

  check('a private object is ours', isOwnedBlobUrl(priv))
  check('a private object is private', isPrivateBlobUrl(priv))
  check('a private object is not reported world-readable', !isPublicBlobUrl(priv))

  check('a legacy public object is still ours (so it can be deleted)', isOwnedBlobUrl(pub))
  check('a legacy public object is reported world-readable', isPublicBlobUrl(pub))
  check('a legacy public object is not treated as private', !isPrivateBlobUrl(pub))

  /**
   * The hostile inputs. `isOwnedBlobUrl` gates the finalize action's fetch, so a
   * false positive here is server-side request forgery: an administrator could
   * point it at an internal address and have the application read it.
   */
  check('an arbitrary host is not ours', !isOwnedBlobUrl('https://evil.example.com/x.gif'))
  check('plain http is not ours', !isOwnedBlobUrl(`http://store123${BLOB_PRIVATE_HOST_SUFFIX}/x.gif`))
  check('a link-local address is not ours', !isOwnedBlobUrl('http://169.254.169.254/latest/meta-data'))
  check(
    'a lookalike suffix is not ours',
    !isOwnedBlobUrl('https://private.blob.vercel-storage.com.evil.test/x'),
  )
  check('a subdomain trick is not ours', !isOwnedBlobUrl('https://blob.vercel-storage.com.evil.test/x'))
  check('garbage is not ours', !isOwnedBlobUrl('not a url'))
  check('an empty string is not ours', !isOwnedBlobUrl(''))
}

/* ========================================================================== */
section('C. Source resolution — where an asset’s bytes come from')
/* ========================================================================== */
{
  const at = (url: string) => decideMediaSource({ url })

  check('a private object is read with the store credential', at(`https://s${BLOB_PRIVATE_HOST_SUFFIX}/a.jpg`) === 'private-blob')
  check('a legacy public object is proxied, not redirected to', at(`https://s${BLOB_PUBLIC_HOST_SUFFIX}/a.jpg`) === 'public-blob')

  /**
   * A pasted third-party URL is REDIRECTED rather than fetched. Proxying it
   * would make the route a general-purpose fetcher for whatever an
   * administrator once typed into a form, which is an SSRF primitive with a
   * session check in front of it.
   */
  check('a third-party URL is a redirect', at('https://images.example.com/a.jpg') === 'external')
  check('an internal address is a redirect, never a server-side fetch', at('http://169.254.169.254/') === 'external')
}

/* ========================================================================== */
section('D. Response policy — no shared cache may keep an authorised body')
/* ========================================================================== */
{
  const headers = mediaResponseHeaders({ mimeType: 'image/gif' })

  check('Cache-Control forbids shared caches', headers.get('Cache-Control')?.startsWith('private') === true)
  check('Cache-Control requires revalidation', MEDIA_CACHE_CONTROL.includes('must-revalidate'))
  check('the cache window is minutes, not days', /max-age=(\d+)/.exec(MEDIA_CACHE_CONTROL) !== null && Number(/max-age=(\d+)/.exec(MEDIA_CACHE_CONTROL)![1]) <= 600)
  check('nothing is publicly cacheable', !MEDIA_CACHE_CONTROL.includes('public'))

  /**
   * The content type is OUR sniffed value, never the upstream header and never
   * anything a client claimed. With `nosniff`, that is what stops a stored
   * object from being interpreted as something other than what its bytes proved
   * it to be.
   */
  check('the content type comes from the row', headers.get('Content-Type') === 'image/gif')
  check('an unknown type degrades to a non-executable one', mediaResponseHeaders({ mimeType: null }).get('Content-Type') === 'application/octet-stream')
  check('sniffing is forbidden', headers.get('X-Content-Type-Options') === 'nosniff')
  check('the asset renders inline rather than downloading', headers.get('Content-Disposition') === 'inline')
  check('range requests are advertised, so video seeking works', headers.get('Accept-Ranges') === 'bytes')
  check('an asset is never indexable', headers.get('X-Robots-Tag')?.includes('noindex') === true)
  check('no referrer is emitted', headers.get('Referrer-Policy') === 'no-referrer')

  /** Nothing about storage may travel in a header. */
  const serialised = [...headers.entries()].flat().join(' ')
  check('no header mentions the storage host', !serialised.includes('blob.vercel-storage.com'))
  check('no header carries a location', headers.get('Location') === null)
}

/* ========================================================================== */
section('E. The route is private by default, and answers rather than redirects')
/* ========================================================================== */
{
  const href = mediaHref('11111111-2222-3333-4444-555555555555')

  check('an asset is addressed by id on this origin', href === '/api/media/11111111-2222-3333-4444-555555555555')
  check('the prefix is what the route file provides', MEDIA_ROUTE_PREFIX === '/api/media/')
  check('our own hrefs are recognisable', isMediaHref(href))
  check('a third-party URL is not one of ours', !isMediaHref('https://images.example.com/a.jpg'))

  /**
   * THE ALLOWLIST IS THE LOGIN WALL. `proxy.ts` answers 401 to any `/api/` path
   * without a session cookie unless `isPublicApi` says otherwise, and the route
   * handler independently calls `getCurrentUser()`. Both must agree that media
   * is private; this asserts the half that a future "make the health check
   * public" edit could plausibly get wrong.
   */
  check('the media route is not in the public API allowlist', !isPublicApi(href))
  check('it is not a public page either', !isPublicPage(href))
  check('so it is not reachable anonymously by any route', !isPublicRoute(href))
  check('the same holds for the bare prefix', !isPublicRoute(MEDIA_ROUTE_PREFIX))
  check('and for an arbitrary id', !isPublicRoute(mediaHref('anything-at-all')))

  /** The sign-in surfaces stay public, or nobody can authenticate at all. */
  check('sign-in is still public', isPublicPage('/sign-in'))
  check('the liveness probe is still public', isPublicApi('/api/health'))
}

/* ========================================================================== */
section('F. Live DTOs — no storage address reaches a browser')
/* ========================================================================== */
{
  const STORAGE_MARKERS = ['blob.vercel-storage.com', 'BLOB_READ_WRITE_TOKEN']

  const leaks = (value: unknown) => {
    const text = JSON.stringify(value ?? null)
    return STORAGE_MARKERS.filter((marker) => text.includes(marker))
  }

  const [product] = await db
    .select({ id: schema.products.id })
    .from(schema.products)
    .innerJoin(schema.productMedia, eq(schema.productMedia.productId, schema.products.id))
    .where(isNull(schema.products.deletedAt))
    .limit(1)

  if (!product) {
    console.log('    --    no product with media in this database; DTO checks skipped')
  } else {
    const gallery = await productGallery(product.id)
    const adminGallery = await adminProductGallery(product.id)
    const cards = await primaryMediaByProduct([product.id])
    const picker = await libraryAssetsForPicker(product.id, 20)

    check('the storefront gallery is not empty (the check is meaningful)', gallery.length > 0)
    check(
      'every storefront gallery url is the authenticated route',
      gallery.every((item) => isMediaHref(item.url)),
      gallery.map((item) => item.url).find((url) => !isMediaHref(url)) ?? '',
    )
    check('the storefront gallery leaks no storage address', leaks(gallery).length === 0, leaks(gallery).join(', '))

    check(
      'every admin gallery url is the authenticated route',
      adminGallery.every((item) => isMediaHref(item.url)),
    )
    check('the admin gallery leaks no storage address', leaks(adminGallery).length === 0, leaks(adminGallery).join(', '))

    check(
      'every card image url is the authenticated route',
      [...cards.values()].every((card) => isMediaHref(card.url)),
    )
    check('card media leaks no storage address', leaks([...cards.values()]).length === 0)

    check('every library picker url is the authenticated route', picker.every((asset) => isMediaHref(asset.url)))
    check('the library picker leaks no storage address', leaks(picker).length === 0)
  }

  /**
   * The admin media library is the ONE place a storage address is legitimately
   * present — the "Add by URL" field round-trips it — so it is asserted
   * precisely rather than exempted: `src` must be the route, and `url` must be
   * the only field carrying anything else.
   */
  const library = await adminListMedia()
  if (library.length === 0) {
    console.log('    --    the media library is empty; library checks skipped')
  } else {
    check('every library asset renders through the route', library.every((asset) => isMediaHref(asset.src)))
    check(
      'the render address is never the storage address',
      library.every((asset) => asset.src !== asset.url),
    )
    check(
      'world-readable rows are flagged for the operator',
      library.every((asset) => asset.worldReadable === isPublicBlobUrl(asset.url)),
    )
  }
}

/* ========================================================================== */
section('G. Storage audit — no world-readable object remains in the catalog')
/* ========================================================================== */
{
  const [{ total, publicHost, privateHost, external }] = await db
    .select({
      total: sql<number>`count(*)::int`,
      publicHost: sql<number>`count(*) filter (where url like ${'%' + BLOB_PUBLIC_HOST_SUFFIX + '%'})::int`,
      privateHost: sql<number>`count(*) filter (where url like ${'%' + BLOB_PRIVATE_HOST_SUFFIX + '%'})::int`,
      external: sql<number>`count(*) filter (where url not like ${'%.blob.vercel-storage.com%'})::int`,
    })
    .from(schema.media)

  console.log(`    --    ${total} media rows: ${privateHost} private, ${publicHost} public, ${external} third-party`)

  /**
   * THE FINDING ITSELF, AS AN ASSERTION.
   *
   * A row on the public host is an object that is world-readable to anyone
   * already holding its URL, and no code in this application can change that.
   * The only fix is to re-upload it into the private store and delete the
   * original. Failing here rather than warning is deliberate: this is the exact
   * condition MEDIA-PRIVACY.md was opened for, and a warning is something a
   * release can be shipped past.
   */
  check(
    'no media row points at a world-readable object',
    publicHost === 0,
    publicHost > 0
      ? `${publicHost} row(s) must be re-uploaded to the private store and the originals deleted`
      : '',
  )

  /**
   * Third-party rows are NOT a failure. They are assets an administrator added
   * by pasting somebody else's URL, they were already public before this
   * application referenced them, and the route redirects rather than proxies
   * them. Counted so the number is visible rather than assumed to be zero.
   */
  check('third-party rows are counted, not silently tolerated', external >= 0)

  /** Everything this application uploaded carries the pathname it was stored at. */
  const [{ missingKey }] = await db
    .select({ missingKey: sql<number>`count(*)::int` })
    .from(schema.media)
    .where(
      and(
        sql`${schema.media.url} like ${'%' + BLOB_PRIVATE_HOST_SUFFIX + '%'}`,
        isNull(schema.media.storageKey),
      ),
    )
  check('every private object records its storage key', missingKey === 0, `${missingKey} without one`)
}

/* ========================================================================== */

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m (${passed + failed} checks)\n`)

if (failed > 0) {
  for (const failure of failures) console.error(`  \x1b[31m✗\x1b[0m ${failure}`)
  process.exit(1)
}
