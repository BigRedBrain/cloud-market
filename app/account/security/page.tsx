import { AccountShell } from '@/components/account/account-shell'
import type { Metadata } from 'next'

import { ChangePasswordForm } from '@/components/auth/auth-forms'
import { SessionList } from '@/components/auth/session-list'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireSession } from '@/lib/auth/dal'
import { listSessions } from '@/lib/auth/session'

export const metadata: Metadata = {
  title: 'Security',
  robots: { index: false, follow: false },
}

export default async function SecurityPage() {
  const session = await requireSession('/account/security')
  const sessions = await listSessions(session.user.id)

  /**
   * Dates are serialised to ISO strings before crossing into the Client
   * Component. Passing Date objects works, but the boundary is a serialisation
   * boundary and being explicit about it avoids surprises when the shape grows.
   */
  const rows = sessions.map((row) => ({
    id: row.id,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    lastUsedAt: row.lastUsedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }))

  return (
    <AccountShell>
      <div className="flex flex-col gap-8">
        <h1 className="font-poster text-3xl tracking-tight text-white uppercase">
          Security
        </h1>

        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
            <CardDescription>
              Changing your password signs out every other device.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where you&apos;re signed in</CardTitle>
            <CardDescription>
              {rows.length === 1
                ? 'This is the only device signed in.'
                : `${rows.length} devices are signed in.`}{' '}
              Sign out anything you don&apos;t recognise.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SessionList sessions={rows} currentSessionId={session.sessionId} />
          </CardContent>
        </Card>
      </div>
    </AccountShell>
  )
}
