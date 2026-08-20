import type { Metadata } from 'next'
import type { Route } from 'next'
import Link from 'next/link'

import { ProductForm } from '@/components/admin/catalog-forms'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth/dal'
import {
  adminListBrands,
  adminListCategories,
  adminListProducts,
} from '@/lib/catalog/admin-queries'

export const metadata: Metadata = {
  title: 'Products',
  robots: { index: false, follow: false },
}

const STATUS_VARIANT = {
  active: 'volt',
  draft: 'smoke',
  archived: 'outline',
} as const

export default async function AdminProductsPage() {
  await requireAdmin()

  const [products, brands, categories] = await Promise.all([
    adminListProducts(),
    adminListBrands(),
    adminListCategories(),
  ])

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-6 font-poster text-2xl tracking-tight text-white uppercase">
        Products
      </h1>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>New product</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductForm brands={brands} categories={categories} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All products ({products.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full font-data text-sm">
              <caption className="sr-only">
                Every product, including drafts and archived items
              </caption>
              <thead>
                <tr className="border-b-2 border-ink text-left text-smoke">
                  <th scope="col" className="px-4 py-2 font-normal">Name</th>
                  <th scope="col" className="px-4 py-2 font-normal">Brand</th>
                  <th scope="col" className="px-4 py-2 font-normal">Category</th>
                  <th scope="col" className="px-4 py-2 font-normal">Status</th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">Variants</th>
                  <th scope="col" className="px-4 py-2 text-right font-normal">Stock</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id} className="border-b border-ink-600 last:border-b-0">
                    <th scope="row" className="px-4 py-3 text-left font-bold">
                      <Link
                        href={`/admin/products/${product.id}` as Route}
                        className="text-white underline underline-offset-4 hover:text-ember"
                      >
                        {product.name}
                      </Link>
                      {product.featured && (
                        <span className="ml-2 text-[0.625rem] text-ember">FEATURED</span>
                      )}
                      {product.newArrival && (
                        <span className="ml-2 text-[0.625rem] text-volt">NEW</span>
                      )}
                    </th>
                    <td className="px-4 py-3 text-smoke">{product.brandName}</td>
                    <td className="px-4 py-3 text-smoke">{product.categoryName}</td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[product.status]}>{product.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right text-smoke">{product.variantCount}</td>
                    <td
                      className={
                        product.totalStock === 0
                          ? 'px-4 py-3 text-right text-smoke'
                          : 'px-4 py-3 text-right text-white'
                      }
                    >
                      {product.totalStock}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
