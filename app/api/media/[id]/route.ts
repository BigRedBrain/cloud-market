import { getCurrentUser } from '@/lib/auth/dal'
import { loadServableMedia, streamMedia } from '@/lib/media/serve'

/**
 * Product media — `GET /api/media/[id]`.
 *
 * THE ONLY WAY AN IMAGE, GIF OR VIDEO REACHES A BROWSER.
 *
 * Phase 5 put the storefront behind a login and left the media in front of it:
 * every asset lived at a permanent, world-readable Vercel Blob URL, so anyone
 * who ever obtained one — from a screenshot, a `Referer` header, a crawl taken
 * while the site was public, a database dump — could fetch it forever, with no
 * session and no expiry. `MEDIA-PRIVACY.md` recorded that as an open finding.
 * This route, plus `access: 'private'` on every upload, is the fix.
 *
 * WHAT MAKES IT A CONTROL RATHER THAN AN OBSCURATION
 *
 *   1. The object is PRIVATE in storage. Its URL is not a credential, because
 *      the URL does not work: reads require the store token, which lives only
 *      on the server. There is no secret URL to keep secret.
 *   2. Every request — including the ones a browser makes on its own to
 *      revalidate a cached image — passes `getCurrentUser()`. Access ends when
 *      the session ends, not when a signature happens to expire.
 *   3. The response may not be stored by any shared cache
 *      (`Cache-Control: private`), so no CDN or corporate proxy can hand one
 *      viewer's authorised bytes to the next person who asks.
 *
 * WHY 401 RATHER THAN A REDIRECT. This is an `/api/` path and its callers are
 * `<img>` and `<video>` elements. A 307 to `/sign-in` would make them render
 * the sign-in PAGE as if it were a picture — a broken image with an HTML body,
 * which is both useless to the browser and impossible for a test to assert on.
 *
 * WHY THE ID IS NOT A CAPABILITY. It is the `media.id` UUID, and knowing it
 * grants nothing: the check is the session, not the id. Enumerating ids
 * anonymously returns 401 for every one of them.
 *
 * ANY SIGNED-IN USER MAY READ ANY ASSET, DELIBERATELY. Product photography is
 * shown to every customer who can reach the catalog, so per-asset authorization
 * would be a check with no rule behind it — it would have to allow everything
 * the storefront displays. The boundary that matters here is "is this person
 * inside the invite-only storefront at all", and that is exactly what is
 * enforced. If media ever carries something narrower (a lab report naming a
 * customer), it needs its own route with its own rule, not a widened one here.
 */

/**
 * Never prerendered, never cached at the framework layer.
 *
 * A response whose correctness depends on WHO asked must not be reused for
 * someone who did not.
 */
export const dynamic = 'force-dynamic'

/** A well-formed `media.id`. Anything else is refused without touching the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  /**
   * AUTHORIZATION FIRST, AND BEFORE THE PARAMETER IS EVEN READ.
   *
   * Nothing about the request is inspected until the session is established, so
   * there is no code path in which an anonymous request causes a database read.
   * The 401 body is empty: an error message here would be a detail about the
   * catalog handed to someone who is not in it.
   */
  const user = await getCurrentUser()
  if (!user) {
    return new Response(null, {
      status: 401,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  const { id } = await context.params
  if (!UUID.test(id)) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
  }

  const media = await loadServableMedia(id)

  /**
   * An archived asset is treated as gone.
   *
   * "Archived" is how this application retires an image that has been replaced,
   * and continuing to serve it would mean a superseded photograph stays
   * fetchable by id for as long as the row exists. 404 rather than 403, because
   * the distinction between "no such asset" and "an asset you may not have"
   * is not one an authenticated customer needs to be able to make.
   */
  if (!media || media.archivedAt !== null) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
  }

  try {
    return await streamMedia(media, request)
  } catch (error) {
    /**
     * Logged without the URL. A storage failure message can quote the object
     * address, and this route exists to keep that address off every surface a
     * person can read — including our own logs, which are read by more people
     * than the store credential is.
     */
    console.error('[media] could not serve asset', id, error instanceof Error ? error.name : error)
    return new Response(null, { status: 502, headers: { 'Cache-Control': 'private, no-store' } })
  }
}
