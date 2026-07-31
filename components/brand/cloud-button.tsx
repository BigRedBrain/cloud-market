'use client'

import { motion, useReducedMotion } from 'motion/react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The Cloud Button — Cloud Market's signature control.
 *
 * A cloud silhouette that smoulders: smoke drifts inside the shape, and the
 * outer edge catches fire on hover and on keyboard focus.
 *
 * Three implementation decisions worth knowing:
 *
 * 1. The glow is a CSS `drop-shadow` filter, not a `box-shadow`. drop-shadow
 *    follows the element's alpha channel, so the fire hugs the cloud's actual
 *    lobed edge instead of a rectangle around it. It is also GPU-composited,
 *    so igniting it costs no layout or paint.
 *
 * 2. The SVG stretches with `preserveAspectRatio="none"` so the button sizes to
 *    its label rather than forcing a fixed width. Non-uniform scaling would
 *    normally smear the ink outline to different weights on the horizontal and
 *    vertical, so the path carries `vector-effect="non-scaling-stroke"` and the
 *    line stays a constant 2px at every size.
 *
 * 3. Only the smoke uses Framer Motion. The lift and press are plain CSS
 *    transitions — cheaper, and they inherit the global reduced-motion reset in
 *    globals.css for free.
 *
 * Reduced motion: the smoke stops drifting and settles into a static haze, and
 * the lift is neutralised by the global reset. The glow, focus ring, and press
 * feedback all remain, because those communicate state rather than decorate it.
 */

/** Puffy four-lobe cloud with a flat base. Drawn once, reused as clip and ink. */
const CLOUD_PATH =
  'M30 88 C12 88 4 74 12 61 C4 46 18 30 36 34 C42 14 70 8 84 22 ' +
  'C96 6 128 6 140 24 C160 16 182 30 178 50 C196 54 200 78 184 88 Z'

const SIZES = {
  sm: 'h-12 px-6 text-sm',
  md: 'h-14 px-8 text-base',
  lg: 'h-16 px-10 text-lg',
} as const

type CloudButtonProps = React.ComponentProps<'button'> & {
  size?: keyof typeof SIZES
}

/** Smoke puffs, expressed as data so the markup stays legible. */
const PUFFS = [
  { cx: 62, cy: 76, rx: 20, ry: 13, delay: 0, duration: 7 },
  { cx: 118, cy: 82, rx: 26, ry: 15, delay: 1.6, duration: 8.5 },
  { cx: 158, cy: 78, rx: 18, ry: 12, delay: 3.4, duration: 7.8 },
  { cx: 92, cy: 84, rx: 22, ry: 12, delay: 5, duration: 9 },
]

export function CloudButton({
  className,
  children,
  size = 'md',
  type = 'button',
  ...props
}: CloudButtonProps) {
  const reduceMotion = useReducedMotion()
  const gradientId = 'cloud-btn-fill'
  const clipId = 'cloud-btn-clip'
  const halftoneId = 'cloud-btn-halftone'

  return (
    <button
      type={type}
      className={cn(
        'group relative isolate inline-flex items-center justify-center',
        'font-display tracking-wide uppercase text-ink',
        // The lift, and the press that overrides it.
        'transition-transform duration-150 ease-out',
        'hover:-translate-y-0.5 active:translate-y-px',
        'disabled:pointer-events-none disabled:opacity-50',
        SIZES[size],
        className,
      )}
      {...props}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 200 96"
        preserveAspectRatio="none"
        className={cn(
          'absolute inset-0 -z-10 h-full w-full',
          'transition-[filter] duration-300 ease-out',
          // Ember core, flare halo. Ignites on pointer hover AND keyboard focus.
          'group-hover:[filter:drop-shadow(0_0_6px_var(--ember))_drop-shadow(0_0_16px_var(--flare))]',
          'group-focus-visible:[filter:drop-shadow(0_0_6px_var(--ember))_drop-shadow(0_0_16px_var(--flare))]',
          // Pressed: the fire dims, as if pushed into the page.
          'group-active:[filter:drop-shadow(0_0_3px_var(--ember))]',
        )}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--volt)" />
            <stop offset="100%" stopColor="var(--ember)" />
          </linearGradient>

          <clipPath id={clipId}>
            <path d={CLOUD_PATH} />
          </clipPath>

          {/* Comic halftone shading, confined to the cloud interior. */}
          <pattern
            id={halftoneId}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1.5" cy="1.5" r="1" fill="var(--ink-950)" opacity="0.22" />
          </pattern>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          <rect width="200" height="96" fill={`url(#${gradientId})`} />

          {PUFFS.map((puff, index) => (
            <motion.ellipse
              key={index}
              cx={puff.cx}
              rx={puff.rx}
              ry={puff.ry}
              fill="var(--cream)"
              initial={false}
              animate={
                reduceMotion
                  ? { cy: puff.cy - 18, opacity: 0.14 }
                  : {
                      cy: [puff.cy, puff.cy - 46],
                      opacity: [0, 0.22, 0],
                      scale: [0.85, 1.15],
                    }
              }
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : {
                      duration: puff.duration,
                      delay: puff.delay,
                      repeat: Infinity,
                      ease: 'easeOut',
                    }
              }
              style={{ transformOrigin: `${puff.cx}px ${puff.cy}px` }}
            />
          ))}

          <rect width="200" height="96" fill={`url(#${halftoneId})`} />
        </g>

        {/* Ink outline drawn last so it sits above the fill and the smoke. */}
        <path
          d={CLOUD_PATH}
          fill="none"
          stroke="var(--ink-950)"
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <span className="relative">{children}</span>
    </button>
  )
}
