import 'server-only'

import { get } from '@vercel/blob'
import { eq } from 'drizzle-orm'

import { db, schema } from '@/lib/db'
import {
  isPrivateBlobUrl,
  isPublicBlobUrl,
  type MediaKind,
} from './constants'

/**
 * Reading a stored object on behalf of a signed-in viewer.
 *
 * THIS MODULE IS THE MEDIA PRIVACY FIX. `constants.ts` decides that objects are
 * written private; this decides how they are read back, and the two together
 * are what make "the storefront is private" true of the pictures as well as the
 * pages.
 *
 * WHY THE BYTES COME THROUGH THE APPLICATION
 *
 * The alternative — mint a short-lived signed CDN URL and redirect the browser
 * to it — is cheaper, and the SDK supports it (`issueSignedToken` +
 * `presignUrl`). It was not chosen, because a signed URL is a BEARER TOKEN: for
 * the length of its TTL, anyone holding it can fetch the object with no session
 * at all. It lands in browser history, in `Referer` headers, in screenshots of
 * an address bar, and in any log an intermediary keeps. That converts a
 * permanent exposure into a repeated short one, which is an improvement rather
 * than a fix, and this storefront's entire premise is that outsiders do not
 * learn what is sold here.
 *
 * Streaming through the application means EVERY BYTE OF EVERY FETCH passes the
 * Data Access Layer. There is no URL to leak, because the only URL a browser
 * ever sees is `/api/media/<uuid>` on our own origin, and that one answers 401
 * without a session — including to the same browser five minutes after sign-out.
 *
 * WHAT IT COSTS, STATED PLAINLY
 *
 * Bandwidth and function time. A product page with twenty images makes twenty
 * authenticated requests that each traverse a serverless function instead of
 * being served from a CDN edge. Range requests are forwarded, so video seeking
 * works and a player fetches only the chunks it plays, but a long video watched
 * to the end does move its whole size through the function. For an invite-only
 * catalog this is the right trade; for a public storefront at scale it would
 * not be, and that judgement is recorded here rather than assumed.
 *
 * Conditional requests are honoured (`If-None-Match` in, `ETag` out), so a
 * browser that already has the bytes revalidates with a 304 and downloads
 * nothing. That is what keeps the cost proportional to distinct assets viewed
 * rather than to page views.
 */

export type ServableMedia = {
  id: string
  /** The storage URL. NEVER sent to a browser. */
  url: string
  /** Blob pathname, present on everything this application uploaded. */
  storageKey: string | null
  kind: MediaKind
  mimeType: string | null
  archivedAt: Date | null
}

/**
 * Where an asset's bytes have to come from.
 *
 * A pure function of the row so it can be enumerated in a test without a
 * database or a network — `scripts/verify-media-privacy.mts` asserts every
 * branch, including that the private branch is what a freshly uploaded asset
 * takes.
 */
export type MediaSource = 'private-blob' | 'public-blob' | 'external'

export function decideMediaSource(media: Pick<ServableMedia, 'url'>): MediaSource {
  if (isPrivateBlobUrl(media.url)) return 'private-blob'
  if (isPublicBlobUrl(media.url)) return 'public-blob'
  return 'external'
}

/** Loads the columns needed to serve an asset, or null. */
export async function loadServableMedia(mediaId: string): Promise<ServableMedia | null> {
  const [row] = await db
    .select({
      id: schema.media.id,
      url: schema.media.url,
      storageKey: schema.media.storageKey,
      kind: schema.media.kind,
      mimeType: schema.media.mimeType,
      archivedAt: schema.media.archivedAt,
    })
    .from(schema.media)
    .where(eq(schema.media.id, mediaId))
    .limit(1)

  return row ?? null
}

/**
 * Headers copied from the storage response onto ours.
 *
 * An allowlist, not a filter. Whatever the provider adds next year — a store
 * id, a request id, an internal cache key — is not something a customer's
 * browser needs, and forwarding headers by exclusion means the default for
 * anything new is to leak it.
 */
const FORWARDED_HEADERS = ['content-length', 'content-range', 'etag', 'last-modified'] as const

/**
 * How long a browser may reuse an asset without asking again.
 *
 * `private` is the load-bearing word: it forbids storage by any SHARED cache,
 * which is every CDN and corporate proxy between here and the customer. Without
 * it a cache could hold an authorised response and hand it to the next person
 * who asks for the same path — the exact failure this route exists to prevent,
 * reintroduced by a header.
 *
 * Five minutes, then revalidate. Long enough that scrolling a category page
 * does not re-download thumbnails; short enough that access revoked at 10:00 is
 * fully effective by 10:05 even for images already on disk. The revalidation is
 * cheap because it is conditional — 304 and no body.
 */
export const MEDIA_CACHE_CONTROL = 'private, max-age=300, must-revalidate'

