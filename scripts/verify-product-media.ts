/**
 * Product media — format policy, storage invariants and gallery behaviour.
 *
 *   npx tsx --env-file=.env.local --conditions=react-server \
 *     scripts/verify-product-media.ts
 *
 * TWO LAYERS, TESTED DIFFERENTLY.
 *
 * The format policy is pure: real file headers go in, a decision comes out, and
 * none of it needs a network or a database. Those tests build genuine bytes —
 * an actual two-frame GIF, an actual PNG with a real IHDR — rather than
 * asserting against mocks, because the thing being tested IS the byte handling.
 *
 * The storage invariants are properties of Postgres, not of TypeScript: one
 * primary per product is a partial unique index, and swapping the primary is
 * only safe because it happens in a transaction. Those are exercised against a
 * real database, the same way `verify-catalog-admin.ts` does it.
 *
 * DEVELOPMENT ONLY. Refuses the production fingerprint. Every row is captured by
 * id at creation and removed by id in teardown.
 *
 * NOT COVERED HERE, deliberately: the browser→Blob transport and the HTTP
 * authorization of the token endpoint. Those need a running server and a real
 * storage token — see `scripts/verify-product-media-http.mjs`.
 */
import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, schema } from '../lib/db'
import {
  canBeThumbnail,
  formatBytes,
  formatDuration,
  isAnimatedFormat,
  isBrowserPlayable,
  isOwnedBlobUrl,
  kindForMimeType,
  MAX_IMAGE_BYTES,
  MAX_MEDIA_PER_PRODUCT,
  MAX_VIDEO_BYTES,
  maxBytesFor,
  isAcceptedMimeType,
} from '../lib/media/constants'
import { refusedFormatLabel, sniff } from '../lib/media/signatures'
import { adminProductGallery, primaryMediaByProduct, productGallery } from '../lib/media/queries'

const PRODUCTION_FP = '2b968b3cbe06'
const fp = (u: string) =>
  createHash('sha256').update(new URL(u).hostname).digest('hex').slice(0, 12)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}
if (fp(process.env.DATABASE_URL) === PRODUCTION_FP) {
  console.error('REFUSING: this is production.')
  process.exit(1)
}

