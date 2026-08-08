import type { Metadata } from 'next'

import { BrandForm } from '@/components/admin/catalog-forms'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdminIdentity } from '@/lib/auth/admin-identity'
import { adminListBrands } from '@/lib/catalog/admin-queries'

export const metadata: Metadata = {
  title: 'Brands',
  robots: { index: false, follow: false },
}

export default async function AdminBrandsPage() {
  // Authoritative check, in the page rather than the layout.
  await requireAdminIdentity()

  const brands = await adminListBrands()

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-6 font-display text-2xl tracking-tight text-white uppercase">
        Brands
      </h1>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>New brand</CardTitle>
        </CardHeader>
        <CardContent>
          <BrandForm />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {brands.map((brand) => (
          <Card key={brand.id}>
            <CardHeader>
              <CardTitle>
                {brand.name}{' '}
                <span className="font-mono text-sm font-normal text-smoke">
                  /{brand.slug} · {brand.productCount} product
                  {brand.productCount === 1 ? '' : 's'}
                  {!brand.active && ' · inactive'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BrandForm brand={brand} />
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  )
}
