import type { Metadata } from 'next'
import Link from 'next/link'
import type { Route } from 'next'
import { notFound } from 'next/navigation'

import { AddToBagForm } from '@/components/bag/bag-controls'
import { ProductCard } from '@/components/product-card'
import { SiteNav } from '@/components/site-nav'
import { getBagCount } from '@/lib/bag/core'
import { getCurrentUser } from '@/lib/auth/dal'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getProductBySlug, listProducts } from '@/lib/catalog/queries'
import { formatCents } from '@/lib/money'

type ProductPageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params
  const detail = await getProductBySlug(slug)

  if (!detail) return { title: 'Product not found' }

  return {
    title: detail.product.name,
    description: detail.product.shortDescription ?? undefined,
  }
}

/** Renders a numeric column only when the value exists. */
function Spec({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <div className="flex justify-between gap-4 border-b border-ink-600 py-2 last:border-b-0">
      <dt className="text-smoke">{label}</dt>
      <dd className="font-mono font-bold text-white">{value}</dd>
    </div>
  )
}

/**
 * Product detail — 50% brand intensity (DESIGN.md §9).
 *
 * Panel outlines, display type for the name, at most one badge. No smoke, no
 * halftone washes: this is the page a customer reads carefully, and potency,
 * price and availability have to win over atmosphere.
 *
 * Variants can be added to the bag directly from the price table. Adding does
 * NOT reserve stock — that happens at the future order boundary, and the bag
 * page says so plainly rather than implying a hold the system cannot honour.
 
 */
