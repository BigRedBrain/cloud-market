import type * as React from 'react'

import { CLOUD_SILHOUETTE_PATH } from '@/components/brand/cloud-geometry'
import { cn } from '@/lib/utils'

/**
 * LoadingCloud — the brand's waiting state.
 *
 * A Pearl cloud with smoke rising inside it and one Signal Yellow spark. The
 * same silhouette as the logo and the cloud button, so waiting still looks like
 * CloudMarket rather than like a generic spinner.
 *
 * Built entirely from keyframes that already exist in globals.css
 * (`smoke-rise`, `fade-in`) — this component adds no CSS of its own and pulls
 * in no animation library.
 *
 * Reduced motion. Those keyframes are declared only inside a
 * `prefers-reduced-motion: no-preference` block, so the drift stops on its own.
 * That alone would leave each puff at its `opacity: 0` start value — an empty
 * cloud — so the resting opacity is restored explicitly with a
 * `motion-reduce:` utility per puff. A reduced-motion visitor gets a complete,
 * still cloud rather than a hollow one. This is the one place the component has
 * to do work instead of inheriting the behaviour.
 *
 * Accessibility. A loading indicator that conveys state needs to announce it,
 * so `label` renders as screen-reader-only text inside a `role="status"`
 * region: the wait is announced without stealing focus. When the surrounding
 * UI already announces the wait — a skeleton grid with its own status — pass
 * `decorative` and the cloud drops out of the accessibility tree entirely.
 */

const SIZES = {
  sm: 'h-8',
  md: 'h-14',
  lg: 'h-24',
} as const

/**
 * Co-prime periods, so the puffs never visibly rise in lockstep.
 *
 * `restClass` is the reduced-motion resting opacity. It is a literal class
 * rather than a computed value because Tailwind resolves arbitrary values at
 * build time and cannot see an interpolated string.
 */
const PUFFS = [
  {
    cx: 68,
    cy: 74,
    rx: 20,
    ry: 13,
    duration: '4.3s',
    delay: '0s',
    restClass: 'motion-reduce:opacity-[0.16]',
  },
  {
    cx: 118,
    cy: 80,
    rx: 25,
    ry: 15,
    duration: '5.1s',
    delay: '1.1s',
    restClass: 'motion-reduce:opacity-[0.12]',
  },
  {
    cx: 152,
    cy: 76,
    rx: 17,
    ry: 11,
    duration: '4.7s',
    delay: '2.3s',
    restClass: 'motion-reduce:opacity-[0.10]',
  },
] as const

type LoadingCloudProps = {
  size?: keyof typeof SIZES
  /** Announced to screen readers. Ignored when `decorative`. */
  label?: string
  /** Hides it from assistive technology — for when something else announces. */
  decorative?: boolean
  className?: string
}

export function LoadingCloud({
  size = 'md',
  label = 'Loading',
  decorative = false,
  className,
}: LoadingCloudProps) {
  const clipId = 'loading-cloud-clip'

  const art = (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 200 96"
      className={cn('w-auto', SIZES[size])}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={CLOUD_SILHOUETTE_PATH} />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        <path d={CLOUD_SILHOUETTE_PATH} fill="var(--pearl)" />

        {PUFFS.map((puff) => (
          <ellipse
            key={puff.cx}
            cx={puff.cx}
            cy={puff.cy}
            rx={puff.rx}
            ry={puff.ry}
            fill="var(--smoke-gray)"
            opacity="0"
            className={cn(
              'animate-[smoke-rise_var(--puff-duration)_ease-out_infinite]',
              'motion-reduce:animate-none',
              puff.restClass,
            )}
            style={
              {
                '--puff-duration': puff.duration,
                animationDelay: puff.delay,
                transformOrigin: `${puff.cx}px ${puff.cy}px`,
              } as React.CSSProperties
            }
          />
        ))}
      </g>

      {/* One spark. Restrained: heat as punctuation, not as a second subject. */}
      <circle
        cx="168"
        cy="26"
        r="5"
        fill="var(--signal-yellow)"
        stroke="var(--dark-smoke-deep)"
        strokeWidth="2"
        className="animate-[fade-in_600ms_ease-out_both] motion-reduce:animate-none"
      />

      {/* Ink outline last, so it sits above the fill and the smoke. */}
      <path
        d={CLOUD_SILHOUETTE_PATH}
        fill="none"
        stroke="var(--dark-smoke-deep)"
        strokeWidth="4"
        strokeLinejoin="round"
      />
    </svg>
  )

  if (decorative) {
    return (
      <span aria-hidden="true" className={cn('inline-flex', className)}>
        {art}
      </span>
    )
  }

  return (
    <span role="status" className={cn('inline-flex', className)}>
      {art}
      <span className="sr-only">{label}</span>
    </span>
  )
}