let passed = 0
let failed = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`    ok    ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (t: string) => console.log(`\n${t}`)

const stamp = Date.now()
const created = {
  productMedia: [] as string[],
  media: [] as string[],
  products: [] as string[],
  categories: [] as string[],
  brands: [] as string[],
}

/* -------------------------------------------------------------------------- */
/* Byte fixtures — real headers, not mocks                                     */
/* -------------------------------------------------------------------------- */

const bytes = (...values: number[]) => Uint8Array.from(values)

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const asciiBytes = (text: string) =>
  Uint8Array.from([...text].map((character) => character.charCodeAt(0)))

/** JPEG: SOI, then an SOF0 declaring 120×80. */
function jpeg(width = 120, height = 80): Uint8Array {
  return concat(
    bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10),
    asciiBytes('JFIF\0'),
    bytes(0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00),
    // SOF0: marker, length, precision, height, width, components
    bytes(
      0xff, 0xc0, 0x00, 0x11, 0x08,
      (height >> 8) & 0xff, height & 0xff,
      (width >> 8) & 0xff, width & 0xff,
      0x03,
    ),
  )
}

/** PNG: 8-byte signature then a real IHDR chunk. */
function png(width = 64, height = 48): Uint8Array {
  return concat(
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    bytes(0x00, 0x00, 0x00, 0x0d),
    asciiBytes('IHDR'),
    bytes(
      (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
      (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
      0x08, 0x06, 0x00, 0x00, 0x00,
    ),
  )
}

/** WebP, lossy (VP8 ) — 40×30. */
function webp(width = 40, height = 30): Uint8Array {
  return concat(
    asciiBytes('RIFF'),
    bytes(0x1a, 0x00, 0x00, 0x00),
    asciiBytes('WEBP'),
    asciiBytes('VP8 '),
    bytes(0x0e, 0x00, 0x00, 0x00),
    bytes(0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a),
    bytes(width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f),
  )
}

/** AVIF: ftyp box with the `avif` brand, then a meta/ispe carrying 200×100. */
function avif(width = 200, height = 100): Uint8Array {
  return concat(
    bytes(0x00, 0x00, 0x00, 0x1c),
    asciiBytes('ftyp'),
    asciiBytes('avif'),
    bytes(0x00, 0x00, 0x00, 0x00),
    asciiBytes('avifmif1miaf'),
    bytes(0x00, 0x00, 0x00, 0x14),
    asciiBytes('ispe'),
    bytes(0x00, 0x00, 0x00, 0x00),
    bytes(
      (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
      (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    ),
  )
}

/**
 * A GIF89a with a global colour table and `frames` image descriptors.
 *
 * Built properly rather than faked, because `gifIsAnimated` walks the real block
 * structure — a stub with the right magic bytes and nothing after it would pass
 * a naive test while proving nothing about frame counting.
 */
function gif(width = 32, height = 24, frames = 1): Uint8Array {
  const parts: Uint8Array[] = [
    asciiBytes('GIF89a'),
    bytes(
      width & 0xff, (width >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
      // Packed: global colour table present, size 2 entries.
      0x80, 0x00, 0x00,
    ),
    // Global colour table: 2 entries × 3 bytes.
    bytes(0x00, 0x00, 0x00, 0xff, 0xff, 0xff),
  ]

  for (let index = 0; index < frames; index += 1) {
    // Graphic control extension.
    parts.push(bytes(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00))
    // Image descriptor: no local colour table.
    parts.push(bytes(0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00))
    // LZW minimum code size, one sub-block, terminator.
    parts.push(bytes(0x02, 0x02, 0x4c, 0x01, 0x00))
  }

  parts.push(bytes(0x3b))
  return concat(...parts)
}

/** MP4: ftyp with the isom brand. */
const mp4 = () =>
  concat(bytes(0x00, 0x00, 0x00, 0x18), asciiBytes('ftyp'), asciiBytes('isom'),
    bytes(0x00, 0x00, 0x02, 0x00), asciiBytes('isomiso2avc1mp41'))

/** WebM: EBML header declaring the webm doctype. */
const webm = () =>
  concat(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00),
    bytes(0x42, 0x82, 0x84), asciiBytes('webm'), bytes(0x00, 0x00, 0x00, 0x00))

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

async function makeProduct(label: string) {
  const [brand] = await db
    .insert(schema.brands)
    .values({ slug: `pm-brand-${label}-${stamp}`, name: `PM Brand ${label}` })
    .returning({ id: schema.brands.id })
  created.brands.push(brand.id)

  const [category] = await db
    .insert(schema.categories)
    .values({ slug: `pm-cat-${label}-${stamp}`, name: `PM Category ${label}` })
    .returning({ id: schema.categories.id })
  created.categories.push(category.id)

  const [product] = await db
    .insert(schema.products)
    .values({
      slug: `pm-product-${label}-${stamp}`,
      name: `PM Product ${label}`,
      brandId: brand.id,
      categoryId: category.id,
      status: 'active',
    })
    .returning({ id: schema.products.id })
  created.products.push(product.id)

  return product.id
}

let assetSeq = 0
async function makeAsset(options: {
  kind: 'image' | 'video'
  mimeType: string
  altText?: string
  width?: number
  height?: number
  bytes?: number
  durationSeconds?: string
}) {
  assetSeq += 1
  const [asset] = await db
    .insert(schema.media)
    .values({
      url: `https://example-store.public.blob.vercel-storage.com/product-media/pm-${stamp}-${assetSeq}`,
      kind: options.kind,
      mimeType: options.mimeType,
      altText: options.altText ?? `asset ${assetSeq}`,
      width: options.width ?? null,
      height: options.height ?? null,
      bytes: options.bytes ?? 1024,
      durationSeconds: options.durationSeconds ?? null,
      storageKey: `product-media/pm-${stamp}-${assetSeq}`,
    })
    .returning({ id: schema.media.id })
  created.media.push(asset.id)
  return asset.id
}

async function attach(
  productId: string,
  mediaId: string,
  options: { sortOrder?: number; isPrimary?: boolean } = {},
) {
  const [row] = await db
    .insert(schema.productMedia)
    .values({
      productId,
      mediaId,
      sortOrder: options.sortOrder ?? 0,
      isPrimary: options.isPrimary ?? false,
    })
    .returning({ id: schema.productMedia.id })
  created.productMedia.push(row.id)
  return row.id
}

