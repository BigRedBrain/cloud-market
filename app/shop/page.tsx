import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { PackageOpen } from 'lucide-react'

import { CatalogFilters, CategoryChips } from '@/components/catalog/catalog-filters'
import { ProductCard } from '@/components/product-card'
import { SiteNav } from '@/components/site-nav'
import { getBagCount } from '@/lib/bag/core'
import { requireUser } from '@/lib/auth/dal'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import {
  listActiveBrands,
  listCategoriesWithCounts,
  listProducts,
  type CatalogSort,
} from '@/lib/catalog/queries'
import type { StrainType } from '@/lib/db/schema'

export const metadata: Metadata = {
  title: 'Shop',
  description: 'Browse licensed Michigan cannabis — flower, pre-rolls, concentrates, edibles and vapes.',
}

const SORTS: CatalogSort[] = ['featured', 'newest', 'price-asc', 'price-desc', 'name']
const STRAINS: StrainType[] = ['indica', 'sativa', 'hybrid', 'cbd']

/**
 * Normalises untrusted query strings into typed filters.
 *
 * Anything unrecognised falls back to a default rather than reaching the query
 * layer. `sort` in particular feeds an ORDER BY, so it is matched against an
 * allow-list — never interpolated.
 */
export function parseCatalogSearchParams(params: Record<string, string | string[] | undefined>) {
  const single = (key: string) => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  const sort = single('sort')
  const strain = single('strain')
  const page = Number(single('page') ?? '1')

  return {
    q: single('q')?.slice(0, 100) || undefined,
    category: single('category') || undefined,
    brand: single('brand') || undefined,
    strain: STRAINS.includes(strain as StrainType) ? (strain as StrainType) : undefined,
    sort: SORTS.includes(sort as CatalogSort) ? (sort as CatalogSort) : ('featured' as CatalogSort),
    inStockOnly: single('inStock') === '1',
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  }
}

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const bagViewer = await requireUser()
  const bagCount = await getBagCount(bagViewer.id)

  const params = await searchParams
  const filters = parseCatalogSearchParams(params)

  const [categories, brands, listing] = await Promise.all([
    listCategoriesWithCounts(),
    listActiveBrands(),
    listProducts(filters),
  ])

  const hasFilters = Boolean(
    filters.q || filters.category || filters.brand || filters.strain || filters.inStockOnly,
  )

  return (
    <>
      <SiteNav bagCount={bagCount} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-10 sm:px-6">
        <header className="mb-8 flex flex-col gap-3">
          <p className="font-mono text-xs tracking-[0.2em] text-ember uppercase">
            Menu
          </p>
          <h1 className="font-display text-4xl tracking-tight text-white uppercase sm:text-5xl">
            Shop
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-smoke">
            Licensed Michigan cannabis. Prices shown are the entry size — open a
            product for every weight.
          </p>
        </header>

        <div className="mb-6">
          <CategoryChips categories={categories} />
        </div>

        <div className="panel mb-8 rounded-lg bg-card p-5">
          <CatalogFilters
            action="/shop"
            categories={categories}
            brands={brands}
            current={filters}
          />
        </div>

        <div
          className="mb-5 flex items-baseline justify-between gap-4"
          aria-live="polite"
        >
          <p className="font-mono text-sm text-smoke">
            {listing.total === 0
              ? 'No products'
              : `${listing.total} product${listing.total === 1 ? '' : 's'}`}
            {filters.q && ` for “${filters.q}”`}
          </p>
          {listing.pageCount > 1 && (
            <p className="font-mono text-xs text-smoke">
              Page {listing.page} of {listing.pageCount}
            </p>
          )}
        </div>

        {listing.products.length === 0 ? (
          <EmptyState
            icon={<PackageOpen />}
            title={hasFilters ? 'Nothing matches those filters' : 'Nothing in the menu yet'}
            description={
              hasFilters
                ? 'Try a broader search, or clear the filters to see the full menu.'
                : 'Products will appear here as soon as they are published.'
            }
            action={
              hasFilters ? (
                <Link href="/shop">
                  <Button variant="primary">Clear filters</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {listing.products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        )}

        {listing.pageCount > 1 && (
          <Pagination
            page={listing.page}
            pageCount={listing.pageCount}
            params={params}
            basePath="/shop"
          />
        )}
      </main>
    </>
  )
}

/**
 * Link-based pagination — no JavaScript. Each page is a real URL, which keeps
 * results crawlable and the back button honest.
 */
export function Pagination({
  page,
  pageCount,
  params,
  basePath,
}: {
  page: number
  pageCount: number
  params: Record<string, string | string[] | undefined>
  basePath: string
}) {
  const href = (target: number) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (key === 'page' || value === undefined) continue
      search.set(key, Array.isArray(value) ? (value[0] ?? '') : value)
    }
    search.set('page', String(target))
    return `${basePath}?${search.toString()}` as Route
  }

  return (
    <nav aria-label="Pagination" className="mt-10 flex items-center justify-between gap-4">
      {page > 1 ? (
        <Link href={href(page - 1)}>
          <Button variant="outline">← Previous</Button>
        </Link>
      ) : (
        <span />
      )}
      <p className="font-mono text-sm text-smoke">
        {page} / {pageCount}
      </p>
      {page < pageCount ? (
        <Link href={href(page + 1)}>
          <Button variant="outline">Next →</Button>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  )
}
