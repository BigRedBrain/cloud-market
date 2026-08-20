import type { Metadata } from 'next'
import Link from 'next/link'
import { Lock } from 'lucide-react'

import { Logo } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert } from '@/components/ui/feedback'
import { Field, Input } from '@/components/ui/field'

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
}

/**
 * Checkout.
 *
 * This page is deliberately the quietest surface in the product, and every
 * absence below is a decision rather than an omission:
 *
 *  - **No smoke background.** Ambient motion behind a payment form competes
 *    with the one thing the customer is trying to concentrate on.
 *  - **No cloud button.** The signature control is for discovery. Here the
 *    primary action is a plain, wide, unmistakable button — a novelty
 *    silhouette on "Place order" invites hesitation at exactly the wrong moment.
 *  - **No hover lift on the summary panel.** Nothing moves that the customer
 *    did not move.
 *  - **Stripped navigation.** The full nav's categories and bag are routes out
 *    of checkout. At this step the logo is a link home and nothing else is.
 *
 * What the brand keeps: ink outlines, panel shadows, the type system, and the
 * cream paper summary. The identity survives; the theatrics do not.
 *
 * The order summary is a paper panel because it is a receipt — the same
 * structural device used everywhere else for lifted-out content.
 */
export default function CheckoutPage() {
  return (
    <>
      <header className="border-b-2 border-ink bg-ink-900">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="-ml-2 rounded-md" aria-label="CloudMarket home">
            <Logo variant="full" tone="cream" showLabel={false} />
          </Link>
          <p className="inline-flex items-center gap-2 font-data text-xs text-smoke">
            <Lock aria-hidden="true" className="size-3.5" />
            Secure checkout
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="mb-8 font-poster text-3xl tracking-tight text-white uppercase">
          Checkout
        </h1>

        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
          <div className="flex flex-col gap-8">
            <Alert tone="info" title="ID required at handoff">
              Bring the government ID matching the name below. Our driver checks
              it before releasing the order.
            </Alert>

            <section className="flex flex-col gap-5">
              <h2 className="font-poster text-xl tracking-tight text-white uppercase">
                Delivery details
              </h2>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field id="co-first" label="First name" required>
                  {(props) => <Input autoComplete="given-name" {...props} />}
                </Field>
                <Field id="co-last" label="Last name" required>
                  {(props) => <Input autoComplete="family-name" {...props} />}
                </Field>
              </div>

              <Field
                id="co-address"
                label="Street address"
                hint="We deliver within 25 miles of Detroit."
                required
              >
                {(props) => <Input autoComplete="street-address" {...props} />}
              </Field>

              <div className="grid gap-5 sm:grid-cols-3">
                <Field id="co-city" label="City" required className="sm:col-span-2">
                  {(props) => <Input autoComplete="address-level2" {...props} />}
                </Field>
                <Field id="co-zip" label="ZIP" required>
                  {(props) => (
                    <Input
                      autoComplete="postal-code"
                      inputMode="numeric"
                      maxLength={5}
                      {...props}
                    />
                  )}
                </Field>
              </div>

              <Field
                id="co-phone"
                label="Phone"
                hint="The driver texts this number on arrival."
                required
              >
                {(props) => (
                  <Input type="tel" autoComplete="tel" inputMode="tel" {...props} />
                )}
              </Field>
            </section>

            <section className="flex flex-col gap-5">
              <h2 className="font-poster text-xl tracking-tight text-white uppercase">
                Payment
              </h2>

              <Alert tone="warning" title="Cash and debit only">
                Federal banking rules mean we can&apos;t take credit cards. Pay
                the driver by debit or cash — exact change appreciated.
              </Alert>
            </section>
          </div>

          {/* Receipt. Paper panel, no interactive motion. */}
          <Card surface="paper" className="lg:sticky lg:top-6">
            <CardHeader>
              <CardTitle>Order summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 font-data text-sm">
              <div className="flex justify-between gap-4">
                <span>Midnight Runtz · 3.5g</span>
                <span>$45.00</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Motor City Haze · 3.5g</span>
                <span>$38.00</span>
              </div>
              <div className="mt-2 flex justify-between gap-4 border-t border-ink/30 pt-2">
                <span>Subtotal</span>
                <span>$83.00</span>
              </div>
              <div className="flex justify-between gap-4 text-muted-foreground">
                <span>Delivery</span>
                <span>Free</span>
              </div>
              <div className="flex justify-between gap-4 text-muted-foreground">
                <span>Excise + sales tax</span>
                <span>$14.11</span>
              </div>
              <div className="mt-2 flex justify-between gap-4 border-t-2 border-ink pt-3 text-base font-bold">
                <span>Total</span>
                <span>$97.11</span>
              </div>

              <Button variant="primary" size="lg" className="mt-4 w-full">
                Place order
              </Button>

              <p className="mt-1 text-center text-xs text-muted-foreground">
                You&apos;ll get a text when the driver leaves.
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  )
}
