import { formatCents } from '@/lib/money'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * Product card.
 *
 * The commercial hierarchy is fixed and deliberate: image, then strain type,
 * then name, then potency, then price, then the action. Price sits in Space
 * Mono at display weight because it is the single most-scanned value on the
 * card, and tabular figures keep a grid of prices optically aligned.
 *
 * At most one badge. The sticker is loud enough that two of them compete and
 * neither gets read — so the card takes a single `badge` prop rather than a
 * list, which makes the rule impossible to break by accident.
 *
 * The whole card is not a link. A card-wide anchor with a nested "Add to bag"
 * button is a nesting violation and makes the button unreachable for keyboard
 * users; instead the title carries the link and stretches its hit area with
 * `after:absolute`, leaving the button as a genuine sibling.
 */

export type Product = {
  id: string
  slug: string
  name: string
  strainType: string
  thcPercent: number
  priceCents: number
  imageUrl?: string
  inStock: boolean
}

type ProductCardProps = {
  product: Product
  badge?: { label: string; variant?: 'volt' | 'ember' | 'flare' | 'cream' }
  className?: string
}

export function ProductCard({ product, badge, className }: ProductCardProps) {
  const soldOut = !product.inStock

  return (
    <article
      className={cn(
        'panel group relative flex flex-col overflow-hidden rounded-lg bg-card',
        'transition-transform duration-100 ease-out',
        'hover:-translate-x-0.5 hover:-translate-y-0.5',
        'focus-within:-translate-x-0.5 focus-within:-translate-y-0.5',
        className,
      )}
    >
      <div className="relative aspect-4/3 overflow-hidden border-b-2 border-ink bg-ink-700">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- Phase 3 swaps in next/image once Blob URLs and sizes are known.
          <img
            src={product.imageUrl}
            alt=""
            className={cn(
              'size-full object-cover',
              soldOut && 'opacity-40 grayscale',
            )}
          />
        ) : (
          <div
            aria-hidden="true"
            className="halftone size-full text-smoke opacity-40"
          />
        )}

        {badge && (
          <div className="absolute top-2 left-2">
            <Badge variant={badge.variant ?? 'volt'} tilt>
              {badge.label}
            </Badge>
          </div>
        )}

        {soldOut && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="panel-sm -rotate-6 rounded-sm bg-ink px-3 py-1.5 font-display text-lg tracking-wide text-cream uppercase">
              Sold out
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-4">
        <p className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
          {product.strainType}
        </p>

        <h3 className="font-display text-lg leading-tight tracking-tight">
          <a
            href={`/product/${product.slug}`}
            className="after:absolute after:inset-0 after:content-['']"
          >
            {product.name}
          </a>
        </h3>

        <p className="font-mono text-xs text-smoke">
          THC {product.thcPercent.toFixed(1)}%
        </p>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="font-mono text-xl font-bold text-cream">
            {formatCents(product.priceCents)}
          </span>

          {/* Sits above the title's stretched hit area. */}
          <Button
            size="sm"
            variant={soldOut ? 'outline' : 'primary'}
            disabled={soldOut}
            className="relative z-10"
          >
            {soldOut ? 'Notify me' : 'Add to bag'}
          </Button>
        </div>
      </div>
    </article>
  )
}