export default async function ProductPage({ params }: ProductPageProps) {
  const bagViewer = await getCurrentUser()
  const bagCount = await getBagCount(bagViewer?.id ?? null)

  const { slug } = await params
  const detail = await getProductBySlug(slug)
  if (!detail) notFound()

  const { product, brand, category, variants, images } = detail

  const totalStock = variants.reduce((sum, variant) => sum + variant.inventoryQuantity, 0)
  const primary = images[0]

  const related = await listProducts({ category: category.slug, sort: 'featured' })
  const alsoLike = related.products.filter((item) => item.slug !== product.slug).slice(0, 3)

  const terpenes = product.terpenes ? Object.entries(product.terpenes) : []

  return (
    <>
      <SiteNav bagCount={bagCount} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        <nav aria-label="Breadcrumb" className="mb-6">
          <ol className="flex flex-wrap items-center gap-2 font-mono text-xs text-smoke">
            <li>
              <Link href="/shop" className="underline underline-offset-4 hover:text-white">
                Shop
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link
                href={`/shop/${category.slug}` as Route}
                className="underline underline-offset-4 hover:text-white"
              >
                {category.name}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-white">
              {product.name}
            </li>
          </ol>
        </nav>

        <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
          {/* ---- Imagery ------------------------------------------------- */}
          <div className="flex flex-col gap-3">
            <div className="panel overflow-hidden rounded-lg bg-ink-700">
              {primary ? (
                // eslint-disable-next-line @next/next/no-img-element -- next/image lands with Blob uploads in a later phase.
                <img
                  src={primary.url}
                  alt={primary.altText}
                  width={640}
                  height={480}
                  className="aspect-4/3 w-full object-cover"
                />
              ) : (
                <div aria-hidden="true" className="halftone aspect-4/3 w-full text-smoke opacity-40" />
              )}
            </div>

            {images.length > 1 && (
              <ul className="grid grid-cols-4 gap-3">
                {images.slice(1).map((image) => (
                  <li key={image.url} className="panel-sm overflow-hidden rounded-md bg-ink-700">
                    {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                    <img
                      src={image.url}
                      alt={image.altText}
                      width={160}
                      height={120}
                      loading="lazy"
                      decoding="async"
                      className="aspect-4/3 w-full object-cover"
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ---- Detail -------------------------------------------------- */}
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Link
                href={`/shop?brand=${brand.slug}` as Route}
                className="font-mono text-xs tracking-widest text-ember uppercase underline underline-offset-4"
              >
                {brand.name}
              </Link>

              <h1 className="font-display text-4xl leading-tight tracking-tight text-white uppercase">
                {product.name}
              </h1>

              {/* One badge maximum, per the design system's card rule. */}
              <div className="flex items-center gap-2">
                {totalStock === 0 ? (
                  <Badge variant="smoke">Sold out</Badge>
                ) : product.newArrival ? (
                  <Badge variant="ember">New arrival</Badge>
                ) : product.featured ? (
                  <Badge variant="ember">Featured</Badge>
                ) : (
                  <Badge variant="volt">In stock</Badge>
                )}
              </div>
            </div>

            {product.shortDescription && (
              <p className="text-lg leading-relaxed text-white">{product.shortDescription}</p>
            )}
            {product.description && (
              <p className="leading-relaxed text-smoke">{product.description}</p>
            )}

            {/* ---- Variants ---------------------------------------------- */}
            <Card>
              <CardHeader>
                <CardTitle>Sizes and prices</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full font-mono text-sm">
                  <caption className="sr-only">
                    Available sizes, prices and stock for {product.name}
                  </caption>
                  <thead>
                    <tr className="border-b-2 border-ink text-left text-smoke">
                      <th scope="col" className="px-4 py-2 font-normal">Size</th>
                      <th scope="col" className="px-4 py-2 font-normal">Price</th>
                      <th scope="col" className="px-4 py-2 text-right font-normal">Stock</th>
                      <th scope="col" className="px-4 py-2 font-normal"><span className="sr-only">Add to bag</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((variant) => (
                      <tr key={variant.id} className="border-b border-ink-600 last:border-b-0">
                        <th scope="row" className="px-4 py-3 text-left font-bold text-white">
                          {variant.label}
                        </th>
                        <td className="px-4 py-3">
                          <span className="font-bold text-white">
                            {formatCents(variant.priceCents)}
                          </span>
                          {variant.compareAtPriceCents && (
                            <span className="ml-2 text-smoke line-through">
                              {formatCents(variant.compareAtPriceCents)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {variant.inventoryQuantity === 0 ? (
                            <span className="text-smoke">Sold out</span>
                          ) : variant.inventoryQuantity <= 3 ? (
                            <span className="text-ember">Only {variant.inventoryQuantity} left</span>
                          ) : (
                            <span className="text-volt">In stock</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <AddToBagForm
                            variantId={variant.id}
                            label={variant.label}
                            soldOut={variant.inventoryQuantity === 0}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* ---- Specifications -------------------------------------------- */}
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="font-mono text-sm">
                <Spec
                  label="Strain type"
                  value={
                    product.strainType
                      ? {
                          indica: 'Indica',
                          sativa: 'Sativa',
                          hybrid: 'Hybrid',
                          hybrid_i: 'Hybrid I',
                          hybrid_s: 'Hybrid S',
                          cbd: 'CBD',
                        }[product.strainType]
                      : null
                  }
                />
                <Spec label="THC" value={product.thcPercent ? `${product.thcPercent}%` : null} />
                <Spec label="CBD" value={product.cbdPercent ? `${product.cbdPercent}%` : null} />
                <Spec label="Genetics" value={product.genetics} />
                <Spec label="Category" value={category.name} />
                <Spec label="Brand" value={brand.name} />
                <Spec label="Lab test" value={product.labTestReference} />
              </dl>
            </CardContent>
          </Card>

          {(product.effects?.length || product.flavors?.length || terpenes.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>Effects and flavour</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {product.effects && product.effects.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="font-mono text-xs tracking-widest text-smoke uppercase">
                      Effects
                    </h3>
                    <ul className="flex flex-wrap gap-2">
                      {product.effects.map((effect) => (
                        <li key={effect}>
                          <Badge variant="outline">{effect}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {product.flavors && product.flavors.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="font-mono text-xs tracking-widest text-smoke uppercase">
                      Flavours
                    </h3>
                    <ul className="flex flex-wrap gap-2">
                      {product.flavors.map((flavor) => (
                        <li key={flavor}>
                          <Badge variant="smoke">{flavor}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {terpenes.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="font-mono text-xs tracking-widest text-smoke uppercase">
                      Terpenes
                    </h3>
                    <dl className="font-mono text-sm">
                      {terpenes.map(([name, value]) => (
                        <div
                          key={name}
                          className="flex justify-between gap-4 border-b border-ink-600 py-1.5 last:border-b-0"
                        >
                          <dt className="text-smoke capitalize">{name}</dt>
                          <dd className="text-white">{value}%</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {alsoLike.length > 0 && (
          <section className="mt-14">
            <h2 className="mb-5 font-display text-2xl tracking-tight text-white uppercase">
              More {category.name.toLowerCase()}
            </h2>
            <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {alsoLike.map((item) => (
                <li key={item.id}>
                  <ProductCard product={item} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  )
}
