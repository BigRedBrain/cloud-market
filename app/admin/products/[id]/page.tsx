import type { Metadata } from 'next'
import type { Route } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ProductForm, VariantForm } from '@/components/admin/catalog-forms'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth/dal'
import {
  adminGetProduct,
  adminListBrands,
  adminListCategories,
} from '@/lib/catalog/admin-queries'
import { formatCents } from '@/lib/money'

export const metadata: Metadata = {
  title: 'Edit product',
  robots: { index: false, follow: false },
}

export default async function AdminProductPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireAdmin()

  const { id } = await params
  const detail = await adminGetProduct(id)
  if (!detail) notFound()

  const [brands, categories] = await Promise.all([adminListBrands(), adminListCategories()])
  const { product, variants } = detail

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4">
        <ol className="flex items-center gap-2 font-data text-xs text-smoke">
          <li>
            <Link href="/admin/products" className="underline underline-offset-4 hover:text-white">
              Products
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-white">{product.name}</li>
        </ol>
      </nav>

      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-poster text-2xl tracking-tight text-white uppercase">
          {product.name}
        </h1>
        {product.status === 'active' && (
          <Link
            href={`/product/${product.slug}` as Route}
            className="font-data text-xs text-ember underline underline-offset-4"
          >
            View on shop →
          </Link>
        )}
      </div>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductForm
            product={{
              ...product,
              status: product.status,
              strainType: product.strainType,
              thcPercent: product.thcPercent,
              cbdPercent: product.cbdPercent,
            }}
            brands={brands}
            categories={categories}
          />
        </CardContent>
      </Card>

      <h2 className="mb-4 font-poster text-xl tracking-tight text-white uppercase">
        Variants ({variants.length})
      </h2>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Add variant</CardTitle>
        </CardHeader>
        <CardContent>
          <VariantForm productId={product.id} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {variants.map((variant) => (
          <Card key={variant.id}>
            <CardHeader>
              <CardTitle>
                {variant.label}{' '}
                <span className="font-data text-sm font-normal text-smoke">
                  {variant.sku} · {formatCents(variant.priceCents)} ·{' '}
                  {variant.inventoryQuantity} in stock
                  {!variant.active && ' · inactive'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <VariantForm productId={product.id} variant={variant} />
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  )
}
