import Link from 'next/link'

import { AccountTabs } from '@/components/account/account-tabs'
import { Logo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { signOutAction } from '@/lib/auth/actions'
import { getCurrentUser } from '@/lib/auth/dal'

/**
 * Account shell.
 *
 * 10% brand intensity: outlines and type, density over character. No smoke, no
 * cloud button, no decorative motion.
 *
 * This layout *reads* the user to render the header, but performs no
 * authorization — layouts do not re-render on navigation under partial
 * rendering, so a guard here would go stale between route changes. Each page
 * calls `requireUser()` itself, which is the pattern Next's own auth guide
 * prescribes. `getCurrentUser` is React-cached, so the layout and the page
 * share a single session lookup.
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()

  return (
    <>
      <header className="border-b-2 border-ink bg-ink-900">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="-ml-2 rounded-md" aria-label="Cloud Market home">
            <Logo variant="full" tone="cream" showLabel={false} />
          </Link>

          {user && (
            <form action={signOutAction}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          )}
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <nav aria-label="Account" className="mb-8 border-b-2 border-ink">
          <AccountTabs />
        </nav>

        <main>{children}</main>
      </div>
    </>
  )
}
