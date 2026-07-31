import type { Route } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/field'
import { cn } from '@/lib/utils'

/**
 * Search and filter controls.
 *
 * A **Server Component**. This is an ordinary `GET` form whose fields are the
 * URL's query string, so it needs no client JavaScript, no state, and no
 * hydration: submitting navigates, and the server re-renders the results. That
 * also means every filtered view is a real, shareable, bookmarkable URL and the
 * back button behaves — which a `useState`-driven filter panel has to
 * reimplement badly.
 *
 * Uses the frozen design system only: `Input`, `Label`, `Button`, `Badge`.
 * No new visual language, no decorative motion. Category pages sit at 70% brand
 * intensity (DESIGN.md §9), which permits panel outlines, display headings and
 * sticker badges but no ambient smoke.
 */

export type FilterOption = { slug: string; name: string; productCount?: number }

type CatalogFiltersProps = {
  action: string
  categories: FilterOption[]
  brands: FilterOption[]
  current: {
    q?: string
    category?: string
    brand?: string
    strain?: string
    sort?: string
    inStockOnly?: boolean
  }
  /** Set when the category is fixed by the route rather than chosen here. */
  lockedCategory?: string
}

const STRAINS = [
  { value: 'indica', label: 'Indica' },
  { value: 'sativa', label: 'Sativa' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'cbd', label: 'CBD' },
]

const SORTS = [
  { value: 'featured', label: 'Featured' },
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
  { value: 'name', label: 'Name' },
]

function selectClasses() {
  return cn(
    'h-11 w-full rounded-md bg-ink-700 px-3',
    'font-sans text-base text-white',
    'border-solid border-ink [border-width:var(--outline-ink)]',
  )
}

export function CatalogFilters({
  action,
  categories,
  brands,
  current,
  lockedCategory,
}: CatalogFiltersProps) {
  return (
    <form action={action} method="GET" className="flex flex-col gap-4">
      {/* Preserved across submissions so a locked category is not lost. */}
      {lockedCategory && <input type="hidden" name="category" value={lockedCategory} />}

      <div className="flex flex-col gap-2">
        <Label htmlFor="q">Search</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-smoke"
            />
            <Input
              id="q"
              name="q"
              type="search"
              defaultValue={current.q ?? ''}
              placeholder="Strain, brand or category"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="primary">
            Search
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {!lockedCategory && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              name="category"
              defaultValue={current.category ?? ''}
              className={selectClasses()}
            >
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category.slug} value={category.slug}>
                  {category.name}
                  {category.productCount !== undefined ? ` (${category.productCount})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="brand">Brand</Label>
          <select
            id="brand"
            name="brand"
            defaultValue={current.brand ?? ''}
            className={selectClasses()}
          >
            <option value="">All brands</option>
            {brands.map((brand) => (
              <option key={brand.slug} value={brand.slug}>
                {brand.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="strain">Strain type</Label>
          <select
            id="strain"
            name="strain"
            defaultValue={current.strain ?? ''}
            className={selectClasses()}
          >
            <option value="">Any</option>
            {STRAINS.map((strain) => (
              <option key={strain.value} value={strain.value}>
                {strain.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="sort">Sort by</Label>
          <select
            id="sort"
            name="sort"
            defaultValue={current.sort ?? 'featured'}
            className={selectClasses()}
          >
            {SORTS.map((sort) => (
              <option key={sort.value} value={sort.value}>
                {sort.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            name="inStock"
            value="1"
            defaultChecked={current.inStockOnly}
            className="size-5 rounded-sm border-2 border-ink bg-ink-700 accent-volt"
          />
          In stock only
        </label>

        <div className="flex gap-2">
          <Button type="submit" variant="outline" size="sm">
            Apply filters
          </Button>
          <Link
            href={action as Route}
            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold text-smoke underline underline-offset-4 hover:text-white"
          >
            Clear
          </Link>
        </div>
      </div>
    </form>
  )
}

/** Category chips. A plain link list — no JavaScript, no client component. */
export function CategoryChips({
  categories,
  activeSlug,
}: {
  categories: FilterOption[]
  activeSlug?: string
}) {
  return (
    <nav aria-label="Categories">
      <ul className="flex flex-wrap gap-2">
        <li>
          <Link href="/shop" aria-current={!activeSlug ? 'page' : undefined}>
            <Badge variant={!activeSlug ? 'ember' : 'outline'}>All</Badge>
          </Link>
        </li>
        {categories.map((category) => (
          <li key={category.slug}>
            <Link
              href={`/shop/${category.slug}` as Route}
              aria-current={activeSlug === category.slug ? 'page' : undefined}
            >
              <Badge variant={activeSlug === category.slug ? 'ember' : 'outline'}>
                {category.name}
                {category.productCount !== undefined && ` ${category.productCount}`}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
