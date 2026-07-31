import { CloudButton } from '@/components/brand/cloud-button'
import { SiteNav } from '@/components/site-nav'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * Landing page.
 *
 * The hero is the thesis: the wordmark set at poster scale, the cloud button
 * smouldering beneath it, halftone bleeding off the top edge. Everything else
 * on the page stays quiet so the button is the thing you remember.
 *
 * The catalogue replaces the placeholder grid in Phase 3.
 */
export default function Home() {
  return (
    <>
      <SiteNav />

      <main className="flex flex-1 flex-col">
        <section className="relative overflow-hidden border-b-2 border-ink">
          {/* Halftone bleeding down from the top edge, ember-tinted. */}
          <div
            aria-hidden="true"
            className="halftone-lg pointer-events-none absolute inset-0 text-ember opacity-30 [mask-image:radial-gradient(120%_80%_at_50%_0%,black,transparent_70%)]"
          />

          <div className="relative mx-auto flex w-full max-w-7xl flex-col items-start gap-8 px-4 py-20 sm:px-6 sm:py-28">
            <Badge variant="ember" tilt>
              Metro Detroit · Same-day
            </Badge>

            <h1 className="max-w-4xl font-display text-6xl leading-[0.9] tracking-tight uppercase sm:text-8xl">
              Cannabis,
              <br />
              <span className="text-volt">to your door</span>
            </h1>

            <p className="max-w-xl text-lg leading-relaxed text-smoke">
              Licensed Michigan flower, cured properly and tested twice. Order by
              8pm and it lands the same day — or pick it up in twenty minutes.
            </p>

            <div className="flex flex-wrap items-center gap-5 pt-2">
              <CloudButton size="lg">Shop the menu</CloudButton>
              <Button variant="outline" size="lg">
                How delivery works
              </Button>
            </div>

            <p className="font-mono text-xs text-smoke">
              21+ · Michigan CRA licensed · ID required at handoff
            </p>
          </div>
        </section>

        <section className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-px bg-ink sm:grid-cols-3">
          {[
            {
              label: 'Delivery window',
              value: 'Same day',
              detail: 'Order before 8pm',
            },
            { label: 'Pickup', value: '20 min', detail: 'Ready when you arrive' },
            { label: 'Minimum', value: '$25', detail: 'Free over $75' },
          ].map((item) => (
            <div key={item.label} className="bg-ink-900 px-6 py-8">
              <p className="font-mono text-[0.6875rem] tracking-widest text-smoke uppercase">
                {item.label}
              </p>
              <p className="mt-2 font-display text-4xl tracking-tight uppercase">
                {item.value}
              </p>
              <p className="mt-1 text-sm text-smoke">{item.detail}</p>
            </div>
          ))}
        </section>
      </main>
    </>
  )
}
