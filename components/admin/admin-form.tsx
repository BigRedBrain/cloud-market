'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/feedback'
import { Spinner } from '@/components/ui/skeleton'
import type { ActionResult } from '@/lib/result'

/**
 * Shared shell for admin forms.
 *
 * Admin sits at 5% brand intensity (DESIGN.md §9): type, hairlines and tabular
 * data, information density over character. What intensity never scales down
 * still applies — focus rings, press feedback and contrast are identical to the
 * hero.
 *
 * `useActionState` keeps these working without JavaScript, same as the auth
 * forms. Nothing here introduces a new visual language; it composes Button,
 * Alert and Spinner from the frozen system.
 */

type AdminFormProps = {
  action: (
    previous: ActionResult<void> | null,
    formData: FormData,
  ) => Promise<ActionResult<void>>
  submitLabel: string
  successMessage: string
  children: (fieldErrors: Record<string, string[]> | undefined) => React.ReactNode
  /** Rendered next to the submit button — usually a delete control. */
  secondary?: React.ReactNode
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      {pending ? (
        <>
          <Spinner label="Saving" />
          Saving
        </>
      ) : (
        label
      )}
    </Button>
  )
}

export function AdminForm({
  action,
  submitLabel,
  successMessage,
  children,
  secondary,
}: AdminFormProps) {
  const [state, formAction] = useActionState<ActionResult<void> | null, FormData>(action, null)

  const failed = state !== null && !state.ok
  const succeeded = state !== null && state.ok

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {failed && (
        <Alert tone="error" title="Could not save">
          {state.message}
        </Alert>
      )}
      {succeeded && (
        <Alert tone="success" title="Saved">
          {successMessage}
        </Alert>
      )}

      {children(failed ? state.fieldErrors : undefined)}

      <div className="flex flex-wrap items-center gap-3 border-t border-ink-600 pt-4">
        <SubmitButton label={submitLabel} />
        {secondary}
      </div>
    </form>
  )
}

/**
 * Destructive action with a confirmation step.
 *
 * The confirmation is `window.confirm` rather than a bespoke modal: it is
 * unmissable, keyboard-accessible for free, and needs no new component in a
 * frozen design system. `formAction` is used so this posts its own action while
 * living inside the parent form's markup.
 */
export function DeleteButton({
  action,
  hiddenFields,
  label = 'Delete',
  confirmMessage,
}: {
  action: (
    previous: ActionResult<void> | null,
    formData: FormData,
  ) => Promise<ActionResult<void>>
  hiddenFields: Record<string, string>
  label?: string
  confirmMessage: string
}) {
  const [state, formAction] = useActionState<ActionResult<void> | null, FormData>(action, null)

  return (
    <>
      {state && !state.ok && (
        <Alert tone="error" title="Could not delete" className="w-full">
          {state.message}
        </Alert>
      )}
      <form
        action={formAction}
        onSubmit={(event) => {
          if (!window.confirm(confirmMessage)) event.preventDefault()
        }}
      >
        {Object.entries(hiddenFields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Button type="submit" variant="destructive" size="sm">
          {label}
        </Button>
      </form>
    </>
  )
}
