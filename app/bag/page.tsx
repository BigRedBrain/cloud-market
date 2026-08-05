import type { Metadata } from 'next'
import Link from 'next/link'
import { PackageOpen } from 'lucide-react'

import { QuantityStepper, RemoveLineForm } from '@/components/bag/bag-controls'
import { StartCheckoutForm } from '@/components/orders/checkout-forms'
import { SiteNav } from '@/components/site-nav'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { EmptyState } from '@/components/ui/empty-state'
import { getCurrentUser } from '@/lib/auth/dal'
import { getBag } from '@/lib/bag/core'
import { formatCents } from '@/lib/money'

export const metadata: Metadata = {
  title: 'Your bag',
  robots: { index: false, follow: false },
}

/**
 * Bag page — 20% brand intensity (DESIGN.md §9).
 *
 * Panel outlines and type only. No smoke, no halftone, no cloud button: this is
 * a task surface, and the customer is here to check what they are about to
 * spend.
 *
 * A Server Component. Every price and the subtotal are computed here from the
 * live catalog on each render, so a price change in admin is reflected on the
 * next load with no reconciliation step.
 */
export default async function BagPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await getCurrentUser()
  const bag = await getBag(user?.id ?? null)

  /**
   * Set by sign-in when merging the guest bag dropped a line that can no longer
   * be bought. The line is gone from the bag, so without this the change would
   * be invisible — the customer would simply find less than they left.
   */
  const bagUpdatedOnSignIn = (await searchParams).bag === 'updated'

  return (
    <>
      <SiteNav bagCount={bag.itemCount} />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="mb-6 font-display text-3xl tracking-tight text-white uppercase">
          Your bag
        </h1>

        {/* Outside the empty/non-empty branch: if every merged line was dropped,
            the bag is empty and this is the only explanation for it. */}
        {bagUpdatedOnSignIn && (
          <div className="mb-6">
            <Alert tone="warning" title="Your bag was updated">
              Some items are no longer available and weren&apos;t carried over
              when you signed in.
            </Alert>
          </div>
        )}

        {bag.lines.length === 0 ? (
          <EmptyState
            icon={<PackageOpen />}
            title="Nothing in your bag yet"
            description="Browse the menu and add something. We hold your bag for 30 days."
            action={
              <Link href="/shop">
                <Button variant="primary">Browse the menu</Button>
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-6">
            {bag.hasIssues && (
              <Alert tone="warning" title="Some items need attention">
                Availability changed while these were in your bag. Items marked
                below aren&apos;t included in the subtotal.
              </Alert>
            )}

            <ul className="flex flex-col gap-4">
              {bag.lines.map((line) => {
                const itemName = `${line.productName} ${line.label}`
                return (
                  <li key={line.lineId}>
                    <Card className="p-4">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                        <div className="panel-sm size-24 shrink-0 overflow-hidden rounded-md bg-ink-700">
                          {line.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- next/image arrives with Blob uploads
                            <img
                              src={line.imageUrl}
                              alt=""
                              width={96}
                              height={96}
                              loading="lazy"
                              decoding="async"
                              className="size-full object-cover"
                            />
                          ) : (
                            <div aria-hidden="true" className="halftone size-full text-smoke opacity-40" />
                          )}
                        </div>

                        <div className="flex flex-1 flex-col gap-1">
                          <p className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                            {line.categoryName}
                          </p>
                          <h2 className="font-display text-lg leading-tight tracking-tight text-white">
                            <Link
                              href={`/product/${line.productSlug}` as never}
                              className="underline-offset-4 hover:underline"
                            >
                              {line.productName}
                            </Link>
                          </h2>
                          <p className="font-mono text-xs text-smoke">
                            {line.label} · {line.sku}
                          </p>

                          {line.isUnavailable && (
                            <p className="mt-1">
                              <Badge variant="flare">
                                {line.unavailableReason === 'out_of_stock'
                                  ? 'Sold out'
                                  : line.unavailableReason === 'insufficient_stock'
                                    ? `Only ${line.availableQuantity} left`
                                    : 'No longer available'}
                              </Badge>
                            </p>
                          )}

                          <div className="mt-3 flex flex-wrap items-center gap-4">
                            <QuantityStepper
                              lineId={line.lineId}
                              quantity={line.quantity}
                              maxQuantity={Math.max(1, line.availableQuantity)}
                              itemName={itemName}
                            />
                            <RemoveLineForm lineId={line.lineId} itemName={itemName} />
                          </div>
                        </div>

                        <div className="text-right">
                          <p className="font-mono text-lg font-bold text-white">
                            {formatCents(line.lineTotalCents)}
                          </p>
                          <p className="font-mono text-xs text-smoke">
                            {formatCents(line.unitPriceCents)} each
                          </p>
                          {line.compareAtPriceCents && (
                            <p className="font-mono text-xs text-smoke line-through">
                              {formatCents(line.compareAtPriceCents * line.quantity)}
                            </p>
                          )}
                        </div>
                      </div>
                    </Card>
                  </li>
                )
              })}
            </ul>

            <Card surface="paper">
              <CardHeader>
                <CardTitle>Summary</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 font-mono text-sm">
                <div className="flex justify-between gap-4">
                  <span>
                    Subtotal ({bag.itemCount} item{bag.itemCount === 1 ? '' : 's'})
                  </span>
                  <span className="font-bold">{formatCents(bag.subtotalCents)}</span>
                </div>
                <p className="mt-1 font-sans text-xs text-muted-foreground">
                  Delivery, taxes and any discounts are calculated at checkout.
                  Prices shown are current and may change until you order.
                </p>

                <div className="mt-4">
                  <StartCheckoutForm disabled={bag.hasIssues} />
                </div>

                <p className="text-center font-sans text-xs text-muted-foreground">
                  Adding to your bag doesn&apos;t reserve stock. Items are held
                  for 15 minutes once you start checkout.
                </p>
              </CardContent>
            </Card>

            <div>
              <Link href="/shop">
                <Button variant="outline">Keep browsing</Button>
              </Link>
            </div>
          </div>
        )}
      </main>
    </>
  )
}
