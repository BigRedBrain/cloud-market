import { formatCents } from '@/lib/money'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * Product card.
 *
 * Commercial hierarchy is fixed: image → category → name → size + potency →
 * availability → price → action. Everything the brief calls "clearly visible"
 * is text at 12px or larger, never an icon alone and never colour alone.
 *
 * Availability is the one place electric green earns its keep. Green means "you
 * can buy this right now" and nothing else in the entire system — which is why
 * it is rationed everywhere else. Paired with the word "In stock" so it still
 * reads in greyscale.
 *
 * Motion is hover-only and 1px: the panel lifts off its ink shadow. No scale,
 * no image zoom. A catalogue grid where every card breathes on hover is the
 * fastest way to make a storefront feel cheap and slow.
 *
 * Images: `loading="lazy"` plus explicit `width`/`height` so the browser
 * reserves the box before bytes arrive. `decoding="async"` keeps decode off the
 * main thread. next/image lands in Phase 3 once Blob URLs and real dimensions
 * exist; this is deliberately the cheap correct thing until then.
 *
 * The card is not wrapped in an anchor. The title carries the link and stretches
 * its hit area with `after:absolute`, leaving "Add to bag" a genuine sibling —
 * a card-wide anchor with a nested button is a nesting violation and makes the
 * button unreachable by keyboard.
 */

export type Product = {
  id: string
  slug: string
  name: string
  /** Displayed as the category eyebrow, e.g. "Indica · Flower". */
  category: string
  /** Pack size as sold, e.g. "3.5g" or "10 pk". */
  size: string
  thcPercent: number
  priceCents: number
  imageUrl?: string
  inStock: boolean
  /** Drives the low-stock warning. Omit when the count is unknown. */
  stockCount?: number
}

type ProductCardProps = {
  product: Product
  badge?: { label: string; variant?: 'ember' | 'flare' | 'volt' | 'cream' }
  className?: string
}

function Availability({ product }: { product: Product }) {
  if (!product.inStock) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-smoke">
        <span aria-hidden="true" className="size-2 rounded-full bg-smoke" />
        Sold out
      </span>
    )
  }

  const low = product.stockCount !== undefined && product.stockCount <= 3

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-xs',
        low ? 'text-ember' : 'text-volt',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-2 rounded-full', low ? 'bg-ember' : 'bg-volt')}
      />
      {low ? `Only ${product.stockCount} left` : 'In stock'}
    </span>
  )
}

export function ProductCard({ product, badge, className }: ProductCardProps) {
  const soldOut = !product.inStock

  return (
    <article
      className={cn(
        'panel group relative flex flex-col overflow-hidden rounded-lg bg-card',
        'transition-transform duration-150 ease-out',
        'hover:-translate-x-0.5 hover:-translate-y-0.5',
        'focus-within:-translate-x-0.5 focus-within:-translate-y-0.5',
        className,
      )}
    >
      <div className="relative aspect-4/3 overflow-hidden border-b-2 border-ink bg-ink-700">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- next/image lands in Phase 3 with real Blob URLs.
          <img
            src={product.imageUrl}
            alt=""
            width={640}
            height={480}
            loading="lazy"
            decoding="async"
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

        {/* Smoke accent bleeding up from the lower edge of the image. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3"
          style={{
            background:
              'linear-gradient(to top, oklch(0.171 0.005 285 / 55%), transparent)',
          }}
        />

        {badge && (
          <div className="absolute top-2 left-2">
            <Badge variant={badge.variant ?? 'ember'} tilt>
              {badge.label}
            </Badge>
          </div>
        )}

        {soldOut && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="panel-sm -rotate-6 rounded-sm bg-ink px-3 py-1.5 font-display text-lg tracking-wide text-white uppercase">
              Sold out
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-4">
        <p className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
          {product.category}
        </p>

        <h3 className="font-display text-lg leading-tight tracking-tight text-white">
          <a
            href={`/product/${product.slug}`}
            className="after:absolute after:inset-0 after:content-['']"
          >
            {product.name}
          </a>
        </h3>

        <p className="font-mono text-xs text-smoke">
          {product.size} · THC {product.thcPercent.toFixed(1)}%
        </p>

        <div className="mt-1">
          <Availability product={product} />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="font-mono text-xl font-bold text-white">
            {formatCents(product.priceCents)}
          </span>

          {/* Sits above the title's stretched hit area. */}
          <Button
            size="sm"
            variant={soldOut ? 'outline' : 'primary'}
            disabled={soldOut}
            className="relative z-10"
          >
            {soldOut ? 'Sold out' : 'Add to bag'}
          </Button>
        </div>
      </div>
    </article>
  )
}
