import type { Metadata } from 'next'

import { CustomerSiteNav } from '@/components/customer-site-nav'
import { NotificationCenter } from '@/components/notifications/notification-center'
import { requireUser } from '@/lib/auth/dal'
import { getBagCount } from '@/lib/bag/core'
import { getMyNotifications } from '@/lib/notifications/queries'

export const metadata: Metadata = {
  title: 'Notifications',
  robots: { index: false, follow: false },
}

/**
 * The customer's own notifications.
 *
 * AUTHENTICATED, AND AUTHENTICATED FIRST. `requireUser()` is the first
 * statement: an anonymous request is redirected to sign-in and carries this
 * path with it, so nothing below runs and no list is assembled for a viewer who
 * does not exist. The query would return `[]` for anonymous anyway — this is
 * the second of the two, because "your notifications" is a page that should ask
 * you to sign in rather than show you an empty room.
 *
 * NO USER ID IS PASSED TO ANYTHING THAT READS NOTIFICATIONS.
 * `getMyNotifications()` takes no arguments and resolves the owner from the
 * session itself, which is what makes "customers see only their own" a property
 * of the query rather than of this page remembering to filter. The `user` here
 * is used for the bag count and for nothing else.
 *
 * NO `marketplaceEntry` IS PASSED. Notifications are not marketplace inventory:
 * a member, a suspended member and an applicant all have their own account
 * notices and all may read them. Omitting the prop points the nav's shop link at
 * `/gate`, which is the honest answer from a page that has resolved no
 * membership — see `components/site-nav.tsx`.
 */
export default async function NotificationsPage() {
  const user = await requireUser('/notifications')

  const [bagCount, notifications] = await Promise.all([
    getBagCount(user.id),
    getMyNotifications(),
  ])

  return (
    <>
      <CustomerSiteNav bagCount={bagCount} />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="mb-6 font-poster text-3xl tracking-tight text-white uppercase">
          Notifications
        </h1>

        <NotificationCenter notifications={notifications} />
      </main>
    </>
  )
}
