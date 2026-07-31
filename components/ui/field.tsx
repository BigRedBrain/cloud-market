import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Form primitives.
 *
 * Checkout is where visual ambition does the most damage, so the rules here are
 * deliberately conservative:
 *
 * - Inputs are 44px minimum and sit on a raised ink surface, not a transparent
 *   one. A borderless "minimal" field is the single most common way to make a
 *   form ambiguous on a phone in poor light.
 * - Errors are announced, not just coloured. `Field` wires `aria-describedby`
 *   and `aria-invalid` automatically, and the message carries an icon-free text
 *   prefix so it survives greyscale.
 * - The error state changes the border to flare AND adds a left rule, so the
 *   signal is redundant rather than colour-only.
 * - Labels are never placeholders. Placeholder-as-label fails the moment a user
 *   starts typing, and it fails permanently for screen readers.
 */

function Label({
  className,
  ...props
}: React.ComponentProps<'label'>) {
  return (
    <label
      className={cn(
        'font-sans text-sm leading-none font-semibold text-cream',
        'peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

function Input({
  className,
  type = 'text',
  ...props
}: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-11 w-full rounded-md bg-ink-700 px-3 py-2',
        'font-sans text-base text-cream',
        'border-solid border-ink [border-width:var(--outline-ink)]',
        'placeholder:text-smoke',
        'transition-[border-color,box-shadow] duration-100',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // Redundant error signalling: colour plus a heavy left rule.
        'aria-[invalid=true]:border-flare aria-[invalid=true]:border-l-[6px]',
        // File inputs inherit almost nothing; normalise the essentials.
        'file:mr-3 file:border-0 file:bg-transparent file:font-semibold file:text-cream',
        className,
      )}
      {...props}
    />
  )
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'flex min-h-24 w-full rounded-md bg-ink-700 px-3 py-2',
        'font-sans text-base text-cream',
        'border-solid border-ink [border-width:var(--outline-ink)]',
        'placeholder:text-smoke',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-flare aria-[invalid=true]:border-l-[6px]',
        className,
      )}
      {...props}
    />
  )
}

type FieldProps = {
  id: string
  label: string
  /** Shown under the field. Replaced by `error` when one is present. */
  hint?: string
  error?: string
  required?: boolean
  className?: string
  children: (props: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': boolean | undefined
    required: boolean | undefined
  }) => React.ReactNode
}

/**
 * Wires label, hint, and error to a control with the correct ARIA relationships.
 * Takes a render prop so it works with any input without cloning elements.
 */
function Field({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps) {
  const messageId = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-1 text-ember" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </Label>

      {children({
        id,
        'aria-describedby': messageId,
        'aria-invalid': error ? true : undefined,
        required: required || undefined,
      })}

      {error ? (
        <p
          id={messageId}
          role="alert"
          className="font-sans text-sm font-semibold text-flare"
        >
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="font-sans text-sm text-smoke">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export { Field, Input, Label, Textarea }
