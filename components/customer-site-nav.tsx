import 'server-only'

import { SiteNav, type MarketplaceEntry } from '@/components/site-nav'
import { getCurrentUser } from '@/lib/auth/dal'
import { getUnreadNotificationCount } from '@/lib/notifications/queries'

/**
 * The customer navigation, with the viewer resolved.
 *
 * A Server Component wrapper around `SiteNav`, and the only place in the
 * storefront header where identity is established. `SiteNav` itself stays a
 * client presentation component: it is handed a bag count, a membership
 * decision and an unread count, and it works out none of them.
 *
 * WHY A WRAPPER RATHER THAN A PROP ON EVERY PAGE. Eight customer pages need the
 * same bell. Threading "is there a viewer, and how many unread rows do they
 * have" through eight call sites means eight chances to pass the wrong id — and
 * a page that passed *someone else's* would be an authorization bug with no
 * single place to catch it. Here there is one call site, it takes no user id,
 * and there is no id for a caller to get wrong.
 *
 * IDENTITY IS DERIVED HERE, NEVER ACCEPTED. This component has no `userId`
 * prop and never will: the viewer comes from `getCurrentUser()`, which reads
 * the session cookie server-side, and the count comes from a query that also
 * takes no id and scopes itself to the authenticated owner. A client that wants
 * someone else's unread count has nothing to send.
 *
 * ANONYMOUS GETS NO BELL. Not a bell reading zero — no control at all. The
 * count is passed as `null` when there is no viewer, and `SiteNav` renders the
 * bell only for a number. The query answers `0` for anonymous anyway; this is
 * the second of the two, so that a signed-in customer with nothing unread and a
 * signed-out visitor are visibly different states rather than the same `0`.
 *
 * IT RESOLVES NO MEMBERSHIP. `marketplaceEntry` is passed straight through from
 * the page that already made that decision — this wrapper does not probe, does
 * not guard, and has no default of its own, so omitting it lands on `SiteNav`'s
 * denial exactly as it did before this component existed. Marketplace entry and
 * "is there a session" are separate facts and are kept that way: a member can be
 * denied entry, and a denied member still has their own notifications.
 */
type CustomerSiteNavProps = {
  /** Bag lines for this viewer, already counted by the page. */
  bagCount?: number
  /**
   * The membership decision already made on the server. Forwarded unchanged;
   * omitting it points the shop link at `/gate`, which is what an unwired
   * caller means.
   */
  marketplaceEntry?: MarketplaceEntry
}

export async function CustomerSiteNav({
  bagCount,
  marketplaceEntry,
}: CustomerSiteNavProps) {
  /*
   * `getCurrentUser()` is `cache()`-wrapped in the DAL, so a page that already
   * asked for the viewer to count its bag pays for one session lookup, not two.
   */
  const viewer = await getCurrentUser()

  /*
   * The count is asked for only when there is someone to ask about. Nothing
   * identifying is passed — `getUnreadNotificationCount()` takes no arguments
   * and derives the owner itself.
   */
  const unreadNotificationCount = viewer ? await getUnreadNotificationCount() : null

  return (
    <SiteNav
      bagCount={bagCount}
      marketplaceEntry={marketplaceEntry}
      unreadNotificationCount={unreadNotificationCount}
    />
  )
}
