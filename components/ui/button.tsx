import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Button.
 *
 * The press is physical: the control sits on a hard ink shadow, lifts 1px on
 * hover, and on `:active` drops *into* the page — travelling down-right while
 * the shadow collapses to 1px. Total travel is 2px, which reads as a stamp
 * hitting paper without ever moving the hit target far enough to cause a
 * mis-tap.
 *
 * Every filled variant pairs a bright fill with INK text, per the contrast
 * contract in globals.css. `outline` and `ghost` are the only variants that put
 * cream on charcoal, and both clear 15:1.
 *
 * No `asChild`: Radix Slot is not a dependency here. For links, spread
 * `buttonVariants({ variant, size })` onto an anchor or `next/link`.
 */
const buttonVariants = cva(
  [
    'relative inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-sans font-semibold tracking-tight',
    'border-solid border-ink rounded-md [border-width:var(--outline-ink)]',
    'transition-[transform,box-shadow,background-color] duration-100 ease-out',
    'select-none',
    // Disabled must not look pressable: the shadow goes, so does the lift.
    'disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none',
    'disabled:translate-x-0 disabled:translate-y-0',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-volt text-ink hover:bg-volt-deep',
        accent: 'bg-ember text-ink hover:bg-ember-deep',
        destructive: 'bg-flare text-ink hover:brightness-110',
        paper: 'bg-cream text-ink hover:bg-cream-dim',
        outline: 'bg-transparent text-cream border-cream/70 hover:bg-cream/10',
        ghost:
          'bg-transparent text-cream border-transparent shadow-none hover:bg-cream/10 hover:text-cream',
      },
      size: {
        sm: 'h-9 px-3 text-sm [&_svg]:size-4',
        // 44px — the minimum comfortable touch target, and the default because
        // most of this storefront is used one-handed on a phone.
        md: 'h-11 px-5 text-sm [&_svg]:size-4',
        lg: 'h-13 px-7 text-base [&_svg]:size-5',
        icon: 'size-11 [&_svg]:size-5',
      },
      elevated: {
        true: 'shadow-panel-sm hover:-translate-x-px hover:-translate-y-px active:translate-x-[2px] active:translate-y-[2px] active:shadow-press',
        false: 'shadow-none',
      },
    },
    compoundVariants: [
      // Ghost has no outline, so it has nothing to cast a shadow from.
      {
        variant: 'ghost',
        elevated: true,
        class: 'shadow-none hover:translate-x-0 hover:translate-y-0',
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
