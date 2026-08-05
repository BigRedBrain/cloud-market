import Link from 'next/link'
import type { Route } from 'next'

import { Logo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { signOutAction } from '@/lib/auth/actions'
import { getCurrentUser, hasPermission } from '@/lib/auth/dal'

/**
 * Admin shell — 5% brand intensity (DESIGN.md §9).
 *
 * Type, hairlines and tabular data. Information density wins outright: no
 * smoke, no halftone, no decorative motion. Focus rings, press feedback and
 * contrast are unchanged from the hero, because intensity governs decoration
 * only.
 *
 * Reads the user to render the header but performs NO authorization — layouts
 * do not re-render on navigation under partial rendering, so a guard here would
 * go stale between route changes. Every admin page calls `requireAdmin()`.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()

  /**
   * Purchase limits are gated on a grant, not on the admin role, so the tab is
   * shown only to holders. This is presentation, not protection — the page runs
   * its own `requirePermission`, and hiding a link has never stopped anyone
   * typing the URL.
   */
  const compliance = await hasPermission('compliance_admin')
  const catalogCompliance = await hasPermission('catalog_compliance_admin')

  const tabs = [
    { href: '/admin', label: 'Overview' },
    { href: '/admin/products', label: 'Products' },
    { href: '/admin/categories', label: 'Categories' },
    { href: '/admin/brands', label: 'Brands' },
    { href: '/admin/campaigns', label: 'Campaigns' },
    { href: '/admin/collections', label: 'Collections' },
    { href: '/admin/badges', label: 'Badges' },
    { href: '/admin/homepage', label: 'Homepage' },
    { href: '/admin/media', label: 'Media' },
    ...(compliance
      ? ([{ href: '/admin/purchase-limits', label: 'Purchase limits' }] as const)
      : []),
    ...(catalogCompliance
      ? ([{ href: '/admin/catalog/compliance', label: 'Catalog compliance' }] as const)
      : []),
  ] as const

  return (
    <>
      <header className="border-b-2 border-ink bg-ink-900">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Link href="/" className="-ml-2 rounded-md" aria-label="Cloud Market home">
              <Logo variant="mark" tone="cream" />
            </Link>
            <span className="font-mono text-xs tracking-widest text-smoke uppercase">
              Admin
            </span>
          </div>

          {user && (
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-xs text-smoke sm:inline">
                {user.email}
              </span>
              <form action={signOutAction}>
                <Button type="submit" variant="ghost" size="sm">
                  Sign out
                </Button>
              </form>
            </div>
          )}
        </div>
      </header>

      <nav aria-label="Admin" className="border-b border-ink-600 bg-ink-900">
        <ul className="mx-auto flex w-full max-w-6xl gap-1 px-4 sm:px-6">
          {tabs.map((tab) => (
            <li key={tab.href}>
              <Link
                href={tab.href as Route}
                className="inline-flex h-10 items-center rounded-t-md px-3 font-sans text-sm font-semibold text-white transition-colors hover:bg-white/10"
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {children}
    </>
  )
}
