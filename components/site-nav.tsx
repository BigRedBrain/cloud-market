'use client'

import { Menu, ShoppingBag, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

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

const LINKS = [
  { href: '/shop', label: 'Shop' },
  { href: '/deals', label: 'Deals' },
  { href: '/delivery', label: 'Delivery' },
  { href: '/about', label: 'About' },
] as const

type SiteNavProps = {
  bagCount?: number
}

export function SiteNav({ bagCount = 0 }: SiteNavProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

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
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        {/*
         * Only `/` exists today. `typedRoutes` type-checks Link hrefs, so the
         * catalogue links below stay plain anchors until those routes ship in
         * later phases — at which point they become `Link` and gain prefetch.
         */}
        <Link href="/" className="-ml-2 rounded-md" aria-label="Cloud Market home">
          <Logo variant="full" tone="cream" showLabel={false} />
        </Link>

        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className={cn(
                    'inline-flex h-10 items-center rounded-md px-3',
                    'font-sans text-sm font-semibold text-cream',
                    'transition-colors hover:bg-cream/10',
                    // Underline is drawn in volt on hover — colour alone never
                    // carries the affordance, the movement does too.
                    'relative after:absolute after:inset-x-3 after:bottom-1.5 after:h-0.5',
                    'after:scale-x-0 after:bg-volt after:transition-transform',
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
            {LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="flex h-12 items-center rounded-md px-3 font-sans text-base font-semibold text-cream hover:bg-cream/10"
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
