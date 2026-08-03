import Link from 'next/link'

import { AccountTabs } from '@/components/account/account-tabs'
import { Logo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { signOutAction } from '@/lib/auth/actions'

/**
 * The account chrome — header, tabs, and the `<main>` element.
 *
 * A PLAIN COMPONENT, NOT A LAYOUT, AND THAT IS THE ENTIRE POINT.
 *
 * `app/account/layout.tsx` used to own this markup. That made every account
 * page a separate async segment beneath it, and Next rendered exactly what it
 * is designed to render in that situation: the layout flushed as a shell and
 * the page streamed into a Suspense boundary underneath, so the served HTML
 * contained
 *
 *     <main><template id="P:1"></template><!--$--><!--/$--></main>
 *
 * with the real content parked in a hidden div, waiting for an inline `$RC(…)`
 * script to move it into place. When that relocation did not complete, the
 * customer got a header, two tabs, and nothing else. Adding a loading fallback
 * replaced "blank" with "skeleton forever" — better, but still a page that
 * never arrived.
 *
 * Rendered as a component instead, this chrome is part of the page's own
 * segment. The page awaits its data first and returns one tree: shell and
 * content together, in a single flush, with no boundary between them and
 * nothing for a client script to assemble. It is the same model `/bag` has
 * always used, and it works for the same reason.
 *
 * The cost is that each page repeats one `<AccountShell>` wrapper. That is the
 * trade being made deliberately: a line of markup per page against a body that
 * renders.
 *
 * Authorization is NOT here. Each page calls `requireUser()` before rendering,
 * which is also what guarantees the shell never appears above an unauthorised
 * body — the await happens first, so a redirect preempts the whole tree.
 */
export function AccountShell({ children }: { children: React.ReactNode }) {
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
