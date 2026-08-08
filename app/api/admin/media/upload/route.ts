import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'

import { resolveAdminIdentity } from '@/lib/auth/admin-identity'
import {
  ACCEPTED_MIME_TYPES,
  BLOB_PREFIX,
  MAX_VIDEO_BYTES,
} from '@/lib/media/constants'

/**
 * Issues short-lived upload tokens so the browser can write directly to Vercel
 * Blob.
 *
 * WHY THE BYTES DO NOT COME THROUGH HERE. A Vercel serverless function has a
 * 4.5 MB request body limit. A 150 MB product video cannot be POSTed to a Route
 * Handler at any level of cleverness, and a Server Action is worse — its body
 * limit is 1 MB by default. Direct-to-storage upload is not an optimisation
 * here, it is the only shape that works.
 *
 * WHAT THIS ENDPOINT IS THEREFORE FOR. It is the authorization gate. No token is
 * issued to anyone who is not a signed-in administrator, and the token it does
 * issue is scoped: one path prefix, an explicit content-type allowlist, and a
 * hard byte ceiling enforced by the storage provider rather than by us.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide that an upload is
 * legitimate. `allowedContentTypes` constrains a header the client sends, and a
 * client that lies still gets an object into the bucket. The real check — magic
 * bytes read back out of storage — happens in `finalizeUploadAction`, which is
 * what actually creates the database row. An object nobody finalizes is never
 * referenced by anything.
 */

export const dynamic = 'force-dynamic'

/** The generous ceiling; the per-kind limit is applied at finalization. */
const TOKEN_MAX_BYTES = MAX_VIDEO_BYTES

/**
 * Reads the requested destination out of a token-generation body.
 *
 * `HandleUploadBody` is a union — the upload-completed callback carries no
 * pathname — so this narrows rather than asserting, and returns null for the
 * shapes that have none.
 */
function requestedPathname(body: HandleUploadBody): string | null {
  if (body.type !== 'blob.generate-client-token') return null
  const pathname = (body.payload as { pathname?: unknown }).pathname
  return typeof pathname === 'string' ? pathname : null
}

export async function POST(request: Request): Promise<Response> {
  let body: HandleUploadBody
  try {
    body = (await request.json()) as HandleUploadBody
  } catch {
    return Response.json({ error: 'Malformed request.' }, { status: 400 })
  }

  /**
   * AUTHORIZATION RUNS HERE, NOT INSIDE `onBeforeGenerateToken`.
   *
   * It was in the callback first, and `scripts/verify-product-media-http.mjs`
   * caught what that does: `handleUpload` catches whatever the callback throws
   * and re-wraps it, so the sentinel message never survives and EVERY refusal
   * came back as an indistinguishable 400. A customer and a malformed body
   * produced the same response, which makes the refusal untestable and hides
   * the difference between "not allowed" and "bad input".
   *
   * Checking before the helper is called keeps the status codes honest: 401 for
   * no session, 403 for an authenticated caller who is not an administrator.
   *
   * THE ROLE CHECK THAT USED TO LIVE HERE WAS `user.role !== 'admin'`, AND IT
   * WAS NOT ENOUGH. Under the Phase 5 identity model a role column is a
   * necessary but insufficient condition — any path that could write
   * `role = 'admin'` would otherwise have been a route to minting Blob upload
   * tokens for this store. `resolveAdminIdentity()` additionally requires the
   * caller to BE the owner or the single backup-slot occupant.
   *
   * The non-throwing probe is used rather than `requireAdminIdentity()` because
   * this is a route handler: it must return a status code, not raise Next's
   * `forbidden()` navigation interrupt, which has no meaning outside a rendered
   * page.
   */
  const identity = await resolveAdminIdentity()
  if (!identity.ok) {
    return identity.reason === 'no_session'
      ? Response.json({ error: 'Sign in to upload media.' }, { status: 401 })
      : Response.json({ error: 'Administrators only.' }, { status: 403 })
  }

  /**
   * The destination path comes from the client, so it is checked rather than
   * trusted. Without this an administrator could mint a token for any path in
   * the store, including one an unrelated feature relies on.
   */
  const pathname = requestedPathname(body)
  if (pathname !== null && !pathname.startsWith(`${BLOB_PREFIX}/`)) {
    return Response.json({ error: 'Invalid upload destination.' }, { status: 400 })
  }

  try {
    const result = await handleUpload({
      body,
      request,

      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [...ACCEPTED_MIME_TYPES],
        maximumSizeInBytes: TOKEN_MAX_BYTES,
        /**
         * Collisions are otherwise decided by whoever uploads second. With a
         * suffix, two operators uploading `front.jpg` on the same day get two
         * objects instead of one overwriting the other.
         */
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ uploadedBy: identity.identity.user.id }),
      }),

      /**
       * Intentionally absent: `onUploadCompleted`.
       *
       * Vercel Blob calls it over the public internet, so it never fires against
       * localhost without a tunnel — a row-creation path that only works in
       * production is a path that is never exercised before it ships. The client
       * calls `finalizeUploadAction` instead, which runs identically in both
       * environments and is where validation belongs.
       */
    })

    return Response.json(result)
  } catch (error) {
    console.error('[media] upload token issuance failed:', error)
    return Response.json({ error: 'Could not start that upload.' }, { status: 400 })
  }
}
