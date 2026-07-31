import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { buttonVariants } from '@/components/ui/button'
import { StatusPanel } from '@/components/ui/feedback'
import { requireUser } from '@/lib/auth/dal'

export const metadata: Metadata = {
  title: 'Verify your email',
  robots: { index: false, follow: false },
}

/**
 * Email verification gate.
 *
 * `requireVerifiedUser()` redirects here, and ordering will sit behind it from
 * Phase 5 — a licensed retailer should not dispatch age-restricted product to
 * an address it has never confirmed reaches a real person.
 *
 * The send-and-confirm flow is NOT implemented, because no transactional email
 * provider is configured yet. The `verification_tokens` table, its purpose enum,
 * and the single-use `consumed_at` semantics are all in place; what is missing
 * is delivery. See AUTHENTICATION.md — this is a known, deliberate gap rather
 * than an oversight, and it is why sign-up currently marks accounts `active`
 * with `email_verified_at` left null.
 */
export default async function VerifyEmailPage() {
  const user = await requireUser('/account/verify-email')

  // Already verified — nothing to do here.
  if (user.emailVerifiedAt) redirect('/account')

  return (
    <StatusPanel
      tone="info"
      title="Email verification is coming"
      description={`We'll send a confirmation link to ${user.email} before your first order. You can browse and build a bag in the meantime.`}
      action={
        <Link href="/account" className={buttonVariants({ variant: 'primary' })}>
          Back to account
        </Link>
      }
    />
  )
}
