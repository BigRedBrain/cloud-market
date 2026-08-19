import { cn } from '@/lib/utils'

/**
 * Cloud Market logo.
 *
 * The mark is the same cloud silhouette as the signature button, stroked in
 * ink — the brand's one shape, used at every scale. The wordmark is Anton,
 * tightened and uppercase.
 *
 * PLACEMENT RULES (enforced here where code can, documented in DESIGN.md where
 * it cannot):
 *
 * - Clear space: a margin equal to the mark's cap-height on all four sides.
 *   Built into `variant="full"` and `variant="stacked"` as padding, so a
 *   correctly-placed logo is the default rather than a thing to remember.
 * - Minimum size: 24px for the mark, 96px wide for the lockup. Below that the
 *   ink outline closes up and the lobes read as a blob.
 * - The mark never rotates, never gets a gradient fill, and never sits on a
 *   mid-tone. It goes on ink, on cream, or on a bright brand fill — nothing in
 *   between, because the 2px outline needs a decisive value contrast.
 * - `tone="cream"` on dark surfaces, `tone="ink"` on cream paper panels and on
 *   volt/ember fills. There is no third option on purpose.
 */

const CLOUD_PATH =
  'M30 88 C12 88 4 74 12 61 C4 46 18 30 36 34 C42 14 70 8 84 22 ' +
  'C96 6 128 6 140 24 C160 16 182 30 178 50 C196 54 200 78 184 88 Z'

type LogoProps = {
  variant?: 'full' | 'mark' | 'stacked'
  tone?: 'cream' | 'ink'
  className?: string
  /** Renders as plain text for screen readers; set false inside a labelled link. */
  showLabel?: boolean
}

function CloudMark({ tone, className }: { tone: 'cream' | 'ink'; className?: string }) {
  const stroke = tone === 'cream' ? 'var(--cream)' : 'var(--ink-950)'

  return (
    <svg
      viewBox="0 0 200 96"
      aria-hidden="true"
      className={cn('h-7 w-auto shrink-0', className)}
    >
      <path
        d={CLOUD_PATH}
        fill="none"
        stroke={stroke}
        strokeWidth="9"
        strokeLinejoin="round"
      />
      {/* Two vents: the mark reads as smoke leaving, not just weather. */}
      <path
        d="M74 44 C70 36 82 32 78 24 M118 40 C114 32 126 28 122 20"
        fill="none"
        stroke={stroke}
        strokeWidth="7"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Logo({
  variant = 'full',
  tone = 'cream',
  className,
  showLabel = true,
}: LogoProps) {
  const text = tone === 'cream' ? 'text-cream' : 'text-ink'

  if (variant === 'mark') {
    return (
      <span className={cn('inline-flex', className)}>
        <CloudMark tone={tone} />
        {showLabel && <span className="sr-only">Cloud Market</span>}
      </span>
    )
  }

  if (variant === 'stacked') {
    return (
      <span className={cn('inline-flex flex-col items-center gap-2 p-3', className)}>
        <CloudMark tone={tone} className="h-12" />
        <span
          className={cn(
            'font-poster text-2xl leading-none tracking-tight uppercase',
            text,
          )}
        >
          Cloud Market
        </span>
      </span>
    )
  }

  return (
    <span className={cn('inline-flex items-center gap-2.5 p-2', className)}>
      <CloudMark tone={tone} />
      <span
        className={cn(
          'font-poster text-xl leading-none tracking-tight uppercase',
          text,
        )}
      >
        Cloud Market
      </span>
    </span>
  )
}
