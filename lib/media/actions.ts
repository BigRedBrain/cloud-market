'use server'

import { del, get, head } from '@vercel/blob'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { requireAdminIdentity } from '@/lib/auth/admin-identity'
import { recordAuditEvent } from '@/lib/auth/audit'
import { db, schema } from '@/lib/db'
import { withUpdatedAt } from '@/lib/db/schema/_shared'
import {
  fail,
  formDataToObject,
  ok,
  parseInput,
  type ActionResult,
} from '@/lib/result'
import {
  canBeThumbnail,
  isOwnedBlobUrl,
  isPrivateBlobUrl,
  kindForMimeType,
  MAX_MEDIA_PER_PRODUCT,
  maxBytesFor,
} from './constants'
import { refusedFormatLabel, sniff, SNIFF_BYTES } from './signatures'

/**
 * Product media mutations.
 *
 * EVERY EXPORT HERE IS A PUBLIC NETWORK ENDPOINT. `'use server'` does not mean
 * "runs on the server", it means "callable by anyone who can reach the site", so
 * each one starts with `requireAdminIdentity()` and re-derives everything it needs from
 * the database rather than believing an id handed to it.
 *
 * The upload path is the interesting one. Bytes never pass through this
 * application: the browser uploads straight to Vercel Blob using a short-lived
 * token issued by `app/api/admin/media/upload/route.ts`, and then calls
 * `finalizeUploadAction` to have the result inspected and recorded. That split
 * exists because Vercel caps a serverless request body at 4.5 MB — a 150 MB
 * video cannot be proxied through a Route Handler at all — but it has a
 * consequence that governs the design below:
 *
 *   A BLOB EXISTS BEFORE ANYTHING HAS VALIDATED IT.
 *
 * So finalization does not trust the upload. It re-reads the stored object's
 * real size and content type from the provider, fetches the leading bytes back
 * out of storage, and identifies the file from its magic numbers. Nothing the
 * browser said about the file is used for any decision. An object that fails is
 * deleted from storage and never becomes a row.
 */

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Refreshes every surface a media change can be visible on. */
function revalidateProductSurfaces(productId: string, slug?: string) {
  revalidatePath(`/admin/products/${productId}`)
  revalidatePath('/admin/products')
  revalidatePath('/admin/media')
  revalidatePath('/shop')
  revalidatePath('/')
  if (slug) revalidatePath(`/product/${slug}`)
}

async function productSlug(productId: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: schema.products.slug })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1)
  return row?.slug ?? null
}

/**
 * Loads a placement and proves it belongs to the product the caller named.
 *
 * Both ids come from the client. Looking the row up by its own id alone would
 * let a caller pass any placement id they liked and mutate another product's
 * gallery, so the product is part of the predicate rather than a display detail.
 */
async function loadPlacement(placementId: string, productId: string) {
  const [row] = await db
    .select({
      id: schema.productMedia.id,
      productId: schema.productMedia.productId,
      mediaId: schema.productMedia.mediaId,
      isPrimary: schema.productMedia.isPrimary,
      sortOrder: schema.productMedia.sortOrder,
      kind: schema.media.kind,
      storageKey: schema.media.storageKey,
      url: schema.media.url,
    })
    .from(schema.productMedia)
    .innerJoin(schema.media, eq(schema.productMedia.mediaId, schema.media.id))
    .where(
      and(
        eq(schema.productMedia.id, placementId),
        eq(schema.productMedia.productId, productId),
      ),
    )
    .limit(1)
  return row ?? null
}

/* -------------------------------------------------------------------------- */
/* Upload finalization                                                         */
/* -------------------------------------------------------------------------- */

const finalizeSchema = z.object({
  productId: z.uuid().optional(),
  url: z.string().trim().min(1).max(4000),
  /**
   * Client-reported video metadata, accepted only as a DISPLAY hint.
   *
   * Reading a duration server-side means parsing an MP4 box tree or shelling out
   * to ffmpeg, neither of which belongs on this path for a number shown in an
   * admin table. It is clamped, never used in a security decision, and never
   * shown to a customer — the worst a lie achieves is a wrong runtime on an
   * internal screen.
   */
  durationSeconds: z.coerce.number().min(0).max(86_400).optional(),
  videoWidth: z.coerce.number().int().min(0).max(100_000).optional(),
  videoHeight: z.coerce.number().int().min(0).max(100_000).optional(),
  altText: z.string().trim().max(255).default(''),
  title: z.string().trim().max(160).optional(),
})

