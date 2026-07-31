import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Empty state.
 *
 * An empty screen is an invitation to act, so every one of these takes an
 * action. The halftone wash gives the panel some weight without needing an
 * illustration to load — the texture is a CSS gradient, so an empty cart costs
 * nothing to render.
 *
 * Copy rules, applied at the call site:
 * - Say what is here, not what is missing. "Nothing in your bag yet" beats
 *   "Empty cart".
 * - The action names the destination: "Browse flower", not "Continue".
 * - No apology. An empty cart is not an error and should not read like one.
 */

type EmptyStateProps = {
  title: string
  description?: string
  /** Rendered under the copy. Give it exactly one primary action. */
  action?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'panel relative overflow-hidden rounded-lg bg-card',
        'flex flex-col items-center gap-4 px-6 py-14 text-center',
        className,
      )}
    >
      {/* Halftone wash, fading out downward so the copy stays clean. */}
      <div
        aria-hidden="true"
        className="halftone-lg pointer-events-none absolute inset-0 text-smoke opacity-25 [mask-image:linear-gradient(to_bottom,black,transparent_70%)]"
      />

      {icon && (
        <div className="relative text-smoke [&_svg]:size-10" aria-hidden="true">
          {icon}
        </div>
      )}

      <div className="relative flex flex-col gap-2">
        <h3 className="font-display text-2xl tracking-tight uppercase">{title}</h3>
        {description && (
          <p className="mx-auto max-w-sm font-sans text-sm leading-relaxed text-smoke">
            {description}
          </p>
        )}
      </div>

      {action && <div className="relative mt-1">{action}</div>}
    </div>
  )
}
