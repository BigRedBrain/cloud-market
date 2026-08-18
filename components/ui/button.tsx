import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Button.
 *
 * Three things happen on interaction, and they are layered rather than swapped:
 *
 *  - The press is physical. 1px lift on hover; on `:active` the control travels
 *    2px down-right while the hard ink shadow collapses from 3px to 1px. Total
 *    travel is 2px — enough to feel like a stamp hitting paper, never enough to
 *    cause a mis-tap.
 *  - The ember glow stacks *on top of* the ink shadow rather than replacing it,
 *    so the control keeps its printed edge and gains heat.
 *  - Focus gets the same glow at lower intensity, plus the global two-layer
 *    focus ring. Keyboard users get the ember treatment too, not a lesser
 *    version.
 *
 * Colour roles follow the brand hierarchy: ember (fiery orange) is the primary
 * action, flare (ember red) is destructive, and Signal Yellow is rationed to
 * confirmation and success. Green is no longer a brand colour at all: it is
 * reserved for in-stock and availability, reachable only through
 * `--status-instock`.
 *
 * Every filled variant pairs a bright fill with INK text, per the contrast
 * contract in globals.css.
 */
const buttonVariants = cva(
  [
    'relative inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-sans font-semibold tracking-tight',
    'border-solid border-ink rounded-md [border-width:var(--outline-ink)]',
    'transition-[transform,box-shadow,background-color] duration-150 ease-out',
    'select-none',
    'disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none',
    'disabled:translate-x-0 disabled:translate-y-0',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        /** Fiery orange. The default call to action. */
        primary: 'bg-ember text-ink hover:bg-ember-deep',
        /** Ember red. Destructive and urgent actions. */
        destructive: 'bg-flare text-ink hover:bg-flare-deep',
        /**
         * Signal Yellow. Confirmation and success ONLY — see note above.
         *
         * Renamed from `volt`: green is no longer a CloudMarket brand colour,
         * and the old name would have kept pointing new work at it.
         */
        confirm: 'bg-signal-yellow text-ink hover:brightness-95',
        /** Cream. Secondary action on dark, and the default on paper panels. */
        paper: 'bg-cream text-ink hover:bg-cream-dim',
        outline: 'bg-transparent text-white border-white/70 hover:bg-white/10',
        ghost:
          'bg-transparent text-white border-transparent shadow-none hover:bg-white/10',
      },
      size: {
        sm: 'h-9 px-3 text-sm [&_svg]:size-4',
        // 44px — the minimum comfortable touch target, and the default because
        // most of this storefront is used one-handed on a phone.
        md: 'h-11 px-5 text-sm [&_svg]:size-4',
        lg: 'h-13 px-7 text-base [&_svg]:size-5',
        icon: 'size-11 [&_svg]:size-5',
      },
      /**
       * Press physics. Applies to every variant — this is interaction
       * feedback, not decoration, and stripping it would cost usability.
       */
      elevated: {
        true: [
          'shadow-panel-sm',
          'hover:-translate-x-px hover:-translate-y-px',
          'active:translate-x-[2px] active:translate-y-[2px]',
          'active:shadow-press',
        ],
        false: 'shadow-none',
      },
    },
    compoundVariants: [
      /**
       * The ember glow is reserved for PRIMARY calls to action.
       *
       * It used to fire on every elevated button, which meant "Cancel",
       * "Keep browsing" and the quantity steppers all glowed as hard as
       * "Place order" — so nothing did. Scoping it to `primary` restores the
       * signal and keeps cart, checkout, account and admin screens calm,
       * where a grid of glowing secondary controls actively hurts scanning.
       *
       * Focus gets the same treatment at lower intensity: keyboard users see
       * the ember, not a lesser version of it.
       */
      {
        variant: 'primary',
        elevated: true,
        class: [
          'hover:shadow-[var(--panel-shadow-sm),var(--glow-ember)]',
          'focus-visible:shadow-[var(--panel-shadow-sm),var(--glow-ember-soft)]',
          'active:shadow-[var(--panel-shadow-press),var(--glow-ember-soft)]',
        ],
      },
      // Ghost has no outline, so it has nothing to cast a shadow from.
      {
        variant: 'ghost',
        elevated: true,
        class: [
          'shadow-none hover:shadow-none focus-visible:shadow-none',
          'hover:translate-x-0 hover:translate-y-0',
          'active:translate-x-0 active:translate-y-0 active:shadow-none',
        ],
      },
    ],
    defaultVariants: {
      variant: 'primary',
      size: 'md',
      elevated: true,
    },
  },
)

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants>

function Button({
  className,
  variant,
  size,
  elevated,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, elevated }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