/**
 * Inspects an uploaded object and, if it is genuinely what it must be, records
 * it — attaching it to a product when one was named.
 *
 * Deletes the stored object on every rejection path. An upload that fails
 * validation must not survive as an orphan someone can still link to.
 */
export async function finalizeUploadAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const { user: admin } = await requireAdminIdentity()

  const parsed = parseInput(finalizeSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { productId, url, durationSeconds, videoWidth, videoHeight, altText, title } = parsed.data

  /**
   * The URL must be on our own blob host.
   *
   * Without this the action is an arbitrary-URL fetcher reachable by any
   * administrator — pointed at an internal address it becomes SSRF, and pointed
   * at anything else it would happily record a `media` row referencing storage
   * this application does not control and cannot delete.
   */
  if (!isOwnedBlobUrl(url)) {
    return fail('validation_error', 'That upload did not come from this application.')
  }

  /** Removes the object; used on every rejection below. */
  const discard = async () => {
    try {
      await del(url)
    } catch (error) {
      console.error('[media] could not delete a rejected upload:', error)
    }
  }

  /**
   * A PUBLIC OBJECT NEVER BECOMES A ROW.
   *
   * `access` is chosen by the CLIENT when it uploads, and the token this
   * application issues constrains the pathname, the content types and the size
   * — not that. So an administrator running a modified client could put a
   * world-readable object into the store. This is the check that makes that
   * pointless: the object is deleted and no `media` row is created, so nothing
   * in the catalog can ever reference a public address.
   *
   * It is also the honest failure mode for a misconfigured store. If the Blob
   * store does not support private access, uploads fail HERE, loudly, instead
   * of quietly reverting the storefront to a public CDN.
   */
  if (!isPrivateBlobUrl(url)) {
    try {
      await del(url)
    } catch (error) {
      console.error('[media] could not delete a public upload:', error)
    }
    return fail(
      'validation_error',
      'That upload was stored publicly and has been removed. Product media must be ' +
        'uploaded to the private store — check that BLOB_READ_WRITE_TOKEN points at one.',
    )
  }

  let size: number
  let pathname: string
  try {
    const metadata = await head(url)
    size = metadata.size
    pathname = metadata.pathname
  } catch (error) {
    console.error('[media] head() failed for an upload:', error)
    return fail('not_found', 'That upload could not be read back from storage.')
  }

  /* ---- Identify from bytes, not from claims ---------------------------- */

  let leading: Uint8Array
  try {
    /**
     * READ BACK THROUGH THE STORE CREDENTIAL, NOT OVER THE PUBLIC INTERNET.
     *
     * Uploads are private (`MEDIA_ACCESS`), so a plain `fetch` of the object's
     * URL — which is what this used to do — now returns 403. The SDK's `get`
     * attaches the store token and forwards the range, so only the first few KB
     * travel however large the file is.
     *
     * There is deliberately no anonymous fallback. A private object that cannot
     * be read with the credential is an error to surface, not a reason to try
     * again without one.
     */
    const result = await get(pathname, {
      access: 'private',
      headers: { range: `bytes=0-${SNIFF_BYTES - 1}` },
    })
    if (result === null || result.stream === null) throw new Error('not readable')
    leading = new Uint8Array(await new Response(result.stream).arrayBuffer())
  } catch (error) {
    console.error('[media] could not read uploaded bytes:', error)
    await discard()
    return fail('internal_error', 'That upload could not be verified and was removed.')
  }

  const refused = refusedFormatLabel(leading)
  if (refused) {
    await discard()
    return fail('validation_error', `That file is a ${refused}, which cannot be uploaded.`)
  }

  const sniffed = sniff(leading)
  if (!sniffed) {
    await discard()
    return fail(
      'validation_error',
      'That file is not a supported image or video. Renaming a file does not change what it is.',
    )
  }

  const kind = kindForMimeType(sniffed.mimeType)
  if (!kind) {
    await discard()
    return fail('validation_error', 'That media type is not supported.')
  }

  const ceiling = maxBytesFor(kind)
  if (size > ceiling) {
    await discard()
    return fail(
      'validation_error',
      `That file is ${(size / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${Math.round(ceiling / 1024 / 1024)} MB limit for ${kind}.`,
    )
  }

  /* ---- Per-product ceiling --------------------------------------------- */

  if (productId) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.productMedia)
      .where(eq(schema.productMedia.productId, productId))

    if (count >= MAX_MEDIA_PER_PRODUCT) {
      await discard()
      return fail(
        'conflict',
        `This product already has the maximum of ${MAX_MEDIA_PER_PRODUCT} media items.`,
      )
    }
  }

  /* ---- Record it -------------------------------------------------------- */

  const width = sniffed.width ?? (kind === 'video' ? (videoWidth ?? null) : null)
  const height = sniffed.height ?? (kind === 'video' ? (videoHeight ?? null) : null)

  try {
    await db.transaction(async (tx) => {
      const [asset] = await tx
        .insert(schema.media)
        .values({
          url,
          kind,
          mimeType: sniffed.mimeType,
          altText,
          title: title ?? pathname.split('/').pop() ?? null,
          width: width && width > 0 ? width : null,
          height: height && height > 0 ? height : null,
          bytes: size,
          durationSeconds:
            kind === 'video' && durationSeconds ? durationSeconds.toFixed(3) : null,
          storageKey: pathname,
        })
        .returning({ id: schema.media.id })

      if (!productId) return

      /**
       * The first image on a product becomes its thumbnail, and only then.
       *
       * A product with no thumbnail displays a placeholder, so the first upload
       * choosing itself is strictly an improvement on nothing. Every upload
       * after that leaves the existing choice alone — an operator adding a
       * detail shot in month three has not asked for the pack shot customers
       * recognise to be replaced.
       *
       * Video is never eligible: a card has no controls and no poster.
       */
      const [existingPrimary] = await tx
        .select({ id: schema.productMedia.id })
        .from(schema.productMedia)
        .where(
          and(
            eq(schema.productMedia.productId, productId),
            eq(schema.productMedia.isPrimary, true),
          ),
        )
        .limit(1)

      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(sort_order), -1) + 1` })
        .from(schema.productMedia)
        .where(eq(schema.productMedia.productId, productId))

      await tx.insert(schema.productMedia).values({
        productId,
        mediaId: asset.id,
        sortOrder: next,
        isPrimary: existingPrimary === undefined && canBeThumbnail(kind),
      })
    })
  } catch (error) {
    console.error('[media] could not record an upload:', error)
    await discard()
    return fail('internal_error', 'That upload could not be saved and was removed.')
  }

  await recordAuditEvent({
    event: 'MEDIA_UPLOADED',
    userId: admin.id,
    entityType: 'media',
    entityId: productId ?? null,
    summary: `${sniffed.mimeType} ${(size / 1024).toFixed(0)}KB${
      sniffed.animated ? ' animated' : ''
    }`,
  })

  if (productId) revalidateProductSurfaces(productId, (await productSlug(productId)) ?? undefined)
  else revalidatePath('/admin/media')

  return ok()
}

/* -------------------------------------------------------------------------- */
/* Library attachment                                                          */
/* -------------------------------------------------------------------------- */

const attachSchema = z.object({
  productId: z.uuid(),
  mediaId: z.uuid(),
})

/** Attaches an asset that already exists in the library. */
export async function attachLibraryMediaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(attachSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { productId, mediaId } = parsed.data

  const [asset] = await db
    .select({ id: schema.media.id, kind: schema.media.kind })
    .from(schema.media)
    .where(eq(schema.media.id, mediaId))
    .limit(1)
  if (!asset) return fail('not_found', 'That asset no longer exists.')

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.productMedia)
    .where(eq(schema.productMedia.productId, productId))

  if (count >= MAX_MEDIA_PER_PRODUCT) {
    return fail(
      'conflict',
      `This product already has the maximum of ${MAX_MEDIA_PER_PRODUCT} media items.`,
    )
  }

  const [duplicate] = await db
    .select({ id: schema.productMedia.id })
    .from(schema.productMedia)
    .where(
      and(
        eq(schema.productMedia.productId, productId),
        eq(schema.productMedia.mediaId, mediaId),
      ),
    )
    .limit(1)
  if (duplicate) return fail('conflict', 'That asset is already on this product.')

  await db.transaction(async (tx) => {
    const [existingPrimary] = await tx
      .select({ id: schema.productMedia.id })
      .from(schema.productMedia)
      .where(
        and(
          eq(schema.productMedia.productId, productId),
          eq(schema.productMedia.isPrimary, true),
        ),
      )
      .limit(1)

    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(sort_order), -1) + 1` })
      .from(schema.productMedia)
      .where(eq(schema.productMedia.productId, productId))

    await tx.insert(schema.productMedia).values({
      productId,
      mediaId,
      sortOrder: next,
      isPrimary: existingPrimary === undefined && canBeThumbnail(asset.kind),
    })
  })

  revalidateProductSurfaces(productId, (await productSlug(productId)) ?? undefined)
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Primary selection                                                           */
/* -------------------------------------------------------------------------- */

