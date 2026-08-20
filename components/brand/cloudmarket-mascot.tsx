import Image, { type StaticImageData } from 'next/image'

import headerMascotArt from '@/brand/production/motion/cloudmarket-header-mascot.png'
import primaryMascotArt from '@/brand/production/mascot/cloudmarket-mascot-primary.png'
import { cn } from '@/lib/utils'

/**
 * CloudMarketMascot — the approved bud mascot pushing the cart.
 *
 * A wrapper around approved artwork. Nothing is redrawn, recoloured or
 * recropped; the component chooses which approved derivative to render, how it
 * is sized, and whether it is announced.
 *
 * Two derivatives, two shapes:
 *   - `primary` (1254x1254, square) — the hero pose. Feature panels, empty
 *     states, application screens.
 *   - `header` (2172x724, 3:1) — the wide traverse artwork, cut for a header
 *     band or a banner where a square would crop badly.
 *
 * Accessibility is a decision the caller has to make, so it is a required-ish
 * prop rather than a guess. The mascot is usually decoration sitting beside
 * copy that already says the thing — in which case `decorative` keeps it out of
 * the accessibility tree entirely. When it genuinely carries meaning (an empty
 * state whose only content is the illustration), pass `alt` instead.
 *
 * Never `priority`: the mascot is an enhancement, not a dependency, and must
 * never compete with real content for the critical path.
 */

const ART: Record<'primary' | 'header', StaticImageData> = {
  primary: primaryMascotArt,
  header: headerMascotArt,
}

const DEFAULT_SIZES: Record<'primary' | 'header', string> = {
  primary: '(min-width: 1024px) 420px, 60vw',
  header: '(min-width: 1024px) 900px, 95vw',
}

type CloudMarketMascotProps = {
  variant?: 'primary' | 'header'
  className?: string
  /** Responsive `sizes`. Override when the render box is unusual. */
  sizes?: string
} & (
  | { decorative: true; alt?: never }
  | { decorative?: false; alt: string }
)

export function CloudMarketMascot({
  variant = 'primary',
  decorative,
  alt,
  sizes,
  className,
}: CloudMarketMascotProps) {
  return (
    <Image
      src={ART[variant]}
      alt={decorative ? '' : (alt ?? '')}
      aria-hidden={decorative || undefined}
      sizes={sizes ?? DEFAULT_SIZES[variant]}
      className={cn('h-auto w-full', className)}
    />
  )
}
