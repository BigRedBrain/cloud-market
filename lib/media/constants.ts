/**
 * Media policy — formats, limits, and the storage prefix.
 *
 * Deliberately a plain module with no imports, so it can be read by the browser
 * bundle (to fail fast and give the operator a useful message before a 150 MB
 * upload starts), by Server Actions (where the decision actually binds), and by
 * the test suite (which asserts the two agree).
 *
 * THE CLIENT COPY IS A COURTESY, NEVER A CONTROL. Every limit here is re-checked
 * server-side in `lib/media/actions.ts` against the *stored* object, not against
 * what the browser claimed it was sending.
 */

/** What an asset fundamentally is. Mirrors the `media_kind` database enum. */
export type MediaKind = 'image' | 'video'

/**
 * Accepted image types.
 *
 * SVG IS DELIBERATELY ABSENT. An SVG is a script-bearing document, not a
 * picture: it can carry `<script>`, `<foreignObject>` and external references,
 * and serving one from our own origin makes it same-origin JavaScript. Accepting
 * it safely needs a sanitizer (DOMPurify or equivalent) plus a hardened
 * Content-Security-Policy — and `next.config.ts` records that this project has
 * no CSP yet, on purpose. Until both exist, SVG stays out.
 */
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const

/**
 * Accepted video types.
 *
 * MP4 and WebM are the two every current browser can actually play. QuickTime
 * is accepted as SOURCE media because operators film on phones and the
 * container is frequently H.264 that plays fine — but it is not assumed
 * playable, and `isBrowserPlayable()` below is what the storefront gates on.
 */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const

export const ACCEPTED_MIME_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as const

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number]

/**
 * Containers a browser will reliably play inline.
 *
 * QuickTime is excluded: `video/quicktime` covers everything from H.264 (plays
 * in Safari, usually not Chrome) to ProRes (plays nowhere). The gallery still
 * shows the asset and still offers it, but it warns rather than silently
 * rendering a black rectangle.
 */
const BROWSER_PLAYABLE = new Set<string>(['video/mp4', 'video/webm'])

export function isBrowserPlayable(mimeType: string | null | undefined): boolean {
  return mimeType !== null && mimeType !== undefined && BROWSER_PLAYABLE.has(mimeType)
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

const MB = 1024 * 1024

/** Per-file ceiling for stills and GIFs. */
export const MAX_IMAGE_BYTES = 25 * MB

/** Per-file ceiling for video. */
export const MAX_VIDEO_BYTES = 150 * MB

/**
 * How many assets one product may carry.
 *
 * A gallery past this stops being a gallery and starts being a page-weight
 * problem, and no storefront layout in this design system displays more.
 */
export const MAX_MEDIA_PER_PRODUCT = 20

/** The ceiling that applies to a given kind. */
export function maxBytesFor(kind: MediaKind): number {
  return kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

export function isAcceptedMimeType(value: string): value is AcceptedMimeType {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(value)
}

export function kindForMimeType(mimeType: string): MediaKind | null {
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return 'image'
  if ((VIDEO_MIME_TYPES as readonly string[]).includes(mimeType)) return 'video'
  return null
}

/**
 * Animated formats, which must never be routed through an image optimizer.
 *
 * Today that is GIF alone. WebP and AVIF *can* be animated, but this project
 * never re-encodes an upload, so an animated WebP is served as-is by the same
 * path — the flag exists so the optimizer bypass has one place to grow.
 */
export function isAnimatedFormat(mimeType: string | null | undefined): boolean {
  return mimeType === 'image/gif'
}

/**
 * May this asset be a product thumbnail?
 *
 * Images and GIFs yes, video no. A card has no controls, no poster and no
 * reasonable autoplay story, so a video thumbnail is a broken card.
 */
export function canBeThumbnail(kind: MediaKind): boolean {
  return kind === 'image'
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

/** Blob path prefix. Namespaced so media objects are greppable in the store. */
export const BLOB_PREFIX = 'product-media'

/**
 * Every upload is written PRIVATE.
 *
 * This is the whole of the media-privacy fix, expressed in one word. A `public`
 * object on Vercel Blob is served from a CDN host with no session, no signature
 * and no expiry: knowing the URL IS the authorization, permanently. The
 * storefront went private in Phase 5 and the media did not, which is what
 * MEDIA-PRIVACY.md recorded as an open finding.
 *
 * A `private` object cannot be fetched by URL at all. Reads require the store's
 * credential, which only the server holds — see `lib/media/serve.ts`.
 *
 * IT IS A CONSTANT, NOT A SETTING. An environment variable able to flip this to
 * `public` would be a way to un-privatise the catalog by editing a dashboard,
 * and every object created while it was wrong would stay world-readable
 * afterwards. Changing it has to be a code change and a review.
 */
export const MEDIA_ACCESS = 'private' as const

/** Suffix of the host a PUBLIC Vercel Blob object is served from. */
export const BLOB_PUBLIC_HOST_SUFFIX = '.public.blob.vercel-storage.com'

/** Suffix of the host a PRIVATE object lives on. Fetching it needs a credential. */
export const BLOB_PRIVATE_HOST_SUFFIX = '.private.blob.vercel-storage.com'

/**
 * Retained under its old name because it is what `next.config.ts` allow-lists
 * and what the CSP names.
 *
 * @deprecated Prefer `BLOB_PUBLIC_HOST_SUFFIX`; the name no longer says which
 * of the two hosts it means.
 */
export const BLOB_HOST_SUFFIX = BLOB_PUBLIC_HOST_SUFFIX

/**
 * Is this URL an object this application uploaded?
 *
 * Gates two things: whether permanent deletion may call `del()` on it, and
 * whether the finalize action will accept it at all — without that check the
 * action is an arbitrary-URL fetcher reachable by an administrator, which is
 * SSRF. A pasted third-party URL is neither ours to delete nor ours to trust.
 *
 * BOTH HOSTS COUNT. New uploads land on the private host; rows created before
 * this change point at the public one, and they are still ours — still
 * deletable, still serveable through the authenticated route. Refusing to
 * recognise them would strand exactly the objects that most need cleaning up.
 */
export function isOwnedBlobUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url)
    return (
      protocol === 'https:' &&
      (hostname.endsWith(BLOB_PUBLIC_HOST_SUFFIX) ||
        hostname.endsWith(BLOB_PRIVATE_HOST_SUFFIX))
    )
  } catch {
    return false
  }
}

