import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Card — a comic panel.
 *
 * Thick ink outline, hard zero-blur offset shadow. The shadow is the whole
 * idea: a blurred shadow reads as soft-UI elevation, a hard one reads as
 * printed ink with the page showing through behind it.
 *
 * `surface="paper"` flips the panel to cream via the token scope in
 * globals.css — every child colour inverts with it. Use it for content lifted
 * out of the dark world: order summaries, receipts, legal copy.
 */

type CardProps = React.ComponentProps<'div'> & {
  surface?: 'ink' | 'paper'
  interactive?: boolean
}

function Card({
  className,
  surface = 'ink',
  interactive = false,
  ...props
}: CardProps) {
  return (
    <div
      data-surface={surface === 'paper' ? 'paper' : undefined}
      className={cn(
        'panel relative rounded-lg bg-card text-card-foreground',
        interactive && [
          'transition-transform duration-100 ease-out',
          'hover:-translate-x-0.5 hover:-translate-y-0.5',
          'focus-within:-translate-x-0.5 focus-within:-translate-y-0.5',
        ],
        className,
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      className={cn('font-display text-xl leading-tight tracking-tight', className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      className={cn('font-sans text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('p-4 pt-0', className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('flex items-center gap-3 p-4 pt-0', className)} {...props} />
  )
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
