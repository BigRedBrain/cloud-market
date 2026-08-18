import type { Metadata } from 'next'

import { MediaForm, ReplaceMediaForm } from '@/components/admin/cms-forms'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { requireAdmin } from '@/lib/auth/dal'
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
  await requireAdmin()

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

      <Alert tone="info" title="Direct upload arrives with Vercel Blob" className="mb-6">
        For now, add an asset by URL. The record, alt text, focal point, archive
        and replace-lineage all work today; only the upload transport is pending.
      </Alert>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Add asset</CardTitle>
        </CardHeader>
        <CardContent>
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
                  <Badge variant="signal">
                    Used {asset.usageCount}×
                  </Badge>
                ) : (
                  <Badge variant="smoke">Unused</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="panel-sm overflow-hidden rounded-md bg-ink-700">
                {/* eslint-disable-next-line @next/next/no-img-element -- library preview; next/image arrives with Blob uploads */}
                <img
                  src={asset.url}
                  alt={asset.altText}
                  width={320}
                  height={240}
                  loading="lazy"
                  decoding="async"
                  className="aspect-4/3 w-full object-cover"
                  style={{
                    objectPosition: `${Number(asset.focalX) * 100}% ${Number(asset.focalY) * 100}%`,
                  }}
                />
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
