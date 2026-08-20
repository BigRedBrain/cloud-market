import type { Metadata } from 'next'
import Link from 'next/link'

import { ForgotPasswordForm } from '@/components/auth/auth-forms'
import { Card } from '@/components/ui/card'

export const metadata: Metadata = {
  title: 'Reset your password',
  robots: { index: false, follow: false },
}

/**
 * Deliberately renders for signed-in visitors too.
 *
 * Bouncing an authenticated user away would be tidier, but someone can be
 * signed in on one device and locked out on another, and this page costs
 * nothing to leave open.
 */
export default function ForgotPasswordPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-poster text-3xl tracking-tight text-white uppercase">
          Reset your password
        </h1>
        <p className="text-sm text-smoke">
          Enter the email address on your account and we&apos;ll send you a link
          to set a new password.
        </p>
      </div>

      <Card className="p-6">
        <ForgotPasswordForm />
      </Card>

      <p className="text-center text-sm text-smoke">
        Remembered it?{' '}
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
