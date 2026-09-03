'use client'

import { Bell, Menu, ShoppingBag, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { HeaderCloudFireStrip } from '@/components/brand/header-cloud-fire-strip'
import { Logo } from '@/components/brand/logo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Site navigation.
 *
 * Sticky, because the bag total is the thing shoppers check most and it should
 * never require a scroll to find. The header carries a heavy bottom ink rule
 * rather than a shadow — on a charcoal page a soft shadow is invisible, and the
 * rule matches the panel language everywhere else.
 *
 * The mobile menu is a plain disclosure, not a modal dialog: it pushes no focus
 * trap and steals no scroll, which keeps it predictable with a screen reader
 * and avoids the iOS scroll-locking bugs that dialogs invite. Escape closes it,
 * focus returns to the trigger, and the trigger reports state via
 * `aria-expanded`.
 *
 * The bag count is text inside the badge, not a bare coloured dot — a count
 * that only exists as colour tells a colour-blind shopper nothing.
 */

/**
 * MARKETPLACE ENTRY IS TOLD TO THIS COMPONENT, NEVER WORKED OUT BY IT.
 *
 * The nav is a client component. It has no session, no database and no way to
 * be trusted about membership, so it resolves nothing: no DAL import, no
 * `lib/marketplace/access` import, no reading of a role, a status or a scope
 * off anything handed to it. A server page that has already made the decision
 * passes the result in, and this component only chooses a link out of it.
 *
 * IT FAILS CLOSED. The prop is optional for compatibility with the call sites
 * that have not been wired yet (`/bag`, `/checkout/review`, `/design`,
 * `/orders/[number]`), and every one of those unwired cases — omitted,
 * `undefined`, or any value this build does not recognise — points at `/gate`.
 * Only the exact literal `'granted'` produces a `/shop` link, which is why the
 * test below is a strict equality against the grant rather than a check for the
 * denial: a new prop value added later lands in the safe branch by default,
 * instead of leaking the catalogue link until someone remembers to update this.
 *
 * A NAV LINK IS NOT A GATE EITHER WAY. Pointing at `/shop` does not admit
 * anyone; `/shop` runs `requireMarketplaceAccess()` for itself. This exists so
 * a non-member is offered the door they can actually open.
 */
export type MarketplaceEntry = 'granted' | 'denied'

/** The marketplace link for a member: the catalogue, under its ordinary label. */
const MARKETPLACE_GRANTED_LINK = { href: '/shop', label: 'Shop' } as const

/** Everyone else — denied, anonymous, unwired caller — is sent to the gate. */
const MARKETPLACE_GATE_LINK = { href: '/gate', label: 'Request access' } as const

/** Strict grant test. Anything that is not the literal grant resolves to /gate. */
function marketplaceLink(entry: MarketplaceEntry | undefined) {
  return entry === 'granted' ? MARKETPLACE_GRANTED_LINK : MARKETPLACE_GATE_LINK
}

/** The links that are public regardless of membership. */
const LINKS = [
  { href: '/deals', label: 'Deals' },
  { href: '/delivery', label: 'Delivery' },
  { href: '/about', label: 'About' },
] as const

/**
 * THE NOTIFICATION BELL IS TOLD TO THIS COMPONENT TOO, ON THE SAME TERMS.
 *
 * `unreadNotificationCount` carries two facts at once, and the type is what
 * keeps them apart:
 *
 *   - a NUMBER means the server resolved a signed-in customer and counted their
 *     own unread rows. The bell renders.
 *   - `null`, or the prop omitted entirely, means there is no viewer to count
 *     for — anonymous, or a caller that has established nothing. NO BELL AND NO
 *     COUNT RENDER AT ALL.
 *
 * Zero is therefore not the anonymous case: a signed-in customer with nothing
 * unread still gets the bell, because the control belongs to them and only the
 * badge is conditional. The presence test is an explicit `typeof === 'number'`
 * rather than a truthiness check for exactly that reason.
 *
 * This component resolves no identity of its own. It has no session and no
 * database, it is never handed a user id, and it could not fetch a count if it
 * wanted to — `components/customer-site-nav.tsx` does that on the server and
 * passes the number in.
 */
type SiteNavProps = {
  bagCount?: number
  /**
   * The membership decision already made on the server. Optional, and its
   * default is the denial — omitting it can never widen access.
   */
  marketplaceEntry?: MarketplaceEntry
  /**
   * Unread notifications for the signed-in viewer, or `null`/omitted when there
   * is no viewer. Optional, and its default hides the bell — an unwired caller
   * shows less, never more.
   */
  unreadNotificationCount?: number | null
}

export function SiteNav({
  bagCount = 0,
  marketplaceEntry = 'denied',
  unreadNotificationCount = null,
}: SiteNavProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const links = [marketplaceLink(marketplaceEntry), ...LINKS]

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <header className="distressed sticky top-0 z-50 border-b-2 border-ink bg-ink-900/95 backdrop-blur-sm">
      {/*
       * Approved cloud/fire artwork, decorative only.
       *
       * Mounted on the <header> rather than the inner bar so it runs full-bleed
       * — the bar is `max-w-7xl`, which would have left the artwork as a
       * centred band with bare header either side on a wide screen.
       *
       * `h-16` pins it to the bar's own height. The strip is `absolute inset-0`,
       * and the header also contains the mobile disclosure panel, so without an
       * explicit height the artwork would stretch downward every time the menu
       * opened. When top, bottom and height are all set, `bottom` is ignored —
       * so this anchors to the top and stays exactly the height of the bar.
       *
       * Opacity is set by MEASUREMENT, not by eye. Cream nav labels over the
       * strip's lightest cloud pixels were measured at each step:
       *
       *   0.40 -> 3.95:1  FAILS AA
       *   0.32 -> 5.10:1
       *   0.30 -> ~5.5:1  (used at lg)
       *   0.20 -> 7.85:1  (used on mobile)
       *
       * So the component's own `ambient` (0.40) is too strong once real text
       * sits on top of it, and desktop is capped at 0.30 for headroom. Mobile
       * goes lower again because the artwork masses its smoke and fire at the
       * left and right edges — exactly where a phone puts the logo and the
       * bag/menu controls, with no room for the artwork's empty centre.
       *
       * The header is `sticky z-50`, so it forms a stacking context: the strip's
       * negative z-index paints it above the header's own background but below
       * every in-flow control. It is `aria-hidden` and `pointer-events-none`
       * inside the component, so it can neither be reached nor clicked.
       */}
      <HeaderCloudFireStrip
        intensity="ambient"
        className="h-16 opacity-20 sm:opacity-25 lg:opacity-30"
      />

      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        {/*
         * Only `/` exists today. `typedRoutes` type-checks Link hrefs, so the
         * catalogue links below stay plain anchors until those routes ship in
         * later phases — at which point they become `Link` and gain prefetch.
         */}
        <Link href="/" className="-ml-2 rounded-md" aria-label="CloudMarket home">
          <Logo variant="full" tone="cream" showLabel={false} />
        </Link>

        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className={cn(
                    'inline-flex h-10 items-center rounded-md px-3',
                    'font-ui text-sm font-semibold text-cream',
                    'transition-colors hover:bg-cream/10',
                    // Underline is drawn in Signal Yellow on hover — colour alone never
                    // carries the affordance, the movement does too.
                    'relative after:absolute after:inset-x-3 after:bottom-1.5 after:h-0.5',
                    'after:scale-x-0 after:bg-signal-yellow after:transition-transform',
                    'hover:after:scale-x-100',
                  )}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          {/*
           * Presence, not truthiness. `unreadNotificationCount > 0` here would
           * hide the bell from a signed-in customer who has read everything,
           * and `unreadNotificationCount &&` would render a bare `0`.
           *
           * The count is in the accessible name because the badge is
           * `aria-hidden` — same rule as the bag below: a number that exists
           * only as a coloured chip is announced to nobody.
           */}
          {typeof unreadNotificationCount === 'number' && (
            <a
              href="/notifications"
              className="relative inline-flex size-11 items-center justify-center rounded-md text-cream transition-colors hover:bg-cream/10"
              aria-label={`Notifications, ${unreadNotificationCount} unread`}
            >
              <Bell aria-hidden="true" className="size-5" />
              {unreadNotificationCount > 0 && (
                <Badge
                  variant="signal"
                  shadow={false}
                  className="absolute -top-0.5 -right-0.5 px-1.5 py-0.5"
                  aria-hidden="true"
                >
                  {unreadNotificationCount}
                </Badge>
              )}
            </a>
          )}

          <a
            href="/bag"
            className="relative inline-flex size-11 items-center justify-center rounded-md text-cream transition-colors hover:bg-cream/10"
            aria-label={`Bag, ${bagCount} ${bagCount === 1 ? 'item' : 'items'}`}
          >
            <ShoppingBag aria-hidden="true" className="size-5" />
            {bagCount > 0 && (
              <Badge
                variant="ember"
                shadow={false}
                className="absolute -top-0.5 -right-0.5 px-1.5 py-0.5"
                aria-hidden="true"
              >
                {bagCount}
              </Badge>
            )}
          </a>

          <Button
            ref={triggerRef}
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </Button>
        </div>
      </div>

      <div
        id="mobile-nav"
        hidden={!open}
        className="border-t-2 border-ink bg-ink-800 md:hidden"
      >
        <nav aria-label="Main, mobile">
          <ul className="flex flex-col p-2">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="flex h-12 items-center rounded-md px-3 font-ui text-base font-semibold text-cream hover:bg-cream/10"
                  onClick={() => setOpen(false)}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  )
}
