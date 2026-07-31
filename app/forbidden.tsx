import Link from 'next/link'

import { buttonVariants } from '@/components/ui/button'
import { StatusPanel } from '@/components/ui/feedback'

/**
 * 403 — rendered when `forbidden()` is thrown from the DAL.
 *
 * The visitor is authenticated but not permitted. Bouncing them to sign-in
 * would be a dead end: they have already signed in, and doing it again changes
 * nothing. So this says plainly what happened and offers the way back.
 *
 * Deliberately does not name the resource or the required role — that would
 * confirm the existence and shape of an admin surface to someone probing.
 */
export default function Forbidden() {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 items-center px-4 py-16 sm:px-6">
      <StatusPanel
        tone="error"
        title="You don't have access"
        description="Your account isn't permitted to view this page. If you think that's wrong, ask an administrator to check your role."
        action={
          <Link href="/" className={buttonVariants({ variant: 'primary' })}>
            Back to the shop
          </Link>
        }
        className="w-full"
      />
    </main>
  )
}
