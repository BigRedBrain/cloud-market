import type { Route } from 'next'
import { BadgeCheck, MapPin, ShieldCheck, Truck } from 'lucide-react'
import Link from 'next/link'

import {
  listCategoriesWithCounts,
  listFeaturedProducts,
} from '@/lib/catalog/queries'
import { BurningCloud } from '@/components/brand/burning-cloud'
import { CloudButton } from '@/components/brand/cloud-button'
import { SmokeBackground } from '@/components/brand/smoke-background'
import { ProductCard } from '@/components/product-card'
import { SiteNav } from '@/components/site-nav'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/**
 * Homepage.
 *
 * Mobile-first: every grid starts at one column and the hero type steps up
 * rather than down. The burning cloud plays inline instead of as a splash gate,
 * so the page is shoppable from the first frame — "Shop the menu" is clickable
 * before the animation finishes.
 *
 * Featured products and categories come from the live catalogue — the same
 * queries the shop uses, so the homepage cannot drift out of sync with what is
 * actually purchasable.
 */



export default async function Home() {
  const [featured, categories] = await Promise.all([
    listFeaturedProducts(3),
    listCategoriesWithCounts(),
  ])

  return (
    <>
      <SiteNav />

      <main className="flex flex-1 flex-col">
        {/* ---- Hero ---------------------------------------------------- */}
        <section className="relative isolate overflow-hidden border-b-2 border-ink">
          <SmokeBackground intensity="hero" />
          <div
            aria-hidden="true"
            className="halftone-lg pointer-events-none absolute inset-0 -z-10 text-ember opacity-25 [mask-image:radial-gradient(120%_80%_at_50%_0%,black,transparent_70%)]"
          />

          <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div className="flex flex-col items-start gap-6">
              <Badge variant="ember" tilt>
                Metro Detroit · Same-day delivery
              </Badge>

              <h1 className="max-w-2xl font-display text-5xl leading-[0.9] tracking-tight text-white uppercase sm:text-7xl xl:text-8xl">
                Cannabis,
                <br />
                <span className="text-ember">to your door</span>
              </h1>

              <p className="max-w-lg text-lg leading-relaxed text-smoke">
                Licensed Michigan flower, cured properly and tested twice. Order
                by 8pm and it lands the same day — or pick it up in twenty
                minutes.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-1">
                <CloudButton size="lg">Shop now</CloudButton>
                <Button variant="outline" size="lg">
                  Browse categories
                </Button>
              </div>

              <p className="font-mono text-xs text-smoke">
                21+ · Michigan CRA licensed · ID required at handoff
              </p>
            </div>

            <div className="order-first mx-auto w-full max-w-sm lg:order-last lg:max-w-md">
              <BurningCloud />
            </div>
          </div>
        </section>

        {/* ---- Delivery facts ------------------------------------------ */}
        <section className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-px bg-ink sm:grid-cols-3">
          {[
            { label: 'Delivery window', value: 'Same day', detail: 'Order before 8pm' },
            { label: 'Pickup', value: '20 min', detail: 'Ready when you arrive' },
            { label: 'Minimum', value: '$25', detail: 'Free delivery over $75' },
          ].map((item) => (
            <div key={item.label} className="bg-ink-900 px-6 py-8">
              <p className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                {item.label}
              </p>
              <p className="mt-2 font-display text-4xl tracking-tight text-white uppercase">
                {item.value}
              </p>
              <p className="mt-1 text-sm text-smoke">{item.detail}</p>
            </div>
          ))}
        </section>

        {/* ---- Featured ------------------------------------------------ */}
        <section className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs tracking-[0.2em] text-ember uppercase">
                This week
              </p>
              <h2 className="mt-1 font-display text-4xl tracking-tight text-white uppercase">
                Featured drops
              </h2>
            </div>
            <Link href="/shop">
              <Button variant="ghost">See the whole menu →</Button>
            </Link>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>

        {/* ---- Categories ---------------------------------------------- */}
        <section className="border-y-2 border-ink bg-ink-800">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
            <h2 className="mb-8 font-display text-4xl tracking-tight text-white uppercase">
              Shop by category
            </h2>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {categories.map((category) => (
                <Link
                  key={category.slug}
                  href={`/shop/${category.slug}` as Route}
                  className="panel-sm group flex flex-col justify-between gap-6 rounded-md bg-ink-900 p-4 transition-transform duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5"
                >
                  <span className="font-display text-lg leading-none tracking-tight text-white uppercase">
                    {category.name}
                  </span>
                  <span className="font-mono text-xs text-smoke">
                    {category.productCount} item{category.productCount === 1 ? '' : 's'}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* ---- Delivery area + trust ----------------------------------- */}
        <section className="mx-auto grid w-full max-w-7xl gap-5 px-4 py-16 sm:px-6 lg:grid-cols-2">
          <Card className="flex flex-col gap-4 p-6">
            <div className="flex items-center gap-3">
              <MapPin aria-hidden="true" className="size-5 text-ember" />
              <h2 className="font-display text-2xl tracking-tight text-white uppercase">
                Where we deliver
              </h2>
            </div>
            <p className="leading-relaxed text-smoke">
              We deliver across Metro Detroit — Wayne, Oakland and Macomb
              counties — to any address within 25 miles of our Detroit
              storefront. Enter your address at checkout and we&apos;ll confirm
              the window before you pay.
            </p>
            <ul className="flex flex-col gap-2 font-mono text-sm text-smoke">
              <li className="flex items-center gap-2">
                <Truck aria-hidden="true" className="size-4 text-volt" />
                Same-day on orders placed before 8pm
              </li>
              <li className="flex items-center gap-2">
                <BadgeCheck aria-hidden="true" className="size-4 text-volt" />
                Contact-free handoff available
              </li>
            </ul>
            <div>
              <Button variant="outline">Check your address</Button>
            </div>
          </Card>

          <Card surface="paper" className="flex flex-col gap-4 p-6">
            <div className="flex items-center gap-3">
              <ShieldCheck aria-hidden="true" className="size-5" />
              <h2 className="font-display text-2xl tracking-tight uppercase">
                Licensed and tested
              </h2>
            </div>
            <p className="leading-relaxed text-muted-foreground">
              Cloud Market is licensed by the Michigan Cannabis Regulatory
              Agency. Every batch is lab-tested for potency and contaminants, and
              the certificate of analysis is linked on each product page.
            </p>
            <dl className="grid grid-cols-2 gap-4 border-t-2 border-ink pt-4 font-mono text-sm">
              <div>
                <dt className="text-muted-foreground">Licence</dt>
                <dd className="font-bold">AU-R-000000</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Type</dt>
                <dd className="font-bold">Adult-use retailer</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              Must be 21+ with valid government ID. Keep out of reach of children
              and animals. Do not drive after use.
            </p>
          </Card>
        </section>
      </main>
    </>
  )
}
