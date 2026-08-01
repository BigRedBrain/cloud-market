import type { Metadata } from 'next'
import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'
import { StatusPanel } from '@/components/ui/feedback'

export const metadata: Metadata = {
  title: 'Check your email',
  robots: { index: false, follow: false },
}

/**
 * THE SINGLE OUTCOME OF A RESET REQUEST.
 *
 * Every request lands here: real address, unknown address, suspended account,
 * throttled request. That is the whole anti-enumeration design made visible —
 * there is no second page for this action, so there is no difference for an
 * attacker to observe.
 *
 * The copy says "if an account exists" rather than "we sent you an email",
 * because the vaguer phrasing would be a lie in the cases where nothing was
 * sent. Being explicit about the condition tells the truth, sets the right
 * expectation, and still reveals nothing.
 */
export default function ResetLinkSentPage() {
  return (
    <StatusPanel
      tone="info"
      title="Check your email"
      description="If an account exists for that address, we've sent a link to reset your password. It works for one hour. Check your spam folder if it hasn't arrived in a few minutes."
      action={
        <Link href="/sign-in" className={buttonVariants({ variant: 'primary' })}>
          Back to sign in
        </Link>
      }
    />
  )
}