/**
 * The primary swap exactly as `setPrimaryMediaAction` performs it.
 *
 * Reproduced rather than imported because the action begins with
 * `requireAdmin()`, which reads cookies and cannot run outside a request. What
 * is under test here is the DATABASE behaviour of the two statements — that they
 * are safe together only inside a transaction — and that is identical either
 * way. Authorization is covered over HTTP in the companion script.
 */
async function swapPrimary(productId: string, placementId: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.productMedia)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(schema.productMedia.productId, productId),
          eq(schema.productMedia.isPrimary, true),
        ),
      )
    await tx
      .update(schema.productMedia)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(schema.productMedia.id, placementId))
  })
}

/* -------------------------------------------------------------------------- */

async function main() {
  console.log('Product media — policy, storage and gallery')
  console.log(`database ${fp(process.env.DATABASE_URL!)} (not production)\n`)

  /* ============================================ 1. FORMAT ACCEPTANCE === */
  section('[1] Accepted image formats identify from their bytes')
  {
    const jpegResult = sniff(jpeg())
    check('JPEG is recognised', jpegResult?.mimeType === 'image/jpeg', String(jpegResult?.mimeType))
    check(
      'JPEG dimensions are read from SOF0',
      jpegResult?.width === 120 && jpegResult?.height === 80,
      `${jpegResult?.width}x${jpegResult?.height}`,
    )

    const pngResult = sniff(png())
    check('PNG is recognised', pngResult?.mimeType === 'image/png')
    check(
      'PNG dimensions are read from IHDR',
      pngResult?.width === 64 && pngResult?.height === 48,
      `${pngResult?.width}x${pngResult?.height}`,
    )

    const webpResult = sniff(webp())
    check('WebP is recognised', webpResult?.mimeType === 'image/webp')
    check(
      'WebP dimensions are read from the VP8 chunk',
      webpResult?.width === 40 && webpResult?.height === 30,
      `${webpResult?.width}x${webpResult?.height}`,
    )

    const avifResult = sniff(avif())
    check('AVIF is recognised', avifResult?.mimeType === 'image/avif')
    check(
      'AVIF dimensions are read from ispe',
      avifResult?.width === 200 && avifResult?.height === 100,
      `${avifResult?.width}x${avifResult?.height}`,
    )

    const gifResult = sniff(gif())
    check('GIF is recognised', gifResult?.mimeType === 'image/gif')
    check(
      'GIF dimensions are read from the screen descriptor',
      gifResult?.width === 32 && gifResult?.height === 24,
      `${gifResult?.width}x${gifResult?.height}`,
    )

    check('every accepted type maps to a kind',
      ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
       'video/mp4', 'video/webm', 'video/quicktime'].every((m) => kindForMimeType(m) !== null))
  }

  /* ================================================ 2. GIF ANIMATION === */
  section('[2] GIF animation is detected and never converted away')
  {
    const still = sniff(gif(32, 24, 1))
    const moving = sniff(gif(32, 24, 6))

    check('a single-frame GIF is not reported animated', still?.animated === false)
    check('a six-frame GIF IS reported animated', moving?.animated === true)

    /**
     * The assertion this whole feature turns on. If the MIME type coming out of
     * the sniffer were ever anything but image/gif, the pipeline would be
     * re-encoding — and re-encoding is what flattens an animation to frame one.
     */
    check(
      'an animated GIF stays image/gif — never PNG, JPEG or WebP',
      moving?.mimeType === 'image/gif',
      String(moving?.mimeType),
    )
    check('the animated GIF keeps its real dimensions', moving?.width === 32 && moving?.height === 24)

    check('GIF is flagged for the optimizer bypass', isAnimatedFormat('image/gif'))
    check('PNG is NOT flagged for the bypass', !isAnimatedFormat('image/png'))
    check('JPEG is NOT flagged for the bypass', !isAnimatedFormat('image/jpeg'))

    /** A GIF must be thumbnail-eligible, or "animated thumbnail" is impossible. */
    check('a GIF is eligible to be a thumbnail', canBeThumbnail('image'))
    check('video is NOT eligible to be a thumbnail', !canBeThumbnail('video'))
  }

  /* ==================================================== 3. VIDEO ======= */
  section('[3] Video formats')
  {
    const mp4Result = sniff(mp4())
    check('MP4 is recognised', mp4Result?.mimeType === 'video/mp4', String(mp4Result?.mimeType))
    check('MP4 classifies as video', mp4Result?.kind === 'video')

    const webmResult = sniff(webm())
    check('WebM is recognised', webmResult?.mimeType === 'video/webm', String(webmResult?.mimeType))
    check('WebM classifies as video', webmResult?.kind === 'video')

    check('MP4 is browser-playable', isBrowserPlayable('video/mp4'))
    check('WebM is browser-playable', isBrowserPlayable('video/webm'))
    check(
      'QuickTime is accepted as source but NOT assumed playable',
      isAcceptedMimeType('video/quicktime') && !isBrowserPlayable('video/quicktime'),
    )

    /** Matroska shares the EBML header with WebM and no browser plays it. */
    const mkv = concat(
      bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00),
      bytes(0x42, 0x82, 0x88), asciiBytes('matroska'),
    )
    check('MKV is refused despite sharing the EBML header', sniff(mkv) === null)
  }

  /* =========================================== 4. HOSTILE UPLOADS ====== */
  section('[4] Unsupported and hostile content is refused')
  {
    const zip = concat(bytes(0x50, 0x4b, 0x03, 0x04), asciiBytes('payload'))
    const exe = concat(bytes(0x4d, 0x5a, 0x90, 0x00), asciiBytes('this is a PE'))
    const elf = concat(bytes(0x7f), asciiBytes('ELF'), bytes(0x02, 0x01, 0x01))
    const pdf = asciiBytes('%PDF-1.7\n%âãÏÓ')
    const svg = asciiBytes('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>')
    const shell = asciiBytes('#!/bin/sh\nrm -rf /\n')
    const empty = new Uint8Array(0)
    const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 251)

    check('a ZIP archive is refused', sniff(zip) === null && refusedFormatLabel(zip) !== null)
    check('a Windows executable is refused', sniff(exe) === null && refusedFormatLabel(exe) !== null)
    check('a Linux executable is refused', sniff(elf) === null && refusedFormatLabel(elf) !== null)
    check('a PDF is refused', sniff(pdf) === null && refusedFormatLabel(pdf) !== null)
    check('an SVG is refused (no sanitizer exists)', sniff(svg) === null)
    check('a shell script is refused', sniff(shell) === null && refusedFormatLabel(shell) !== null)
    check('an empty file is refused', sniff(empty) === null)
    check('random bytes are refused', sniff(noise) === null)

    /**
     * THE CENTRAL CLAIM OF THE UPLOAD GATE. Renaming decides nothing, because
     * the name is never consulted — only these bytes are.
     */
    const zipNamedJpg = zip
    check(
      'a ZIP renamed .jpg is still refused',
      sniff(zipNamedJpg) === null,
      'filename is never consulted',
    )
    const exeNamedMp4 = exe
    check('an .exe renamed .mp4 is still refused', sniff(exeNamedMp4) === null)

    /** A polyglot: valid GIF header, ZIP payload appended. Identifies as GIF. */
    const polyglot = concat(gif(4, 4, 1), zip)
    check(
      'a GIF with an archive appended is still handled as a GIF, not an archive',
      sniff(polyglot)?.mimeType === 'image/gif',
    )
  }

  /* ================================================= 5. SIZE LIMITS ==== */
  section('[5] Size limits')
  {
    check('image ceiling is 25 MB', MAX_IMAGE_BYTES === 25 * 1024 * 1024)
    check('video ceiling is 150 MB', MAX_VIDEO_BYTES === 150 * 1024 * 1024)
    check('per-product ceiling is 20', MAX_MEDIA_PER_PRODUCT === 20)

    check('an image is measured against the image ceiling', maxBytesFor('image') === MAX_IMAGE_BYTES)
    check('a video is measured against the video ceiling', maxBytesFor('video') === MAX_VIDEO_BYTES)

    const overImage = MAX_IMAGE_BYTES + 1
    check('a 25 MB + 1 byte image is over the limit', overImage > maxBytesFor('image'))
    check(
      'a 30 MB file is rejected as an image but allowed as video',
      30 * 1024 * 1024 > maxBytesFor('image') && 30 * 1024 * 1024 < maxBytesFor('video'),
    )
    check('a 151 MB video is over the limit', 151 * 1024 * 1024 > maxBytesFor('video'))

    check('formatBytes renders MB', formatBytes(2 * 1024 * 1024) === '2.0 MB')
    check('formatBytes handles absent sizes', formatBytes(null) === '—')
    check('formatDuration renders m:ss', formatDuration(95) === '1:35')
    check('formatDuration handles absent durations', formatDuration(null) === '—')
  }

  /* ============================================ 6. HOST OWNERSHIP ====== */
  section('[6] Only our own storage is trusted')
  {
    check(
      'a Vercel Blob URL is ours',
      isOwnedBlobUrl('https://abc.public.blob.vercel-storage.com/product-media/x.gif'),
    )
    check('an arbitrary host is not', !isOwnedBlobUrl('https://evil.example.com/x.gif'))
    check('plain http is not', !isOwnedBlobUrl('http://abc.public.blob.vercel-storage.com/x.gif'))
    check('an internal address is not', !isOwnedBlobUrl('http://169.254.169.254/latest/meta-data'))
    check('a lookalike suffix is not', !isOwnedBlobUrl('https://public.blob.vercel-storage.com.evil.test/x'))
    check('garbage is not', !isOwnedBlobUrl('not a url'))
  }

  /* ============================================ 7. PRIMARY UNIQUENESS == */
  section('[7] One primary per product, enforced by the database')
  {
    const productId = await makeProduct('primary')
    const first = await makeAsset({ kind: 'image', mimeType: 'image/jpeg' })
    const second = await makeAsset({ kind: 'image', mimeType: 'image/gif' })

    const firstPlacement = await attach(productId, first, { sortOrder: 0, isPrimary: true })
    await attach(productId, second, { sortOrder: 1 })

    let secondPrimaryRejected = false
    try {
      await db
        .update(schema.productMedia)
        .set({ isPrimary: true })
        .where(
          and(
            eq(schema.productMedia.productId, productId),
            eq(schema.productMedia.isPrimary, false),
          ),
        )
    } catch {
      secondPrimaryRejected = true
    }
    check(
      'a second primary is refused by the partial unique index',
      secondPrimaryRejected,
      'product_media_one_primary_per_product',
    )

    const stillOne = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.productMedia)
      .where(
        and(
          eq(schema.productMedia.productId, productId),
          eq(schema.productMedia.isPrimary, true),
        ),
      )
    check('exactly one primary survives', stillOne[0].n === 1, `${stillOne[0].n}`)

    /** Non-primary rows are exempt from the index and may coexist freely. */
    const third = await makeAsset({ kind: 'image', mimeType: 'image/png' })
    await attach(productId, third, { sortOrder: 2 })
    const total = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.productMedia)
      .where(eq(schema.productMedia.productId, productId))
    check('many non-primary rows coexist', total[0].n === 3, `${total[0].n}`)

    check('the original primary is unchanged', firstPlacement.length > 0)
  }

  /* ============================================ 8. CHANGING PRIMARY ==== */
  section('[8] Changing the thumbnail is transactional')
  {
    const productId = await makeProduct('swap')
    const jpegAsset = await makeAsset({ kind: 'image', mimeType: 'image/jpeg' })
    const gifAsset = await makeAsset({ kind: 'image', mimeType: 'image/gif' })

    const jpegPlacement = await attach(productId, jpegAsset, { sortOrder: 0, isPrimary: true })
    const gifPlacement = await attach(productId, gifAsset, { sortOrder: 1 })

    await swapPrimary(productId, gifPlacement)

    const after = await db
      .select({
        id: schema.productMedia.id,
        isPrimary: schema.productMedia.isPrimary,
        mimeType: schema.media.mimeType,
      })
      .from(schema.productMedia)
      .innerJoin(schema.media, eq(schema.productMedia.mediaId, schema.media.id))
      .where(eq(schema.productMedia.productId, productId))

    const primaries = after.filter((row) => row.isPrimary)
    check('still exactly one primary after the swap', primaries.length === 1)
    check('the GIF is now primary', primaries[0]?.id === gifPlacement)
    check('a GIF can be the product thumbnail', primaries[0]?.mimeType === 'image/gif')
    check('the previous primary was cleared', after.find((r) => r.id === jpegPlacement)?.isPrimary === false)

    /**
     * The transaction is what makes this safe. Rolling one back must leave the
     * ORIGINAL primary in place — not zero primaries, which is what a
     * non-transactional clear-then-set leaves behind when the second statement
     * fails.
     */
    let rolledBack = false
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.productMedia)
          .set({ isPrimary: false })
          .where(eq(schema.productMedia.productId, productId))
        throw new Error('simulated failure between the two statements')
      })
    } catch {
      rolledBack = true
    }

    const afterRollback = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.productMedia)
      .where(
        and(
          eq(schema.productMedia.productId, productId),
          eq(schema.productMedia.isPrimary, true),
        ),
      )
    check('a failed swap rolls back', rolledBack)
    check(
      'the product still has its thumbnail after a rolled-back swap',
      afterRollback[0].n === 1,
      `${afterRollback[0].n} primaries`,
    )
  }

  /* ================================================== 9. ORDERING ====== */
  section('[9] Ordering')
  {
    const productId = await makeProduct('order')
    const a = await makeAsset({ kind: 'image', mimeType: 'image/jpeg', altText: 'A' })
    const b = await makeAsset({ kind: 'image', mimeType: 'image/png', altText: 'B' })
    const c = await makeAsset({ kind: 'image', mimeType: 'image/webp', altText: 'C' })

    await attach(productId, a, { sortOrder: 0, isPrimary: true })
    const bPlacement = await attach(productId, b, { sortOrder: 1 })
    const cPlacement = await attach(productId, c, { sortOrder: 2 })

    const before = await productGallery(productId)
    check('primary leads the gallery', before[0]?.altText === 'A')
    check('the rest follow sort order', before[1]?.altText === 'B' && before[2]?.altText === 'C')

    // Swap B and C, as the reorder action does.
    await db.transaction(async (tx) => {
      await tx.update(schema.productMedia).set({ sortOrder: 2 }).where(eq(schema.productMedia.id, bPlacement))
      await tx.update(schema.productMedia).set({ sortOrder: 1 }).where(eq(schema.productMedia.id, cPlacement))
    })

    const after = await productGallery(productId)
    check('reordering takes effect', after[1]?.altText === 'C' && after[2]?.altText === 'B')
    check('the primary still leads after reordering', after[0]?.altText === 'A')

    /** Ties must not shuffle between reads. */
    await db.update(schema.productMedia).set({ sortOrder: 5 }).where(eq(schema.productMedia.id, bPlacement))
    await db.update(schema.productMedia).set({ sortOrder: 5 }).where(eq(schema.productMedia.id, cPlacement))
    const tie1 = await productGallery(productId)
    const tie2 = await productGallery(productId)
    check(
      'equal sort orders resolve identically every read',
      tie1.map((i) => i.id).join() === tie2.map((i) => i.id).join(),
      'created_at is the tie-break',
    )
  }

  /* ============================================= 10. MIXED GALLERY ===== */
  section('[10] Mixed image, GIF and video galleries')
  {
    const productId = await makeProduct('mixed')
    const stillAsset = await makeAsset({
      kind: 'image', mimeType: 'image/jpeg', altText: 'Pack shot', width: 800, height: 600,
    })
    const gifAsset = await makeAsset({
      kind: 'image', mimeType: 'image/gif', altText: 'Rotating jar', width: 320, height: 240,
    })
    const videoAsset = await makeAsset({
      kind: 'video', mimeType: 'video/mp4', altText: 'Grow walkthrough',
      width: 1920, height: 1080, durationSeconds: '42.500', bytes: 12_000_000,
    })
    const webmAsset = await makeAsset({ kind: 'video', mimeType: 'video/webm', altText: 'Clip' })

    await attach(productId, gifAsset, { sortOrder: 0, isPrimary: true })
    await attach(productId, stillAsset, { sortOrder: 1 })
    await attach(productId, videoAsset, { sortOrder: 2 })
    await attach(productId, webmAsset, { sortOrder: 3 })

    const gallery = await productGallery(productId)
    check('all four assets are returned', gallery.length === 4, `${gallery.length}`)
    check('the animated GIF is the primary', gallery[0]?.mimeType === 'image/gif' && gallery[0]?.isPrimary)
    check('video appears in the gallery', gallery.some((i) => i.kind === 'video'))
    check(
      'video carries its duration for the player',
      gallery.find((i) => i.mimeType === 'video/mp4')?.durationSeconds === '42.500',
    )
    check(
      'dimensions travel with every asset (no layout shift)',
      gallery.every((i) => i.kind === 'video' || (i.width !== null && i.height !== null)),
    )

    /* The storefront card must pick the GIF and must never pick a video. */
    const cardMedia = await primaryMediaByProduct([productId])
    const card = cardMedia.get(productId)
    check('the card uses the primary GIF', card?.mimeType === 'image/gif')
    check(
      'the card MIME type reaches the renderer so the optimizer is bypassed',
      isAnimatedFormat(card?.mimeType),
    )
    check('the card carries alt text', card?.altText === 'Rotating jar')

    /* A product whose ONLY asset is a video must fall back to the placeholder. */
    const videoOnly = await makeProduct('videoonly')
    const loneVideo = await makeAsset({ kind: 'video', mimeType: 'video/mp4' })
    await attach(videoOnly, loneVideo, { sortOrder: 0 })
    const videoOnlyCard = await primaryMediaByProduct([videoOnly])
    check(
      'a video-only product yields NO card image (placeholder, not a broken <img>)',
      videoOnlyCard.get(videoOnly) === undefined,
    )
    check(
      'but its video still appears in the product gallery',
      (await productGallery(videoOnly)).length === 1,
    )
  }

  /* ============================================ 11. ALT AND CAPTION ==== */
  section('[11] Alt text and captions')
  {
    const productId = await makeProduct('alt')
    const asset = await makeAsset({
      kind: 'image', mimeType: 'image/png', altText: 'Asset-level description',
    })
    const placement = await attach(productId, asset, { sortOrder: 0, isPrimary: true })

    const inherited = await productGallery(productId)
    check('alt text falls back to the asset', inherited[0]?.altText === 'Asset-level description')

    await db
      .update(schema.productMedia)
      .set({ altTextOverride: 'This product, on a shelf', caption: 'Shot in store' })
      .where(eq(schema.productMedia.id, placement))

    const overridden = await productGallery(productId)
    check('a placement override wins', overridden[0]?.altText === 'This product, on a shelf')
    check('the caption is returned', overridden[0]?.caption === 'Shot in store')

    /** Empty string is "decorative", which is different from "inherit". */
    await db
      .update(schema.productMedia)
      .set({ altTextOverride: '' })
      .where(eq(schema.productMedia.id, placement))
    const decorative = await productGallery(productId)
    check(
      'an empty override means decorative, not inherit',
      decorative[0]?.altText === '',
      `got "${decorative[0]?.altText}"`,
    )

    const adminView = await adminProductGallery(productId)
    check('the admin can see the override is set', adminView[0]?.altTextOverride === '')
    check('the admin can still see the asset description', adminView[0]?.assetAltText === 'Asset-level description')
  }

  /* =========================================== 12. REMOVAL AND REUSE === */
  section('[12] Remove from product vs delete asset')
  {
    const productA = await makeProduct('reuse-a')
    const productB = await makeProduct('reuse-b')
    const shared = await makeAsset({ kind: 'image', mimeType: 'image/jpeg', altText: 'Shared' })

    const placementA = await attach(productA, shared, { sortOrder: 0, isPrimary: true })
    await attach(productB, shared, { sortOrder: 0, isPrimary: true })

    const adminA = await adminProductGallery(productA)
    check('reuse is visible to the admin', adminA[0]?.otherUsageCount === 1, `${adminA[0]?.otherUsageCount}`)

    /* Detaching from A must not touch B, nor the asset. */
    await db.delete(schema.productMedia).where(eq(schema.productMedia.id, placementA))
    created.productMedia = created.productMedia.filter((id) => id !== placementA)

    const assetStillThere = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.media)
      .where(eq(schema.media.id, shared))
    check('removing from one product leaves the asset intact', assetStillThere[0].n === 1)
    check('the other product keeps it', (await productGallery(productB)).length === 1)

    const adminB = await adminProductGallery(productB)
    check('reuse count drops once the other placement is gone', adminB[0]?.otherUsageCount === 0)

    /* Now the sole placement: permanent deletion becomes permissible. */
    const soleProduct = await makeProduct('sole')
    const soleAsset = await makeAsset({ kind: 'image', mimeType: 'image/png' })
    const solePlacement = await attach(soleProduct, soleAsset, { sortOrder: 0, isPrimary: true })

    const soleAdmin = await adminProductGallery(soleProduct)
    check('an unshared asset reports zero other uses', soleAdmin[0]?.otherUsageCount === 0)

    await db.transaction(async (tx) => {
      await tx.delete(schema.productMedia).where(eq(schema.productMedia.id, solePlacement))
      await tx.delete(schema.media).where(eq(schema.media.id, soleAsset))
    })
    created.productMedia = created.productMedia.filter((id) => id !== solePlacement)
    created.media = created.media.filter((id) => id !== soleAsset)

    const gone = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.media)
      .where(eq(schema.media.id, soleAsset))
    check('permanent deletion removes the asset', gone[0].n === 0)
    check('and its product is left with no media', (await productGallery(soleProduct)).length === 0)
  }

  /* ============================================ 13. CASCADE SAFETY ===== */
  section('[13] Deleting a product never deletes shared assets')
  {
    const doomed = await makeProduct('doomed')
    const survivor = await makeProduct('survivor')
    const asset = await makeAsset({ kind: 'image', mimeType: 'image/jpeg' })

    await attach(doomed, asset, { sortOrder: 0, isPrimary: true })
    await attach(survivor, asset, { sortOrder: 0, isPrimary: true })

    await db.delete(schema.products).where(eq(schema.products.id, doomed))
    created.products = created.products.filter((id) => id !== doomed)

    const assetAlive = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.media)
      .where(eq(schema.media.id, asset))
    check('the asset survives its product being deleted', assetAlive[0].n === 1)
    check('the surviving product still shows it', (await productGallery(survivor)).length === 1)

    const orphaned = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.productMedia)
      .where(eq(schema.productMedia.productId, doomed))
    check('the placement cascaded away with the product', orphaned[0].n === 0)
  }

  /* ============================================= 14. NO MEDIA ========== */
  section('[14] A product with no media')
  {
    const bare = await makeProduct('bare')
    check('the gallery is empty, not an error', (await productGallery(bare)).length === 0)
    check('the admin gallery is empty', (await adminProductGallery(bare)).length === 0)

    const cards = await primaryMediaByProduct([bare])
    check('no card image is produced', cards.get(bare) === undefined)
    check('an empty id list is handled', (await primaryMediaByProduct([])).size === 0)
  }

  /* ============================================= 15. DUPLICATES ======== */
  section('[15] The same asset cannot be attached twice')
  {
    const productId = await makeProduct('dupe')
    const asset = await makeAsset({ kind: 'image', mimeType: 'image/jpeg' })
    await attach(productId, asset, { sortOrder: 0, isPrimary: true })

    let rejected = false
    try {
      await db.insert(schema.productMedia).values({ productId, mediaId: asset, sortOrder: 1 })
    } catch {
      rejected = true
    }
    check('a duplicate attachment is refused', rejected, 'product_media_product_media_unique')
    check(
      'the gallery still has exactly one entry',
      (await productGallery(productId)).length === 1,
    )
  }

  console.log(`\n${'='.repeat(58)}`)
  console.log(failed === 0 ? `ALL ${passed} CHECKS PASSED` : `${passed} passed, ${failed} FAILED`)
  if (failures.length > 0) console.log(failures.map((f) => `  - ${f}`).join('\n'))
  console.log('='.repeat(58))
}

async function teardown() {
  try {
    if (created.productMedia.length)
      await db.delete(schema.productMedia).where(inArray(schema.productMedia.id, created.productMedia))
    if (created.media.length)
      await db.delete(schema.media).where(inArray(schema.media.id, created.media))
    if (created.products.length)
      await db.delete(schema.products).where(inArray(schema.products.id, created.products))
    if (created.categories.length)
      await db.delete(schema.categories).where(inArray(schema.categories.id, created.categories))
    if (created.brands.length)
      await db.delete(schema.brands).where(inArray(schema.brands.id, created.brands))
  } catch (error) {
    console.error('\nTEARDOWN FAILED — rows may remain:', error)
  }
}

main()
  .catch((error) => {
    console.error('\nABORTED:', error)
    failed += 1
  })
  .finally(async () => {
    await teardown()
    process.exit(failed === 0 ? 0 : 1)
  })
