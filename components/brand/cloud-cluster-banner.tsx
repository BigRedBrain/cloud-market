import type * as React from 'react'

import {
  buildBannerClusters,
  buildCloudCluster,
} from '@/components/brand/cloud-puffs'
import { CloudShape } from '@/components/brand/cloud-shape'
import { cn } from '@/lib/utils'

/**
 * CloudClusterBanner — a wide band built from SEVERAL clouds, not one wide one.
 *
 * Stretching a single silhouette across a banner smears the lobes and thins the
 * outline on one axis, which reads as a graphic border rather than as weather.
 * Here the width comes from the arrangement: a dominant central cloud with
 * supporting clouds drifting behind it.
 *
 * LAYER ORDER IS EXPLICIT, NOT INCIDENTAL
 *
 *   z-0   supporting clouds   (decorative backdrop)
 *   z-10  central content cloud
 *   z-20  headline and body copy
 *
 * This is the fix for seams cutting through the headline. Previously the text
 * sat over whichever cloud edges happened to land underneath it, so a
 * supporting cloud's outline could run straight through a word. Now the central
 * cloud owns a predictable rectangular safe area and is painted above its
 * neighbours, so no decorative edge can cross the type. The neighbours still
 * overlap it — behind — which is what preserves the illusion of several clouds
 * floating together.
 *
 * The z-indexes are declared rather than left to DOM order, because the content
 * wrapper carries `z-10` and therefore establishes a stacking context: its own
 * cloud sits at `-z-10` inside that context and still paints above every
 * supporting cloud outside it.
 *
 * Motion: each supporting cloud drifts vertically a few pixels on its own
 * period, so the bank never bobs in unison. Transform only, no JavaScript. The
 * keyframe is declared inside `prefers-reduced-motion: no-preference`, so a
 * reduced-motion visitor gets the full composition holding perfectly still.
 */

type CloudClusterBannerProps = {
  children: React.ReactNode
  /** Supporting clouds behind the central one. 2–5 reads best. */
  count?: number
  /** Changes the whole arrangement. Same seed, same banner. */
  seed?: number
  surface?: 'pearl' | 'cloud-white'
  /** Vendor accent. Presentational only. */
  glowColor?: string
  className?: string
}

export function CloudClusterBanner({
  children,
  count = 5,
  seed = 1,
  surface = 'pearl',
  glowColor,
  className,
}: CloudClusterBannerProps) {
  const supporting = buildBannerClusters(seed, count)
  // The central cloud is its own cluster, sized to the content box.
  const centre = buildCloudCluster({ seed: seed + 501, width: 400, height: 240 })

  return (
    <div className={cn('relative isolate', className)}>
      {/*
       * Supporting clouds. Inert, and clipped: the end clouds bleed past the
       * band on purpose so the bank reads as continuing offscreen, and without
       * clipping that bleed would become real page width.
       */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
      >
        {supporting.map((entry, index) => (
          <div
            key={`${seed}-${index}`}
            className={cn(
              'absolute aspect-5/3',
              'animate-[cloud-float_var(--float-duration)_ease-in-out_infinite_alternate]',
              'motion-reduce:animate-none',
              // The outermost clouds are dropped on small screens, where they
              // sit mostly offscreen and only add weight.
              entry.optional && 'hidden sm:block',
            )}
            style={
              {
                left: `${entry.left}%`,
                height: `${entry.height}%`,
                top: `${entry.top}%`,
                // Centre each cloud on its left coordinate, so the spread stays
                // even regardless of how wide the cloud turns out.
                transform: 'translateX(-50%)',
                '--float-duration': entry.floatDuration,
                animationDelay: entry.floatDelay,
              } as React.CSSProperties
            }
          >
            <CloudShape
              cluster={entry.cluster}
              id={`banner-${seed}-${index}`}
              surface={surface}
              shadow={entry.depth === 'front'}
              // No bloom and no grit back here: supporting clouds are backdrop,
              // and detail at this depth only competes with the centre.
              grit={false}
              outline={7}
            />
          </div>
        ))}
      </div>

      {/*
       * Central content cloud. `z-10` puts it above every supporting cloud and
       * makes this element a stacking context, so its own `-z-10` cloud stays
       * inside it rather than falling behind the backdrop.
       */}
      <div className="relative z-10 mx-auto w-full max-w-md px-10 py-16 text-center sm:max-w-xl sm:px-16 sm:py-20">
        <CloudShape
          cluster={centre}
          id={`banner-centre-${seed}`}
          surface={surface}
          glowColor={glowColor}
          className="absolute inset-0 -z-10"
        />

        <BannerSparks glowColor={glowColor} />

        <div className="relative z-20">{children}</div>
      </div>
    </div>
  )
}

/**
 * GlowingHeadline — illuminated comic lettering.
 *
 * This carries the STRONGEST glow in the system, deliberately. The hierarchy is
 * headline first, spark marks second, cloud bloom a distant third; inverting it
 * turns the banner into a neon object, which is the opposite of the brief. The
 * goal is glowing lettering floating inside gritty clouds.
 *
 * The glow is a stack of small text-shadows rather than one big soft one, which
 * is the difference between illuminated ink and a neon sign. The fill stays a
 * solid, fully opaque colour underneath, so the words are legible at full
 * contrast even if the shadows are stripped — by a forced-colours mode, an
 * older browser, or a user stylesheet. The glow is decoration; it never carries
 * meaning on its own.
 *
 * Permanent Marker by default, per the brand rules for display type. Body copy
 * beneath a headline stays in Archivo and never glows.
 */
export function GlowingHeadline({
  children,
  glowColor,
  className,
  as: Tag = 'h4',
}: {
  children: React.ReactNode
  glowColor?: string
  className?: string
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'p'
}) {
  return (
    <Tag
      className={cn(
        'font-brand text-lg leading-tight text-ink sm:text-3xl',
        className,
      )}
      style={
        glowColor
          ? {
              textShadow: [
                `0 0 1px ${glowColor}`,
                `0 0 6px ${glowColor}`,
                `0 0 15px ${glowColor}`,
                `0 0 30px ${glowColor}`,
              ].join(', '),
            }
          : undefined
      }
    >
      {children}
    </Tag>
  )
}

/**
 * BannerSparks — the middle tier of the glow hierarchy.
 *
 * Small four-point marks picking up the vendor accent: loud enough to tie the
 * headline to the cloud, quiet enough never to compete with it. Purely
 * decorative, so they are hidden from assistive technology, and they fall back
 * to ink when no accent is set — they never depend on colour to be visible.
 */
export function BannerSparks({ glowColor }: { glowColor?: string }) {
  const fill = glowColor ?? 'var(--dark-smoke-deep)'
  const marks = [
    { key: 'a', className: 'top-6 left-8 size-3', opacity: 0.9 },
    { key: 'b', className: 'top-10 right-10 size-4', opacity: 0.75 },
    { key: 'c', className: 'bottom-8 left-14 size-2.5', opacity: 0.6 },
  ]

  return (
    <>
      {marks.map((mark) => (
        <svg
          key={mark.key}
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 100 100"
          className={cn('pointer-events-none absolute z-10', mark.className)}
          style={{
            opacity: mark.opacity,
            filter: glowColor ? `drop-shadow(0 0 4px ${glowColor})` : undefined,
          }}
        >
          <path
            d="M50 4 L58 42 L96 50 L58 58 L50 96 L42 58 L4 50 L42 42 Z"
            fill={fill}
          />
        </svg>
      ))}
    </>
  )
}