const placementSchema = z.object({
  productId: z.uuid(),
  placementId: z.uuid(),
})

/**
 * Moves the thumbnail to another asset.
 *
 * Transactional, and it has to be: `product_media_one_primary_per_product` is a
 * partial unique index, so the old primary must be cleared and the new one set
 * as one atomic unit. Setting first would collide with the index; clearing first
 * without a transaction leaves the product with NO thumbnail if the second
 * statement fails.
 */
export async function setPrimaryMediaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(placementSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { productId, placementId } = parsed.data

  const placement = await loadPlacement(placementId, productId)
  if (!placement) return fail('not_found', 'That media item is not on this product.')

  if (!canBeThumbnail(placement.kind)) {
    return fail(
      'conflict',
      'A video cannot be the thumbnail. Product cards have no player — choose an image or a GIF.',
    )
  }

  if (placement.isPrimary) return ok()

  await db.transaction(async (tx) => {
    await tx
      .update(schema.productMedia)
      .set(withUpdatedAt({ isPrimary: false }))
      .where(
        and(
          eq(schema.productMedia.productId, productId),
          eq(schema.productMedia.isPrimary, true),
        ),
      )

    await tx
      .update(schema.productMedia)
      .set(withUpdatedAt({ isPrimary: true }))
      .where(eq(schema.productMedia.id, placementId))
  })

  revalidateProductSurfaces(productId, (await productSlug(productId)) ?? undefined)
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

const moveSchema = placementSchema.extend({
  direction: z.enum(['up', 'down']),
})

/**
 * Moves one item within the gallery.
 *
 * Sort orders are NORMALISED to 0..n-1 first. Everything predating this feature
 * has `sort_order = 0` — the column default — so a bare swap between two rows
 * that both hold 0 is a no-op that looks like a broken button. Rewriting the
 * sequence from the displayed order makes the operation total rather than
 * dependent on whatever happened to be in the column.
 *
 * The primary is pinned to the front by `GALLERY_ORDER` and is excluded from the
 * movable sequence, so ordering describes the rest of the gallery. The admin
 * disables its arrows to match.
 */
export async function moveProductMediaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(moveSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { productId, placementId, direction } = parsed.data

  const placement = await loadPlacement(placementId, productId)
  if (!placement) return fail('not_found', 'That media item is not on this product.')
  if (placement.isPrimary) {
    return fail('conflict', 'The thumbnail always leads the gallery and cannot be moved.')
  }

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.productMedia.id })
      .from(schema.productMedia)
      .where(
        and(
          eq(schema.productMedia.productId, productId),
          eq(schema.productMedia.isPrimary, false),
        ),
      )
      .orderBy(asc(schema.productMedia.sortOrder), asc(schema.productMedia.createdAt))

    const order = rows.map((row) => row.id)
    const index = order.indexOf(placementId)
    if (index === -1) return

    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= order.length) return

    ;[order[index], order[target]] = [order[target], order[index]]

    // Rewrite the whole sequence so the result never depends on prior values.
    for (const [position, id] of order.entries()) {
      await tx
        .update(schema.productMedia)
        .set(withUpdatedAt({ sortOrder: position }))
        .where(eq(schema.productMedia.id, id))
    }
  })

  revalidateProductSurfaces(productId, (await productSlug(productId)) ?? undefined)
  return ok()
}

