import type { Metadata } from 'next'
import Link from 'next/link'

import { ResetPasswordForm } from '@/components/auth/auth-forms'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { StatusPanel } from '@/components/ui/feedback'

export const metadata: Metadata = {
  title: 'Set a new password',
  robots: { index: false, follow: false },
}

/**
 * The reset link's landing page.
 *
 * IT DOES NOT CONSUME THE TOKEN. Rendering is a GET, and GETs are followed by
 * link scanners, mail-client prefetchers and browser preloads. If arriving here
 * spent the token, corporate mail security would burn every reset link before
 * its owner clicked it. Consumption happens in the POST that actually sets the
 * password.
 *
 * It also does not validate the token first. Checking here would mean either
 * consuming it (above) or a second lookup whose only product is an earlier,
 * more detailed error message — and "that token doesn't exist" versus "that
 * token expired" is a distinction an unauthenticated visitor has no business
 * receiving. The form posts, the action decides, and every failure reads the
 * same.
 */
export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  if (!token || token.length > 200) {
    return (
      <StatusPanel
        tone="warning"
        title="That reset link isn't valid"
        description="Reset links expire after an hour and can only be used once. Request a new one to continue."
        action={
          <Link href="/forgot-password" className={buttonVariants({ variant: 'primary' })}>
            Request a new link
          </Link>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-poster text-3xl tracking-tight text-white uppercase">
          Set a new password
        </h1>
        <p className="text-sm text-smoke">
          Choose a new password for your account. You&apos;ll be signed out
          everywhere and asked to sign in again.
        </p>
      </div>

      <Card className="p-6">
        <ResetPasswordForm token={token} />
      </Card>
    </div>
  )
}
