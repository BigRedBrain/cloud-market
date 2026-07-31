import { cn } from '@/lib/utils'

/**
 * Ambient smoke.
 *
 * Three radial-gradient layers drifting on co-prime periods (37s / 43s / 53s)
 * so the loop never visibly repeats. Deliberately a **server component with no
 * JavaScript whatsoever** — this is the first thing on screen, and paying a
 * Framer Motion runtime for background atmosphere would be the wrong trade.
 * CSS animations run off the main thread; a JS animation loop does not.
 *
 * Cost control, in order of importance:
 *
 *  - Transform-only animation. Each layer is promoted once and then composited;
 *    nothing repaints, nothing reflows.
 *  - Softness from gradients, never `filter: blur()`. Blurring a viewport-sized
 *    element is among the most expensive things a mobile GPU can be asked for,
 *    and this storefront's traffic is mostly mid-range Android.
 *  - `contain: strict` so the layers cannot influence layout or paint outside
 *    themselves.
 *
 * Reduced motion: the keyframes are only declared inside a
 * `prefers-reduced-motion: no-preference` block, so the layers simply sit
 * still. That is a genuine alternative rather than a removal — the haze still
 * gives the page its depth, it just stops moving.
 *
 * Always decorative: `aria-hidden` and `pointer-events-none`, so it never
 * appears in the accessibility tree or intercepts a tap.
 */

type SmokeBackgroundProps = {
  /** `fixed` for full-page atmosphere, `absolute` to scope it to a section. */
  position?: 'fixed' | 'absolute'
  /** Overall strength. `hero` is heavier; `ambient` sits under content. */
  intensity?: 'ambient' | 'hero'
  className?: string
}

export function SmokeBackground({
  position = 'absolute',
  intensity = 'ambient',
  className,
}: SmokeBackgroundProps) {
  const opacity = intensity === 'hero' ? 'opacity-100' : 'opacity-60'

  return (
    <div
      aria-hidden="true"
      className={cn(
        position === 'fixed' ? 'fixed' : 'absolute',
        'inset-0 -z-10 overflow-hidden pointer-events-none',
        '[contain:strict]',
        opacity,
        className,
      )}
    >
      {/* Warm ember haze, low and heavy. */}
      <div
        className={cn(
          'absolute -inset-1/4',
          'animate-[smoke-drift-a_37s_ease-in-out_infinite_alternate]',
          'motion-reduce:animate-none',
        )}
        style={{
          background:
            'radial-gradient(45% 40% at 30% 70%, oklch(0.735 0.19 48 / 14%), transparent 70%)',
        }}
      />

      {/* Cool smoke, drifting counter to the ember. */}
      <div
        className={cn(
          'absolute -inset-1/4',
          'animate-[smoke-drift-b_43s_ease-in-out_infinite_alternate]',
          'motion-reduce:animate-none',
        )}
        style={{
          background:
            'radial-gradient(50% 45% at 70% 35%, oklch(0.648 0.008 262 / 16%), transparent 72%)',
        }}
      />

      {/* Faint red heat at the base — the fire under the smoke. */}
      <div
        className={cn(
          'absolute -inset-1/4',
          'animate-[smoke-drift-c_53s_ease-in-out_infinite_alternate]',
          'motion-reduce:animate-none',
        )}
        style={{
          background:
            'radial-gradient(40% 35% at 50% 95%, oklch(0.64 0.229 27 / 10%), transparent 68%)',
        }}
      />
    </div>
  )
}
