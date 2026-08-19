import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Badge — a die-cut sticker.
 *
 * Badges carry status that changes a buying decision: potency, stock, delivery
 * eligibility, sale. They are loud on purpose, which means they have to be
 * rationed — see DESIGN.md for the one-badge-per-card rule.
 *
 * `tilt` rotates the sticker a degree or two. It is off by default: rotation is
 * for a single hero sticker, and a grid of tilted badges reads as a mistake
 * rather than a style.
 *
 * Colour is never the only signal. Every variant is paired with text, so a
 * badge still communicates fully in greyscale or to a colour-blind shopper.
 */
const badgeVariants = cva(
  [
    'inline-flex items-center gap-1.5 whitespace-nowrap',
    'font-data text-[0.6875rem] leading-none font-bold tracking-wider uppercase',
    'border-solid border-ink [border-width:var(--outline-ink-thin)]',
    'px-2 py-1 rounded-sm',
    '[&_svg]:size-3 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        /** Stock green. Availability only — see --status-instock. */
        volt: 'bg-volt text-ink',
        /** Signal Yellow. Confirmation, emphasis, "this one" states. */
        signal: 'bg-signal-yellow text-ink',
        ember: 'bg-ember text-ink',
        flare: 'bg-flare text-ink',
        cream: 'bg-cream text-ink',
        smoke: 'bg-ink-700 text-cream border-smoke/60',
        outline: 'bg-transparent text-cream border-cream/70',
      },
      tilt: {
        true: '-rotate-2',
        false: '',
      },
      shadow: {
        true: 'shadow-press',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'volt',
      tilt: false,
      shadow: true,
    },
  },
)

type BadgeProps = React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>

function Badge({ className, variant, tilt, shadow, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant, tilt, shadow }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
