import Image from 'next/image'

import wordmarkArt from '@/brand/production/logo/cloudmarket-wordmark.png'
import { cn } from '@/lib/utils'

/**
 * CloudMarketWordmark — the approved brush wordmark.
 *
 * A wrapper, not a drawing. The artwork is the approved production file and is
 * never redrawn, recoloured or recropped here; this component only decides how
 * it is sized, described and loaded.
 *
 * No layout shift: the asset is a static import, so next/image receives the
 * intrinsic 2172x724 dimensions at build time and reserves the correct box
 * before any bytes arrive.
 *
 * Accessibility. The wordmark IS the company name rendered as art, so by
 * default it carries "CloudMarket" as its accessible name. When it sits inside
 * something already labelled — a link to home with its own `aria-label`, or
 * beside a visible "CloudMarket" heading — pass `decorative` so the name is not
 * announced twice.
 *
 * The artwork is white brush lettering with fire and smoke, so it needs a dark
 * plate behind it. It must not be placed on Pearl, on Cloud White, or on
 * photography without a solid dark backing.
 */

const WIDTHS = {
  sm: 'max-w-[12rem]',
  md: 'max-w-xs',
  lg: 'max-w-xl',
  full: 'max-w-full',
} as const

type CloudMarketWordmarkProps = {
  size?: keyof typeof WIDTHS
  /** Hides it from assistive technology. Use inside an already-labelled link. */
  decorative?: boolean
  /** Above the fold only — the gate hero and little else. */
  priority?: boolean
  className?: string
}

export function CloudMarketWordmark({
  size = 'md',
  decorative = false,
  priority = false,
  className,
}: CloudMarketWordmarkProps) {
  return (
    <Image
      src={wordmarkArt}
      alt={decorative ? '' : 'CloudMarket'}
      aria-hidden={decorative || undefined}
      priority={priority}
      sizes="(min-width: 1024px) 576px, 90vw"
      className={cn('h-auto w-full', WIDTHS[size], className)}
    />
  )
}
