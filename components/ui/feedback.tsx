import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Error, success, warning and info states.
 *
 * Three rules, all of them about not relying on colour:
 *
 *  1. Every tone carries an icon AND a heading word, so the state survives
 *     greyscale and colour-blindness.
 *  2. The left rule is 6px — the same redundant signal the form fields use, so
 *     an error looks like an error whether it appears inline or in a panel.
 *  3. Errors announce with `role="alert"` (assertive — the user needs to know
 *     now, mid-checkout); success announces with `role="status"` (polite, so it
 *     does not interrupt whatever they are typing).
 *
 * Copy guidance, applied at the call site: errors say what happened and what to
 * do next, in the interface's voice. They do not apologise and they are never
 * vague. "Card declined. Try another card or use cash on delivery." — not
 * "Something went wrong."
 */

const TONES = {
  error: {
    icon: XCircle,
    rule: 'border-l-flare',
    accent: 'text-flare',
    role: 'alert' as const,
  },
  success: {
    icon: CheckCircle2,
    rule: 'border-l-volt',
    accent: 'text-volt',
    role: 'status' as const,
  },
  warning: {
    icon: AlertTriangle,
    rule: 'border-l-ember',
    accent: 'text-ember',
    role: 'status' as const,
  },
  info: {
    icon: Info,
    rule: 'border-l-smoke',
    accent: 'text-smoke',
    role: 'status' as const,
  },
}

type Tone = keyof typeof TONES

type AlertProps = {
  tone: Tone
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

/** Inline banner. Use above a form, or at the top of a checkout step. */
export function Alert({ tone, title, children, action, className }: AlertProps) {
  const { icon: Icon, rule, accent, role } = TONES[tone]

  return (
    <div
      role={role}
      className={cn(
        'panel-sm flex gap-3 rounded-md border-l-[6px] bg-ink-800 p-4',
        rule,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', accent)} />
      <div className="flex flex-col gap-1">
        <p className="font-sans font-bold text-white">{title}</p>
        {children && (
          <div className="text-sm leading-relaxed text-smoke">{children}</div>
        )}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  )
}

type StatusPanelProps = {
  tone: Tone
  title: string
  description?: string
  action?: React.ReactNode
  /** Order number, reference code — anything worth reading back. */
  reference?: { label: string; value: string }
  className?: string
}

/**
 * Full-panel outcome — order confirmed, payment failed, address unserviceable.
 *
 * Success states get NO celebratory motion. Confetti on an order confirmation
 * is the single most common way to make a checkout feel unserious, and it
 * delays the one thing the customer actually wants: their order number, in
 * text they can copy.
 */
export function StatusPanel({
  tone,
  title,
  description,
  action,
  reference,
  className,
}: StatusPanelProps) {
  const { icon: Icon, accent, role } = TONES[tone]

  return (
    <div
      role={role}
      className={cn(
        'panel relative overflow-hidden rounded-lg bg-card',
        'flex flex-col items-center gap-4 px-6 py-12 text-center',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="halftone-lg pointer-events-none absolute inset-0 text-smoke opacity-20 [mask-image:linear-gradient(to_bottom,black,transparent_70%)]"
      />

      <Icon aria-hidden="true" className={cn('relative size-12', accent)} />

      <div className="relative flex flex-col gap-2">
        <h2 className="font-display text-3xl tracking-tight text-white uppercase">
          {title}
        </h2>
        {description && (
          <p className="mx-auto max-w-md text-sm leading-relaxed text-smoke">
            {description}
          </p>
        )}
      </div>

      {reference && (
        <div className="relative rounded-md border-2 border-ink bg-ink-900 px-4 py-2">
          <p className="font-mono text-[0.625rem] tracking-widest text-smoke uppercase">
            {reference.label}
          </p>
          <p className="font-mono text-lg font-bold text-white">{reference.value}</p>
        </div>
      )}

      {action && <div className="relative mt-1">{action}</div>}
    </div>
  )
}