/**
 * Applies a whole order at once — what drag-and-drop submits.
 *
 * Takes the complete list of non-primary placements in their new order and
 * rejects anything that is not a permutation of what is actually on the product.
 * A partial list would silently renumber some rows and leave others stale.
 */
const reorderSchema = z.object({
  productId: z.uuid(),
  /** Repeated form field, so a no-JS fallback could post it too. */
  placementId: z.union([z.array(z.uuid()), z.uuid()]),
})

export async function reorderProductMediaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(reorderSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { productId } = parsed.data
  const submitted = Array.isArray(parsed.data.placementId)
    ? parsed.data.placementId
    : [parsed.data.placementId]

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.productMedia.id })
      .from(schema.productMedia)
      .where(
        and(
          eq(schema.productMedia.productId, productId),
          eq(schema.productMedia.isPrimary, false),
        ),
      )

    const actual = new Set(rows.map((row) => row.id))
    const unique = new Set(submitted)

    if (unique.size !== submitted.length) return 'duplicate' as const
    if (unique.size !== actual.size) return 'mismatch' as const
    for (const id of unique) if (!actual.has(id)) return 'mismatch' as const

    for (const [position, id] of submitted.entries()) {
      await tx
        .update(schema.productMedia)
        .set(withUpdatedAt({ sortOrder: position }))
        .where(eq(schema.productMedia.id, id))
    }
    return 'ok' as const
  })

  if (result !== 'ok') {
    return fail('conflict', 'The gallery changed while you were reordering it. Reload and retry.')
  }

  revalidateProductSurfaces(productId, (await productSlug(productId)) ?? undefined)
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                    */
/* -------------------------------------------------------------------------- */

