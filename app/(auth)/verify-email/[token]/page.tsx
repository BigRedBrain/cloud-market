import type { Metadata } from 'next'
import Link from 'next/link'

import { ConfirmEmailForm } from '@/components/auth/auth-forms'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { StatusPanel } from '@/components/ui/feedback'
import { inspectVerificationToken } from '@/lib/auth/email-actions'

export const metadata: Metadata = {
  title: 'Confirm your email',
  robots: { index: false, follow: false },
}

/**
 * The confirmation link's landing page.
 *
 * THIS GET CHANGES NOTHING. It reads the token, decides what to show, and
 * writes nothing — no consumption, no `email_verified_at`, no audit event
 * implying an account changed.
 *
 * That is not caution for its own sake. A URL in an email is opened by things
 * that are not the customer: corporate mail security following every link,
 * antivirus appliances, link-preview bots, browser prefetchers. If arriving
 * here performed the verification, those systems would confirm addresses on
 * behalf of people who never clicked, and the customer would then find a spent
 * link for an account something else had already "confirmed". Every one of
 * those openers issues a GET; none of them submits a form.
 *
 * So the link renders a button and the button POSTs. The state change lives in
 * `confirmEmailAction`, behind an explicit human action, and it works with
 * JavaScript disabled because it is an ordinary HTML form.
 *
 * DELIBERATELY OUTSIDE /account. The proxy bounces every `/account/*` request
 * arriving without a session cookie, and someone confirming from their phone's
 * mail app usually has no session there. The token is the proof — 256 bits of
 * CSPRNG output, single-use, scoped to one purpose.
 *
 * Response headers for this route are `no-store` and `no-referrer`; see
 * next.config.ts.
 */
export default async function VerifyEmailTokenPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const view = await inspectVerificationToken(token)

  if (view.status === 'already_verified') {
    return (
      <StatusPanel
        tone="success"
        title="Email already confirmed"
        description="Your email address is confirmed. Nothing more is needed."
        action={
          <Link href="/sign-in" className={buttonVariants({ variant: 'primary' })}>
            Sign in
          </Link>
        }
      />
    )
  }

  /**
   * Replaced by a newer link.
   *
   * No action button on purpose. The remedy is an email the customer already
   * has, so pointing them at "request a new link" would cause the very thing
   * that brought them here. Nothing is sent from this page.
   */
  if (view.status === 'superseded') {
    return (
      <StatusPanel
        tone="info"
        title="A newer confirmation link was requested"
        description="This link was replaced when you requested another confirmation email. Use the most recent link in your inbox. You can safely delete the older email."
      />
    )
  }

  if (view.status !== 'ready') {
    return (
      <StatusPanel
        tone="warning"
        title={
          view.status === 'expired'
            ? 'That confirmation link has expired'
            : "That confirmation link isn't valid"
        }
        description={
          view.status === 'expired'
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-3xl tracking-tight text-white uppercase">
          Confirm your email
        </h1>
        <p className="text-sm text-smoke">
          One more step. Confirm below and your address is set — you won&apos;t
          need this link again.
        </p>
      </div>

      <Card className="p-6">
        <ConfirmEmailForm token={view.token} />
      </Card>
    </div>
  )
}
