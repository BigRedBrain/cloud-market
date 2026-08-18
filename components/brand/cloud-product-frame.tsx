import Image, { type StaticImageData } from 'next/image'
import type * as React from 'react'

import { buildCloudCluster } from '@/components/brand/cloud-puffs'
import { CloudShape } from '@/components/brand/cloud-shape'
import { cn } from '@/lib/utils'

/**
 * CloudProductFrame — a product card shaped like a comic cloud.
 *
 * The rule the spec is most insistent about: the cloud must never make a name
 * or a price hard to scan. So the two concerns never touch.
 *
 *   - The cloud is an `aria-hidden` SVG on its own layer with
 *     `pointer-events: none`. It is scenery.
 *   - Everything readable lives in an ordinary rectangular flow box with
 *     ordinary padding. Nothing is clipped to a lobe, no text follows a curve,
 *     and a long name wraps and grows the box downward exactly as it would in a
 *     plain div — the silhouette simply follows.
 *
 * The thumbnail sits inside that same rectangular region, so it can never be
 * cut by a lobe. It keeps its aspect ratio through `object-cover` on a square
 * box and carries its own ink outline, matching the reference.
 *
 * Server component. No client JavaScript.
 */

type ProductImage = {
  src: StaticImageData | string
  /** Real alt text. Pass an empty string only if the image is truly redundant. */
  alt: string
}

type CloudProductFrameProps = {
  /** Category / strain line above the name. */
  eyebrow?: string
  name: string
  /** Pack size, e.g. "3.5g". */
  size?: string
  /** Verified potency or similar. Never invent one — omit when unknown. */
  data?: string
  /** Pre-formatted. The component does no money maths. */
  price?: string
  badge?: React.ReactNode
  image?: ProductImage
  /**
   * Vendor accent. Presentational only — drives the outer bloom and the small
   * spark marks, never the cloud body, the ink outline, or any body copy.
   */
  glowColor?: string
  surface?: 'pearl' | 'cloud-white'
  /** Changes which irregular cloud is drawn. Same seed, same cloud. */
  seed?: number
  className?: string
}

export function CloudProductFrame({
  eyebrow,
  name,
  size,
  data,
  price,
  badge,
  image,
  glowColor,
  surface = 'pearl',
  seed = 1,
  className,
}: CloudProductFrameProps) {
  const cluster = buildCloudCluster({ seed, width: 400, height: 240 })
  const id = `cloud-product-${seed}`

  return (
    <div className={cn('relative isolate', className)}>
      <CloudShape
        cluster={cluster}
        id={id}
        surface={surface}
        glowColor={glowColor}
        className="absolute inset-0 -z-10"
      />

      {/*
       * The safe rectangular region.
       *
       * The padding looks extravagant and is not: the guaranteed-opaque core of
       * the cluster spans about 78% of its width but only 46% of its height, so
       * the box has to be roughly 2x the content's own height for the content
       * to sit inside solid cloud. Anything less and the corners of the text
       * block hang off the silhouette into open air — which is exactly what the
       * first attempt got wrong.
       *
       * It is also what the reference does: a lot of cloud around a modest
       * block of type.
       */}
      <div className="relative flex items-center gap-5 px-10 py-16 sm:gap-7 sm:px-16 sm:py-20">
        {image && (
          <div className="shrink-0">
            <div
              className="relative size-20 overflow-hidden rounded-md border-4 border-dark-smoke-deep bg-dark-smoke sm:size-28"
              // Hard zero-blur offset, matching the panels elsewhere in the
              // system. A blurred shadow here would read as soft-UI elevation
              // and fight the printed-ink language of everything around it.
              style={{ boxShadow: "4px 4px 0 0 var(--dark-smoke-deep)" }}
            >
              <Image
                src={image.src}
                alt={image.alt}
                fill
                sizes="(min-width: 640px) 112px, 80px"
                className="object-cover"
              />
            </div>
          </div>
        )}

        <div className="min-w-0 flex-1 text-ink">
          {badge && <div className="mb-2">{badge}</div>}

          {eyebrow && (
            <p className="font-data text-[0.625rem] tracking-[0.18em] uppercase opacity-70">
              {eyebrow}
            </p>
          )}

          <h4 className="mt-1 font-poster text-xl leading-tight tracking-tight uppercase sm:text-2xl">
            {name}
          </h4>

          {(size || data) && (
            <p className="mt-1 font-data text-xs opacity-75">
              {[size, data].filter(Boolean).join(' · ')}
            </p>
          )}

          {price && (
            <>
              {/* Rule, matching the reference. Decorative, so it is hidden. */}
              <hr
                aria-hidden="true"
                className="mt-2.5 w-16 border-0 border-t-2 border-dark-smoke-deep opacity-60"
              />
              <p className="mt-2 font-data text-xl font-bold sm:text-2xl">
                {price}
              </p>
            </>
          )}
        </div>
      </div>

      {/*
       * Spark marks. Purely decorative punctuation — they take the vendor
       * accent when one is set and fall back to ink, so they never depend on
       * colour to be visible.
       */}
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 100 100"
        className="pointer-events-none absolute top-6 left-6 size-4 opacity-80"
      >
        <path
          d="M50 6 L58 42 L94 50 L58 58 L50 94 L42 58 L6 50 L42 42 Z"
          fill={glowColor ?? 'var(--dark-smoke-deep)'}
        />
      </svg>
    </div>
  )
}