const metaSchema = placementSchema.extend({
  altText: z.string().trim().max(255).default(''),
  caption: z.string().trim().max(320).default(''),
})

/**
 * Edits the alt text and caption for one placement.
 *
 * An empty alt is stored as an empty string rather than null, because the two
 * mean different things here: null inherits the asset's description, and ''
 * asserts the image is decorative. Blanking the field is a decision, so it is
 * recorded as one.
 */
export async function updateProductMediaMetaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(metaSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { productId, placementId, altText, caption } = parsed.data

  const placement = await loadPlacement(placementId, productId)
  if (!placement) return fail('not_found', 'That media item is not on this product.')

  await db
    .update(schema.productMedia)
    .set(
      withUpdatedAt({
        altTextOverride: altText,
        caption: caption.length > 0 ? caption : null,
      }),
    )
    .where(eq(schema.productMedia.id, placementId))

  revalidateProductSurfaces(productId, (await productSlug(productId)) ?? undefined)
  return ok()
}

/* -------------------------------------------------------------------------- */
/* Removal                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Removes an asset FROM A PRODUCT. The asset itself is untouched.
 *
 * These are different operations with different blast radii and they are kept
 * apart deliberately — the same photograph may be on three products and a
 * campaign, and taking it off one of them must not reach into the others.
 *
 * If the thumbnail is removed, the next eligible image is promoted inside the
 * same transaction. The alternative is a product that silently falls back to
 * whatever sorts first, which is the same visible outcome with none of the
 * intent recorded.
 */
