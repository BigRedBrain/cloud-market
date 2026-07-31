import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { SignInForm } from '@/components/auth/auth-forms'
import { Card } from '@/components/ui/card'
import { getCurrentUser } from '@/lib/auth/dal'
import { safeRedirectPath } from '@/lib/auth/validation'

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams

  /**
   * Authoritative check. proxy.ts already bounces visitors who merely *have* a
   * cookie, but that check is optimistic by design — this one actually resolves
   * the session against the database.
   */
  if (await getCurrentUser()) {
    redirect(safeRedirectPath(next))
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-3xl tracking-tight text-white uppercase">
          Sign in
        </h1>
        <p className="text-sm text-smoke">
          Order history, saved addresses, and faster checkout.
        </p>
      </div>

      <Card className="p-6">
        <SignInForm next={next} />
      </Card>

      <p className="text-center text-sm text-smoke">
        New here?{' '}
        <Link
          href="/sign-up"
          className="font-semibold text-white underline underline-offset-4 hover:text-ember"
        >
          Create an account
        </Link>
      </p>
    </div>
  )
}
