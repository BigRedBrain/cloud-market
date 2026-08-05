import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { PlaceOrderForm } from '@/components/orders/checkout-forms'
import { SiteNav } from '@/components/site-nav'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { requireVerifiedUser } from '@/lib/auth/dal'
import { db, schema } from '@/lib/db'
import { formatCents } from '@/lib/orders/pricing'
import { and, eq, sql } from 'drizzle-orm'

export const metadata: Metadata = {
  title: 'Review your order',
  robots: { index: false, follow: false },
}

/**
 * The last screen before an order exists.
 *
 * Every figure shown here was computed server-side and is already stored on the
 * draft. Nothing on this page is recalculated in the browser, and nothing the
 * browser submits influences a total — the form carries an order id, an
 * idempotency key and an age confirmation, and that is all.
 *
 * The draft is re-read on every render, so a customer who leaves this tab open
 * past the hold window sees the expiry rather than a stale total.
 */
export default async function CheckoutReviewPage() {
  const user = await requireVerifiedUser()

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.userId, user.id), eq(schema.orders.currentStatus, 'draft')))
    .limit(1)

  if (!order) redirect('/bag')

  const lines = await db
    .select()
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, order.id))

  const [store] = await db
    .select({ name: schema.stores.name, addressLine1: schema.stores.addressLine1,
      city: schema.stores.city, postalCode: schema.stores.postalCode })
    .from(schema.stores)
    .where(eq(schema.stores.id, order.storeId))
    .limit(1)

  /**
   * Asked of the DATABASE, not of this process.
   *
   * `Date.now()` here would be wrong twice over: it is an impure call during
   * render, and it compares an application server's clock against a stored
   * timestamp. Every other expiry check in this phase evaluates `now()` inside
   * Postgres, and the page a customer reads must not be the one place that
   * disagrees.
   */
  const [reservation] = await db
    .select({ stillHeld: sql<boolean>`${schema.orders.reservedUntil} > now()` })
    .from(schema.orders)
    .where(eq(schema.orders.id, order.id))

  const expired = !reservation?.stillHeld

  return (
    <>
      <SiteNav bagCount={0} />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="mb-6 font-display text-3xl tracking-tight text-white uppercase">
          Review your order
        </h1>

        {expired && (
          <div className="mb-6">
            <Alert tone="warning" title="Your checkout timed out">
              The items were released back to stock. Start again from your bag.
            </Alert>
          </div>
        )}

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Pickup at {store?.name ?? 'the store'}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-smoke">
              <p>{store?.addressLine1}</p>
              <p>{store?.city} {store?.postalCode}</p>
              <p className="mt-3 text-white">Pay with cash when you collect.</p>
              <p className="mt-1">
                Bring government-issued photo ID. We check it at handoff — it is
                required by law, and we cannot release an order without it.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Your items</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3">
                {lines.map((line) => (
                  <li key={line.id} className="flex justify-between gap-4 text-sm">
                    <span className="text-white">
                      {line.productName}{' '}
                      <span className="text-smoke">({line.variantLabel}) &times; {line.quantity}</span>
                    </span>
                    <span className="font-mono text-white">
                      {formatCents(line.lineSubtotalCents)}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className="mt-5 flex flex-col gap-2 border-t-2 border-ink pt-4 font-mono text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-smoke">Subtotal</dt>
                  <dd className="text-white">{formatCents(order.subtotalCents)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-smoke">
                    Excise tax ({(order.exciseTaxRateBps / 100).toFixed(0)}%)
                  </dt>
                  <dd className="text-white">{formatCents(order.exciseTaxCents)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-smoke">
                    Sales tax ({(order.salesTaxRateBps / 100).toFixed(0)}%)
                  </dt>
                  <dd className="text-white">{formatCents(order.salesTaxCents)}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t-2 border-ink pt-2 text-base">
                  <dt className="text-white">Total due at pickup</dt>
                  <dd className="font-semibold text-white">{formatCents(order.totalCents)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {expired ? (
            <Link href="/bag" className={buttonVariants({ variant: 'primary' })}>
              Back to your bag
            </Link>
          ) : (
            <Card className="p-6">
              <PlaceOrderForm orderId={order.id} />
            </Card>
          )}
        </div>
      </main>
    </>
  )
}
