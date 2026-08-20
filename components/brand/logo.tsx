import Image from 'next/image'

import submarkArt from '@/brand/production/logo/cloudmarket-submark.png'
import wordmarkArt from '@/brand/production/logo/cloudmarket-wordmark.png'
import { cn } from '@/lib/utils'

/**
 * CloudMarket logo.
 *
 * This renders the APPROVED production artwork. It previously drew a stroked
 * cloud silhouette in SVG with an Anton "Cloud Market" wordmark beside it —
 * legacy art from the pre-CloudMarket product, and the wrong company name.
 * Nothing is drawn here any more: both variants are the approved files from
 * `brand/production/logo/`, resized for chrome and never redrawn or recoloured.
 *
 * WHY next/image DIRECTLY, RATHER THAN <CloudMarketWordmark>
 *
 * That wrapper sizes by max-width and hard-codes `sizes="(min-width: 1024px)
 * 576px, 90vw"`, which is correct for a hero and badly wrong for a 96px header
 * slot — it would make Next serve a ~576px derivative for a mark a sixth that
 * size, on every page that has a header. This component needs height-driven
 * sizing and its own `sizes`, so it consumes the same approved assets directly.
 *
 * PLACEMENT RULES
 *
 * - Minimum size: the lockup is 96px wide at `full`, which is the documented
 *   floor. The brush strokes and the fire outline close up below that.
 * - Both files are white-and-fire artwork on transparency, so they REQUIRE a
 *   dark backing. `tone="cream"` assumes the surrounding surface is already
 *   dark. `tone="ink"` — used on Pearl paper panels — supplies its own Dark
 *   Smoke plate, because the artwork would otherwise disappear into the panel.
 *   That is why tone is still binary rather than a free colour.
 * - The artwork is never rotated, recoloured, or stretched; `w-auto` with a
 *   fixed height preserves the intrinsic ratio (wordmark 3:1, submark 1:1).
 *
 * No layout shift: both are static imports, so next/image knows the intrinsic
 * dimensions at build time and reserves the box before any bytes arrive.
 */

type LogoProps = {
  variant?: 'full' | 'mark' | 'stacked'
  tone?: 'cream' | 'ink'
  className?: string
  /**
   * Whether the logo carries the accessible name. Set false inside a link that
   * already has its own `aria-label`, so the name is not announced twice.
   */
  showLabel?: boolean
}

/** Dark plate for paper panels — see the tone note above. */
const PLATE = 'rounded-md bg-dark-smoke'

export function Logo({
  variant = 'full',
  tone = 'cream',
  className,
  showLabel = true,
}: LogoProps) {
  const alt = showLabel ? 'CloudMarket' : ''
  const hidden = showLabel ? undefined : true
  const onPaper = tone === 'ink'

  if (variant === 'mark') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center',
          onPaper && `${PLATE} p-1`,
          className,
        )}
      >
        <Image
          src={submarkArt}
          alt={alt}
          aria-hidden={hidden}
          sizes="48px"
          className="h-7 w-auto"
        />
      </span>
    )
  }

  if (variant === 'stacked') {
    return (
      <span
        className={cn(
          'inline-flex flex-col items-center gap-2 p-3',
          onPaper && PLATE,
          className,
        )}
      >
        <Image
          src={submarkArt}
          alt=""
          aria-hidden
          sizes="96px"
          className="h-12 w-auto"
        />
        <Image
          src={wordmarkArt}
          alt={alt}
          aria-hidden={hidden}
          sizes="192px"
          className="h-8 w-auto"
        />
      </span>
    )
  }

  // full — the horizontal lockup. The wordmark artwork already carries the
  // cloud, smoke and fire treatment, so it stands alone: pairing it with the
  // submark here would state the brand twice and double the header footprint.
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center p-2',
        onPaper && PLATE,
        className,
      )}
    >
      <Image
        src={wordmarkArt}
        alt={alt}
        aria-hidden={hidden}
        sizes="128px"
        className="h-8 w-auto"
      />
    </span>
  )
}
