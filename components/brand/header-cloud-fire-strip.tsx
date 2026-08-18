import Image from 'next/image'

import stripArt from '@/brand/production/motion/cloudmarket-header-cloud-fire-strip.png'
import { cn } from '@/lib/utils'

/**
 * HeaderCloudFireStrip — atmospheric band for behind a header.
 *
 * The approved artwork is built for exactly this: smoke and fire massed along
 * the left and right with the centre deliberately left empty, so a logo and
 * navigation can sit in the gap without fighting the illustration.
 *
 * Purely decorative and structurally inert:
 *   - `aria-hidden`, so it never reaches the accessibility tree.
 *   - `pointer-events-none`, so it can never intercept a click meant for a nav
 *     link — the spec is explicit that mascot and header motion must never
 *     block navigation.
 *   - absolutely positioned behind its container's content on a negative
 *     z-index, so it participates in no layout.
 *
 * Readability is the caller's other half of the contract. `intensity` exists
 * because the strip sits *under* text: at `ambient` it is faint enough that
 * nav labels keep their contrast, and `full` should be reserved for bands with
 * no text over the busy edges.
 *
 * NOT wired into SiteNav. This is an isolated primitive; header integration is
 * a later, separate step.
 */

const INTENSITY = {
  ambient: 'opacity-40',
  full: 'opacity-100',
} as const

type HeaderCloudFireStripProps = {
  intensity?: keyof typeof INTENSITY
  /** Flips it, so a footer band does not mirror the header exactly. */
  flip?: boolean
  className?: string
}

export function HeaderCloudFireStrip({
  intensity = 'ambient',
  flip = false,
  className,
}: HeaderCloudFireStripProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 -z-10 overflow-hidden select-none',
        // Contain paint so the strip can never influence layout outside itself.
        '[contain:paint]',
        INTENSITY[intensity],
        className,
      )}
    >
      <Image
        src={stripArt}
        alt=""
        sizes="100vw"
        className={cn(
          'h-full w-full object-cover object-bottom',
          flip && 'scale-y-[-1]',
        )}
      />
    </div>
  )
}
