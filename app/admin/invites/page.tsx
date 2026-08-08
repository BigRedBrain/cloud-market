import type { Metadata } from 'next'

import { CreateInviteForm, InviteTable } from '@/components/admin/invite-manager'
import { Alert } from '@/components/ui/feedback'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdminIdentity } from '@/lib/auth/admin-identity'
import { isInviteSystemConfigured } from '@/lib/invites/codes'
import { listInvites } from '@/lib/invites/queries'

export const metadata: Metadata = {
  title: 'Invites',
  robots: { index: false, follow: false },
}

/**
 * Invite administration — 5% brand intensity (DESIGN.md §9).
 *
 * Available to BOTH administrators. An invite creates a customer account and
 * nothing more, so there is no security reason to reserve it for the owner —
 * see the header of `lib/invites/admin-actions.ts`. The operations that ARE
 * owner-only are the ones that change who can administer the store, and they
 * live behind Security → Admin access.
 */
export default async function AdminInvitesPage() {
  await requireAdminIdentity()

  /**
   * Reported plainly rather than crashing.
   *
   * Without the pepper, `hashInviteCode` throws — so an unconfigured deployment
   * would show an administrator a generic error page with no indication that one
   * environment variable is the cause. The existing invite list is still
   * readable (it holds no code material), so the page renders normally with the
   * problem stated at the top.
   */
  const configured = isInviteSystemConfigured()
  const invites = await listInvites()

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-col gap-2">
        <h1 className="font-display text-3xl tracking-tight text-white uppercase">
          Invites
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-smoke">
          Cloud Market is invite-only. Every account is created by redeeming one
          of these codes, and an invite grants nothing beyond a customer account
          — it can never confer staff or administrative access.
        </p>
      </header>

      {!configured && (
        <div className="mb-8">
          <Alert tone="error" title="Invite codes are not configured">
            <code className="font-mono">INVITE_CODE_PEPPER</code> is not set on
            this deployment, so no new invite can be issued and no existing code
            can be redeemed. Registration is closed until it is configured.
          </Alert>
        </div>
      )}

      <div className="flex flex-col gap-8">
        <CreateInviteForm />

        <Card>
          <CardHeader>
            <CardTitle>All invites</CardTitle>
          </CardHeader>
          <CardContent>
            {/**
              * Only the masked prefix is ever rendered. `listInvites` does not
              * select `code_hash`, and there is no function in this codebase
              * that can reconstruct a usable code from anything stored.
              */}
            <InviteTable invites={invites} />
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
