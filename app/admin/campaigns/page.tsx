import type { Metadata } from 'next'

import { CampaignForm, StatusPill } from '@/components/admin/cms-forms'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth/dal'
import { adminListCampaigns, adminListMedia } from '@/lib/cms/admin-queries'

export const metadata: Metadata = {
  title: 'Campaigns',
  robots: { index: false, follow: false },
}

/**
 * Campaign manager — 5% brand intensity.
 *
 * The announcement bar lives here too, as a campaign of type `announcement`.
 * It has the same shape (message, CTA, schedule, priority), and a separate
 * table would have meant a second scheduling implementation to keep in step.
 */
export default async function AdminCampaignsPage() {
  await requireAdmin()

  const [campaigns, media] = await Promise.all([adminListCampaigns(), adminListMedia()])

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-2 font-poster text-2xl tracking-tight text-white uppercase">
        Campaigns
      </h1>
      <p className="mb-6 max-w-2xl text-sm text-smoke">
        Promotions, heroes and the announcement bar. Set a status and a window —
        a scheduled campaign goes live on its own, with no deploy.
      </p>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>New campaign</CardTitle>
        </CardHeader>
        <CardContent>
          <CampaignForm media={media} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {campaigns.map((campaign) => (
          <Card key={campaign.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3">
                <span>{campaign.title}</span>
                <StatusPill status={campaign.status} liveNow={campaign.liveNow} />
                <span className="font-data text-sm font-normal text-smoke">
                  {campaign.type} · /{campaign.slug} · priority {campaign.priority}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CampaignForm campaign={campaign} media={media} />
            </CardContent>
          </Card>
        ))}

        {campaigns.length === 0 && (
          <p className="text-sm text-smoke">
            No campaigns yet. The homepage falls back to its built-in defaults
            until one is published.
          </p>
        )}
      </div>
    </main>
  )
}
