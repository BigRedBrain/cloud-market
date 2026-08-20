import Link from 'next/link'

import { Logo } from '@/components/brand/logo'

/**
 * Shell for sign-in and sign-up.
 *
 * 10% brand intensity (DESIGN.md §9): stripped header, no smoke, no cloud
 * button, no decorative motion. The full site nav is deliberately absent —
 * its categories and bag are routes *away* from the one thing the visitor came
 * here to finish. The logo links home and nothing else does.
 *
 * No auth check happens in this layout. Layouts do not re-render on navigation
 * under partial rendering, so a check here would silently go stale; the
 * redirect for already-signed-in visitors is handled optimistically in proxy.ts
 * and authoritatively in each page.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b-2 border-ink bg-ink-900">
        <div className="mx-auto flex h-16 w-full max-w-lg items-center px-4 sm:px-6">
          <Link href="/" className="-ml-2 rounded-md" aria-label="CloudMarket home">
            <Logo variant="full" tone="cream" showLabel={false} />
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-4 py-12 sm:px-6">
        {children}
      </main>
    </>
  )
}
