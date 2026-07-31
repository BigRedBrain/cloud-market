import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'
import { PackageOpen } from 'lucide-react'

import { CatalogFilters, CategoryChips } from '@/components/catalog/catalog-filters'
import { ProductCard } from '@/components/product-card'
import { SiteNav } from '@/components/site-nav'
import { getBagCount } from '@/lib/bag/core'
import { getCurrentUser } from '@/lib/auth/dal'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination, parseCatalogSearchParams } from '@/app/shop/page'
import {
  getCategoryBySlug,
  listActiveBrands,
  listCategoriesWithCounts,
  listProducts,
} from '@/lib/catalog/queries'

type CategoryPageProps = {
  params: Promise<{ category: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { category: slug } = await params
  const category = await getCategoryBySlug(slug)

  if (!category) return { title: 'Category not found' }

  return {
    title: category.name,
    description: category.description ?? `Browse ${category.name} at Cloud Market.`,
  }
}

/**
 * Category page — 70% brand intensity (DESIGN.md §9).
 *
 * Permits halftone accents, panel outlines, display headings and sticker
 * badges. No ambient smoke: this is a browsing surface, not a hero.
 *
 * The category is fixed by the route, so it is passed to the filter form as a
 * locked hidden field rather than a select. Filtering therefore narrows within
 * the category instead of silently navigating out of it.
 */
export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const bagViewer = await getCurrentUser()
  const bagCount = await getBagCount(bagViewer?.id ?? null)

  const { category: slug } = await params
  const query = await searchParams

  const category = await getCategoryBySlug(slug)
  if (!category) notFound()

  const filters = { ...parseCatalogSearchParams(query), category: slug }

  const [categories, brands, listing] = await Promise.all([
    listCategoriesWithCounts(),
    listActiveBrands(),
    listProducts(filters),
  ])

  const hasFilters = Boolean(filters.q || filters.brand || filters.strain || filters.inStockOnly)

  return (
    <>
      <SiteNav bagCount={bagCount} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-10 sm:px-6">
        <nav aria-label="Breadcrumb" className="mb-4">
          <ol className="flex items-center gap-2 font-mono text-xs text-smoke">
            <li>
              <Link href="/shop" className="underline underline-offset-4 hover:text-white">
                Shop
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-white">
              {category.name}
            </li>
          </ol>
        </nav>

        <header className="relative mb-8 overflow-hidden">
          {/* Halftone accent — permitted at 70%, kept off the copy. */}
          <div
            aria-hidden="true"
            className="halftone pointer-events-none absolute inset-0 text-ember opacity-20 [mask-image:linear-gradient(to_right,black,transparent_60%)]"
          />
          <div className="relative flex flex-col gap-3 py-2">
            <h1 className="font-display text-4xl tracking-tight text-white uppercase sm:text-5xl">
              {category.name}
            </h1>
            {category.description && (
              <p className="max-w-2xl text-sm leading-relaxed text-smoke">
                {category.description}
              </p>
            )}
          </div>
        </header>

        <div className="mb-6">
          <CategoryChips categories={categories} activeSlug={slug} />
        </div>

        <div className="panel mb-8 rounded-lg bg-card p-5">
          <CatalogFilters
            action={`/shop/${slug}`}
            categories={categories}
            brands={brands}
            current={filters}
            lockedCategory={slug}
          />
        </div>

        <div className="mb-5 flex items-baseline justify-between gap-4" aria-live="polite">
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
            title={hasFilters ? 'Nothing matches those filters' : `No ${category.name.toLowerCase()} right now`}
            description={
              hasFilters
                ? 'Try a broader search, or clear the filters to see everything in this category.'
                : 'Check back soon, or browse the rest of the menu.'
            }
            action={
              <Link href={(hasFilters ? `/shop/${slug}` : '/shop') as Route}>
                <Button variant="primary">
                  {hasFilters ? 'Clear filters' : 'Browse the menu'}
                </Button>
              </Link>
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
            params={query}
            basePath={`/shop/${slug}`}
          />
        )}
      </main>
    </>
  )
}
