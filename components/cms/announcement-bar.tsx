import type { Route } from 'next'
import Link from 'next/link'

import { getLiveAnnouncement } from '@/lib/cms/queries'

/**
 * Announcement bar.
 *
 * A **Server Component** that renders `null` when nothing is live — so with no
 * announcement configured the storefront is byte-identical to what it was
 * before this phase. That is deliberate: the brief asked for no visual change,
 * and the honest way to honour that is for new chrome to be absent rather than
 * empty-but-present.
 *
 * Content comes from a campaign of type `announcement`, so scheduling a holiday
 * notice for Friday is the same mechanism as scheduling a hero. The bar appears
 * and disappears on its own; nobody has to remember to take it down.
 *
 * Uses only frozen design system tokens — ember fill with ink text, per the
 * contrast contract that every bright fill takes ink text.
 */
export async function AnnouncementBar() {
  const announcement = await getLiveAnnouncement()
  if (!announcement) return null

  const message = announcement.body ?? announcement.subtitle ?? announcement.title

  return (
    <div
      // `role="region"` + a label so a screen-reader user can find or skip it.
      role="region"
      aria-label="Site announcement"
      className="border-b-2 border-ink bg-ember text-ink"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center sm:px-6">
        <p className="font-sans text-sm font-semibold">{message}</p>

        {announcement.ctaLabel && announcement.ctaHref && (
          <Link
            href={announcement.ctaHref as Route}
            className="font-sans text-sm font-bold underline underline-offset-4"
          >
            {announcement.ctaLabel}
          </Link>
        )}
      </div>
    </div>
  )
}
