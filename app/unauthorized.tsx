import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'
import { StatusPanel } from '@/components/ui/feedback'

/**
 * 401 — rendered when `unauthorized()` is thrown.
 *
 * The DAL prefers a redirect to /sign-in for ordinary page navigation, because
 * a redirect preserves the user's intent. This segment exists for the cases
 * where a redirect is wrong — a fetch or an embedded request that should get a
 * real 401 rather than a 200 with a login form in it.
 */
export default function Unauthorized() {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 items-center px-4 py-16 sm:px-6">
      <StatusPanel
        tone="warning"
        title="Sign in to continue"
        description="This page needs an account. Sign in and we'll bring you straight back."
        action={
          <Link href="/sign-in" className={buttonVariants({ variant: 'primary' })}>
            Sign in
          </Link>
        }
        className="w-full"
      />
    </main>
  )
}
