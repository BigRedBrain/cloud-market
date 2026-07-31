import type { Metadata } from 'next'
import { Flame, PackageOpen, Truck } from 'lucide-react'

import { CloudButton } from '@/components/brand/cloud-button'
import { Logo } from '@/components/brand/logo'
import { ProductCard, type Product } from '@/components/product-card'
import { SiteNav } from '@/components/site-nav'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, Input, Textarea } from '@/components/ui/field'
import { ProductCardSkeleton, Skeleton, Spinner } from '@/components/ui/skeleton'

export const metadata: Metadata = {
  title: 'Design system',
  // Internal reference, not a storefront page.
  robots: { index: false, follow: false },
}

const SAMPLE: Product[] = [
  {
    id: '1',
    slug: 'midnight-runtz',
    name: 'Midnight Runtz',
    strainType: 'Indica',
    thcPercent: 27.4,
    priceCents: 4500,
    inStock: true,
  },
  {
    id: '2',
    slug: 'motor-city-haze',
    name: 'Motor City Haze',
    strainType: 'Sativa',
    thcPercent: 22.1,
    priceCents: 3800,
    inStock: true,
  },
  {
    id: '3',
    slug: 'eastside-og',
    name: 'Eastside OG',
    strainType: 'Hybrid',
    thcPercent: 24.9,
    priceCents: 4200,
    inStock: false,
  },
]

const SWATCHES = [
  { name: 'ink', hex: '#121214', role: 'Foundation', className: 'bg-ink-900' },
  { name: 'ink-800', hex: '#1B1B1F', role: 'Panel', className: 'bg-ink-800' },
  { name: 'cream', hex: '#F5EEE0', role: 'Body text', className: 'bg-cream' },
  { name: 'smoke', hex: '#8E9298', role: 'Secondary', className: 'bg-smoke' },
  { name: 'volt', hex: '#46FF7D', role: 'Primary action', className: 'bg-volt' },
  { name: 'ember', hex: '#FF7A18', role: 'Accent, heat', className: 'bg-ember' },
  { name: 'flare', hex: '#FF3B2F', role: 'Destructive', className: 'bg-flare' },
]

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-3xl tracking-tight uppercase">{title}</h2>
        {note && <p className="max-w-2xl text-sm text-smoke">{note}</p>}
      </div>
      {children}
    </section>
  )
}

