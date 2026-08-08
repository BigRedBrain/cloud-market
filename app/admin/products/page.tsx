import type { Metadata } from 'next'
import type { Route } from 'next'
import Link from 'next/link'

import { ProductForm } from '@/components/admin/catalog-forms'
import { MediaImage } from '@/components/catalog/media-image'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdminIdentity } from '@/lib/auth/admin-identity'
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
  await requireAdminIdentity()

  const [products, brands, categories] = await Promise.all([
    adminListProducts(),
    adminListBrands(),
    adminListCategories(),
  ])

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-6 font-display text-2xl tracking-tight text-white uppercase">
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
            <table className="w-full font-mono text-sm">
              <caption className="sr-only">
                Every product, including drafts and archived items
              </caption>
              <thead>
                <tr className="border-b-2 border-ink text-left text-smoke">
                  <th scope="col" className="px-4 py-2 font-normal">
                    <span className="sr-only">Thumbnail</span>
                  </th>
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
                    <td className="py-2 pl-4">
                      <div className="size-12 overflow-hidden rounded-sm bg-ink-700">
                        {product.thumbnailUrl ? (
                          <MediaImage
                            src={product.thumbnailUrl}
                            alt=""
                            width={48}
                            height={48}
                            mimeType={product.thumbnailMimeType}
                            sizes="48px"
                            className="size-full object-cover"
                          />
                        ) : (
                          <div
                            aria-hidden="true"
                            className="flex size-full items-center justify-center text-[0.5rem] text-smoke"
                          >
                            NONE
                          </div>
                        )}
                      </div>
                    </td>
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
                      {product.mediaCount === 0 && (
                        <span className="ml-2 text-[0.625rem] text-ember">NO MEDIA</span>
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
