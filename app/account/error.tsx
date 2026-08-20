'use client'

import Link from 'next/link'

import { Button, buttonVariants } from '@/components/ui/button'
import { Alert } from '@/components/ui/feedback'

/**
 * Error boundary for the account pages.
 *
 * Before this existed, a failure while rendering the streamed account segment
 * left the outlet blank with nothing to act on — the customer saw a header,
 * two tabs and an empty page, and had no way to recover except guessing.
 *
 * NOTHING FROM `error` IS DISPLAYED. A rendering fault here can carry a query,
 * a column name, or part of a row; the customer can do nothing with any of it
 * and it should not be on their screen. `digest` is the identifier that ties a
 * report back to the server log, so that is the only thing shown, and only when
 * Next provides one.
 *
 * Must be a Client Component — that is how React error boundaries work.
 */
export default function AccountError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-poster text-3xl tracking-tight text-white uppercase">
        Account
      </h1>

      <Alert tone="warning" title="We couldn't load your account">
        Something went wrong on our side. Your account and your details are
        unaffected — this is a problem displaying the page, not a problem with
        your data.
      </Alert>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link href="/shop" className={buttonVariants({ variant: 'ghost' })}>
          Back to the shop
        </Link>
      </div>

      {error.digest && (
        <p className="font-data text-xs text-smoke">
          Reference: {error.digest}
        </p>
      )}
    </div>
  )
}
