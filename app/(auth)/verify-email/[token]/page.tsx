import type { Metadata } from 'next'
import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'
import { StatusPanel } from '@/components/ui/feedback'
import { verifyEmailToken } from '@/lib/auth/email-actions'

export const metadata: Metadata = {
  title: 'Email confirmation',
  robots: { index: false, follow: false },
}

/**
 * Confirms an email address from the link in the message.
 *
 * THIS ONE DOES CONSUME ON GET, unlike the reset page, and the difference is
 * deliberate. A verification link has no follow-up step to attach the write to
 * — asking someone to click a link and then press a button to confirm that they
 * clicked the link is friction for no gain.
 *
 * The cost is that a link scanner can consume the token before the human does.
 * `verifyEmailToken` handles exactly that: if the token was already consumed
 * and the account is verified, this reports success, because the address really
 * is confirmed. Nothing is re-verified and no token becomes reusable.
 *
 * DELIBERATELY OUTSIDE /account. The proxy bounces every /account/* request
 * that arrives without a session cookie, and someone confirming from their
 * phone's mail app
 * usually has no session there, and forcing a sign-in first would strand them.
 * The token is the proof — it is 256 bits of CSPRNG output, single-use, and
 * scoped to one purpose.
 */
export default async function VerifyEmailTokenPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const outcome = await verifyEmailToken(token)

  if (outcome.status === 'verified' || outcome.status === 'already_verified') {
    return (
      <StatusPanel
        tone="success"
        title="Email confirmed"
        description={
          outcome.status === 'verified'
            ? "Your email address is confirmed. You're all set to order when checkout opens."
            : 'Your email address was already confirmed. Nothing more to do.'
        }
        action={
          <Link href="/account" className={buttonVariants({ variant: 'primary' })}>
            Go to your account
          </Link>
        }
      />
    )
  }

  return (
    <StatusPanel
      tone="warning"
      title={
        outcome.status === 'expired'
          ? 'That confirmation link has expired'
          : "That confirmation link isn't valid"
      }
      description={
        outcome.status === 'expired'
          ? 'Confirmation links work for 24 hours. Sign in and request a new one.'
          : 'Confirmation links can only be used once. Sign in and request a new one.'
      }
      action={
        <Link
          href="/account/verify-email"
          className={buttonVariants({ variant: 'primary' })}
        >
          Request a new link
        </Link>
      }
    />
  )
}
