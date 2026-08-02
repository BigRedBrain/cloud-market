'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * The account tab strip.
 *
 * A Client Component only because a Server Component layout cannot read the
 * current pathname — layouts receive no route props, and `usePathname` is the
 * supported way to ask. Nothing else here needs the client: no state, no
 * effects, no data.
 *
 * `aria-current="page"` is the part that matters. Without it the tabs are two
 * indistinguishable links to a screen reader, and a sighted user relying on the
 * hover style has no idea which section they are in. The visual treatment reuses
 * the hover style that was already on these links rather than introducing
 * anything new.
 */
const TABS = [
  { href: '/account', label: 'Profile' },
  { href: '/account/security', label: 'Security' },
] as const

export function AccountTabs() {
  const pathname = usePathname()

  return (
    <ul className="flex items-center gap-1">
      {TABS.map((tab) => {
        /**
         * Exact match for /account, prefix match for the rest — otherwise
         * /account/security would light up Profile as well, since every account
         * route starts with it.
         */
        const isCurrent =
          tab.href === '/account'
            ? pathname === '/account'
            : pathname.startsWith(tab.href)

        return (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={isCurrent ? 'page' : undefined}
              className={[
                'inline-flex h-11 items-center rounded-t-md px-4 text-sm font-semibold',
                'text-white transition-colors hover:bg-white/10',
                isCurrent ? 'bg-white/10' : '',
              ].join(' ')}
            >
              {tab.label}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
