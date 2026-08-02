import Link from 'next/link'

import { AccountTabs } from '@/components/account/account-tabs'
import { Logo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { signOutAction } from '@/lib/auth/actions'

/**
 * Account shell.
 *
 * 10% brand intensity: outlines and type, density over character. No smoke, no
 * cloud button, no decorative motion.
 *
 * SYNCHRONOUS, AND WHY THAT IS NOT THE WHOLE STORY.
 *
 * This layout used to `await getCurrentUser()` purely to hide the sign-out
 * button from a signed-out visitor — a database round trip to answer a question
 * with only one possible answer, since every route beneath it is authenticated:
 * `proxy.ts` bounces a request with no session cookie and each page calls
 * `requireUser()`. Removing it lets the shell flush without waiting on the
 * session.
 *
 * It did NOT remove the Suspense boundary, and it was never going to. `<main>`
 * lives HERE, in the layout, while the page is a separate async segment — so
 * React flushes this shell and streams the page into a boundary underneath.
 * That is the App Router working as designed, not a defect. Measured: with the
 * layout sync and no loading.tsx, `<main>` still served
 *
 *     <main><template id="P:1"></template><!--$--><!--/$--></main>
 *
 * `/bag` renders into its `<main>` because `<main>` is inside the page there —
 * it is one segment, not two. The comparison never held.
 *
 * What actually protects the customer is `loading.tsx`: the boundary now has
 * visible content instead of nothing, so a delayed or failed stream shows a
 * skeleton rather than an empty authenticated page. `error.tsx` catches the
 * other half.
 *
 * Authorization still does NOT live here. Layouts do not re-render on
 * navigation under partial rendering, so a guard here would go stale between
 * route changes; each page calls `requireUser()` itself.
 */
export default function AccountLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <header className="border-b-2 border-ink bg-ink-900">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="-ml-2 rounded-md" aria-label="Cloud Market home">
            <Logo variant="full" tone="cream" showLabel={false} />
          </Link>

          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
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
