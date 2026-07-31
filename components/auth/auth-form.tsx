'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/feedback'
import { Spinner } from '@/components/ui/skeleton'
import type { ActionResult } from '@/lib/result'

/**
 * Shared shell for every authentication form.
 *
 * Account screens sit at 10% brand intensity (DESIGN.md §9): panel outlines and
 * type, no smoke, no cloud silhouette, no decorative motion. What the intensity
 * scale explicitly does NOT scale down is feedback — the primary button keeps
 * its ember glow and press physics, focus rings are unchanged, and contrast is
 * identical to the hero.
 *
 * `useActionState` gives progressive enhancement: the form posts and works
 * without JavaScript, and upgrades to inline errors when hydrated.
 */

type AuthFormProps = {
  action: (
    previous: ActionResult<void> | null,
    formData: FormData,
  ) => Promise<ActionResult<void>>
  submitLabel: string
  pendingLabel: string
  successMessage?: string
  children: (fieldErrors: Record<string, string[]> | undefined) => React.ReactNode
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="primary" size="lg" disabled={pending} className="w-full">
      {pending ? (
        <>
          <Spinner label={pendingLabel} />
          {pendingLabel}
        </>
      ) : (
        label
      )}
    </Button>
  )
}

export function AuthForm({
  action,
  submitLabel,
  pendingLabel,
  successMessage,
  children,
}: AuthFormProps) {
  const [state, formAction] = useActionState<ActionResult<void> | null, FormData>(
    action,
    null,
  )

  const failed = state !== null && !state.ok
  const succeeded = state !== null && state.ok

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {/*
       * Form-level errors render above the fields and carry role="alert", so a
       * screen reader announces a failed sign-in rather than leaving the user
       * wondering whether the button worked.
       */}
      {failed && (
        <Alert
          tone={state.code === 'rate_limited' ? 'warning' : 'error'}
          title={state.code === 'rate_limited' ? 'Too many attempts' : 'Check your details'}
        >
          {state.message}
        </Alert>
      )}

      {succeeded && successMessage && (
        <Alert tone="success" title="Saved">
          {successMessage}
        </Alert>
      )}

      {children(failed ? state.fieldErrors : undefined)}

      <SubmitButton label={submitLabel} pendingLabel={pendingLabel} />
    </form>
  )
}