export async function detachProductMediaAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  await requireAdminIdentity()

  const parsed = parseInput(placementSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { productId, placementId } = parsed.data

  const placement = await loadPlacement(placementId, productId)
  if (!placement) return fail('not_found', 'That media item is not on this product.')

  await db.transaction(async (tx) => {
    await tx.delete(schema.productMedia).where(eq(schema.productMedia.id, placementId))

    if (!placement.isPrimary) return

    const [successor] = await tx
      .select({ id: schema.productMedia.id })
      .from(schema.productMedia)
      .innerJoin(schema.media, eq(schema.productMedia.mediaId, schema.media.id))
      .where(
        and(
          eq(schema.productMedia.productId, productId),
          eq(schema.media.kind, 'image'),
          ne(schema.productMedia.id, placementId),
        ),
      )
      .orderBy(asc(schema.productMedia.sortOrder), asc(schema.productMedia.createdAt))
      .limit(1)

    if (successor) {
      await tx
        .update(schema.productMedia)
        .set(withUpdatedAt({ isPrimary: true }))
        .where(eq(schema.productMedia.id, successor.id))
    }
  })

  revalidateProductSurfaces(productId, (await productSlug(productId)) ?? undefined)
  return ok()
}

/**
 * Destroys the underlying asset and its stored object.
 *
 * REFUSES while anything else references it. The count spans product
 * placements, campaign and collection heroes, brand assets and brand logos —
 * deleting an image out from under a live campaign is not recoverable by
 * undoing anything in this application, because the bytes are gone from storage.
 *
 * The blob is deleted only when we know we own it: rows added by pasting an
 * external URL carry no `storage_key`, and calling `del()` on someone else's
 * CDN URL is at best a no-op and at worst an action against storage that is not
 * ours. Those rows are removed from the database and the object left alone.
 */
export async function deleteMediaAssetAction(
  _previous: ActionResult<void> | null,
  formData: FormData,
): Promise<ActionResult<void>> {
  const { user: admin } = await requireAdminIdentity()

  const parsed = parseInput(placementSchema, formDataToObject(formData))
  if (!parsed.ok) return parsed
  const { productId, placementId } = parsed.data

  const placement = await loadPlacement(placementId, productId)
  if (!placement) return fail('not_found', 'That media item is not on this product.')

  const [{ used }] = await db
    .select({
      used: sql<number>`(
          (select count(*) from ${schema.productMedia} pm
            where pm.media_id = ${placement.mediaId} and pm.id <> ${placementId})
        + (select count(*) from ${schema.campaigns} c where c.hero_media_id = ${placement.mediaId})
        + (select count(*) from ${schema.collections} col where col.hero_media_id = ${placement.mediaId})
        + (select count(*) from ${schema.brandAssets} ba where ba.media_id = ${placement.mediaId})
        + (select count(*) from ${schema.brands} b where b.logo_media_id = ${placement.mediaId})
      )::int`,
    })
    .from(schema.media)
    .where(eq(schema.media.id, placement.mediaId))

  if (used > 0) {
    return fail(
      'conflict',
      `That asset is used in ${used} other place${used === 1 ? '' : 's'}. ` +
        'Remove it from this product instead, or detach it elsewhere first.',
    )
  }

  /**
   * Database first, storage second.
   *
   * Reversed, a failure between the two leaves rows pointing at bytes that no
   * longer exist — broken images on the storefront. This ordering can instead
   * leave an unreferenced object in the bucket, which costs a little storage and
   * is invisible to customers. That is the better failure to have.
   */
  await db.transaction(async (tx) => {
    await tx.delete(schema.productMedia).where(eq(schema.productMedia.id, placementId))
    await tx.delete(schema.media).where(eq(schema.media.id, placement.mediaId))
  })

  if (placement.storageKey && isOwnedBlobUrl(placement.url)) {
    try {
      await del(placement.url)
    } catch (error) {
      console.error('[media] blob deletion failed; the row is already gone:', error)
    }
  }

  await recordAuditEvent({
    event: 'MEDIA_ARCHIVED',
    userId: admin.id,
    entityType: 'media',
    entityId: placement.mediaId,
    summary: 'permanently deleted',
  })

  revalidateProductSurfaces(productId, (await productSlug(productId)) ?? undefined)
  return ok()
}
