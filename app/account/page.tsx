import type { Metadata } from 'next'
import Link from 'next/link'

import { ProfileForm } from '@/components/auth/auth-forms'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { requireUser } from '@/lib/auth/dal'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'

export const metadata: Metadata = {
  title: 'Account',
  robots: { index: false, follow: false },
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // Authoritative check, close to the data — not in the layout.
  const user = await requireUser('/account')

  /** Sign-in lands here by default, so the bag notice has to be shown here too. */
  const bagUpdatedOnSignIn = (await searchParams).bag === 'updated'

  const [details] = await db
    .select({ phone: schema.users.phone, dateOfBirth: schema.users.dateOfBirth })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl tracking-tight text-white uppercase">
          Profile
        </h1>
        <div className="flex items-center gap-2">
          {user.role !== 'customer' && (
            <Badge variant="ember">{user.role}</Badge>
          )}
          {user.emailVerifiedAt ? (
            <Badge variant="volt">Email verified</Badge>
          ) : (
            <Badge variant="smoke">Email unverified</Badge>
          )}
        </div>
      </div>

      {bagUpdatedOnSignIn && (
        <Alert tone="warning" title="Your bag was updated">
          Some items are no longer available and weren&apos;t carried over when
          you signed in.{' '}
          <Link href="/bag" className="underline">
            Check your bag
          </Link>
          .
        </Alert>
      )}

      {!user.emailVerifiedAt && (
        <Alert tone="info" title="Verify your email before ordering">
          You can browse and build a bag now. We&apos;ll ask you to confirm your
          email address before your first order goes out.
        </Alert>
      )}

      <Card className="p-6">
        <ProfileForm
          defaultName={user.name ?? ''}
          defaultPhone={details?.phone ?? ''}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 font-mono text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-smoke">Email</span>
            <span className="text-white">{user.email}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-smoke">Date of birth</span>
            <span className="text-white">{details?.dateOfBirth ?? '—'}</span>
          </div>
          <p className="mt-1 font-sans text-xs text-smoke">
            Date of birth is the legal basis for serving you and cannot be
            changed here. Contact support if it is wrong.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
