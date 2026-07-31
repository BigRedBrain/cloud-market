import type { Metadata } from 'next'

import { CategoryForm } from '@/components/admin/catalog-forms'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth/dal'
import { adminListCategories } from '@/lib/catalog/admin-queries'

export const metadata: Metadata = {
  title: 'Categories',
  robots: { index: false, follow: false },
}

export default async function AdminCategoriesPage() {
  await requireAdmin()

  const categories = await adminListCategories()

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-6 font-display text-2xl tracking-tight text-white uppercase">
        Categories
      </h1>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>New category</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryForm />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {categories.map((category) => (
          <Card key={category.id}>
            <CardHeader>
              <CardTitle>
                {category.name}{' '}
                <span className="font-mono text-sm font-normal text-smoke">
                  /{category.slug} · sort {category.sortOrder} · {category.productCount} product
                  {category.productCount === 1 ? '' : 's'}
                  {!category.active && ' · inactive'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CategoryForm category={category} />
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  )
}
