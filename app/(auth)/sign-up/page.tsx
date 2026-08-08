import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { SignUpForm } from '@/components/auth/auth-forms'
import { Card } from '@/components/ui/card'
import { getCurrentUser } from '@/lib/auth/dal'
import { MINIMUM_AGE_YEARS } from '@/lib/auth/validation'

export const metadata: Metadata = {
  title: 'Create account',
  robots: { index: false, follow: false },
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (await getCurrentUser()) redirect('/account')

  /**
   * The return destination, carried from the proxy's redirect. Read here and
   * passed to the form as a hidden field; `safeRedirectPath` re-validates it
   * server-side on submit, because a value that has been through a URL is
   * untrusted no matter who put it there.
   */
  const params = await searchParams
  const next = typeof params.next === 'string' ? params.next : undefined

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-3xl tracking-tight text-white uppercase">
          Create account
        </h1>
        <p className="text-sm text-smoke">
          Cloud Market is invite-only. You must be {MINIMUM_AGE_YEARS} or older,
          and we check ID at handoff.
        </p>
      </div>

      <Card className="p-6">
        <SignUpForm next={next} />
      </Card>

      <p className="text-center text-sm text-smoke">
        Already have an account?{' '}
        <Link
          href="/sign-in"
          className="font-semibold text-white underline underline-offset-4 hover:text-ember"
        >
          Sign in
        </Link>
      </p>
    </div>
  )
}
