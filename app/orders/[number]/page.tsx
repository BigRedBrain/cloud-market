import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, asc, eq } from 'drizzle-orm'

import { CancelOrderForm } from '@/components/orders/checkout-forms'
import { SiteNav } from '@/components/site-nav'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { requireUser } from '@/lib/auth/dal'
import { db, schema } from '@/lib/db'
import { formatCents } from '@/lib/orders/pricing'

export const metadata: Metadata = {
  title: 'Your order',
  robots: { index: false, follow: false },
}

const STATUS_COPY: Record<
  string,
  { tone: 'info' | 'success' | 'warning'; text: string }
> = {
  placed: { tone: 'success', text: 'We have your order and are getting it ready.' },
  preparing: { tone: 'info', text: 'Your order is being prepared.' },
  ready: { tone: 'success', text: 'Ready for pickup. Bring photo ID and cash.' },
  completed: { tone: 'success', text: 'Collected. Thanks for shopping with us.' },
  cancelled: { tone: 'warning', text: 'This order was cancelled.' },
  expired: { tone: 'warning', text: 'This checkout timed out before it was placed.' },
}

/**
 * One order, scoped to its owner.
 *
 * Looked up by `(order_number, user_id)`, never by number alone. An order number
 * is short and human-readable by design, which also makes it guessable — so it
 * is never sufficient on its own to read someone's purchase history. A mismatch
 * is a 404 rather than a 403, because "that order exists but is not yours" is
 * itself information.
 */
export default async function OrderPage({
  params,
}: {
  params: Promise<{ number: string }>
}) {
  const { number } = await params
  const user = await requireUser()

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.orderNumber, decodeURIComponent(number)),
        eq(schema.orders.userId, user.id),
      ),
    )
    .limit(1)

  if (!order) notFound()

  const lines = await db
    .select()
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, order.id))

  const events = await db
    .select()
    .from(schema.orderEvents)
    .where(eq(schema.orderEvents.orderId, order.id))
    .orderBy(asc(schema.orderEvents.occurredAt))

  const [store] = await db
    .select({
      name: schema.stores.name,
      addressLine1: schema.stores.addressLine1,
      city: schema.stores.city,
    })
    .from(schema.stores)
    .where(eq(schema.stores.id, order.storeId))
    .limit(1)

  const status = STATUS_COPY[order.currentStatus] ?? {
    tone: 'info' as const,
    text: 'Order received.',
  }
  const cancellable = ['placed', 'preparing', 'ready'].includes(order.currentStatus)

  return (
    <>
      <SiteNav bagCount={0} />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-poster text-3xl tracking-tight text-white uppercase">
            Order {order.orderNumber}
          </h1>
          <Badge variant={order.currentStatus === 'cancelled' ? 'smoke' : 'signal'}>
            {order.currentStatus}
          </Badge>
        </div>

        <div className="flex flex-col gap-6">
          <Alert tone={status.tone} title="Order status">
            {status.text}
          </Alert>

          <Card>
            <CardHeader>
              <CardTitle>Pickup</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-smoke">
              <p className="text-white">{store?.name}</p>
              <p>
                {store?.addressLine1}, {store?.city}
              </p>
              <p className="mt-3 text-white">
                {formatCents(order.totalCents)} due in cash at pickup.
              </p>
              <p className="mt-1">Photo ID is checked before handoff.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3">
                {lines.map((line) => (
                  <li key={line.id} className="flex justify-between gap-4 text-sm">
                    <span className="text-white">
                      {line.productName}{' '}
                      <span className="text-smoke">
                        ({line.variantLabel}) &times; {line.quantity}
                      </span>
                    </span>
                    <span className="font-data text-white">
                      {formatCents(line.lineTotalCents)}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className="mt-5 flex flex-col gap-2 border-t-2 border-ink pt-4 font-data text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-smoke">Subtotal</dt>
                  <dd className="text-white">{formatCents(order.subtotalCents)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-smoke">Excise tax</dt>
                  <dd className="text-white">{formatCents(order.exciseTaxCents)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-smoke">Sales tax</dt>
                  <dd className="text-white">{formatCents(order.salesTaxCents)}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t-2 border-ink pt-2 text-base">
                  <dt className="text-white">Total</dt>
                  <dd className="font-semibold text-white">
                    {formatCents(order.totalCents)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-2 font-data text-xs text-smoke">
                {events.map((event) => (
                  <li key={event.id} className="flex justify-between gap-4">
                    <span className="text-white">{event.eventType}</span>
                    <span>
                      {event.occurredAt.toISOString().replace('T', ' ').slice(0, 16)}
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          {cancellable && (
            <Card className="p-6">
              <CancelOrderForm orderId={order.id} />
            </Card>
          )}

          <Link href="/shop" className={buttonVariants({ variant: 'ghost' })}>
            Keep shopping
          </Link>
        </div>
      </main>
    </>
  )
}
