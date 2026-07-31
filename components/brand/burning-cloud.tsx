import { cn } from '@/lib/utils'

/**
 * Burning cloud — the opening moment.
 *
 * The mark inks itself in (the outline draws, comic-panel style), then catches
 * fire: flames grow up from behind the silhouette and the vents light in ember.
 * Total runtime ~1.5s.
 *
 * **Zero client JavaScript.** A server component. The draw-on uses
 * `pathLength="1"`, which normalises the path so `stroke-dasharray: 1` and an
 * animated `stroke-dashoffset` produce a clean draw regardless of the path's
 * real geometry — the outline can be redesigned without retuning the animation.
 *
 * Deliberately NOT a full-screen splash. A splash gate would sit in front of
 * the Largest Contentful Paint, delay first interaction, and cost conversions
 * on every repeat visit. This plays inline inside the hero, so the page is
 * readable and shoppable while it runs and "Shop now" is clickable from the
 * first frame.
 *
 * Reduced motion: the keyframes are declared only inside a
 * `prefers-reduced-motion: no-preference` block, and every element's resting
 * CSS is its *finished* state. So a reduced-motion visitor sees the fully-lit
 * burning cloud immediately — the brand moment preserved as a still image
 * rather than removed.
 */

const CLOUD_PATH =
  'M30 88 C12 88 4 74 12 61 C4 46 18 30 36 34 C42 14 70 8 84 22 ' +
  'C96 6 128 6 140 24 C160 16 182 30 178 50 C196 54 200 78 184 88 Z'

const FLAMES = [
  { d: 'M70 30 C66 18 78 14 74 2 C86 12 82 24 70 30 Z', delay: '0.55s' },
  { d: 'M108 22 C103 8 117 4 112 -8 C127 4 122 16 108 22 Z', delay: '0.7s' },
  { d: 'M146 32 C142 21 153 17 149 6 C161 16 157 26 146 32 Z', delay: '0.62s' },
]

export function BurningCloud({ className }: { className?: string }) {
  return (
    <svg
      viewBox="-10 -14 220 116"
      aria-hidden="true"
      className={cn(
        'h-auto w-full',
        'animate-[fade-in_400ms_ease-out_both] motion-reduce:animate-none',
      )}
      style={{
        filter:
          'drop-shadow(0 0 10px oklch(0.735 0.19 48 / 45%)) drop-shadow(0 0 26px oklch(0.64 0.229 27 / 30%))',
      }}
    >
      <defs>
        <linearGradient id="burning-cloud-flame" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--flare)" />
          <stop offset="100%" stopColor="var(--ember)" />
        </linearGradient>
      </defs>

      {/* Flames first, so the cloud body overlaps and hides their roots. */}
      {FLAMES.map((flame) => (
        <path
          key={flame.d}
          d={flame.d}
          fill="url(#burning-cloud-flame)"
          className="animate-[flame-grow_1.1s_ease-out_both] motion-reduce:animate-none"
          style={{ transformOrigin: 'center bottom', animationDelay: flame.delay }}
        />
      ))}

      {/* The cloud inks itself in, then fills. */}
      <path
        d={CLOUD_PATH}
        pathLength="1"
        fill="var(--ink-900)"
        stroke="var(--cream)"
        strokeWidth="7"
        strokeLinejoin="round"
        className={cn(
          'animate-[cloud-ink-draw_1s_ease-in-out_both,cloud-fill-in_500ms_ease-out_450ms_both]',
          'motion-reduce:animate-none',
        )}
        style={{ strokeDasharray: 1 }}
      />

      {/* Two vents — the mark reads as smoke leaving, not just weather. */}
      <path
        d="M74 44 C70 36 82 32 78 24 M118 40 C114 32 126 28 122 20"
        fill="none"
        stroke="var(--ember)"
        strokeWidth="6"
        strokeLinecap="round"
        className="animate-[fade-in_600ms_ease-out_900ms_both] motion-reduce:animate-none"
      />
    </svg>
  )
}
