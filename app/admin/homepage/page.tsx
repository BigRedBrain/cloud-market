import type { Metadata } from 'next'

import { HomepageSectionForm, StatusPill } from '@/components/admin/cms-forms'
import { Alert } from '@/components/ui/feedback'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth/dal'
import {
  adminListCampaigns,
  adminListCollections,
  adminListHomepageSections,
} from '@/lib/cms/admin-queries'

export const metadata: Metadata = {
  title: 'Homepage',
  robots: { index: false, follow: false },
}

/**
 * Homepage builder.
 *
 * Each row is one slot on the homepage. Order is `sortOrder`; whether it renders
 * is the publishing window.
 *
 * IMPORTANT: an empty configuration is a valid state. With no live sections the
 * homepage falls back to its built-in defaults, so an unconfigured install still
 * renders exactly what it renders today. Nothing about the *visual* design
 * changes here — only where the content comes from.
 */
export default async function AdminHomepagePage() {
  await requireAdmin()

  const [sections, campaigns, collections] = await Promise.all([
    adminListHomepageSections(),
    adminListCampaigns(),
    adminListCollections(),
  ])

  const liveCount = sections.filter((section) => section.liveNow).length

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-2 font-display text-2xl tracking-tight text-white uppercase">
        Homepage
      </h1>
      <p className="mb-6 max-w-2xl text-sm text-smoke">
        Order and schedule the sections of the homepage. Layout and styling come
        from the design system and are not editable here.
      </p>

      {liveCount === 0 && (
        <Alert tone="info" title="Using built-in defaults" className="mb-6">
          No homepage sections are live, so the homepage renders its default
          layout. Publish a section to take control of it.
        </Alert>
      )}

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Add section</CardTitle>
        </CardHeader>
        <CardContent>
          <HomepageSectionForm campaigns={campaigns} collections={collections} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {sections.map((section) => (
          <Card key={section.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm text-smoke">#{section.sortOrder}</span>
                <span>{section.name}</span>
                <StatusPill status={section.status} liveNow={section.liveNow} />
                <span className="font-mono text-sm font-normal text-smoke">
                  {section.type}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <HomepageSectionForm
                section={section}
                campaigns={campaigns}
                collections={collections}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  )
}
