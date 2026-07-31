import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Loading states.
 *
 * Skeletons keep the ink outline of the thing they stand in for, so the page
 * does not reflow when content lands — the panel is already the right size and
 * shape, it is just empty. The shimmer is a background-position animation on a
 * gradient, which composites without repainting.
 *
 * `prefers-reduced-motion` is handled by the global reset in globals.css: the
 * shimmer stops and the skeleton becomes a flat block, which still reads
 * correctly as "not loaded yet".
 */

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-sm bg-ink-700',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Product card skeleton. Mirrors ProductCard's exact geometry so the swap from
 * loading to loaded shifts nothing — cumulative layout shift on a catalogue
 * grid is both a ranking penalty and a genuine mis-tap hazard.
 */
function ProductCardSkeleton() {
  return (
    <div className="panel rounded-lg bg-card p-0">
      <Skeleton className="aspect-4/3 w-full rounded-none rounded-t-md" />
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <div className="mt-2 flex items-center justify-between">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    </div>
  )
}

/**
 * Inline busy indicator for buttons mid-submit. Announced politely so a screen
 * reader user learns the order is being placed without the message stealing
 * focus from the flow.
 */
function Spinner({ label = 'Working' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      />
      <span className="sr-only">{label}</span>
    </span>
  )
}

export { Skeleton, ProductCardSkeleton, Spinner }
