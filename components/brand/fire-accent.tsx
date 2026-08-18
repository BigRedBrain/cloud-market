import { useId } from 'react'

import { FLAME_PATHS } from '@/components/brand/cloud-geometry'
import { cn } from '@/lib/utils'

/**
 * FireAccent — the reusable comic flame.
 *
 * Signal Yellow at the tip, Ember through the middle, Fire Red at the base.
 * Ember appears here and only here: it is not a brand colour, it is the stop
 * that stops the gradient reading as a warning stripe.
 *
 * Always decorative. The flame is `aria-hidden` and carries no accessible
 * name, because a flame beside a heading is never the information — the
 * heading is. If a caller ever needs fire to *mean* something, the meaning
 * belongs in adjacent text, per the rule that nothing is communicated by shape
 * or colour alone.
 *
 * Reduced motion: the flicker keyframe is declared inside a
 * `prefers-reduced-motion: no-preference` block in globals.css, so a
 * reduced-motion visitor gets the flame fully drawn and lit, simply holding
 * still — the composition is complete, not removed. `motion-reduce:animate-none`
 * is belt to that braces.
 */

const SIZES = {
  sm: 'h-4',
  md: 'h-8',
  lg: 'h-16',
} as const

type FireAccentProps = {
  size?: keyof typeof SIZES
  /** Flicker on a 900ms loop. Off by default — fire is an accent, not a focus. */
  animated?: boolean
  /**
   * Optional explicit gradient id. Almost never needed — a unique one is
   * generated per instance. Provide it only when something external has to
   * reference the gradient by name.
   */
  id?: string
  className?: string
}

export function FireAccent({
  size = 'md',
  animated = false,
  id,
  className,
}: FireAccentProps) {
  /*
   * SVG gradients are referenced by id, and ids are document-global. A
   * per-size default meant two accents of the same size emitted duplicate ids
   * — technically invalid, and fragile the moment the two gradients diverge.
   *
   * useId() gives a genuinely unique value per instance. It works in a Server
   * Component (verified in the build output), so this stays RSC — no client
   * boundary, no hydration mismatch, and the rendered visual is unchanged.
   */
  const generatedId = useId()
  const gradientId = id ?? `cloudmarket-fire${generatedId}`

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 180 90"
      className={cn('w-auto shrink-0', SIZES[size], className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--fire-base)" />
          <stop offset="55%" stopColor="var(--fire-core)" />
          <stop offset="100%" stopColor="var(--fire-tip)" />
        </linearGradient>
      </defs>

      {FLAME_PATHS.map((d, index) => (
        <path
          key={d}
          d={d}
          fill={`url(#${gradientId})`}
          stroke="var(--dark-smoke-deep)"
          strokeWidth="2"
          strokeLinejoin="round"
          className={cn(
            animated &&
              'animate-[ember-flicker_900ms_ease-in-out_infinite] motion-reduce:animate-none',
          )}
          style={{
            transformOrigin: 'center bottom',
            // Offsetting each lick stops the cluster pulsing as one block.
            animationDelay: `${index * 0.25}s`,
          }}
        />
      ))}
    </svg>
  )
}