export default function DesignSystemPage() {
  return (
    <>
      <SiteNav bagCount={3} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-12 sm:px-6">
        <header className="mb-14 flex flex-col gap-3">
          <p className="font-mono text-xs tracking-[0.2em] text-ember uppercase">
            Cloud Market · Brand system v1
          </p>
          <h1 className="max-w-3xl font-display text-5xl leading-[0.95] tracking-tight uppercase sm:text-7xl">
            Ink, smoke <span className="text-volt">and fire</span>
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-smoke">
            A comic panel pressed onto charcoal. Thick outlines, hard shadows,
            halftone shading — and one rule that carries the accessibility of the
            whole system: every bright fill takes ink text, never cream.
          </p>
        </header>

        <div className="flex flex-col gap-20">
          <Section
            title="Colour"
            note="Authored in oklch so a tint keeps its hue. Contrast pairings are fixed by the token, not chosen per component."
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {SWATCHES.map((swatch) => (
                <div key={swatch.name} className="panel-sm overflow-hidden rounded-md">
                  <div className={`h-16 w-full ${swatch.className}`} />
                  <div className="bg-ink-800 p-2.5">
                    <p className="font-mono text-xs font-bold text-cream">
                      {swatch.name}
                    </p>
                    <p className="font-mono text-[0.625rem] text-smoke">
                      {swatch.hex}
                    </p>
                    <p className="mt-1 text-[0.6875rem] text-smoke">{swatch.role}</p>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section
            title="Typography"
            note="Anton for display only, never below 1.5rem and never for prose. Archivo carries everything readable. Space Mono handles prices, potency and order numbers."
          >
            <Card className="p-6">
              <div className="flex flex-col gap-6">
                <div>
                  <p className="mb-2 font-mono text-[0.625rem] tracking-widest text-smoke uppercase">
                    Anton · display
                  </p>
                  <p className="font-display text-5xl leading-none tracking-tight uppercase">
                    Delivered to your door
                  </p>
                </div>
                <div className="border-t border-ink-600 pt-6">
                  <p className="mb-2 font-mono text-[0.625rem] tracking-widest text-smoke uppercase">
                    Archivo · body
                  </p>
                  <p className="max-w-2xl text-base leading-relaxed">
                    Licensed Michigan cannabis, cured properly and tested twice.
                    Order by 8pm for same-day delivery across Metro Detroit.
                  </p>
                </div>
                <div className="border-t border-ink-600 pt-6">
                  <p className="mb-2 font-mono text-[0.625rem] tracking-widest text-smoke uppercase">
                    Space Mono · data
                  </p>
                  <p className="font-mono text-2xl font-bold">
                    $42.00 <span className="text-smoke">· THC 27.4% · 3.5g</span>
                  </p>
                </div>
              </div>
            </Card>
          </Section>

          <Section
            title="Logo"
            note="One shape at every scale. Clear space equal to cap-height is built into the component as padding, so correct placement is the default."
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="flex items-center justify-center p-8">
                <Logo variant="full" />
              </Card>
              <Card className="flex items-center justify-center p-8">
                <Logo variant="stacked" />
              </Card>
              <Card surface="paper" className="flex items-center justify-center p-8">
                <Logo variant="full" tone="ink" />
              </Card>
            </div>
          </Section>

          <Section
            title="The cloud button"
            note="The signature. Smoke drifts inside the silhouette; the outer edge ignites on hover and on keyboard focus. Tab to it — the fire is not hover-only."
          >
            <Card className="flex flex-wrap items-center justify-center gap-8 p-12">
              <CloudButton size="sm">Shop now</CloudButton>
              <CloudButton size="md">Add to bag</CloudButton>
              <CloudButton size="lg">Checkout</CloudButton>
            </Card>
          </Section>

          <Section
            title="Buttons"
            note="The press is physical: 1px lift on hover, 2px drop on active as the ink shadow collapses. Disabled loses the shadow entirely, so it never looks pressable."
          >
            <Card className="flex flex-col gap-6 p-6">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary">Add to bag</Button>
                <Button variant="accent">Reorder</Button>
                <Button variant="destructive">Remove</Button>
                <Button variant="paper">Track order</Button>
                <Button variant="outline">Keep browsing</Button>
                <Button variant="ghost">Cancel</Button>
                <Button disabled>Sold out</Button>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-ink-600 pt-6">
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
                <Button size="icon" aria-label="Add">
                  <Flame />
                </Button>
                <Button>
                  <Spinner label="Placing order" />
                  Placing order
                </Button>
              </div>
            </Card>
          </Section>

          <Section
            title="Badges"
            note="Die-cut stickers, rationed to one per card. Every badge pairs colour with text so it survives greyscale."
          >
            <Card className="flex flex-wrap items-center gap-3 p-6">
              <Badge variant="volt">In stock</Badge>
              <Badge variant="ember">
                <Flame aria-hidden="true" />
                Top shelf
              </Badge>
              <Badge variant="flare">Last 3</Badge>
              <Badge variant="cream">New drop</Badge>
              <Badge variant="smoke">Indica</Badge>
              <Badge variant="outline">Lab tested</Badge>
              <Badge variant="ember" tilt>
                20% off
              </Badge>
            </Card>
          </Section>

          <Section
            title="Forms"
            note="44px targets, labels never used as placeholders, and errors signalled twice — flare border plus a heavy left rule — so the state is never colour-only."
          >
            <Card className="max-w-xl p-6">
              <div className="flex flex-col gap-5">
                <Field
                  id="demo-name"
                  label="Full name"
                  hint="As it appears on your state ID."
                  required
                >
                  {(props) => <Input placeholder="Jordan Ellis" {...props} />}
                </Field>

                <Field
                  id="demo-address"
                  label="Delivery address"
                  error="We don't deliver to this ZIP yet. Try pickup instead."
                  required
                >
                  {(props) => <Input placeholder="1 Example St" {...props} />}
                </Field>

                <Field id="demo-notes" label="Delivery notes">
                  {(props) => (
                    <Textarea placeholder="Gate code, buzzer, where to leave it" {...props} />
                  )}
                </Field>

                <div className="flex gap-3">
                  <Button variant="primary">Save address</Button>
                  <Button variant="ghost">Cancel</Button>
                </div>
              </div>
            </Card>
          </Section>

          <Section
            title="Product cards"
            note="Fixed hierarchy: type, name, potency, price, action. The title stretches its own hit area so the whole panel is clickable without nesting a button inside a link."
          >
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <ProductCard
                product={SAMPLE[0]}
                badge={{ label: 'Top shelf', variant: 'ember' }}
              />
              <ProductCard product={SAMPLE[1]} badge={{ label: 'New drop' }} />
              <ProductCard product={SAMPLE[2]} />
            </div>
          </Section>

          <Section
            title="Loading"
            note="Skeletons keep the outline of what they replace, so nothing shifts when content lands."
          >
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <ProductCardSkeleton />
              <ProductCardSkeleton />
              <Card className="flex flex-col gap-3 p-4">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </Card>
            </div>
          </Section>

          <Section
            title="Empty states"
            note="An empty screen is an invitation to act, so each one names its next step. No apologies — an empty bag is not an error."
          >
            <div className="grid gap-5 lg:grid-cols-2">
              <EmptyState
                icon={<PackageOpen />}
                title="Nothing in your bag yet"
                description="Browse the menu and add something. We hold your bag for 24 hours."
                action={<Button variant="primary">Browse flower</Button>}
              />
              <EmptyState
                icon={<Truck />}
                title="No orders yet"
                description="Your delivery and pickup history will show up here once you place your first order."
                action={<Button variant="outline">See the menu</Button>}
              />
            </div>
          </Section>

          <Section
            title="Paper panels"
            note="Cream surfaces are a structural device, not a theme. They mark content lifted out of the dark world: receipts, totals, legal copy."
          >
            <Card surface="paper" className="max-w-md">
              <CardHeader>
                <CardTitle>Order summary</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 font-mono text-sm">
                <div className="flex justify-between">
                  <span>Midnight Runtz · 3.5g</span>
                  <span>$45.00</span>
                </div>
                <div className="flex justify-between">
                  <span>Delivery</span>
                  <span>$5.00</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Excise + sales tax</span>
                  <span>$8.50</span>
                </div>
                <div className="mt-2 flex justify-between border-t-2 border-ink pt-2 text-base font-bold">
                  <span>Total</span>
                  <span>$58.50</span>
                </div>
              </CardContent>
            </Card>
          </Section>
        </div>
      </main>
    </>
  )
}
