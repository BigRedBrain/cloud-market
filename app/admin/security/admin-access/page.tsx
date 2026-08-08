import type { Metadata } from 'next'

import { AdminAccessManager } from '@/components/admin/admin-access'
import { Alert } from '@/components/ui/feedback'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getAdminAccessOverview } from '@/lib/admin/backup-admin'

export const metadata: Metadata = {
  title: 'Admin access',
  robots: { index: false, follow: false },
}

/**
 * Owner-only administrative access control.
 *
 * `getAdminAccessOverview()` calls `requireOwner()` internally, so the guard
 * travels with the data rather than sitting in this component where a future
 * refactor could separate them. A backup administrator reaching this URL gets a
 * 403 from that call, not from anything on this page.
 *
 * THERE IS NO OWNERSHIP-TRANSFER CONTROL HERE, and there is none anywhere else
 * either. Ownership is `CLOUDMARKET_OWNER_USER_ID` in the deployment
 * environment; moving it requires access to the hosting account. A web form
 * that could hand over permanent control of the store is a web form worth
 * attacking, and the operation is rare enough that its inconvenience costs
 * nothing.
 */
export default async function AdminAccessPage() {
  const overview = await getAdminAccessOverview()

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-col gap-2">
        <h1 className="font-display text-3xl tracking-tight text-white uppercase">
          Admin access
        </h1>
        <p className="text-sm leading-relaxed text-smoke">
          Cloud Market has at most two administrators: you, permanently, and one
          optional backup. There is no third slot, and the database will not
          permit one.
        </p>
      </header>

      <div className="flex flex-col gap-8">
        <Card>
          <CardHeader>
            <CardTitle>Owner</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid gap-2 font-mono text-sm">
              <div className="flex justify-between gap-4 border-b border-ink-600 py-2">
                <dt className="text-smoke">Account</dt>
                <dd className="text-white">{overview.ownerEmail}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-smoke">Source</dt>
                <dd className="text-white">Server environment</dd>
              </div>
            </dl>

            <p className="text-sm leading-relaxed text-smoke">
              {/**
                * The owner's user id is deliberately NOT rendered. The page is
                * owner-only, so showing it would leak nothing to an outsider —
                * but it would put a permanently-privileged identifier into a
                * screenshot, a support ticket or a shared browser session, and
                * it answers no question the owner actually has.
                */}
              This account cannot be removed, demoted, suspended or replaced
              through the website. Changing it means editing{' '}
              <code className="font-mono text-white">CLOUDMARKET_OWNER_USER_ID</code>{' '}
              in the deployment environment.
            </p>
          </CardContent>
        </Card>

        <AdminAccessManager
          backup={
            overview.backup
              ? {
                  email: overview.backup.email,
                  name: overview.backup.name,
                  assignedAt: overview.backup.assignedAt,
                }
              : null
          }
        />

        <Alert tone="info" title="What a backup administrator cannot do">
          <ul className="ml-4 list-disc text-sm leading-relaxed">
            <li>Appoint, remove or replace another administrator</li>
            <li>Remove, demote or suspend the owner</li>
            <li>Transfer ownership</li>
            <li>Change the owner identity environment variable</li>
            <li>Configure crypto payment providers or their secrets</li>
            <li>Issue a refund</li>
          </ul>
        </Alert>
      </div>
    </main>
  )
}
