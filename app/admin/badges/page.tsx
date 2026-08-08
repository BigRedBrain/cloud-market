import type { Metadata } from 'next'

import {
  BadgeForm,
  MembershipToggles,
  toggleProductBadgeAction,
} from '@/components/admin/cms-forms'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdminIdentity } from '@/lib/auth/admin-identity'
import {
  adminGetProductBadgeIds,
  adminListBadges,
  adminListProductsForPicker,
} from '@/lib/cms/admin-queries'

export const metadata: Metadata = {
  title: 'Badges',
  robots: { index: false, follow: false },
}

const ALLOWED = ['volt', 'ember', 'flare', 'cream', 'smoke', 'outline'] as const
type AllowedVariant = (typeof ALLOWED)[number]

/**
 * Product badges — records, not booleans.
 *
 * `products.featured` and `new_arrival` were booleans, and that is exactly the
 * pattern this replaces: every new label would have needed a migration and a
 * deploy. A badge is a row, so the owner invents "Big Red Select" unaided.
 *
 * Colour is chosen from the frozen design system's Badge variants — an editor
 * picks from the existing visual language rather than introducing a new one.
 */
export default async function AdminBadgesPage() {
  await requireAdminIdentity()

  const [badges, products] = await Promise.all([
    adminListBadges(),
    adminListProductsForPicker(),
  ])

  const assignments = await Promise.all(
    products.map(async (product) => ({
      id: product.id,
      badgeIds: [...(await adminGetProductBadgeIds(product.id))],
    })),
  )

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-2 font-display text-2xl tracking-tight text-white uppercase">
        Badges
      </h1>
      <p className="mb-6 max-w-2xl text-sm text-smoke">
        Reusable labels. Cards show the highest-priority badge; the product page
        shows them all.
      </p>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>New badge</CardTitle>
        </CardHeader>
        <CardContent>
          <BadgeForm />
        </CardContent>
      </Card>

      <div className="mb-8 flex flex-col gap-4">
        {badges.map((badge) => (
          <Card key={badge.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3">
                <Badge
                  variant={
                    ALLOWED.includes(badge.variant as AllowedVariant)
                      ? (badge.variant as AllowedVariant)
                      : 'ember'
                  }
                >
                  {badge.icon ? `${badge.icon} ${badge.label}` : badge.label}
                </Badge>
                <span className="font-mono text-sm font-normal text-smoke">
                  /{badge.slug} · {badge.productCount} product
                  {badge.productCount === 1 ? '' : 's'}
                  {!badge.active && ' · inactive'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BadgeForm badge={badge} />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Assign badges to products</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {products.map((product) => {
            const assigned =
              assignments.find((row) => row.id === product.id)?.badgeIds ?? []
            return (
              <div key={product.id} className="flex flex-col gap-2">
                <h3 className="font-mono text-xs tracking-widest text-smoke uppercase">
                  {product.name}
                  {product.status !== 'active' && ` (${product.status})`}
                </h3>
                <MembershipToggles
                  parentField="productId"
                  parentId={product.id}
                  childField="badgeId"
                  items={badges.map((badge) => ({
                    id: badge.id,
                    name: badge.icon ? `${badge.icon} ${badge.label}` : badge.label,
                  }))}
                  selected={assigned}
                  action={toggleProductBadgeAction}
                />
              </div>
            )
          })}
        </CardContent>
      </Card>
    </main>
  )
}