/** Is this object one that requires the store credential to read? */
export function isPrivateBlobUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url)
    return protocol === 'https:' && hostname.endsWith(BLOB_PRIVATE_HOST_SUFFIX)
  } catch {
    return false
  }
}

/**
 * Is this object WORLD-READABLE — reachable by anyone holding the URL?
 *
 * Used by `scripts/verify-media-privacy.mts` to fail a release that still has
 * public objects in the catalog, and by the admin media library to mark them.
 * A row matching this is not a bug in the code; it is an object that existed
 * before the store became private and has to be re-uploaded or deleted.
 */
export function isPublicBlobUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url)
    return protocol === 'https:' && hostname.endsWith(BLOB_PUBLIC_HOST_SUFFIX)
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* How media reaches a browser                                                 */
/* -------------------------------------------------------------------------- */

/** The authenticated route every asset is served through. */
export const MEDIA_ROUTE_PREFIX = '/api/media/'

/**
 * The only `src` a browser is ever given for an asset.
 *
 * SAME-ORIGIN, BY ID, WITH NO STORAGE DETAIL IN IT. The storage URL never
 * reaches the page: not in an `<img src>`, not in a `srcset`, not in a poster
 * attribute, not in the RSC payload behind them. There is therefore no URL for
 * a customer to copy out of dev-tools, no URL to leak in a `Referer`, and
 * nothing that keeps working after the session ends — the route re-checks the
 * session on every single request, including the ones the browser makes hours
 * later out of its own cache validation.
 *
 * Declared in this module, which has no imports, so the storefront, the admin
 * screens and the test suites all build the same string.
 */
export function mediaHref(mediaId: string): string {
  return `${MEDIA_ROUTE_PREFIX}${mediaId}`
}

/** Is this `src` one of ours, rather than a pasted third-party URL? */
export function isMediaHref(src: string): boolean {
  return src.startsWith(MEDIA_ROUTE_PREFIX)
}

/** Human-facing size, for the admin cards. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MB) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

/** Human-facing duration, for video cards. */
export function formatDuration(seconds: number | string | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  const total = typeof seconds === 'string' ? Number(seconds) : seconds
  if (!Number.isFinite(total) || total < 0) return '—'
  const minutes = Math.floor(total / 60)
  const remainder = Math.floor(total % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}