/**
 * The headers every media response carries, as a pure function of the row.
 *
 * Exported so `scripts/verify-media-privacy.mts` can assert the policy without
 * a network or a storage credential — in particular that `Cache-Control` says
 * `private`, and that no header carries the storage address.
 */
export function mediaResponseHeaders(
  media: Pick<ServableMedia, 'mimeType'>,
): Headers {
  const headers = new Headers()

  /**
   * The content type comes from OUR row, which was decided by sniffing the
   * stored bytes at upload (`lib/media/signatures.ts`), not from the upstream
   * response and never from anything a client claimed. Paired with `nosniff`,
   * that is what stops an object from being interpreted as anything other than
   * the picture or video it was proven to be.
   */
  headers.set('Content-Type', media.mimeType ?? 'application/octet-stream')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Content-Disposition', 'inline')
  headers.set('Cache-Control', MEDIA_CACHE_CONTROL)
  headers.set('Accept-Ranges', 'bytes')
  /** Belt to the login wall's braces: an asset is never an indexable document. */
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet')
  /**
   * A media response is never a navigation, so no `Referer` should ever carry
   * one of these URLs onward. Cheap, and it costs nothing that is used.
   */
  headers.set('Referrer-Policy', 'no-referrer')
  return headers
}

/**
 * `from` is typed structurally rather than as `Headers`.
 *
 * The Blob SDK returns undici's `Headers`, the platform gives us the global
 * one, and the two are nominally different types with the same shape. Asking
 * only for `get` is what both actually provide, and is honest about what this
 * function uses.
 */
function copyForwarded(from: { get(name: string): string | null }, to: Headers): void {
  for (const name of FORWARDED_HEADERS) {
    const value = from.get(name)
    if (value !== null) to.set(name, value)
  }
}

/**
 * Streams an asset to an authorised viewer.
 *
 * The caller has already proved the viewer may see it. This function does not
 * re-check authorization and must never be reachable from anywhere that has
 * not — which is why it lives beside `server-only` and has exactly one caller,
 * `app/api/media/[id]/route.ts`.
 */
export async function streamMedia(
  media: ServableMedia,
  request: Request,
): Promise<Response> {
  const range = request.headers.get('range')
  const ifNoneMatch = request.headers.get('if-none-match')
  const source = decideMediaSource(media)

  /**
   * An asset added by pasting somebody else's URL is REDIRECTED, not proxied.
   *
   * Proxying it would make this route a general-purpose fetcher for whatever an
   * administrator once typed into a form — an SSRF primitive with a session
   * check in front of it, which is still an SSRF primitive. The object is on a
   * third-party host and is already public by construction; sending the browser
   * there discloses nothing that was not already disclosed, and keeps this
   * server out of the business of fetching arbitrary addresses.
   */
  if (source === 'external') {
    return new Response(null, {
      status: 307,
      headers: {
        Location: media.url,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
      },
    })
  }

  const forwarded: Record<string, string> = {}
  if (range) forwarded.range = range

  if (source === 'private-blob') {
    /**
     * `storageKey` (the blob pathname) is preferred over the URL: the SDK
     * resolves a pathname against the store id in the token, so a row whose URL
     * was written when the store had a different id still resolves. Falling
     * back to the URL keeps rows that predate the column serveable.
     */
    const result = await get(media.storageKey ?? media.url, {
      access: 'private',
      headers: forwarded,
      ...(ifNoneMatch ? { ifNoneMatch } : {}),
    })

    if (result === null) return new Response(null, { status: 404 })

    if (result.statusCode === 304) {
      const headers = mediaResponseHeaders(media)
      copyForwarded(result.headers, headers)
      return new Response(null, { status: 304, headers })
    }

    const headers = mediaResponseHeaders(media)
    copyForwarded(result.headers, headers)
    return new Response(result.stream, {
      status: headers.has('Content-Range') ? 206 : 200,
      headers,
    })
  }

  /**
   * LEGACY PUBLIC OBJECT.
   *
   * Fetched server-side rather than redirected to, so that the world-readable
   * URL still does not reach the browser — a customer who never learns the URL
   * cannot share it, and cannot keep using it after their access ends. The
   * object itself remains world-readable to anyone who ALREADY has the URL, and
   * no amount of code here changes that: the only fix is to re-upload it into
   * the private store and delete the public one. `npm run test:media:privacy`
   * fails while any such row exists, so this branch is a migration aid with an
   * expiry date, not a supported state.
   */
  const upstream = await fetch(media.url, {
    headers: {
      ...forwarded,
      ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
    },
    cache: 'no-store',
  })

  if (upstream.status === 404) return new Response(null, { status: 404 })
  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
    return new Response(null, { status: 502 })
  }

  const headers = mediaResponseHeaders(media)
  copyForwarded(upstream.headers, headers)

  if (upstream.status === 304) return new Response(null, { status: 304, headers })

  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers })
}
