import type { Metadata } from 'next'

import { MediaForm, ReplaceMediaForm } from '@/components/admin/cms-forms'
import { MediaLibraryUpload } from '@/components/admin/media-upload'
import { MediaImage } from '@/components/catalog/media-image'
import { formatBytes, formatDuration, isAnimatedFormat } from '@/lib/media/constants'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { requireAdminIdentity } from '@/lib/auth/admin-identity'
import { adminListMedia } from '@/lib/cms/admin-queries'

export const metadata: Metadata = {
  title: 'Media library',
  robots: { index: false, follow: false },
}

/**
 * Media library.
 *
 * Nothing owns a raw image URL — products, campaigns, collections and brand
 * assets all reference a media record, so alt text, dimensions and focal point
 * live once and travel everywhere the asset appears.
 *
 * "Replace" inserts a NEW row and retires the old one rather than mutating the
 * URL in place, so what a campaign showed last month stays resolvable and a bad
 * replacement can be undone.
 */
export default async function AdminMediaPage() {
  await requireAdminIdentity()

  const assets = await adminListMedia()
  const active = assets.filter((asset) => !asset.archivedAt)
  const archived = assets.filter((asset) => asset.archivedAt)

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-2 font-display text-2xl tracking-tight text-white uppercase">
        Media library
      </h1>
      <p className="mb-6 max-w-2xl text-sm text-smoke">
        Every image is a record. Alt text and focal point are stored on the asset,
        so every crop everywhere agrees.
      </p>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Upload</CardTitle>
        </CardHeader>
        <CardContent>
          <MediaLibraryUpload />
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Add by URL</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert tone="info" title="For assets hosted elsewhere">
            An asset added this way points at storage this application does not
            own, so it cannot be optimized or permanently deleted from here.
            Prefer uploading.
          </Alert>
          <MediaForm />
        </CardContent>
      </Card>

      <h2 className="mb-4 font-display text-xl tracking-tight text-white uppercase">
        Active ({active.length})
      </h2>

      <div className="mb-10 grid gap-4 lg:grid-cols-2">
        {active.map((asset) => (
          <Card key={asset.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3 text-base">
                <span>{asset.title ?? 'Untitled'}</span>
                {asset.usageCount > 0 ? (
                  <Badge variant="volt">
                    Used {asset.usageCount}×
                  </Badge>
                ) : (
                  <Badge variant="smoke">Unused</Badge>
                )}
                {/**
                 * An object from the public-store era: still fetchable by anyone
                 * holding its URL, no matter what this application does. Shown
                 * here because the fix is operational — re-upload it and delete
                 * the original — and an operator cannot act on a finding they
                 * cannot see. See MEDIA-PRIVACY.md.
                 */}
                {asset.worldReadable && <Badge variant="ember">Public URL</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="panel-sm relative aspect-4/3 overflow-hidden rounded-md bg-ink-700">
                {asset.kind === 'video' ? (
                  <video
                    /**
                     * `src`, never `url`. The raw storage address is on this DTO
                     * because the "Add by URL" field round-trips it; rendering
                     * from it would put a storage address into the markup of a
                     * page, which is the habit this release removed.
                     */
                    src={asset.src}
                    controls
                    playsInline
                    muted
                    preload="metadata"
                    aria-label={asset.altText || asset.title || 'Video asset'}
                    className="size-full object-contain"
                  />
                ) : (
                  <MediaImage
                    src={asset.src}
                    alt={asset.altText}
                    width={asset.width}
                    height={asset.height}
                    mimeType={asset.mimeType}
                    sizes="320px"
                    className="size-full object-cover"
                  />
                )}

                <span className="absolute top-2 left-2 rounded-sm bg-ink-900/85 px-1.5 py-0.5 font-mono text-[0.5625rem] tracking-wider text-cream uppercase">
                  {asset.kind === 'video'
                    ? `Video · ${formatDuration(asset.durationSeconds)}`
                    : isAnimatedFormat(asset.mimeType)
                      ? 'GIF · animated'
                      : 'Image'}
                  {' · '}
                  {formatBytes(asset.bytes)}
                </span>
              </div>

              <MediaForm asset={asset} />

              <div className="border-t border-ink-600 pt-4">
                <h3 className="mb-2 font-mono text-xs tracking-widest text-smoke uppercase">
                  Replace
                </h3>
                <ReplaceMediaForm assetId={asset.id} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {archived.length > 0 && (
        <>
          <h2 className="mb-4 font-display text-xl tracking-tight text-white uppercase">
            Archived ({archived.length})
          </h2>
          <ul className="flex flex-col gap-2 font-mono text-sm text-smoke">
            {archived.map((asset) => (
              <li key={asset.id} className="panel-sm rounded-md bg-ink-800 p-3">
                {asset.title ?? asset.id.slice(0, 8)}
                {asset.replacedByMediaId && ' · replaced'}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}
