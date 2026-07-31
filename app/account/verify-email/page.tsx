import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ResendVerificationForm } from '@/components/auth/auth-forms'
import { Card } from '@/components/ui/card'
import { requireUser } from '@/lib/auth/dal'

export const metadata: Metadata = {
  title: 'Confirm your email',
  robots: { index: false, follow: false },
}

/**
 * Email verification prompt and resend.
 *
 * Authenticated, and about the caller's own address, so this page can afford to
 * be specific: it names the address, states the expiry, and the throttle tells
 * the user exactly how long to wait. None of that is an enumeration risk — the
 * visitor already proved they hold this account. The vagueness required on
 * `/forgot-password` would be unhelpful here, not safer.
 *
 * Being unverified is NOT a block. `email_verified_at` gates ordering when
 * checkout arrives; it does not gate signing in, browsing, or keeping a bag,
 * and `status` stays `active` so verification is recorded in exactly one place.
 */
export default async function VerifyEmailPage() {
  const user = await requireUser('/account/verify-email')

  // Already verified — nothing to do here.
  if (user.emailVerifiedAt) redirect('/account')

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-3xl tracking-tight text-white uppercase">
          Confirm your email
        </h1>
        <p className="text-sm text-smoke">
          We&apos;ll send a confirmation link to{' '}
          <span className="font-semibold text-white">{user.email}</span>. The link
          works for 24 hours. You can keep browsing and building a bag in the
          meantime — you&apos;ll need a confirmed address before your first order.
        </p>
      </div>

      <Card className="p-6">
        <ResendVerificationForm />
      </Card>

      <p className="text-center text-sm text-smoke">
        <Link
          href="/account"
          className="font-semibold text-white underline underline-offset-4 hover:text-ember"
        >
          Back to your account
        </Link>
      </p>
    </div>
  )
}
