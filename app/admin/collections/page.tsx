import type { Metadata } from 'next'

import {
  CollectionForm,
  MembershipToggles,
  StatusPill,
  toggleCollectionProductAction,
} from '@/components/admin/cms-forms'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdmin } from '@/lib/auth/dal'
import {
  adminGetCollectionProductIds,
  adminListCollections,
  adminListProductsForPicker,
} from '@/lib/cms/admin-queries'

export const metadata: Metadata = {
  title: 'Collections',
  robots: { index: false, follow: false },
}

/**
 * Collections — editorial groupings, NOT categories.
 *
 * A category is what a product *is*; a collection is a merchandising choice,
 * and a product can be in as many as the owner likes.
 */
export default async function AdminCollectionsPage() {
  await requireAdmin()

  const [collections, products] = await Promise.all([
    adminListCollections(),
    adminListProductsForPicker(),
  ])

  const membership = await Promise.all(
    collections.map(async (collection) => ({
      id: collection.id,
      productIds: [...(await adminGetCollectionProductIds(collection.id))],
    })),
  )
  const byCollection = new Map(membership.map((row) => [row.id, row.productIds]))

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-2 font-display text-2xl tracking-tight text-white uppercase">
        Collections
      </h1>
      <p className="mb-6 max-w-2xl text-sm text-smoke">
        Editorial groupings like Staff Picks or Michigan Favorites. A product can
        belong to several — this is merchandising, not taxonomy.
      </p>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>New collection</CardTitle>
        </CardHeader>
        <CardContent>
          <CollectionForm />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {collections.map((collection) => (
          <Card key={collection.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3">
                <span>{collection.name}</span>
                <StatusPill status={collection.status} liveNow={collection.liveNow} />
                <span className="font-mono text-sm font-normal text-smoke">
                  /{collection.slug} · {collection.productCount} product
                  {collection.productCount === 1 ? '' : 's'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <CollectionForm collection={collection} />

              <div className="flex flex-col gap-3 border-t border-ink-600 pt-4">
                <h3 className="font-mono text-xs tracking-widest text-smoke uppercase">
                  Products in this collection
                </h3>
                <MembershipToggles
                  parentField="collectionId"
                  parentId={collection.id}
                  childField="productId"
                  items={products.map((product) => ({
                    id: product.id,
                    name: product.name,
                    status: product.status,
                  }))}
                  selected={byCollection.get(collection.id) ?? []}
                  action={toggleCollectionProductAction}
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  )
}
