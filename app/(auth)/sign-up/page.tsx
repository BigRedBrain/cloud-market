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

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect('/account')

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-poster text-3xl tracking-tight text-white uppercase">
          Create account
        </h1>
        <p className="text-sm text-smoke">
          You must be {MINIMUM_AGE_YEARS} or older. We check ID at handoff.
        </p>
      </div>

      <Card className="p-6">
        <SignUpForm />
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
