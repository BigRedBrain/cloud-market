import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The Cloud Button — Cloud Market's signature control.
 *
 * A cloud silhouette that smoulders: smoke drifts inside the shape, flames lick
 * the underside on hover, and the outer edge catches fire on hover and on
 * keyboard focus.
 *
 * **Zero client JavaScript.** This is a server component. It was originally
 * built on Framer Motion, and the performance audit measured that dependency at
 * ~53 KB gzip on the homepage's critical path — for four drifting ellipses. All
 * of it is now CSS keyframes, which run off the main thread and cost nothing to
 * download. The brief's "SVG or CSS-based smoke and flame effects where
 * possible" is doing real work here, not just aesthetics.
 *
 * Three other decisions worth knowing:
 *
 * 1. The glow is a CSS `drop-shadow` filter, not `box-shadow`. drop-shadow
 *    follows the element's alpha channel, so the fire hugs the cloud's lobed
 *    edge instead of a rectangle around it, and it composites on the GPU.
 *
 * 2. The SVG stretches with `preserveAspectRatio="none"` so the button sizes to
 *    its label. Non-uniform scaling would smear the ink outline to different
 *    weights on each axis, so the path carries `vector-effect="non-scaling-stroke"`
 *    and the line stays a constant 2px at every size.
 *
 * 3. Flames are drawn behind the clipped fill, so only their tips show past the
 *    cloud's lower edge — the fire reads as coming from behind the silhouette
 *    rather than painted onto it.
 *
 * Reduced motion: every keyframe here is declared inside a
 * `prefers-reduced-motion: no-preference` block, so the smoke and flames simply
 * hold still. The glow, focus ring, and pressed state all remain, because those
 * communicate state rather than decorate it.
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

/** Smoke puffs. Co-prime periods so the loop never visibly repeats. */
const PUFFS = [
  { cx: 62, cy: 76, rx: 20, ry: 13, delay: '0s', duration: '7s' },
  { cx: 118, cy: 82, rx: 26, ry: 15, delay: '1.6s', duration: '8.5s' },
  { cx: 158, cy: 78, rx: 18, ry: 12, delay: '3.4s', duration: '7.9s' },
  { cx: 92, cy: 84, rx: 22, ry: 12, delay: '5s', duration: '9.1s' },
]

const FLAMES = [
  { d: 'M52 94 C48 84 60 80 56 70 C68 80 64 90 52 94 Z', delay: '0s' },
  { d: 'M96 96 C91 84 105 80 100 68 C115 80 110 90 96 96 Z', delay: '0.25s' },
  { d: 'M148 94 C144 85 155 81 151 71 C163 80 159 88 148 94 Z', delay: '0.5s' },
]

type CloudButtonProps = React.ComponentProps<'button'> & {
  size?: keyof typeof SIZES
}

export function CloudButton({
  className,
  children,
  size = 'md',
  type = 'button',
  ...props
}: CloudButtonProps) {
  const gradientId = 'cloud-btn-fill'
  const clipId = 'cloud-btn-clip'
  const halftoneId = 'cloud-btn-halftone'

  return (
    <button
      type={type}
      className={cn(
        'group relative isolate inline-flex items-center justify-center',
        'font-poster tracking-wide text-ink uppercase',
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
          'group-hover:[filter:drop-shadow(0_0_6px_var(--ember))_drop-shadow(0_0_16px_var(--flare))]',
          'group-focus-visible:[filter:drop-shadow(0_0_6px_var(--ember))_drop-shadow(0_0_16px_var(--flare))]',
          'group-active:[filter:drop-shadow(0_0_3px_var(--ember))]',
        )}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ember)" />
            <stop offset="100%" stopColor="var(--flare)" />
          </linearGradient>

          <clipPath id={clipId}>
            <path d={CLOUD_PATH} />
          </clipPath>

          <pattern
            id={halftoneId}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1.5" cy="1.5" r="1" fill="var(--ink-950)" opacity="0.22" />
          </pattern>
        </defs>

        {/* Flames behind the body — only their tips clear the lower edge. */}
        <g className="opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
          {FLAMES.map((flame) => (
            <path
              key={flame.d}
              d={flame.d}
              fill="var(--flare)"
              className="animate-[ember-flicker_900ms_ease-in-out_infinite] motion-reduce:animate-none"
              style={{
                transformOrigin: 'center bottom',
                animationDelay: flame.delay,
              }}
            />
          ))}
        </g>

        <g clipPath={`url(#${clipId})`}>
          <rect width="200" height="96" fill={`url(#${gradientId})`} />

          {PUFFS.map((puff) => (
            <ellipse
              key={puff.cx}
              cx={puff.cx}
              cy={puff.cy}
              rx={puff.rx}
              ry={puff.ry}
              fill="var(--cream)"
              opacity="0"
              className="animate-[smoke-rise_var(--puff-duration)_ease-out_infinite] motion-reduce:animate-none motion-reduce:opacity-[0.12]"
              style={
                {
                  '--puff-duration': puff.duration,
                  animationDelay: puff.delay,
                  transformOrigin: `${puff.cx}px ${puff.cy}px`,
                } as React.CSSProperties
              }
            />
          ))}

          <rect width="200" height="96" fill={`url(#${halftoneId})`} />
        </g>

        {/* Ink outline last, so it sits above the fill and the smoke. */}
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
